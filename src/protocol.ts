// The agent interface: one JSON request in, one JSON response out. The command line reads a
// request on stdin; the library and any other front end call `handle` with the same object.
//
// A request holds exactly one operation:
//   {"start": [TASK, ...], "wait": SECONDS?}    start tasks; with wait, collect them as below
//   {"collect": [ID, ...], "wait": SECONDS?}     block until one has finished (default 600s)
//   {"continue": ID, "prompt": TEXT, ...}        a finished session's next turn, with TASK's options
//   {"stop": [ID, ...]}
//   {"show": ID}                                 the session with the steps of its latest turn
// TASK is {"prompt", "model"?, "write"?, "dir"?, "effort"?, "schema"?, "timeout"?}.
//
// Every response is {"tasks": [RESULT, ...]}, or {"error": {"message", "hint"}} for a request ask
// can't carry out. RESULT is {"id", "state", "answer"?, "error"?, "changes"?, "retrying"?,
// "activity"?}; state is running, retrying, succeeded, failed or stopped.

import { rmSync, statSync } from "node:fs"
import { resolve as absolute } from "node:path"
import { resolve as model, type Home, readJSON, type Config } from "./home.ts"
import type { Failure } from "./loop.ts"
import { create, latest, now, open, reload, save, status, transcript, unlock, worker, type Change, type Session, type State } from "./sessions.ts"
import { activity, steps } from "./steps.ts"
import { launch } from "./worker.ts"

/** The protocol as `ask help requests` prints it. */
export const guide = `Agents use ask by sending one JSON request on stdin and reading one JSON response on stdout.
Subagents work in the background; a request returns as soon as they start, or once one has
finished if it says how long to wait.

REQUESTS
  {"start": [TASK, ...], "wait": seconds}
      Start tasks. Without wait, returns at once; with it, blocks until one finishes or the
      wait is over, like collect.
  {"collect": [ID, ...], "wait": seconds}
      Block until at least one of the sessions has finished (or wait passes, default 600),
      then report them all. Finished ones stay finished; collect the rest again.
  {"continue": ID, "prompt": "...", "wait": seconds, ...}
      Give a finished session its next prompt. It keeps the conversation. Takes TASK's
      fields, except dir.
  {"stop": [ID, ...]}
      Stop sessions. A stopped session can be continued.
  {"show": ID}
      The session, with every step of its latest turn.

TASK
  prompt     What to do (required)
  model      provider/model (default: config.json's model)
  write      true to let it edit files and run commands (default: read-only)
  dir        Where it works (default: the current directory)
  effort     Reasoning effort, like low, medium or high
  schema     A JSON Schema its answer must match
  timeout    Seconds before it is stopped (default: 900)

RESPONSE
  {"tasks": [{"id", "state", "answer", "error", "changes", "retrying", "activity"}]}
  state      running, retrying, succeeded, failed or stopped
  answer     The subagent's answer, when it succeeded
  error      {"message", "hint"}, when it failed; hint says what to do next
  changes    Files a write task changed: [{"path", "change"}]
  retrying   Why the provider is being retried, while it is
  activity   Its latest step, while it runs
  A request ask can't carry out gets {"error": {"message", "hint"}} and exit status 2.

EXAMPLE
  $ ask <<'EOF'
  {"start": [{"prompt": "Where is the retry logic?"}, {"prompt": "List the API routes"}], "wait": 300}
  EOF
`

export type Task = { prompt: string; model?: string; write?: boolean; dir?: string; effort?: string; schema?: object; timeout?: number }

export type Request =
  | { start: Task[]; wait?: number }
  | { collect: string[]; wait?: number }
  | ({ continue: string } & Task & { wait?: number })
  | { stop: string[] }
  | { show: string }

export type Result = {
  id: string
  state: State
  answer?: string
  error?: Failure
  changes?: Change[]
  /** Why the provider is being retried, while it is. */
  retrying?: string
  /** The latest step of a running task, like "read src/a.ts". */
  activity?: string
  /** With show: every step of the latest turn. */
  steps?: string[]
}

