// Running a session's latest turn. `execute` runs it in this process; `launch` starts a
// detached worker (`ask __worker FOLDER`) that runs it beyond the caller's lifetime, recording
// its pid as the session's lock. Either way the transcript is saved after every step, the
// record says `retrying` while a provider is being retried, and a write turn lists what it
// changed.

import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "./catalog.ts"
import { resolve, type Home } from "./home.ts"
import { run } from "./loop.ts"
import { withRetries } from "./provider.ts"
import { latest, lock, now, save, saveTranscript, transcript, unlock, type Change, type Session } from "./sessions.ts"

/** Starts a detached worker for the session's latest turn and records it as the lock. */
export function launch(s: Session) {
  const script = fileURLToPath(new URL("./cli.ts", import.meta.url))
  const args = script.startsWith("/$bunfs") ? [] : [script]
  const out = openSync(join(s.folder, "log"), "a", 0o600)
  const child = spawn(process.execPath, [...args, "__worker", s.folder], { detached: true, stdio: ["ignore", out, out] })
  closeSync(out)
  if (!child.pid) throw new Error("cannot start the worker")
  lock(s, child.pid)
  child.unref()
}

/** The detached side: runs the turn, ending it as stopped on SIGTERM. */
export async function main(h: Home, s: Session) {
  const stop = new AbortController()
  process.on("SIGTERM", () => stop.abort())
  process.on("SIGHUP", () => {})
  await execute(h, s, stop.signal)
  process.exit(latest(s).state === "succeeded" ? 0 : 1)
}

/** Runs the session's latest turn to its end, saving as it goes. */
export async function execute(h: Home, s: Session, signal?: AbortSignal) {
  const t = latest(s)
  const finish = () => {
    t.finished = now()
    delete t.retry
    save(s)
    unlock(s)
  }
  let target
  try {
    target = await resolve(h, t.model)
  } catch (err) {
    t.state = "failed"
    t.error = { message: (err as Error).message }
    return finish()
  }
  const before = t.write ? snapshot(s.dir) : undefined
  const provider = withRetries(connect(target.model, target.key, target.baseURL), (attempt, err) => {
    t.state = "retrying"
    t.retry = `${err.message} (attempt ${attempt})`
    save(s)
  })
  const timeout = AbortSignal.timeout(t.timeout * 1000)
  const r = await run({
    provider,
    model: target.model.id,
    dir: s.dir,
    prompt: t.prompt,
    messages: transcript(s),
    write: t.write,
    effort: t.effort,
    schema: t.schema,
    maxOutput: target.model.output,
    session: s.id,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    onUpdate(messages, usage) {
      saveTranscript(s, messages)
      t.state = "running"
      delete t.retry
      t.usage = usage
      save(s)
    },
  })
  saveTranscript(s, r.messages)
  t.usage = r.usage
  t.steps = r.steps
  if (r.answer !== undefined) {
    t.state = "succeeded"
    t.answer = r.answer
  } else if (signal?.aborted) {
    t.state = "stopped"
  } else if (timeout.aborted) {
    t.state = "failed"
    t.error = { message: `timed out after ${t.timeout} seconds`, hint: "continue the session to let it go on, or pass a longer --timeout" }
  } else {
    t.state = "failed"
    t.error = r.error
  }
  if (before) t.changes = diff(before, snapshot(s.dir))
  finish()
}

/** The dirty files of a repository, each with its status and a hash of its content. */
function snapshot(dir: string): Map<string, string> | undefined {
  let out: string
  try {
    out = execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: dir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
  } catch {
    return undefined
  }
  const files = new Map<string, string>()
  const entries = out.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.length < 4) continue
    const code = e.slice(0, 2)
    const path = e.slice(3)
    if (code[0] === "R" || code[0] === "C") i++
    let hash = ""
    try {
      hash = createHash("sha1").update(readFileSync(join(dir, path))).digest("hex")
    } catch {}
    files.set(path, `${code}:${hash}`)
  }
  return files
}

/** What changed between two snapshots. Files that were already dirty count only if they changed again. */
function diff(before: Map<string, string> | undefined, after: Map<string, string> | undefined): Change[] | undefined {
  if (!before || !after) return undefined
  const out: Change[] = []
  for (const [path, v] of after) {
    if (before.get(path) === v) continue
    const code = v.slice(0, 2)
    out.push({ path, change: code.includes("D") ? "deleted" : code === "??" || code.includes("A") ? "added" : "modified" })
  }
  for (const path of before.keys()) if (!after.has(path)) out.push({ path, change: "modified" })
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
