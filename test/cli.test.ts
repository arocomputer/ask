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
  const ask = (args: string[], input?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, ASK_HOME: home, NO_COLOR: "1" } }, (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      )
      child.stdin!.end(input ?? "")
    })
  return { fake, home, project, ask }
}

describe("cli", () => {
  test("a session runs in the background and wait prints its answer", async () => {
    const { ask } = await setup([{ calls: [{ name: "read", args: { path: "port.txt" } }] }, { text: "Port 7341." }])
    const start = await ask(["Which port?"])
    const id = start.stdout.trim()
    assert.match(id, /^[a-z0-9]{6}$/)
    const r = await ask(["wait", id])
    assert.equal(r.code, 0)
    assert.equal(r.stdout, "Port 7341.\n")
  })

  test("stop ends a running session as stopped", async () => {
    const { ask } = await setup([{ text: "late", delay: 20_000 }])
    const id = (await ask(["Slow task"])).stdout.trim()
    await new Promise((ok) => setTimeout(ok, 500))
    assert.equal((await ask(["stop", id])).code, 0)
    const r = await ask(["wait", id, "--json"])
    assert.equal(JSON.parse(r.stdout).state, "stopped")
  })

  test("a session whose worker died reads as failed", async () => {
    const { ask, home } = await setup([{ text: "never", delay: 20_000 }])
    const id = (await ask(["Task"])).stdout.trim()
    const { pid } = JSON.parse(readFileSync(join(home, "sessions", id, "lock"), "utf8"))
    process.kill(pid, "SIGKILL")
    const r = await ask(["wait", id, "--json"])
    assert.equal(JSON.parse(r.stdout).state, "failed")
    assert.match(JSON.parse(r.stdout).error.message, /worker exited/)
  })

  test("continue carries the conversation into the next turn", async () => {
    const { ask, fake } = await setup([{ text: "First answer." }, { text: "Second answer." }])
    const first = JSON.parse((await ask(["--wait", "--json", "First question"])).stdout)
    const r = await ask(["continue", first.id, "Second question", "--wait"])
    assert.equal(r.stdout, "Second answer.\n")
    assert.deepEqual(fake.requests[1].messages.slice(1).map((m: any) => m.content), ["First question", "First answer.", "Second question"])
  })

  test("a write turn lists the files it changed", async () => {
    const { ask, project } = await setup([{ calls: [{ name: "write", args: { path: "new.txt", content: "hi" } }] }, { text: "Done." }])
    execFileSync("git", ["init", "-q"], { cwd: project })
    const r = await ask(["-w", "--wait", "--json", "Add a file"])
    assert.deepEqual(JSON.parse(r.stdout).changes, [{ path: "new.txt", change: "added" }])
  })

  test("auth login checks a piped key before saving it", async () => {
    const { ask, home } = await setup([{ status: 401, error: "Invalid credential" }])
    const r = await ask(["auth", "login", "fake"], "bad-key")
    assert.equal(r.code, 1)
    assert.match(r.stderr, /refused the key: Invalid credential/)
    assert.equal(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).fake.api_key, "k")
  })

  test("a mistake in the call exits 2 and says what to do", async () => {
    const { ask } = await setup([{ text: "unused" }])
    const r = await ask(["--frobnicate", "task"])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /^X Unknown option '--frobnicate'\n  ask --help lists the flags\n$/)
  })
})