export type Response = { tasks: Result[] } | { error: Failure }

/** A request ask can't carry out, with what to send instead. */
export class Invalid extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

const taskKeys = ["prompt", "model", "write", "dir", "effort", "schema", "timeout"]
const ops = ["start", "collect", "continue", "stop", "show"]

/** Parses and carries out one request. Never throws: failures become `{"error"}`. */
export async function handle(h: Home, request: unknown): Promise<Response> {
  try {
    return { tasks: await carry(h, request) }
  } catch (err) {
    const e = err as Invalid
    return { error: { message: e.message, ...(e.hint ? { hint: e.hint } : {}) } }
  }
}

async function carry(h: Home, r: unknown): Promise<Result[]> {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Invalid("a request is one JSON object", '{"start": [{"prompt": "..."}]}')
  const req = r as Record<string, unknown>
  const op = ops.filter((k) => k in req)
  if (op.length !== 1) throw new Invalid(`a request holds exactly one of ${ops.join(", ")}`, '{"start": [{"prompt": "..."}]}')
  const wait = seconds(req.wait, "wait")
  switch (op[0]) {
    case "start": {
      only(req, ["start", "wait"])
      if (!Array.isArray(req.start) || !req.start.length) throw new Invalid("start takes a list of tasks", '{"start": [{"prompt": "..."}]}')
      const tasks = req.start.map((t, i) => task(t, `start[${i}]`))
      const started: Session[] = []
      for (const t of tasks) started.push(await begin(h, t))
      return wait === undefined ? started.map(result) : collect(started, wait)
    }
    case "collect": {
      only(req, ["collect", "wait"])
      return collect(ids(req.collect, "collect").map((id) => find(h, id)), wait ?? 600)
    }
    case "continue": {
      only(req, ["continue", "wait", ...taskKeys.filter((k) => k !== "dir")])
      if (typeof req.continue !== "string") throw new Invalid("continue takes a session id", '{"continue": "k3f9a2", "prompt": "..."}')
      const s = find(h, req.continue)
      const state = status(s).state
      if (state === "running" || state === "retrying") throw new Invalid(`${s.id} is still running`, `{"collect": ["${s.id}"]} first`)
      const { continue: _, wait: __, ...rest } = req
      const t = task(rest, "continue")
      const last = latest(s)
      const target = await chosen(h, t.model ?? last.model)
      s.turns.push({
        prompt: t.prompt,
        model: target,
        write: t.write ?? false,
        effort: t.effort ?? (t.model ? undefined : last.effort),
        schema: t.schema,
        timeout: t.timeout ?? defaultTimeout(h),
        state: "running",
        started: now(),
      })
      save(s)
      try {
        launch(s)
      } catch (err) {
        s.turns.pop()
        save(s)
        throw err
      }
      return wait === undefined ? [result(s)] : collect([s], wait)
    }
    case "stop": {
      only(req, ["stop"])
      const out: Result[] = []
      for (const id of ids(req.stop, "stop")) out.push(result(await stop(find(h, id))))
      return out
    }
    case "show": {
      only(req, ["show"])
      if (typeof req.show !== "string") throw new Invalid("show takes a session id", '{"show": "k3f9a2"}')
      const s = find(h, req.show)
      return [{ ...result(s), steps: steps(transcript(s), s.turns.length) }]
    }
  }
  throw new Invalid("unreachable")
}

/** A session's latest turn as the agent sees it: small, with detail only where it helps. */
export function result(s: Session): Result {
  const t = status(s)
  const r: Result = { id: s.id, state: t.state }
  if (t.answer !== undefined) r.answer = t.answer
  if (t.error) r.error = t.error
  if (t.changes?.length) r.changes = t.changes
  if (t.retry) r.retrying = t.retry
  if (t.state === "running" || t.state === "retrying") r.activity = activity(transcript(s))
  return r
}

