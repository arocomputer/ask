// Running a session's latest turn. `execute` runs it in this process; `launch` starts a
// detached worker (`ask __worker FOLDER`) that runs it beyond the caller's lifetime, recording
// its pid as the session's lock. Either way the transcript is saved after every step, the
// record says `retrying` while a provider is being retried, and a write turn lists what it
// changed. A turn whose prompt is already in the transcript is resumed from where it stopped.

import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "./catalog.ts"
import { changes, snapshot } from "./git.ts"
import { resolve, type Home } from "./home.ts"
import { run } from "./loop.ts"
import { withRetries } from "./provider.ts"
import { latest, lock, now, save, saveTranscript, transcript, unlock, worker, type Session } from "./sessions.ts"

/** Starts a detached worker for the session's latest turn and records it as the lock. */
export function launch(s: Session) {
  lock(s)
  const script = fileURLToPath(new URL("./cli.ts", import.meta.url))
  const args = script.startsWith("/$bunfs") ? [] : [script]
  const out = openSync(join(s.folder, "log"), "a", 0o600)
  const child = spawn(process.execPath, [...args, "__worker", s.folder], { detached: true, stdio: ["ignore", out, out] })
  closeSync(out)
  if (!child.pid) {
    unlock(s)
    throw new Error("cannot start the worker")
  }
  lock(s, child.pid)
  child.unref()
}

/**
 * The detached side: runs the turn, ending it as stopped on SIGTERM. It refuses a turn that
 * isn't waiting to run, or that another live worker owns, so it can never run a turn twice.
 */
export async function main(h: Home, s: Session) {
  const owner = worker(s)
  if (latest(s).state !== "running" || (owner && owner !== process.pid)) {
    process.stderr.write(`ask: session ${s.id} has no turn waiting to run\n`)
    process.exit(2)
  }
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
  const messages = transcript(s)
  const resuming = messages.filter((m) => m.role === "user").length >= s.turns.length
  const r = await run({
    provider,
    model: target.model.id,
    dir: s.dir,
    prompt: resuming ? undefined : t.prompt,
    messages,
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
  if (before) {
    const found = changes(before)
    const merged = new Map((t.changes ?? []).map((c) => [c.path, c]))
    for (const c of found.changes) merged.set(c.path, c)
    t.changes = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path))
    t.commits = (t.commits ?? 0) + found.commits
  }
  finish()
}
