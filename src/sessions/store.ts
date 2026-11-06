// Sessions on disk: one folder per conversation under ~/.ask/sessions/ID, holding session.json
// (the record and its turns), transcript.json (every message so far, saved after each step) and
// lock (the pid of the worker running the latest turn). A turn marked running whose worker is
// gone has failed; readers work that out without writing.

import { execFileSync } from "node:child_process"
import { randomInt } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { readJSON, writeJSON, type Home } from "../base/home.ts"
import type { Failure } from "../agent/loop.ts"
import type { Message, Usage } from "../providers/stream.ts"

export type State = "running" | "retrying" | "succeeded" | "failed" | "stopped"

export type { Change } from "../base/git.ts"
import type { Change } from "../base/git.ts"

/** One prompt and its outcome. */
export type Turn = {
  prompt: string
  model: string
  write: boolean
  /** OS confinement selected when the turn starts. Missing on older turns means enabled. */
  sandbox?: boolean
  /** Serializes stop/restart transitions independently of the reported restart count. */
  generation?: number
  /** Outcome remains valid even if final Git change reporting fails. */
  changesError?: string
  effort?: string
  schema?: object
  /** Seconds before the turn is stopped. */
  timeout: number
  state: State
  started: string
  finished?: string
  answer?: string
  error?: Failure
  usage?: Usage
  steps?: number
  /** Why the provider is being retried, while it is. */
  retry?: string
  /** How many times the turn was restarted after its worker was stopped. */
  resumed?: number
  changes?: Change[]
  /** Commits a write turn made on top of where it started. */
  commits?: number
  /** Legacy cleanup report, retained for reading older turns. */
  reverted?: string[]
}

/**
 * session.json. `worktree` is the checkout and branch a worktree task works on; `harness` the
 * harness session behind the latest turns run by a harness, and the turn that last used it;
 * `parent` the agent conversation that started the session, when ask could tell; `origin` the
 * repository (or else folder) it was started from.
 */
export type Record = {
  id: string
  created: string
  dir: string
  parent?: string
  origin?: string
  worktree?: { path: string; branch: string }
  harness?: { name: string; session: string; turn: number }
  turns: Turn[]
}

export type Session = Record & { folder: string }

const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

export function now(): string {
  return new Date().toISOString()
}

/** Creates a session folder with its first turn, marked running. */
export function create(h: Home, dir: string, turn: Omit<Turn, "state" | "started">, worktree?: Record["worktree"]): Session {
  mkdirSync(h.sessions, { recursive: true, mode: 0o700 })
  for (;;) {
    const id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("")
    const folder = join(h.sessions, id)
    try {
      mkdirSync(folder, { mode: 0o700 })
    } catch {
      continue
    }
    const created = now()
    const s: Session = { id, created, dir, ...(worktree ? { worktree } : {}), turns: [{ ...turn, state: "running", started: created }], folder }
    save(s)
    return s
  }
}

/** Opens a session by id, or throws what to do. */
export function open(h: Home, id: string): Session {
  const clean = id.trim().toLowerCase()
  if (!/^[a-z0-9]{1,32}$/.test(clean)) throw new Error(`${JSON.stringify(id)} isn't a session id; ask sessions lists them`)
  const folder = join(h.sessions, clean)
  const rec = readJSON<Record | undefined>(join(folder, "session.json"), undefined)
  if (!rec) throw new Error(`no session ${clean}; ask sessions lists them`)
  return { ...rec, folder }
}

/** Every readable session, most recently started turn first. */
export function list(h: Home): Session[] {
  let names: string[] = []
  try {
    names = readdirSync(h.sessions)
  } catch {}
  const out: Session[] = []
  for (const name of names) {
    try {
      out.push(open(h, name))
    } catch {}
  }
  return out.sort((a, b) => latest(b).started.localeCompare(latest(a).started))
}

/**
 * The sessions someone may mean by "mine": with a parent, those that conversation started;
 * otherwise those started from `origin`. Sessions from before ask recorded either count by the
 * folder they work in.
 */
export function scoped(sessions: Session[], who: { parent?: string; origin: string }): Session[] {
  if (who.parent) return sessions.filter((s) => s.parent === who.parent)
  return sessions.filter((s) => (s.origin ?? s.dir) === who.origin || (!s.origin && s.dir.startsWith(who.origin + "/")))
}

export function latest(s: Record): Turn {
  return s.turns[s.turns.length - 1]
}

export function save(s: Session) {
  const { folder, ...rec } = s
  writeJSON(join(folder, "session.json"), rec)
}

