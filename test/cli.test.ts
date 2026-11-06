import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { serve, type Fake, type Reply } from "./fake.ts"

const cli = join(import.meta.dirname, "..", "src", "cli.ts")
const fakes: Fake[] = []
after(() => Promise.all(fakes.map((f) => f.close())))

const defaultCatalog = (url: string) => ({ fake: { id: "fake", name: "Fake", env: ["FAKE_API_KEY"], npm: "@ai-sdk/openai-compatible", api: url, models: { m: { id: "m", name: "M" } } } })

/** A home with a one-model catalog served by a fake provider, a key, and a project folder. */
async function setup(replies: Reply[], catalog: unknown = defaultCatalog) {
  const fake = await serve("chat", replies)
  fakes.push(fake)
  const root = mkdtempSync(join(tmpdir(), "ask-cli-"))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, "cache"), { recursive: true })
  mkdirSync(project)
  writeFileSync(join(project, "port.txt"), "7341\n")
  const resolved = typeof catalog === "function" ? (catalog as (url: string) => unknown)(fake.url) : catalog
  writeFileSync(join(home, "cache", "models.json"), JSON.stringify(resolved))
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "fake/m" }))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ fake: { api_key: "k" } }))
  const run = (args: string[], input = "", env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, ASK_HOME: home, NO_COLOR: "1", ...env } }, (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      )
      child.stdin!.end(input)
    })
  /** Sends one JSON request and returns the parsed response. */
  const ask = async (request: object, env: NodeJS.ProcessEnv = {}) => JSON.parse((await run([], JSON.stringify(request), env)).stdout)
  return { fake, home, project, run, ask }
}

