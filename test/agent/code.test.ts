import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { runCode, type Notice } from "../../src/agent/code.ts"
import { toolset } from "../../src/agent/loop.ts"
import type { Tool } from "../../src/agent/tools.ts"

const tool = (name: string, readonly: boolean, run: Tool["run"]): Tool => ({ name, readonly, run, parameters: {}, description: name })

/** Drive the real evaluator and broker with controlled capabilities. */
async function execute(code: string, tools: Tool[] = [], options: { signal?: AbortSignal; notice?: (notice: Notice) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ask-codemode-test-"))
  try {
    return await runCode(JSON.stringify({ code }), tools, { dir, signal: options.signal }, options.notice ?? (() => {}))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("scripts have no ambient process, imports, filesystem, network or timers", async () => {
  const output = await execute(`
    const types = [typeof process, typeof require, typeof Bun, typeof fetch, typeof setTimeout, typeof console];
    const imported = await import("node:fs").then(() => true, () => false);
    return { types, imported };
  `)
  assert.deepEqual(JSON.parse(output), { types: Array(6).fill("undefined"), imported: false })
})

test("disabled capabilities are not available inside a write script", async () => {
  const tools = toolset({ write: true, off: ["shell"] })
  const output = await execute(`return [typeof tools.shell, typeof tools.write, typeof tools.execute]`, tools)
  assert.deepEqual(JSON.parse(output), ["undefined", "function", "undefined"])
})

test("discovery pages the permitted catalog without leaking denied tools", async () => {
  const extra = ["lookup-a", "lookup-b", "lookup-disabled", "lookup-private"].map((name) => tool(name, name !== "lookup-private", async () => name))
  const tools = toolset({ off: ["lookup-disabled"], extra })
  const output = await execute(`
    const first = await discover({ query: "lookup", limit: 1 });
    const next = await discover({ query: "lookup", offset: first.next });
    return { first, next, result: await tools[next.tools[0].name]({}) };
  `, tools)
  const result = JSON.parse(output)
  assert.deepEqual(result.first, { tools: [{ name: "lookup-a", description: "lookup-a", parameters: {}, readonly: true }], next: 1 })
  assert.deepEqual(result.next.tools.map(({ name }: { name: string }) => name), ["lookup-b"])
  assert.equal(result.next.next, null)
  assert.equal(result.result, "lookup-b")
})

test("independent reads overlap and mutations are barriers", { timeout: 6000 }, async () => {
  const log: string[] = []
  const simultaneous = Promise.withResolvers<void>()
  const read = tool("read", true, async ({ which }) => {
    log.push(`start ${which}`)
    if (which === 2) simultaneous.resolve()
    if (which === 1) await simultaneous.promise
    log.push(`end ${which}`)
    return String(which)
  })
  const write = tool("write", false, async ({ which }) => {
    log.push(`start ${which}`)
    await wait(15)
    log.push(`end ${which}`)
    return String(which)
  })
  const output = await execute(`return await Promise.all([
    tools.read({ which: 1 }), tools.read({ which: 2 }),
    tools.write({ which: 3 }), tools.read({ which: 4 }), tools.write({ which: 5 })
  ])`, [read, write], { signal: AbortSignal.timeout(4500) })
  assert.equal(output, '["1","2","3","4","5"]')
  assert.deepEqual(log, ["start 1", "start 2", "end 2", "end 1", "start 3", "end 3", "start 4", "end 4", "start 5", "end 5"])
})

test("cancelling notifies the active tool and never dispatches a queued mutation", { timeout: 5000 }, async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const events: string[] = []
  const write = tool("write", false, async ({ which }, { signal }) => {
    events.push(String(which))
    started.resolve()
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
    events.push("cancelled")
    return ""
  })
  const running = execute(`await Promise.all([tools.write({ which: 1 }), tools.write({ which: 2 })])`, [write], { signal: controller.signal })
  await Promise.race([started.promise, running.then((output) => { throw new Error(output) })])
  controller.abort()
  assert.match(await running, /stopped.*\nA tool may already have changed state/)
  assert.deepEqual(events, ["1", "cancelled"])
})

test("tool errors can be handled by a script, but unawaited calls cannot outlive it", async () => {
  const calls: string[] = []
  const read = tool("read", true, async () => { throw new Error("not found") })
  const write = tool("write", false, async () => { calls.push("write"); return "" })
  assert.equal(await execute(`try { await tools.read() } catch (err) { return err.message }`, [read]), "not found")
  assert.match(await execute(`tools.write(); return 42`, [write]), /^error:.*pending tool calls/)
  assert.deepEqual(calls, [])
})

test("CPU limits cover a loop after an awaited callback", { timeout: 6500 }, async () => {
  const read = tool("read", true, async () => "ok")
  assert.match(await execute(`await tools.read(); while (true) {}`, [read]), /^error:.*CPU time limit/)
})

test("the guest heap is bounded", async () => {
  assert.match(await execute(`return new Uint8Array(64 * 1024 * 1024).length`), /^error:.*memory/i)
})

test("one snippet cannot dispatch more than its nested call budget", async () => {
  let calls = 0
  const read = tool("read", true, async () => String(++calls))
  assert.match(await execute(`for (let i = 0; i < 40; i++) await tools.read()`, [read]), /^error:.*at most 32 nested calls/)
  assert.equal(calls, 32)
})

test("the model-facing result is bounded after script processing", async () => {
  const output = await execute(`return "é".repeat(60_000)`)
  assert.ok(Buffer.byteLength(output) <= 64 * 1024)
  assert.match(output, /^é+[\s\S]*output truncated/)
})
