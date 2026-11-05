import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { serve, type Fake, type Reply } from "./fake.ts"

const cli = join(import.meta.dirname, "..", "src", "cli.ts")
const fakes: Fake[] = []
after(() => Promise.all(fakes.map((f) => f.close())))

/** A home with a one-model catalog served by a fake provider, a key, and a project folder. */
async function setup(replies: Reply[]) {
  const fake = await serve("chat", replies)
  fakes.push(fake)
  const root = mkdtempSync(join(tmpdir(), "ask-cli-"))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, "cache"), { recursive: true })
  mkdirSync(project)
  writeFileSync(join(project, "port.txt"), "7341\n")
  const catalog = { fake: { id: "fake", name: "Fake", env: ["FAKE_API_KEY"], npm: "@ai-sdk/openai-compatible", api: fake.url, models: { m: { id: "m", name: "M" } } } }
  writeFileSync(join(home, "cache", "models.json"), JSON.stringify(catalog))
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "fake/m" }))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ fake: { api_key: "k" } }))
  const run = (args: string[], input = "") =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, ASK_HOME: home, NO_COLOR: "1" } }, (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      )
      child.stdin!.end(input)
    })
  /** Sends one JSON request and returns the parsed response. */
  const ask = async (request: object) => JSON.parse((await run([], JSON.stringify(request))).stdout)
  return { fake, home, project, run, ask }
}

describe("cli", () => {
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

  test("a task whose worker died reads as failed", async () => {
    const { ask, home } = await setup([{ text: "never", delay: 20_000 }])
    const { tasks } = await ask({ start: [{ prompt: "Task" }] })
    const { pid } = JSON.parse(readFileSync(join(home, "sessions", tasks[0].id, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    const r = await ask({ collect: [tasks[0].id], wait: 5 })
    assert.equal(r.tasks[0].state, "failed")
    assert.match(r.tasks[0].error.message, /worker exited/)
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

  test("doctor names what is broken and how to fix it", async () => {
    const { run, home } = await setup([{ text: "ok" }])
    writeFileSync(join(home, "config.json"), "{}")
    const r = await run(["doctor"])
    assert.equal(r.code, 1)
    assert.match(r.stdout, /^X Model     no default model\n\s+ask settings$/m)
  })

  test("a request ask can't carry out says what to send instead", async () => {
    const { run } = await setup([{ text: "unused" }])
    const r = await run([], JSON.stringify({ start: [{ prompt: "x", modle: "fake/m" }] }))
    assert.equal(r.code, 2)
    assert.deepEqual(JSON.parse(r.stdout).error, { message: "start[0] has unknown key modle", hint: "it takes prompt, model, write, dir, effort, schema, timeout" })
  })
})
