import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { connect, type Model } from "../../src/providers/catalog.ts"
import { interrupted, run, toolset, type Checkpoint } from "../../src/agent/loop.ts"
import type { Message, Protocol } from "../../src/providers/stream.ts"
import { responses } from "../../src/providers/responses.ts"
import { serve } from "../fake.ts"

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

  test("an extension's tool runs in the loop, and a read-only task gets only read-only ones", async () => {
    const tool = (name: string, readonly: boolean) => ({ name, description: name, parameters: { type: "object", properties: {} }, readonly, run: async () => `${name} ran` })
    const fake = await serve("chat", [{ calls: [{ name: "weather", args: {} }] }, { text: "Sunny." }])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Weather?", extra: [tool("weather", true), tool("deploy", false)] })
      assert.equal(r.answer, "Sunny.")
      const offered = fake.requests[0].tools.map((t: any) => t.function.name)
      assert.ok(offered.includes("weather") && !offered.includes("deploy"))
      assert.match(JSON.stringify(fake.requests[1]), /weather ran/)
    } finally {
      await fake.close()
    }
  })

  test("search is offered, even read-only, only when there is an engine to search with", async () => {
    const fake = await serve("chat", [{ calls: [{ name: "search", args: { query: "bun release" } }] }, { text: "Done." }, { text: "Done." }])
    try {
      const engine = async (q: string) => [{ title: `found ${q}`, url: "https://example.com/", snippet: "" }]
      await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Look it up", search: engine })
      assert.ok(fake.requests[0].tools.some((t: any) => t.function.name === "search"))
      assert.match(JSON.stringify(fake.requests[1]), /found bun release/)
      await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Again" })
      assert.ok(!fake.requests[2].tools.some((t: any) => t.function.name === "search"))
    } finally {
      await fake.close()
    }
  })

  test("an added tool replaces the built-in of its name, a read-only task only takes read-only ones, and off leaves tools out", () => {
    const tool = (name: string, readonly: boolean) => ({ name, description: "mine", parameters: {}, readonly, run: async () => "mine" })
    const write = toolset({ write: true, search: async () => [], extra: [tool("search", true), tool("shell", false)], off: ["edit"] })
    assert.equal(write.find((t) => t.name === "search")?.description, "mine")
    assert.equal(write.find((t) => t.name === "shell")?.description, "mine")
    assert.ok(!write.some((t) => t.name === "edit"))
    const read = toolset({ write: false, extra: [tool("read", false)] })
    assert.notEqual(read.find((t) => t.name === "read")?.description, "mine")
  })

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

  for (const protocol of ["responses", "chat", "anthropic"] as const) test(`${protocol}: overflow is summarized without changing the transcript or latest tool exchange`, async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "x".repeat(5000))
    const fake = await serve(protocol, [
      { calls: [{ name: "read", args: { path: "big.txt" } }] },
      { text: "", calls: [{ name: "list", args: {} }] },
      { status: 400, error: "This model's maximum context length is 1000 tokens" },
      { text: "Goal: Go. The file contained x's." },
      { text: "done" },
    ])
    try {
      const r = await run({ provider: connect(model(protocol, fake.url), "k"), model: "m", dir, prompt: "Go" })
      assert.equal(r.answer, "done")
      assert.match(JSON.stringify(fake.requests[3]), /xxxxx/)
      assert.match(JSON.stringify(fake.requests[4]), /conversation-checkpoint/)
      assert.match(JSON.stringify(fake.requests[4]), /Goal: Go/)
      assert.match(JSON.stringify(fake.requests[4]), /list/)
      assert.doesNotMatch(JSON.stringify(fake.requests[4]), /xxxxx/)
      assert.match(JSON.stringify(r.messages), /xxxxx/)
      assert.doesNotMatch(JSON.stringify(r.messages), /output elided/)
      assert.equal(r.usage.input, 400)
    } finally {
      await fake.close()
    }
  })

  test("a checkpoint request that overflows retries without long older tool outputs", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "x".repeat(5000))
    const overflow = { status: 400, error: "This model's maximum context length is 1000 tokens" }
    const fake = await serve("chat", [
      { calls: [{ name: "read", args: { path: "big.txt" } }] },
      { calls: [{ name: "list", args: {} }] },
      overflow, overflow, overflow,
      { text: "Goal: Go; reread big.txt if needed." },
      { text: "done" },
    ])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir, prompt: "Go" })
      assert.equal(r.answer, "done")
      assert.match(JSON.stringify(fake.requests[4]), /output elided/)
      assert.match(JSON.stringify(fake.requests[4]), /xxxxx/)
      assert.doesNotMatch(JSON.stringify(fake.requests[5]), /xxxxx/)
      assert.match(JSON.stringify(r.messages), /xxxxx/)
    } finally {
      await fake.close()
    }
  })

  test("a failed compaction leaves the original conversation recoverable", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "x".repeat(5000))
    const fake = await serve("chat", [
      { calls: [{ name: "read", args: { path: "big.txt" } }] },
      { calls: [{ name: "list", args: {} }] },
      { status: 400, error: "This model's maximum context length is 1000 tokens" },
      { text: "" },
    ])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir, prompt: "Go" })
      assert.match(r.error?.message ?? "", /compaction failed/)
      assert.match(JSON.stringify(r.messages), /xxxxx/)
    } finally {
      await fake.close()
    }
  })

  test("a checkpoint is reused on a later turn only when its transcript prefix matches", async () => {
    const dir = project()
    writeFileSync(join(dir, "big.txt"), "x".repeat(5000))
    const fake = await serve("chat", [
      { calls: [{ name: "read", args: { path: "big.txt" } }] },
      { calls: [{ name: "list", args: {} }] },
      { status: 400, error: "This model's maximum context length is 1000 tokens" },
      { text: "Goal: Go." }, { text: "done" }, { text: "continued" }, { text: "again" },
    ])
    try {
      let saved: Checkpoint | undefined
      const provider = connect(model("chat", fake.url), "k")
      const first = await run({ provider, model: "m", dir, prompt: "Go", onCheckpoint: (c) => { saved = c } })
      assert.ok(saved)
      await run({ provider, model: "m", dir, messages: first.messages, prompt: "Continue", checkpoint: saved })
      assert.match(JSON.stringify(fake.requests[5]), /conversation-checkpoint/)
      assert.doesNotMatch(JSON.stringify(fake.requests[5]), /xxxxx/)
      const changed: Message[] = [{ role: "user", text: "Different task" }, ...first.messages.slice(1)]
      await run({ provider, model: "m", dir, messages: changed, prompt: "Continue", checkpoint: saved })
      assert.doesNotMatch(JSON.stringify(fake.requests[6]), /conversation-checkpoint/)
      assert.match(JSON.stringify(fake.requests[6]), /xxxxx/)
    } finally {
      await fake.close()
    }
  })

  test("a known context limit triggers compaction before an overflow", async () => {
    const fake = await serve("chat", [{ text: "Goal: investigate." }, { text: "done" }])
    const messages: Message[] = [
      { role: "user", text: "investigate " + "x".repeat(5000) },
      { role: "assistant", text: "working", calls: [] },
      { role: "user", text: "continue" },
      { role: "assistant", text: "checking", calls: [] },
    ]
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), messages, contextLimit: 1000 })
      assert.equal(r.answer, "done")
      assert.match(JSON.stringify(fake.requests[0]), /concise handoff/)
      assert.match(JSON.stringify(fake.requests[1]), /conversation-checkpoint/)
    } finally {
      await fake.close()
    }
  })

  test("a resumed turn adds new usage to the usage already recorded", async () => {
    const fake = await serve("chat", [{ text: "done" }])
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Go", initialUsage: { input: 300, output: 20, cached: 10 } })
      assert.deepEqual(r.usage, { input: 400, output: 30, cached: 10 })
    } finally {
      await fake.close()
    }
  })

  test("failed proactive compaction still attempts the original request", async () => {
    const fake = await serve("chat", [{ text: "x".repeat(8000) }, { text: "done" }])
    const messages: Message[] = [
      { role: "user", text: "x".repeat(5000) },
      { role: "assistant", text: "working", calls: [] },
      { role: "user", text: "continue" },
      { role: "assistant", text: "checking", calls: [] },
    ]
    try {
      const r = await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), messages, contextLimit: 1000 })
      assert.equal(r.answer, "done")
      assert.doesNotMatch(JSON.stringify(fake.requests[1]), /conversation-checkpoint/)
    } finally {
      await fake.close()
    }
  })

  test("an older result with the same id does not hide an interrupted call", () => {
    const call = { id: "reused", name: "shell", arguments: "{}" }
    const messages: Message[] = [
      { role: "assistant", text: "", calls: [call] },
      { role: "tool", id: "reused", name: "shell", output: "old result" },
      { role: "user", text: "next" },
      { role: "assistant", text: "", calls: [call] },
    ]
    assert.match(JSON.stringify(interrupted(messages).at(-1)), /interrupted before it finished/)
  })

  test("a read-only task is offered no way to write or run commands", async () => {
    const fake = await serve("chat", [{ text: "ok" }])
    try {
      await run({ provider: connect(model("chat", fake.url), "k"), model: "m", dir: project(), prompt: "Look" })
      assert.deepEqual(fake.requests[0].tools.map((t: any) => t.function.name), ["read", "list", "grep", "git", "fetch"])
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
      assert.match(fake.requests[1].messages.at(-1).content, /^error: no tool named delete_everything; the tools are read, list, grep, git, fetch$/)
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
