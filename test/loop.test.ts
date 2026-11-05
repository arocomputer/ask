import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { connect, type Model } from "../src/catalog.ts"
import { run } from "../src/loop.ts"
import type { Protocol } from "../src/provider.ts"
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
