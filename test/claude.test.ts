import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { describe, test } from "node:test"

const cli = join(import.meta.dirname, "..", "src", "cli.ts")

/**
 * A stand-in for Claude Code: it records how it was started, then plays a stream like the real
 * one's. FAKE_CLAUDE_MODE picks the run: ok (a read, then the answer), signedout, or slow.
 */
const fakeClaude = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0) }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_MODE !== "signedout", authMethod: "claude.ai" })); process.exit(0) }
let input = ""
process.stdin.on("data", (d) => (input += d))
process.stdin.on("end", async () => {
  const keep = ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "GIT_OPTIONAL_LOCKS", "ANTHROPIC_API_KEY"]
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, input, pid: process.pid, env: Object.fromEntries(keep.map((k) => [k, process.env[k]])) }) + "\\n")
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
  const session = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1]
  if (process.env.FAKE_CLAUDE_MODE === "slow") await new Promise((ok) => setTimeout(ok, 60000))
  if (process.env.FAKE_CLAUDE_MODE === "signedout") return say({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: session })
  say({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"] })
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: process.cwd() + "/a.txt" } }] } })
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "contents" }] } })
  say({ type: "assistant", message: { content: [{ type: "text", text: "Done: " + input }] } })
  say({ type: "result", subtype: "success", is_error: false, result: "Done: " + input, session_id: session, usage: { input_tokens: 10, output_tokens: 5 } })
})
`

/** A home whose default model is claude/sonnet, with the fake claude first on PATH. */
function setup(mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "ask-claude-"))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const project = join(root, "project")
  for (const d of [join(home, "cache"), bin, project]) mkdirSync(d, { recursive: true })
  writeFileSync(join(bin, "claude"), fakeClaude)
  chmodSync(join(bin, "claude"), 0o755)
  writeFileSync(join(home, "cache", "models.json"), JSON.stringify({ fake: { id: "fake", name: "Fake", env: [], npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:9/v1", models: { m: { id: "m", name: "M" } } } }))
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "claude/sonnet" }))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ fake: { api_key: "k" }, anthropic: { api_key: "sk-ant-secret" } }))
  const log = join(root, "claude.log")
  writeFileSync(log, "")
  const env: NodeJS.ProcessEnv = { ...process.env, ASK_HOME: home, NO_COLOR: "1", PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode }
  delete env.ANTHROPIC_API_KEY
  const ask = (request: object) =>
    new Promise<any>((done) => {
      const child = execFile(process.execPath, [cli], { cwd: project, env }, (_, stdout) => done(JSON.parse(stdout)))
      child.stdin!.end(JSON.stringify(request))
    })
  const runs = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  return { ask, runs }
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe("claude", () => {
  test("a read-only claude/ task runs Claude Code kept to reading, and ask hands it no credential", async () => {
    const { ask, runs } = setup()
    const r = await ask({ start: [{ prompt: "Find it" }], wait: 30 })
    assert.equal(r.tasks[0].answer, "Done: Find it")
    const [run] = runs()
    assert.deepEqual([after(run.args, "--model"), after(run.args, "--tools"), after(run.args, "--permission-mode")], ["sonnet", "Read,Grep,Glob", "manual"])
    assert.deepEqual([after(run.args, "--settings"), after(run.args, "--setting-sources"), after(run.args, "--mcp-config")], ['{"disableAllHooks":true}', "user", '{"mcpServers":{}}'])
    assert.ok(run.args.includes("--strict-mcp-config") && run.args.includes("--disable-slash-commands") && !run.args.includes("--bare"))
    assert.match(after(run.args, "--session-id"), /^[0-9a-f-]{36}$/)
    assert.deepEqual(run.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", GIT_OPTIONAL_LOCKS: "0" })
    assert.deepEqual((await ask({ show: r.tasks[0].id })).tasks[0].steps, ["read a.txt"])
  })

  test("a write task runs Claude Code with its own tools and no permission prompts", async () => {
    const { ask, runs } = setup()
    await ask({ start: [{ prompt: "Fix it", write: true }], wait: 30 })
    const [run] = runs()
    assert.equal(after(run.args, "--permission-mode"), "bypassPermissions")
    assert.ok(!run.args.includes("--tools"))
  })

  test("a later turn resumes the same Claude session", async () => {
    const { ask, runs } = setup()
    const first = await ask({ start: [{ prompt: "One" }], wait: 30 })
    const second = await ask({ continue: first.tasks[0].id, prompt: "Two", wait: 30 })
    assert.equal(second.tasks[0].answer, "Done: Two")
    const [a, b] = runs()
    assert.equal(after(b.args, "--resume"), after(a.args, "--session-id"))
  })

  test("a session can't move between Claude Code and ask's own loop", async () => {
    const { ask } = setup()
    const first = await ask({ start: [{ prompt: "One" }], wait: 30 })
    const r = await ask({ continue: first.tasks[0].id, prompt: "Two", model: "fake/m" })
    assert.match(r.error.message, /runs in Claude Code, and its conversation can't move out of Claude Code$/)
  })

  test("Claude Code that isn't signed in fails with how to sign in", async () => {
    const { ask } = setup("signedout")
    const r = await ask({ start: [{ prompt: "Hi" }], wait: 30 })
    assert.equal(r.tasks[0].state, "failed")
    assert.equal(r.tasks[0].error.hint, "run claude, sign in with /login, then try again")
  })

  test("stopping a task stops Claude Code", async () => {
    const { ask, runs } = setup("slow")
    const { tasks } = await ask({ start: [{ prompt: "Slow" }] })
    while (!runs().length) await new Promise((ok) => setTimeout(ok, 50))
    assert.equal((await ask({ stop: [tasks[0].id] })).tasks[0].state, "stopped")
    await new Promise((ok) => setTimeout(ok, 300))
    assert.throws(() => process.kill(runs()[0].pid, 0))
  })
})
