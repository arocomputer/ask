// Running a session's latest turn. `execute` runs it in this process; `launch` starts a
// detached worker (`ask __worker FOLDER`) that runs it beyond the caller's lifetime, recording
// its pid as the session's lock. Either way the transcript is saved after every step, the
// record says `retrying` while a provider is being retried, and a write turn lists what it
// changed. A turn whose prompt is already in the transcript is resumed from where it stopped.
// A turn for a harness's model (claude/, codex/, an extension's) runs with that harness instead
// of ask's own loop.

import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "../providers/catalog.ts"
import { changes, snapshot } from "../base/git.ts"
import { checkConfig, readJSON, writeJSON, type Config, type Home } from "../base/home.ts"
import { readModels, resolve } from "./models.ts"
import { web } from "../agent/search.ts"
import { harness, settings, tools } from "../harnesses/extensions.ts"
import { open, support, type Sandbox } from "../sandbox/confine.ts"
import { history, type Harness, type Outcome } from "../harnesses/harness.ts"
import { run, type Checkpoint } from "../agent/loop.ts"
import { withRetries, type Message, type Usage } from "../providers/stream.ts"
import { latest, lock, now, save, saveTranscript, transcript, unlock, worker, type Session } from "./store.ts"

/** Starts a detached worker for the session's latest turn and records it as the lock. */
export function launch(s: Session) {
  lock(s)
  const script = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url))
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
 * Runs the latest turn with a harness. It continues the harness's own session only when the
 * turn before (or this turn, when resumed) ran on the same harness; otherwise it starts a new
 * one and sends the earlier conversation along as history, so a session can move between ask's
 * loop and any harness.
 */
async function runHarness(h: Home, s: Session, name: string, common: Omit<Parameters<Harness["run"]>[0], "session" | "settings" | "onSession">, resuming: boolean): Promise<Outcome> {
  const x = await harness(h, name)
  const usage = { input: 0, output: 0, cached: 0 }
  if (!x) return { error: { message: `no harness called ${name}`, hint: `run ask install ${name}` }, messages: common.messages, usage, steps: 0 }
  const n = s.turns.length
  // Sessions from before harnesses kept their Claude session as `claude`, and never left it.
  const legacy = s as Session & { claude?: string }
  if (legacy.claude && !s.harness) s.harness = { name: "claude", session: legacy.claude, turn: resuming ? n : n - 1 }
  delete legacy.claude
  const own = s.harness?.name === name && s.harness.turn === (resuming ? n : n - 1) ? s.harness.session : undefined
  let { messages, prompt } = common
  let earlier: string | undefined
  if (!own) {
    if (resuming) {
      const last = messages.findLastIndex((m) => m.role === "user")
      if (last >= 0) messages = messages.slice(0, last)
      prompt = latest(s).prompt
    }
    earlier = messages.length ? history(messages) : undefined
  }
  return x.run({
    ...common,
    messages,
    prompt,
    history: earlier,
    session: own,
    settings: settings(h, name),
    onSession(id) {
      s.harness = { name, session: id, turn: n }
      save(s)
    },
  })
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
  let sandbox: Sandbox | undefined
  try {
    checkConfig(h)
    const target = await resolve(h, t.model)
    const models = target.model.protocol === "harness" ? undefined : await readModels(h, target)
    // Pin the turn's confinement choice across restarts; older turns default to enabled.
    if (target.model.protocol !== "harness") {
      const can = t.sandbox === false ? undefined : support()
      if (can && !can.ok) {
        t.state = "failed"
        t.error = { message: `built-in tasks need a sandbox, and ${can.detail}`, hint: can.fix }
        return
      }
      sandbox = await open(s.dir, t.write, t.sandbox !== false)
    }
    // A killed worker must not redefine the baseline after it already changed files.
    const baseline = join(s.folder, `before-${s.turns.length}.json`)
    const prior = t.write ? readJSON<{ root: string; head: string; files: [string, string][] } | undefined>(baseline, undefined) : undefined
    const before = t.write ? prior ? { ...prior, files: new Map(prior.files) } : snapshot(s.dir) : undefined
    if (before && !prior) writeJSON(baseline, { ...before, files: [...before.files] })
    const timeout = AbortSignal.timeout(t.timeout * 1000)
    const messages = transcript(s)
    const resuming = messages.filter((m) => m.role === "user").length >= s.turns.length
    const onUpdate = (messages: Message[], usage: Usage) => {
      saveTranscript(s, messages)
      t.state = "running"
      delete t.retry
      t.usage = usage
      save(s)
    }
    const common = {
      model: target.model.id,
      dir: s.dir,
      prompt: resuming ? undefined : t.prompt,
      messages,
      write: t.write,
      effort: t.effort,
      schema: t.schema,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      onUpdate,
    }
    const r =
      target.model.protocol === "harness"
        ? await runHarness(h, s, target.model.provider, { ...common, sandbox: t.sandbox !== false }, resuming)
        : await run({
            ...common,
            provider: withRetries(connect(target.model, target.key, target.baseURL), (attempt, err) => {
              t.state = "retrying"
              t.retry = `${err.message} (attempt ${attempt})`
              save(s)
            }),
            maxOutput: target.model.output,
            contextLimit: target.model.context,
            initialUsage: resuming ? t.usage : undefined,
            checkpoint: readJSON<Checkpoint | undefined>(join(s.folder, "checkpoint.json"), undefined),
            onCheckpoint(checkpoint, messages, usage) {
              onUpdate(messages, usage)
              writeJSON(join(s.folder, "checkpoint.json"), checkpoint)
            },
            session: s.id,
            extra: await tools(h),
            sandbox,
            models,
            search: web,
            off: Object.entries(readJSON<Config>(h.config, {}).tools ?? {}).flatMap(([name, on]) => (on === false ? [name] : [])),
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
      t.error = { message: `timed out after ${t.timeout} seconds`, hint: "continue the session to let it go on, or give the task a longer timeout" }
    } else {
      t.state = "failed"
      t.error = r.error
    }
    if (before) {
      try {
        const found = changes(before)
        t.changes = found.changes
        t.commits = found.commits
        delete t.changesError
      } catch (err) {
        t.changesError = `change reporting failed: ${(err as Error).message}`
      }
    }
  } catch (err) {
    t.state = signal?.aborted ? "stopped" : "failed"
    t.error = { message: (err as Error).message }
  } finally {
    try { await sandbox?.close() }
    finally { finish() }
  }
}
