// What the commands share: errors with hints, the session line and record, waiting for
// sessions, starting a turn, and reading stdin.

import { readJSON, type Config, type Home } from "../home.ts"
import type { Message } from "../provider.ts"
import { latest, reload, status, transcript, type Session, type Turn } from "../sessions.ts"
import { clean, count, duration, spinner, stateWord, style, symbol, truncate, type Style } from "../term.ts"
import { launch } from "../worker.ts"

/** A mistake in how ask was called; exits 2. `hint` says what to do instead. */
export class Usage extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

/** The JSON record commands print with --json: a session and its latest turn. */
export function record(s: Session) {
  const t = status(s)
  return {
    id: s.id,
    state: t.state,
    turn: s.turns.length,
    model: t.model,
    write: t.write,
    dir: s.dir,
    started: t.started,
    ...(t.finished ? { finished: t.finished } : {}),
    ...(t.answer !== undefined ? { answer: t.answer } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.retry ? { retrying: t.retry } : {}),
    ...(t.usage ? { usage: t.usage } : {}),
    ...(t.changes ? { changes: t.changes } : {}),
  }
}

/** Seconds a turn has taken, or took. */
export function elapsed(t: Turn): number {
  return ((t.finished ? Date.parse(t.finished) : Date.now()) - Date.parse(t.started)) / 1000
}

/** One line about a session: symbol, id, state, model, time, tokens. */
export function line(s: Session, st: Style): string {
  const t = status(s)
  const parts = [t.model, duration(elapsed(t))]
  if (t.usage) parts.push(`${count(t.usage.input + t.usage.output)} tokens`)
  return `${symbol(t.state, st)} ${st.cyan(s.id)} ${stateWord(t.state, st)} ${st.gray("· " + parts.join(" · "))}`
}

/** A tool call in a few words, like "read src/a.ts:40" or "shell npm test". */
export function describe(name: string, args: string): string {
  let a: Record<string, unknown> = {}
  try {
    a = JSON.parse(args)
  } catch {}
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "")
  switch (name) {
    case "read":
      return `read ${s("path")}${typeof a.line === "number" ? `:${a.line}` : ""}`
    case "list":
      return `list ${[s("path"), s("pattern")].filter(Boolean).join(" ") || "."}`
    case "grep":
      return `grep ${s("pattern")}${s("path") ? ` in ${s("path")}` : ""}${s("glob") ? ` (${s("glob")})` : ""}`
    case "shell":
      return `shell ${s("command").split("\n")[0]}`
    default:
      return `${name} ${s("path")}`.trim()
  }
}

/** The latest visible step of a transcript, for a spinner. */
export function activity(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user") return "thinking"
    if (m.role === "assistant" && m.calls.length) return clean(describe(m.calls.at(-1)!.name, m.calls.at(-1)!.arguments))
    if (m.role === "assistant" && m.text) return clean(m.text.split("\n")[0])
  }
  return "starting"
}

/**
 * Polls until one of the sessions' latest turns has finished, then returns that session.
 * `tick` hears the first still-running session meanwhile. Gives up after `timeout` seconds.
 */
export async function waitFor(sessions: Session[], opts: { timeout?: number; tick?: (s: Session) => void } = {}): Promise<Session | undefined> {
  const deadline = opts.timeout ? Date.now() + opts.timeout * 1000 : Infinity
  for (;;) {
    for (let i = 0; i < sessions.length; i++) {
      sessions[i] = reload(sessions[i])
      const state = status(sessions[i]).state
      if (state !== "running" && state !== "retrying") return sessions[i]
    }
    opts.tick?.(sessions[0])
    if (Date.now() > deadline) return undefined
    await new Promise((ok) => setTimeout(ok, 250))
  }
}

/** Prints a finished session for a person: status line on stderr, answer on stdout. Returns the exit code. */
export function finished(s: Session, json: boolean): number {
  const t = status(s)
  if (json) {
    process.stdout.write(JSON.stringify(record(s), null, 2) + "\n")
    return t.state === "succeeded" ? 0 : 1
  }
  const st = style(process.stderr)
  process.stderr.write(line(s, st) + "\n")
  if (t.state === "succeeded") {
    process.stdout.write(t.answer + "\n")
    return 0
  }
  if (t.error) process.stderr.write(`${st.red(t.error.message)}\n${t.error.hint ? st.gray(t.error.hint) + "\n" : ""}`)
  return 1
}

/** Prints that a turn started: the id alone when piped, a styled line on a terminal. */
export function started(s: Session, json: boolean) {
  if (json) return process.stdout.write(JSON.stringify({ id: s.id, state: "running", turn: s.turns.length }) + "\n")
  if (!process.stdout.isTTY) return process.stdout.write(s.id + "\n")
  const st = style()
  const t = latest(s)
  const mode = t.write ? st.yellow("write") : "read-only"
  process.stdout.write(`${st.green("✓")} Started ${st.cyan(s.id)} ${st.gray("·")} ${t.model} ${st.gray("·")} ${mode}\n`)
  process.stdout.write(st.gray(`  ask wait ${s.id}   ask show ${s.id}   ask stop ${s.id}`) + "\n")
}

/** Launches the session's latest turn, undoing it if the worker can't start. */
export function begin(s: Session, undo: () => void) {
  try {
    launch(s)
  } catch (err) {
    undo()
    throw err
  }
}

/** Waits for one session with a spinner showing its latest step, then prints it. */
export async function block(s: Session, json: boolean): Promise<number> {
  const st = style(process.stderr)
  const spin = (x: Session) => `${st.cyan(x.id)} ${truncate(activity(transcript(x)), 60)}${latest(x).retry ? st.yellow(" · retrying") : ""}`
  const sp = spinner(spin(s))
  const done = await waitFor([s], { tick: (x) => sp.update(spin(x)) })
  sp.stop()
  return finished(done!, json)
}

/** The turn timeout: config.json's, else 15 minutes. */
export function timeout(h: Home, given?: string): number {
  if (given !== undefined) {
    const n = Number(given)
    if (!Number.isFinite(n) || n <= 0) throw new Usage(`--timeout takes seconds, like 600`)
    return n
  }
  return readJSON<Config>(h.config, {}).timeout ?? 900
}

/** All of stdin as text, or "" on a terminal. */
export async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text
}
