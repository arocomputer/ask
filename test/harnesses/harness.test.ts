import assert from "node:assert/strict"
import { execFile, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join, relative } from "node:path"
import { describe, test } from "node:test"
import { invocation } from "../../src/harnesses/claude.ts"
import { toolchains } from "../../src/harnesses/codex.ts"
import { before, tidy } from "../../src/harnesses/harness.ts"

const cli = join(import.meta.dirname, "..", "..", "src", "cli.ts")

/**
 * A stand-in for Claude Code: it records how it was started, then plays a stream like the real
 * one's. FAKE_MODE picks the run: ok (a read, then the answer), signedout, or slow.
 */
const fakeClaude = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0) }
if (args[0] === "--help") { console.log("--restricted --permission-prompts"); process.exit(0) }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_MODE !== "signedout", authMethod: "claude.ai" })); process.exit(0) }
let input = ""
process.stdin.on("data", (d) => (input += d))
process.stdin.on("end", async () => {
  const keep = ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "GIT_OPTIONAL_LOCKS", "ANTHROPIC_API_KEY", "ASK_HOME", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "EXTRA"]
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ who: "claude", args, input, pid: process.pid, env: Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) }) + "\\n")
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
  const session = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1]
  if (process.env.FAKE_MODE === "slow") await new Promise((ok) => setTimeout(ok, 60000))
  if (process.env.FAKE_MODE === "signedout") return say({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: session })
  const last = input.split("\\n").pop()
  say({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"] })
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: process.cwd() + "/a.txt" } }] } })
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "contents" }] } })
  say({ type: "assistant", message: { content: [{ type: "text", text: "Claude: " + last }] } })
  say({ type: "result", subtype: "success", is_error: false, result: "Claude: " + last, session_id: session, usage: { input_tokens: 10, output_tokens: 5 } })
})
`

/** A stand-in for Codex: records how it was started, then plays \`codex exec --json\` events. */
const fakeCodex = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log(process.env.FAKE_MODE === "old" ? "codex-cli 0.100.0" : "codex-cli 9.9.9"); process.exit(0) }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0) }
let input = ""
process.stdin.on("data", (d) => (input += d))
process.stdin.on("end", () => {
  const keep = ["CODEX_THREAD_ID", "CODEX_SANDBOX", "OPENAI_API_KEY"]
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ who: "codex", args, input, env: Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) }) + "\\n")
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
  require("node:fs").mkdirSync(".codex", { recursive: true })
  const thread = args[1] === "resume" ? args[2] : "thread-" + process.pid
  say({ type: "thread.started", thread_id: thread })
  say({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "/bin/zsh -lc \\"ls\\"", aggregated_output: "a.txt\\n", exit_code: 0 } })
  say({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Codex: " + input.split("\\n").pop() } })
  say({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } })
})
`