/** Reads the record again, for one another process is writing. */
export function reload(s: Session): Session {
  const rec = readJSON<Record | undefined>(join(s.folder, "session.json"), undefined)
  if (!rec) throw new Error(`session ${s.id} is gone`)
  return { ...rec, folder: s.folder }
}

export function transcript(s: Session): Message[] {
  return readJSON<Message[]>(join(s.folder, "transcript.json"), [])
}

export function saveTranscript(s: Session, messages: Message[]) {
  writeJSON(join(s.folder, "transcript.json"), messages)
}

/**
 * Records the worker running the latest turn: its pid, or before it exists, the time a
 * launcher began starting it, so nobody takes the turn for lost in between.
 */
export function lock(s: Session, pid?: number) {
  writeJSON(join(s.folder, "lock"), pid ? { pid } : { starting: Date.now() })
}

/** How long a launcher may take between claiming a turn and recording its worker's pid. */
const startup = 30_000

export function unlock(s: Session) {
  rmSync(join(s.folder, "lock"), { force: true })
}

/** True while a worker runs the latest turn, or a launcher is starting or restarting one. */
export function alive(s: Session): boolean {
  if (active(s)) return true
  return held(claimPath(s))
}

/** A worker or launcher, excluding the caller's transition claim. */
export function active(s: Session): boolean {
  if (worker(s)) return true
  const starting = readJSON<{ starting?: number }>(join(s.folder, "lock"), {}).starting
  return !!starting && Date.now() - starting < startup
}

/** Where the next restart of the latest turn is claimed. */
function restart(s: Session): string {
  return join(s.folder, `resume-${s.turns.length}-${(latest(s).generation ?? latest(s).resumed ?? 0) + 1}`)
}

/** Abandoned claims use immutable child slots, avoiding races deleting another caller's lock. */
function claimPath(s: Session): string {
  let path = restart(s)
  for (;;) {
    const info = statSync(join(path, "retry"), { throwIfNoEntry: false })
    if (!info) return path
    path = join(path, "retry")
  }
}

/** A live transition owner keeps its claim even when paused longer than the startup grace. */
function held(path: string): boolean {
  const info = statSync(path, { throwIfNoEntry: false })
  if (!info) return false
  const owner = readJSON<{ pid?: number }>(join(path, "owner"), {}).pid
  if (!owner) return Date.now() - info.mtimeMs < startup
  try { process.kill(owner, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH" }
}

/**
 * Claims the next restart of the latest turn. Creating a folder succeeds for one caller only,
 * so two requests that find the same lost turn never restart it twice.
 */
export function claim(s: Session): boolean {
  let path = claimPath(s)
  const info = statSync(path, { throwIfNoEntry: false })
  if (info && !held(path)) path = join(path, "retry")
  try {
    mkdirSync(path)
    writeJSON(join(path, "owner"), { pid: process.pid })
    // A process paused before publishing its owner may have lost this slot to a retry.
    return claimPath(s) === path
  } catch {
    return false
  }
}

/** The pid of the live worker for this session, if any: alive and still running this session. */
export function worker(s: Session): number | undefined {
  const pid = readJSON<{ pid?: number }>(join(s.folder, "lock"), {}).pid
  if (!pid) return undefined
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return undefined
  }
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] }).toString()
    return command.trimEnd().endsWith(` __worker ${s.folder}`) ? pid : undefined
  } catch {
    try { process.kill(pid, 0) }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") return undefined }
    // Fail closed if ps is unavailable: do not duplicate a possibly live worker.
    throw new Error(`cannot verify worker ${pid}; ensure ps is installed before resuming or stopping ${s.id}`)
  }
}

/**
 * The latest turn as a reader should see it: a running turn without a worker has failed. The
 * record is read again before saying so, since a worker saves its outcome just before it
 * removes its lock.
 */
export function status(s: Session): Turn {
  const t = latest(s)
  if ((t.state !== "running" && t.state !== "retrying") || alive(s)) return t
  const fresh = latest(reload(s))
  if (fresh.state !== "running" && fresh.state !== "retrying") return fresh
  return { ...fresh, state: "failed", error: { message: "the worker stopped before the turn finished", hint: `collect resumes it where it left off, or {"continue": "${s.id}"}; its log is ${join(s.folder, "log")}` } }
}

/** The log the worker writes its own errors to. */
export function log(s: Session): string {
  try {
    return readFileSync(join(s.folder, "log"), "utf8")
  } catch {
    return ""
  }
}