/** Blocks until one of the sessions has finished or `wait` seconds pass, then reports them all. */
async function collect(sessions: Session[], wait: number): Promise<Result[]> {
  const deadline = Date.now() + wait * 1000
  for (;;) {
    sessions = sessions.map(reload)
    if (sessions.some((s) => !["running", "retrying"].includes(status(s).state)) || Date.now() >= deadline) return sessions.map(result)
    await new Promise((ok) => setTimeout(ok, 250))
  }
}

async function begin(h: Home, t: Task): Promise<Session> {
  const dir = absolute(t.dir ?? ".")
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Invalid(`${t.dir} is not a directory`)
  const s = create(h, dir, {
    prompt: t.prompt,
    model: await chosen(h, t.model),
    write: t.write ?? false,
    effort: t.effort,
    schema: t.schema,
    timeout: t.timeout ?? defaultTimeout(h),
  })
  try {
    launch(s)
  } catch (err) {
    rmSync(s.folder, { recursive: true, force: true })
    throw err
  }
  return s
}

/** Sends SIGTERM, waits up to ten seconds, then SIGKILL; records the turn as stopped. */
async function stop(s: Session): Promise<Session> {
  const pid = worker(s)
  if (!pid) return s
  const gone = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (!worker(s)) return true
      await new Promise((ok) => setTimeout(ok, 50))
    }
    return !worker(s)
  }
  process.kill(pid, "SIGTERM")
  if (!(await gone(10_000))) {
    process.kill(pid, "SIGKILL")
    await gone(2_000)
  }
  const fresh = reload(s)
  const t = latest(fresh)
  if (t.state === "running" || t.state === "retrying") {
    Object.assign(t, { state: "stopped", finished: now() })
    delete t.retry
    save(fresh)
    unlock(fresh)
  }
  return fresh
}

async function chosen(h: Home, name?: string): Promise<string> {
  try {
    const { model: m } = await model(h, name)
    return `${m.provider}/${m.id}`
  } catch (err) {
    throw new Invalid((err as Error).message)
  }
}

function defaultTimeout(h: Home): number {
  return readJSON<Config>(h.config, {}).timeout ?? 900
}

function find(h: Home, id: string): Session {
  try {
    return open(h, id)
  } catch (err) {
    throw new Invalid((err as Error).message.replace(/; ask sessions lists them$/, ""))
  }
}

function task(v: unknown, where: string): Task {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Invalid(`${where} must be an object with a prompt`)
  const t = v as Record<string, unknown>
  only(t, taskKeys, where)
  if (typeof t.prompt !== "string" || !t.prompt.trim()) throw new Invalid(`${where} needs a prompt`)
  for (const k of ["model", "dir", "effort"]) if (t[k] !== undefined && typeof t[k] !== "string") throw new Invalid(`${where}.${k} must be a string`)
  if (t.write !== undefined && typeof t.write !== "boolean") throw new Invalid(`${where}.write must be true or false`)
  if (t.schema !== undefined && (!t.schema || typeof t.schema !== "object" || Array.isArray(t.schema))) throw new Invalid(`${where}.schema must be a JSON Schema object`)
  const timeout = seconds(t.timeout, `${where}.timeout`)
  if (timeout === 0) throw new Invalid(`${where}.timeout must be more than 0 seconds`)
  return { ...(t as Task), prompt: t.prompt.trim(), timeout }
}

function only(o: Record<string, unknown>, allowed: string[], where = "the request") {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k))
  if (extra.length) throw new Invalid(`${where} has unknown ${extra.length > 1 ? "keys" : "key"} ${extra.join(", ")}`, `it takes ${allowed.join(", ")}`)
}

function ids(v: unknown, op: string): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string")) throw new Invalid(`${op} takes a list of session ids`, `{"${op}": ["k3f9a2"]}`)
  return v
}

function seconds(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "number" || !(v >= 0)) throw new Invalid(`${what} is a number of seconds`)
  return v
}