/** A home whose default model is claude/sonnet, with both harnesses on and the fakes first on PATH. */
function setup(mode = "ok", config: object = {}, extra: NodeJS.ProcessEnv = {}, sandbox = true) {
  const root = mkdtempSync(join(tmpdir(), "ask-harness-"))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const project = join(root, "project")
  for (const d of [join(home, "cache"), bin, project]) mkdirSync(d, { recursive: true })
  // Claude Code's sandbox needs these on Linux; ask only checks that they are there.
  const tools = sandbox ? [["bwrap", "#!/bin/sh\n"], ["socat", "#!/bin/sh\n"]] : []
  for (const [name, script] of [["claude", fakeClaude], ["codex", fakeCodex], ...tools]) {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(home, "cache", "models.json"), JSON.stringify({ fake: { id: "fake", name: "Fake", env: [], npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:9/v1", models: { m: { id: "m", name: "M" } } } }))
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "claude/sonnet", extensions: ["claude", "codex"], ...config }))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ fake: { api_key: "k" }, anthropic: { api_key: "sk-ant-secret" } }))
  const log = join(root, "runs.log")
  writeFileSync(log, "")
  // As if ask were called from inside a Claude Code session, with API keys in the environment.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASK_HOME: home,
    NO_COLOR: "1",
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_MODE: mode,
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "outer",
    ANTHROPIC_API_KEY: "sk-ant-env",
    OPENAI_API_KEY: "sk-env",
    ...extra,
  }
  delete env.ASK_PARENT
  const run = (args: string[], input = "") =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, [cli, ...args], { cwd: project, env }, (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }))
      child.stdin!.end(input)
    })
  const ask = async (request: object) => JSON.parse((await run([], JSON.stringify(request))).stdout)
  const runs = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const config_ = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
  return { root, home, project, ask, run, runs, config: config_ }
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe("claude", () => {
  test("a read-only claude/ task runs Claude Code restricted to reading its folder, without API keys or the caller's markers", async () => {
    const { ask, runs, home } = setup()
    const r = await ask({ start: [{ prompt: "Find it" }], wait: 30 })
    assert.equal(r.tasks[0].answer, "Claude: Find it")
    const [run] = runs()
    assert.deepEqual([after(run.args, "--model"), after(run.args, "--tools"), after(run.args, "--permission-mode")], ["sonnet", "Read,Grep,Glob,WebSearch", "dontAsk"])
    assert.deepEqual([after(run.args, "--settings"), after(run.args, "--permission-prompts"), after(run.args, "--mcp-config")], ['{"disableAllHooks":true}', "none", '{"mcpServers":{}}'])
    assert.ok(["--restricted", "--strict-mcp-config", "--disable-slash-commands"].every((f) => run.args.includes(f)) && !run.args.includes("--bare"))
    assert.match(after(run.args, "--session-id"), /^[0-9a-f-]{36}$/)
    assert.deepEqual(run.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", GIT_OPTIONAL_LOCKS: "0" })
    assert.deepEqual((await ask({ show: r.tasks[0].id })).tasks[0].steps, ["read a.txt"])
    assert.equal(JSON.parse(readFileSync(join(home, "sessions", r.tasks[0].id, "session.json"), "utf8")).parent, "claude:outer")
  })

  test("a write task gets Claude Code's edit tools and Bash, confined to its folder, never bypassing permissions", async () => {
    const { ask, runs } = setup()
    await ask({ start: [{ prompt: "Fix it", write: true }], wait: 30 })
    const [run] = runs()
    assert.deepEqual([after(run.args, "--tools"), after(run.args, "--allowedTools"), after(run.args, "--permission-mode")], ["Read,Grep,Glob,WebSearch,Edit,Write,Bash", "Bash,WebSearch", "acceptEdits"])
    assert.ok(run.args.includes("--restricted"))
  })

  test("a write task where Claude Code's sandbox can't run is refused", { skip: (process.platform !== "linux" || !!spawnSync("sh", ["-c", "command -v socat"]).stdout?.toString().trim()) && "socat is installed here" }, async () => {
    const { ask, runs } = setup("ok", {}, {}, false)
    const r = await ask({ start: [{ prompt: "Fix it", write: true }], wait: 30 })
    assert.match(r.tasks[0].error.hint, /bubblewrap and socat/)
    assert.equal(runs().length, 0)
  })

  test("where the sandbox can run, a write task's commands must run in it, with the home folder unreadable", () => {
    const r = { model: "sonnet", dir: "/p", write: true, messages: [], settings: {}, onSession() {}, onUpdate() {} }
    const on = JSON.parse(after(invocation(r, "s", false, true).args, "--settings"))
    assert.deepEqual(on.sandbox, { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false })
    assert.deepEqual(on.permissions, { blockReadsOutsideWorkingDirectories: true })
    assert.equal(JSON.parse(after(invocation(r, "s", false, false).args, "--settings")).sandbox, undefined)
  })

  test("a later turn resumes the same Claude session", async () => {
    const { ask, runs } = setup()
    const first = await ask({ start: [{ prompt: "One" }], wait: 30 })
    const second = await ask({ continue: first.tasks[0].id, prompt: "Two", wait: 30 })
    assert.equal(second.tasks[0].answer, "Claude: Two")
    const [a, b] = runs()
    assert.equal(after(b.args, "--resume"), after(a.args, "--session-id"))
    assert.equal(b.input, "Two")
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

  test("config.json's harness entry adds arguments after ask's, and environment", async () => {
    const { ask, runs } = setup("ok", { harnesses: { claude: { args: ["--model", "opus"], env: { EXTRA: "yes" } } } })
    await ask({ start: [{ prompt: "Hi" }], wait: 30 })
    const [run] = runs()
    assert.deepEqual(run.args.slice(-2), ["--model", "opus"])
    assert.equal(run.env.EXTRA, "yes")
  })

  test("a harness takes model names the catalog doesn't list, but never one that looks like a flag", async () => {
    const { ask, runs } = setup()
    assert.equal((await ask({ start: [{ prompt: "Hi", model: "claude/claude-next-9" }], wait: 30 })).tasks[0].state, "succeeded")
    assert.equal(after(runs()[0].args, "--model"), "claude-next-9")
    assert.match((await ask({ start: [{ prompt: "Hi", model: "claude/--bare" }] })).error.message, /isn't a model name/)
  })

  test("a harness that isn't installed says how to install it", async () => {
    const { ask } = setup("ok", { extensions: [] })
    const r = await ask({ start: [{ prompt: "Hi" }] })
    assert.match(r.error.message, /run ask install claude$/)
  })
})

describe("codex", () => {
  test("a read-only codex/ task runs Codex under ask's read-only profile, without the user's config, API keys or leftovers", async () => {
    const { ask, runs, project } = setup("ok", { model: "codex/default" })
    const r = await ask({ start: [{ prompt: "Look" }], wait: 30 })
    assert.equal(r.tasks[0].answer, "Codex: Look")
    const [run] = runs()
    assert.deepEqual(run.args.slice(0, 1), ["exec"])
    assert.ok(run.args.includes('default_permissions="ask"') && !run.args.includes("-s"))
    const fs = run.args.find((a: string) => a.startsWith("permissions.ask.filesystem="))
    assert.match(fs, /":minimal" = "read"/)
    assert.match(fs, /":workspace_roots" = \{"\." = "read", "\*\*\/\.env" = "deny", "\*\*\/\.env\.\[!e\]\*" = "deny"\}/)
    assert.doesNotMatch(fs, /"write"/)
    assert.ok(run.args.includes("--ignore-user-config") && run.args.includes("--ignore-rules") && !run.args.includes("-m"))
    assert.equal(run.args.at(-1), "-")
    assert.deepEqual(run.env, {})
    assert.ok(!existsSync(join(project, ".codex")))
    assert.deepEqual((await ask({ show: r.tasks[0].id })).tasks[0].steps, ["shell ls"])
  })

  test("Codex older than the profiles ask relies on doesn't run", async () => {
    const { ask, runs } = setup("old", { model: "codex/default" })
    const r = await ask({ start: [{ prompt: "Look" }], wait: 30 })
    assert.match(r.tasks[0].error.hint, /or newer; update it$/)
    assert.equal(runs().length, 0)
  })

  test("commands may read the toolchains on PATH, never the home folder or what holds it", () => {
    const t = toolchains("/nonexistent", ["/usr/bin", homedir(), "/"].join(delimiter))
    assert.ok(t.includes(realpathSync("/usr/bin")))
    assert.ok(!t.includes(homedir()) && !t.includes("/") && !t.some((d) => !relative(d, homedir()).startsWith("..")))
  })

  test("a write task may write its folder, and a later turn resumes the thread under its own rules", async () => {
    const { ask, runs } = setup("ok", { model: "codex/gpt-5.5" })
    const first = await ask({ start: [{ prompt: "One", write: true }], wait: 30 })
    await ask({ continue: first.tasks[0].id, prompt: "Two", wait: 30 })
    const [a, b] = runs()
    const fs = (run: any) => run.args.find((x: string) => x.startsWith("permissions.ask.filesystem="))
    assert.equal(after(a.args, "-m"), "gpt-5.5")
    assert.match(fs(a), /":workspace_roots" = \{"\." = "write",/)
    assert.match(fs(a), /":tmpdir" = "write"/)
    assert.deepEqual(b.args.slice(0, 2), ["exec", "resume"])
    assert.match(b.args[2], /^thread-\d+$/)
    assert.match(fs(b), /":workspace_roots" = \{"\." = "read",/)
  })
})

describe("sandbox leftovers", () => {
  test("only new, empty decoys are removed; what was there and what the task wrote stay", () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-tidy-"))
    writeFileSync(join(dir, ".env"), "")
    const earlier = before(dir)
    writeFileSync(join(dir, ".env.local"), "")
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true })
    writeFileSync(join(dir, "package.json"), "{}")
    writeFileSync(join(dir, "notes.txt"), "")
    tidy(dir, earlier)
    assert.deepEqual(readdirSync(dir).sort(), [".env", "notes.txt", "package.json"])
  })
})

describe("handoff", () => {
  test("a session moves between harnesses, each new one getting the conversation so far", async () => {
    const { ask, runs } = setup()
    const first = await ask({ start: [{ prompt: "One" }], wait: 30 })
    const id = first.tasks[0].id
    assert.equal((await ask({ continue: id, prompt: "Two", model: "codex/default", wait: 30 })).tasks[0].answer, "Codex: Two")
    assert.equal((await ask({ continue: id, prompt: "Three", model: "claude/sonnet", wait: 30 })).tasks[0].answer, "Claude: Three")
    await ask({ continue: id, prompt: "Four", wait: 30 })
    const [a, b, c, d] = runs()
    assert.equal(b.who, "codex")
    assert.ok(!b.args.includes("resume"))
    assert.match(b.input, /User: One[\s\S]*Assistant: Claude: One[\s\S]*<\/conversation>\n\nTwo$/)
    assert.ok(c.args.includes("--session-id") && after(c.args, "--session-id") !== after(a.args, "--session-id"))
    assert.match(c.input, /User: Two[\s\S]*Assistant used shell[\s\S]*Codex: Two[\s\S]*\n\nThree$/)
    assert.equal(after(d.args, "--resume"), after(c.args, "--session-id"))
    assert.equal(d.input, "Four")
  })
})

describe("install", () => {
  test("installing a harness turns it on and writes its settings; removing undoes both", async () => {
    const { run, config } = setup("ok", { extensions: [], models: ["codex/default", "fake/m"] })
    assert.equal((await run(["install", "codex"])).code, 0)
    assert.deepEqual([config().extensions, config().harnesses], [["codex"], { codex: { command: "codex", args: [], env: {} } }])
    assert.equal((await run(["remove", "codex"])).code, 0)
    assert.deepEqual([config().extensions, config().harnesses, config().models], [undefined, undefined, ["fake/m"]])
  })

  test("an extension turned off in config.json never runs", async () => {
    const { root, home, run, config } = setup()
    const src = join(root, "noisy")
    mkdirSync(src)
    writeFileSync(join(src, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(join(src, "index.js"), `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(join(root, "ran"))}, "")\nexport default { name: "noisy", tools: [] }`)
    assert.equal((await run(["install", src])).code, 0)
    rmSync(join(root, "ran"))
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...config(), extensions: ["claude"] }))
    assert.match((await run(["install"])).stdout, /noisy\s+Extension\s+turned off/)
    assert.ok(!existsSync(join(root, "ran")))
  })

  test("remove refuses a name that isn't one", async () => {
    const { root, run } = setup()
    mkdirSync(join(root, "keep"))
    assert.equal((await run(["remove", "../../keep"])).code, 1)
    assert.ok(existsSync(join(root, "keep")))
  })

  test("the skill replaces an agent's own file only for as long as it is installed, and only for agents that are here", async () => {
    const user = mkdtempSync(join(tmpdir(), "ask-user-"))
    const file = join(user, ".claude", "skills", "ask", "SKILL.md")
    mkdirSync(join(user, ".claude", "skills", "ask"), { recursive: true })
    writeFileSync(file, "mine")
    const { run } = setup("ok", {}, { HOME: user })
    assert.equal((await run(["install", "skill"])).code, 0)
    assert.match(readFileSync(file, "utf8"), /^---\nname: ask/)
    assert.equal(readFileSync(`${file}.bak`, "utf8"), "mine")
    assert.ok(!existsSync(join(user, ".codex")))
    assert.equal((await run(["remove", "skill"])).code, 0)
    assert.equal(readFileSync(file, "utf8"), "mine")
    assert.ok(!existsSync(`${file}.bak`))
  })

  test("an extension is copied in only when installed, runs as a harness, and leaves no folder once removed", async () => {
    const { root, home, run, ask } = setup()
    assert.ok(!existsSync(join(home, "extensions")))
    const src = join(root, "echo")
    mkdirSync(src)
    writeFileSync(join(src, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(
      join(src, "index.js"),
      `export default { name: "echo", harness: { name: "echo", title: "Echo", models: () => [{ id: "one", name: "One" }], status: () => ({ ready: true, detail: "ready" }),
        async run(r) { r.onSession("e1"); return { answer: "echo: " + r.prompt, messages: [...r.messages, { role: "user", text: r.prompt }], usage: { input: 0, output: 0, cached: 0 }, steps: 0 } } } }`,
    )
    assert.equal((await run(["install", src])).code, 0)
    assert.ok(existsSync(join(home, "extensions", "echo", "index.js")))
    assert.equal((await ask({ start: [{ prompt: "hi", model: "echo/one" }], wait: 30 })).tasks[0].answer, "echo: hi")
    assert.equal((await run(["remove", "echo"])).code, 0)
    assert.ok(!existsSync(join(home, "extensions")))
  })
})