describe("cli", () => {
  test("disabled built-in confinement survives restart after config changes", async () => {
    const { ask, home, run } = await setup([{ text: "Done.", delay: 1_000 }])
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: "fake/m", sandbox: false }))
    assert.match((await run(["doctor"])).stdout, /disabled in config.json/)
    const { tasks } = await ask({ start: [{ prompt: "Task" }] })
    const path = join(home, "sessions", tasks[0].id, "session.json")
    assert.equal(JSON.parse(readFileSync(path, "utf8")).turns[0].sandbox, false)
    const { pid } = JSON.parse(readFileSync(join(home, "sessions", tasks[0].id, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: "fake/m", sandbox: true }))
    const done = await ask({ collect: [tasks[0].id], wait: 30 })
    assert.equal(done.tasks[0].state, "succeeded")
    assert.equal(JSON.parse(readFileSync(path, "utf8")).turns[0].sandbox, false)
  })

  test("a started task is collected with its answer", async () => {
    const { ask } = await setup([{ calls: [{ name: "read", args: { path: "port.txt" } }] }, { text: "Port 7341." }])
    const started = await ask({ start: [{ prompt: "Which port?" }] })
    assert.equal(started.tasks[0].state, "running")
    const done = await ask({ collect: [started.tasks[0].id] })
    assert.deepEqual(done.tasks, [{ id: started.tasks[0].id, state: "succeeded", answer: "Port 7341." }])
  })

  test("waiting returns once the first task finishes and reports the rest as running", async () => {
    const { ask } = await setup([
      { when: "fast", text: "quick" },
      { when: "slow", text: "late", delay: 20_000 },
    ])
    const r = await ask({ start: [{ prompt: "slow one" }, { prompt: "fast one" }], wait: 30 })
    assert.deepEqual(r.tasks.map((t: any) => t.state), ["running", "succeeded"])
    assert.equal(r.tasks[1].answer, "quick")
  })

  test("stop ends a running task as stopped", async () => {
    const { ask } = await setup([{ text: "late", delay: 20_000 }])
    const { tasks } = await ask({ start: [{ prompt: "Slow task" }] })
    await new Promise((ok) => setTimeout(ok, 500))
    assert.equal((await ask({ stop: [tasks[0].id] })).tasks[0].state, "stopped")
  })

  test("collect resumes a task whose worker was killed", async () => {
    const { ask, home } = await setup([{ text: "Done.", delay: 1_000 }])
    const { tasks } = await ask({ start: [{ prompt: "Task" }] })
    const { pid } = JSON.parse(readFileSync(join(home, "sessions", tasks[0].id, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    assert.equal((await ask({ show: tasks[0].id })).tasks[0].state, "failed")
    const r = await ask({ collect: [tasks[0].id], wait: 30 })
    assert.deepEqual(r.tasks[0], { id: tasks[0].id, state: "succeeded", answer: "Done.", resumed: 1 })
  })

  test("a restarted worker preserves the turn's previously recorded usage", { timeout: 15_000 }, async () => {
    const { ask, home, fake } = await setup([
      { calls: [{ name: "read", args: { path: "port.txt" } }] },
      { text: "late", delay: 3_000 },
      { text: "done" },
    ])
    const { tasks } = await ask({ start: [{ prompt: "Task" }] })
    while (fake.requests.length < 2) await new Promise((ok) => setTimeout(ok, 20))
    const folder = join(home, "sessions", tasks[0].id)
    const { pid } = JSON.parse(readFileSync(join(folder, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    const result = await ask({ collect: [tasks[0].id], wait: 10 })
    assert.equal(result.tasks[0].state, "succeeded")
    const session = JSON.parse(readFileSync(join(folder, "session.json"), "utf8"))
    assert.deepEqual(session.turns[0].usage, { input: 200, output: 20, cached: 0 })
  })

  test("two collects that find the same lost turn restart it once", async () => {
    const { ask, home, fake } = await setup([{ text: "Done.", delay: 1_000 }])
    const { tasks } = await ask({ start: [{ prompt: "Task" }] })
    while (!fake.requests.length) await new Promise((ok) => setTimeout(ok, 20))
    const { pid } = JSON.parse(readFileSync(join(home, "sessions", tasks[0].id, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    const [a, b] = await Promise.all([ask({ collect: [tasks[0].id], wait: 30 }), ask({ collect: [tasks[0].id], wait: 30 })])
    assert.deepEqual([a.tasks[0], b.tasks[0]].map((t: any) => t.resumed), [1, 1], JSON.stringify([a, b]))
    assert.equal(fake.requests.length, 2)
  })

  test("once a task has been restarted, collect waits for all of them", async () => {
    const { ask, home, fake } = await setup([
      { when: "fast", text: "quick" },
      { when: "slow", text: "late", delay: 1_500 },
    ])
    const { tasks } = await ask({ start: [{ prompt: "fast" }, { prompt: "slow" }] })
    while (fake.requests.length < 2) await new Promise((ok) => setTimeout(ok, 20))
    const { pid } = JSON.parse(readFileSync(join(home, "sessions", tasks[1].id, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    const r = await ask({ collect: tasks.map((t: any) => t.id), wait: 30 })
    assert.deepEqual(r.tasks.map((t: any) => t.state), ["succeeded", "succeeded"])
  })

  test("a response says to wait longer while restarted tasks are still running", async () => {
    const { ask, home, fake } = await setup([{ text: "late", delay: 3_000 }])
    const { tasks } = await ask({ start: [{ prompt: "slow" }] })
    while (!fake.requests.length) await new Promise((ok) => setTimeout(ok, 20))
    process.kill(JSON.parse(readFileSync(join(home, "sessions", tasks[0].id, "lock"), "utf8")).pid, "SIGKILL")
    const r = await ask({ collect: [tasks[0].id], wait: 1 })
    assert.equal(r.tasks[0].state, "running")
    assert.match(r.hint, /only make progress while you wait/)
  })

  test("continue without a prompt resumes a stopped turn", async () => {
    const { ask, fake } = await setup([{ when: "Task", text: "Done.", delay: 3_000 }])
    const { tasks } = await ask({ start: [{ prompt: "Task" }] })
    await new Promise((ok) => setTimeout(ok, 300))
    await ask({ stop: [tasks[0].id] })
    const r = await ask({ continue: tasks[0].id, wait: 30 })
    assert.equal(r.tasks[0].answer, "Done.")
    assert.deepEqual(fake.requests.at(-1).messages.slice(1).map((m: any) => m.content), ["Task"])
  })

  test("continue carries the conversation into the next turn", async () => {
    const { ask, fake } = await setup([{ text: "First answer." }, { text: "Second answer." }])
    const first = await ask({ start: [{ prompt: "First question" }], wait: 30 })
    const second = await ask({ continue: first.tasks[0].id, prompt: "Second question", wait: 30 })
    assert.equal(second.tasks[0].answer, "Second answer.")
    assert.deepEqual(fake.requests[1].messages.slice(1).map((m: any) => m.content), ["First question", "First answer.", "Second question"])
  })

  test("a write task lists the files it changed", async () => {
    const { ask, project } = await setup([{ calls: [{ name: "write", args: { path: "new.txt", content: "hi" } }] }, { text: "Done." }])
    execFileSync("git", ["init", "-q"], { cwd: project })
    const r = await ask({ start: [{ prompt: "Add a file", write: true }], wait: 30 })
    assert.deepEqual(r.tasks[0].changes, [{ path: "new.txt", change: "added" }])
  })

  test("looking around creates nothing in the home folder", async () => {
    const { run, home } = await setup([{ text: "unused" }])
    rmSync(home, { recursive: true })
    for (const args of [["help"], ["help", "requests"], ["sessions"], ["show", "--help"], ["--version"]]) await run(args)
    assert.throws(() => readdirSync(home))
  })

  test("a task without a key for its provider fails before it starts", async () => {
    const { ask, home } = await setup([{ text: "unused" }])
    writeFileSync(join(home, "auth.json"), "{}")
    const r = await ask({ start: [{ prompt: "Task" }] })
    assert.equal(r.error.message, "no key for fake; add one with ask settings, or set FAKE_API_KEY")
  })

  test("a task past its timeout fails as timed out", async () => {
    const { ask } = await setup([{ text: "late", delay: 10_000 }])
    const r = await ask({ start: [{ prompt: "Slow", timeout: 1 }], wait: 20 })
    assert.equal(r.tasks[0].state, "failed")
    assert.equal(r.tasks[0].error.message, "timed out after 1 seconds")
  })

  test("dir sets where a task works", async () => {
    const { ask, fake, project } = await setup([{ calls: [{ name: "read", args: { path: "other.txt" } }] }, { text: "ok" }])
    mkdirSync(join(project, "elsewhere"))
    writeFileSync(join(project, "elsewhere", "other.txt"), "found it\n")
    await ask({ start: [{ prompt: "Read it", dir: join(project, "elsewhere") }], wait: 30 })
    assert.match(JSON.stringify(fake.requests[1]), /1\\tfound it/)
  })

  test("piped, sessions prints one tab-separated line per session with an exact time", async () => {
    const { ask, run } = await setup([{ text: "ok" }])
    const { tasks } = await ask({ start: [{ prompt: "First line\nsecond line" }], wait: 30 })
    const [line] = (await run(["sessions"])).stdout.trim().split("\n")
    const [state, task, id, started] = line.split("\t")
    assert.deepEqual([state, task, id], ["succeeded", "First line", tasks[0].id])
    assert.ok(!Number.isNaN(Date.parse(started)))
  })

  test("the sessions request lists the calling conversation's own sessions, or everyone's", async () => {
    const { ask } = await setup([{ text: "ok" }])
    const mine = await ask({ start: [{ prompt: "Mine\nmore" }], wait: 30 }, { ASK_PARENT: "agent:a" })
    await ask({ start: [{ prompt: "Theirs" }], wait: 30 }, { ASK_PARENT: "agent:b" })
    const own = await ask({ sessions: {} }, { ASK_PARENT: "agent:a" })
    assert.deepEqual(own.tasks.map((t: any) => [t.id, t.task]), [[mine.tasks[0].id, "Mine"]])
    assert.equal((await ask({ sessions: { all: true } }, { ASK_PARENT: "agent:a" })).tasks.length, 2)
  })

  test("a word ask doesn't know is an error, never a prompt", async () => {
    const { run, home } = await setup([{ text: "unused" }])
    const r = await run(["settings-typo"])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /^unknown command "settings-typo" for "ask"/)
    assert.throws(() => readdirSync(join(home, "sessions")))
  })

  test("one bad task in a start request starts none of them", async () => {
    const { ask, home } = await setup([{ text: "unused" }])
    const r = await ask({ start: [{ prompt: "fine" }, { prompt: "bad", dir: "/no/such/dir" }] })
    assert.match(r.error.message, /start\[1\]\.dir/)
    assert.throws(() => readdirSync(join(home, "sessions")))
  })

  test("the worker never runs a finished turn again", async () => {
    const { ask, run, home, fake } = await setup([{ text: "Done." }])
    const { tasks } = await ask({ start: [{ prompt: "Task" }], wait: 30 })
    const r = await run(["__worker", join(home, "sessions", tasks[0].id)])
    assert.equal(r.code, 2)
    assert.equal(fake.requests.length, 1)
  })

  test("doctor names what is broken and how to fix it", async () => {
    const { run, home } = await setup([{ text: "ok" }])
    writeFileSync(join(home, "config.json"), "{}")
    const r = await run(["doctor"])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /^X Model     no default model\n\s+ask settings$/m)
  })

  test("a worktree task works on its own branch and leaves the caller's files alone", async () => {
    const { ask, project } = await setup([{ calls: [{ name: "write", args: { path: "new.txt", content: "hi" } }] }, { text: "Done." }])
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "start"]])
      execFileSync("git", ["-C", project, ...args], { stdio: "ignore" })
    const r = await ask({ start: [{ prompt: "Add a file", worktree: true }], wait: 30 })
    const t = r.tasks[0]
    assert.equal(t.worktree.branch, "ask/add-file")
    assert.deepEqual(t.changes, [{ path: "new.txt", change: "added" }])
    assert.equal(readFileSync(join(t.worktree.path, "new.txt"), "utf8"), "hi")
    assert.throws(() => readFileSync(join(project, "new.txt")))
  })

  test("a later turn works in the session's worktree", async () => {
    const { ask, project, fake } = await setup([
      { when: "Second", calls: [{ name: "write", args: { path: "second.txt", content: "2" } }] },
      { text: "Done." },
    ])
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "start"]])
      execFileSync("git", ["-C", project, ...args], { stdio: "ignore" })
    const first = await ask({ start: [{ prompt: "First look", worktree: true }], wait: 30 })
    await ask({ continue: first.tasks[0].id, prompt: "Second step", write: true, wait: 30 })
    assert.equal(readFileSync(join(first.tasks[0].worktree.path, "second.txt"), "utf8"), "2")
    assert.equal(fake.requests.length, 3)
    assert.throws(() => readFileSync(join(project, "second.txt")))
  })

  test("continue refuses a session whose worktree is gone", async () => {
    const { ask, project } = await setup([{ text: "Done." }])
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "start"]])
      execFileSync("git", ["-C", project, ...args], { stdio: "ignore" })
    const first = await ask({ start: [{ prompt: "Look around", worktree: true }], wait: 30 })
    execFileSync("git", ["-C", project, "worktree", "remove", "--force", first.tasks[0].worktree.path])
    const r = await ask({ continue: first.tasks[0].id, prompt: "More" })
    assert.match(r.error.message, /which is gone$/)
  })

  test("a request ask can't carry out says what to send instead", async () => {
    const { run } = await setup([{ text: "unused" }])
    const r = await run([], JSON.stringify({ start: [{ prompt: "x", modle: "fake/m" }] }))
    assert.equal(r.code, 2)
    assert.deepEqual(JSON.parse(r.stdout).error, { message: "start[0] has unknown key modle", hint: "it takes prompt, model, write, worktree, dir, effort, schema, timeout" })
  })
})
