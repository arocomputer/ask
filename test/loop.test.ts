import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { connect, type Model } from "../src/catalog.ts"
import { interrupted, run } from "../src/loop.ts"
import type { Protocol } from "../src/provider.ts"
import { responses } from "../src/responses.ts"
import { serve } from "./fake.ts"

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-loop-"))
  writeFileSync(join(dir, "port.txt"), "service-alpha listens on 7341\n")
  return dir
}

function model(protocol: Protocol, url: string): Model {
  return { provider: "fake", id: "m", name: "M", protocol, baseURL: url, env: [], reasoning: false }
}

describe("loop", () => {
  for (const protocol of ["responses", "chat", "anthropic"] as const) {
    test(`${protocol}: a tool call's output reaches the model and the answer comes back`, async () => {
      const fake = await serve(protocol, [{ calls: [{ name: "read", args: { path: "port.txt" } }] }, { text: "It is 7341." }])
      try {
        const r = await run({ provider: connect(model(protocol, fake.url), "k"), model: "m", dir: project(), prompt: "Which port?" })
        assert.equal(r.answer, "It is 7341.")
        assert.match(JSON.stringify(fake.requests[1]), /1\\tservice-alpha listens on 7341/)
        assert.deepEqual(r.usage, { input: 200, output: 20, cached: 0 })
      } finally {
        await fake.close()
      }
    })
  }

  test("a conversation started on one protocol continues on another", async () => {
    const dir = project()
    const first = await serve("chat", [{ calls: [{ name: "read", args: { path: "port.txt" } }] }, { text: "7341" }])
    const second = await serve("anthropic", [{ text: "Still 7341." }])
    try {
      const a = await run({ provider: connect(model("chat", first.url), "k"), model: "m", dir, prompt: "Which port?" })
      const b = await run({ provider: connect(model("anthropic", second.url), "k"), model: "m", dir, prompt: "Sure?", messages: a.messages })
      assert.equal(b.answer, "Still 7341.")
      const sent = second.requests[0].messages
      assert.deepEqual(sent.map((m: any) => m.role), ["user", "assistant", "user", "assistant", "user"])
      assert.equal(sent[2].content[0].type, "tool_result")
    } finally {
      await first.close()
      await second.close()
    }
  })

  test("an overflowing context elides old tool outputs and tries again", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "x".repeat(5000))
    const fake = await serve("chat", [
      { calls: [{ name: "read", args: { path: "big.txt" } }] },
      { text: "", calls: [{ name: "list", args: {} }] },
      { status: 400, error: "This model's maximum context length is 1000 tokens" },
      { text: "done" },
    ])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir, prompt: "Go" })
      assert.equal(r.answer, "done")
      assert.doesNotMatch(JSON.stringify(fake.requests[3]), /xxxxx/)
      assert.match(JSON.stringify(fake.requests[3]), /output elided/)
    } finally {
      await fake.close()
    }
  })

  test("a read-only task is offered no way to write or run commands", async () => {
    const fake = await serve("chat", [{ text: "ok" }])
    try {
      await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Look" })
      assert.deepEqual(fake.requests[0].tools.map((t: any) => t.function.name), ["read", "list", "grep"])
    } finally {
      await fake.close()
    }
  })

  test("the project's instructions reach the model", async () => {
    const dir = project()
    writeFileSync(join(dir, "AGENTS.md"), "Indent with tabs.\n")
    const fake = await serve("chat", [{ text: "ok" }])
    try {
      await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir, prompt: "Look" })
      assert.match(fake.requests[0].messages[0].content, /# Project instructions\n\nIndent with tabs\.$/)
    } finally {
      await fake.close()
    }
  })

  test("requests store nothing upstream, and sealed reasoning replays on the next step", async () => {
    const fake = await serve("responses", [{ reasoning: { encrypted: "sealed" }, calls: [{ name: "list", args: {} }] }, { text: "done" }])
    try {
      await run({ provider: responses({ baseURL: fake.url, key: "k" }, true), model: "m", dir: project(), prompt: "Look" })
      assert.equal(fake.requests[0].store, false)
      assert.deepEqual(fake.requests[0].include, ["reasoning.encrypted_content"])
      assert.ok(fake.requests[1].input.some((i: any) => i.type === "reasoning" && i.encrypted_content === "sealed"))
    } finally {
      await fake.close()
    }
  })

  test("a gateway's unsealed reasoning is not sent back", async () => {
    const fake = await serve("responses", [{ reasoning: {}, calls: [{ name: "list", args: {} }] }, { text: "done" }])
    try {
      await run({ provider: connect(model("responses", fake.url), "k"), model: "m", dir: project(), prompt: "Look" })
      assert.equal(fake.requests[0].include, undefined)
      assert.ok(!fake.requests[1].input.some((i: any) => i.type === "reasoning"))
    } finally {
      await fake.close()
    }
  })

  test("providers hear who is calling and which conversation it is", async () => {
    const fake = await serve("anthropic", [{ text: "ok" }])
    try {
      await run({ provider: connect(model("anthropic", fake.url), "k"), model: "m", dir: project(), prompt: "Look", session: "k3f9a2" })
      assert.match(String(fake.headers[0]["user-agent"]), /^ask\//)
      assert.equal(fake.headers[0]["x-opencode-session"], "k3f9a2")
    } finally {
      await fake.close()
    }
  })

  test("a schema reaches the provider as the answer's format", async () => {
    const schema = { type: "object", properties: { port: { type: "integer" } } }
    const fake = await serve("chat", [{ text: '{"port": 7341}' }])
    try {
      await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Port?", schema })
      assert.deepEqual(fake.requests[0].response_format, { type: "json_schema", json_schema: { name: "answer", schema } })
    } finally {
      await fake.close()
    }
  })

  test("a call to a missing tool, or with arguments that aren't JSON, goes back to the model as an error", async () => {
    const fake = await serve("chat", [{ calls: [{ name: "delete_everything", args: {} }] }, { text: "ok" }])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Go" })
      assert.equal(r.answer, "ok")
      assert.match(fake.requests[1].messages.at(-1).content, /^error: no tool named delete_everything; the tools are read, list, grep$/)
    } finally {
      await fake.close()
    }
    const bad = await run({
      provider: { complete: async () => ({ message: { role: "assistant", text: "", calls: [{ id: "c", name: "read", arguments: "{not json" }] }, usage: { input: 0, output: 0, cached: 0 } }) },
      model: "m",
      dir: project(),
      prompt: "Go",
      maxSteps: 1,
    })
    assert.equal((bad.messages.at(-1) as { output: string }).output, "error: arguments must be a JSON object")
  })

  test("a reply cut off at the output limit is a failure, not an answer", async () => {
    const r = await run({
      provider: { complete: async () => ({ message: { role: "assistant", text: "The port is 73", calls: [] }, usage: { input: 0, output: 0, cached: 0 }, incomplete: "max_output_tokens" }) },
      model: "m",
      dir: project(),
      prompt: "Port?",
    })
    assert.equal(r.answer, undefined)
    assert.equal(r.error!.message, "the model stopped early (max_output_tokens)")
  })

  test("a call cut off by a stopped worker reaches the resumed model as interrupted", () => {
    const out = interrupted([
      { role: "user", text: "Deploy" },
      { role: "assistant", text: "", calls: [{ id: "c1", name: "shell", arguments: '{"command":"git push"}' }] },
    ])
    assert.equal(out.length, 3)
    assert.match((out[2] as { output: string }).output, /^error: this call was interrupted.*check whether it took effect/)
  })

  test("a failure says what to do next", async () => {
    const fake = await serve("chat", [{ status: 401, error: "Invalid credential" }])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Go" })
      assert.equal(r.answer, undefined)
      assert.match(r.error!.message, /rejected the credential: Invalid credential/)
      assert.match(r.error!.hint!, /ask doctor/)
    } finally {
      await fake.close()
    }
  })
})
