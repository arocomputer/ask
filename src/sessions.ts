// Sessions on disk: one folder per conversation under ~/.ask/sessions/ID, holding session.json
// (the record and its turns), transcript.json (every message so far, saved after each step) and
// lock (the pid of the worker running the latest turn). A turn marked running whose worker is
// gone has failed; readers work that out without writing.

import { execFileSync } from "node:child_process"
import { randomInt } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { readJSON, writeJSON, type Home } from "./home.ts"
import type { Failure } from "./loop.ts"
import type { Message, Usage } from "./provider.ts"

export type State = "running" | "retrying" | "succeeded" | "failed" | "stopped"

export type { Change } from "./git.ts"
import type { Change } from "./git.ts"

/** One prompt and its outcome. */
export type Turn = {
  prompt: string
  model: string
  write: boolean
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
}

/**
 * session.json. `worktree` is the checkout and branch a worktree task works on; `claude` the
 * Claude Code session behind a claude/ session.
 */
export type Record = { id: string; created: string; dir: string; worktree?: { path: string; branch: string }; claude?: string; turns: Turn[] }

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
  if (worker(s)) return true
  const starting = readJSON<{ starting?: number }>(join(s.folder, "lock"), {}).starting
  if (starting && Date.now() - starting < startup) return true
  const claimed = statSync(restart(s), { throwIfNoEntry: false })
  return !!claimed && Date.now() - claimed.mtimeMs < startup
}

/** Where the next restart of the latest turn is claimed. */
function restart(s: Session): string {
  return join(s.folder, `resume-${s.turns.length}-${(latest(s).resumed ?? 0) + 1}`)
}

/**
 * Claims the next restart of the latest turn. Creating a folder succeeds for one caller only,
 * so two requests that find the same lost turn never restart it twice.
 */
export function claim(s: Session): boolean {
  try {
    mkdirSync(restart(s))
    return true
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
    return command.includes(s.folder) ? pid : undefined
  } catch {
    return undefined
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
