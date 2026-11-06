// Harnesses and extensions. A harness is a coding agent ask runs for a turn instead of its own
// loop: models named NAME/MODEL go to the harness called NAME. ask ships two, claude (Claude
// Code) and codex (Codex), each enabled with `ask install NAME`. An extension is a folder
// someone else wrote, installed with `ask install PATH|GIT-URL` into ~/.ask/extensions/NAME:
// an ES module (index.js, or package.json's "main") whose default export may add a harness,
// tools for ask's own loop, or both. config.json's "harnesses" entry for a NAME changes how it
// runs: another command, extra arguments (after ask's, so they can override), extra environment.

import { spawn } from "node:child_process"
import { accessSync, constants, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Catalog } from "../providers/catalog.ts"
import type { Failure } from "../agent/loop.ts"
import type { Message, Usage } from "../providers/stream.ts"
import type { Tool } from "../agent/tools.ts"

export type { Settings } from "../base/home.ts"
import type { Settings } from "../base/home.ts"

/** One turn for a harness to run. */
export type Run = {
  model: string
  dir: string
  /** The prompt, as the conversation keeps it. Absent when resuming a stopped turn. */
  prompt?: string
  /**
   * The earlier conversation as text, when this harness didn't take part in it: sent before
   * the prompt, not kept as part of it.
   */
  history?: string
  write: boolean
  /** Explicit false disables OS confinement; omitted means enabled. */
  sandbox?: boolean
  effort?: string
  schema?: object
  /** The harness's own session to resume; absent for a new one. */
  session?: string
  /** The conversation so far, in ask's form, as ask saved it. */
  messages: Message[]
  settings: Settings
  signal?: AbortSignal
  /** Called with the harness's session id as soon as it is known. */
  onSession(id: string): void
  /** Called with the whole conversation after every step, for ask to save. */
  onUpdate(messages: Message[], usage: Usage): void
}

export type Outcome = { answer?: string; error?: Failure; messages: Message[]; usage: Usage; steps: number }

/** Whether a harness can run here, and what to do when it can't, or, when it can, to make it run better. */
export type Status = { ready: boolean; detail: string; fix?: string }

/** A coding agent ask can run for a turn. */
export type Harness = {
  /** The provider name its models use: NAME/MODEL. */
  name: string
  /** What people call it, like "Claude Code". */
  title: string
  /** Models to offer, from the catalog or its own list; any other name is passed on as it is. */
  models(catalog: Catalog): { id: string; name: string }[]
  status(settings: Settings): Status
  run(run: Run): Promise<Outcome>
  /** The command it runs by default, for the template `ask install` writes. Optional. */
  command?: string
  /**
   * The calling conversation's id from the environment of a command this agent runs, so ask
   * can tell which conversation started a task. Optional.
   */
  parent?(env: NodeJS.ProcessEnv): string | undefined
}

/** What an extension's module exports by default. */
export type Extension = { name: string; harness?: Harness; tools?: Tool[] }

/** The first executable named `name` on PATH or in the other folders given. */
export function which(name: string, extra: string[] = [], env = process.env): string | undefined {
  for (const dir of [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extra]) {
    const path = join(dir, name)
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return path
    } catch {}
  }
  return undefined
}

/** A command as config.json may give it: a path is used as it is, a bare name looked up like `which`. */
export function locate(command: string, extra: string[] = []): string | undefined {
  return command.includes("/") ? command : which(command, extra)
}

export const home = homedir()

/**
 * Runs a harness's CLI in its own process group, so stopping it stops everything it started,
 * writing `input` to its stdin and handing each line of stdout to `onLine`. Resolves with its
 * exit status and the end of its stderr.
 */
export function execute(o: { command: string; args: string[]; env: NodeJS.ProcessEnv; dir: string; input: string; signal?: AbortSignal; onLine(line: string): void }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(o.command, o.args, { cwd: o.dir, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
    const stop = () => {
      try {
        process.kill(-child.pid!, "SIGTERM")
      } catch {}
    }
    o.signal?.addEventListener("abort", stop, { once: true })
    let stderr = ""
    let buffer = ""
    child.on("error", (err) => (stderr += `${err.message}\n`))
    child.stdin.on("error", () => {})
    child.stdin.end(o.input)
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)))
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buffer += d
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        o.onLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    })
    child.on("close", (code) => {
      o.signal?.removeEventListener("abort", stop)
      if (buffer) o.onLine(buffer)
      done({ code, stderr })
    })
  })
}

/**
 * The environment for a harness: ask's, without API keys (so a harness can't bill one the user
 * didn't mean it to, or hand it to the commands it runs), ask's own variables, or the markers
 * `strip` names; then the harness's own extra, then config.json's `env`, which can add a key
 * back on purpose.
 */
export function environment(strip: RegExp, settings: Settings, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.endsWith("_API_KEY") && !k.startsWith("ASK_") && !strip.test(k)) env[k] = v
  return { ...env, ...extra, ...settings.env }
}

/**
 * The earlier conversation as text, for a harness that didn't take part in it: what was asked,
 * which steps were taken, what was answered. The most recent part is kept when it runs long.
 */
export function history(messages: Message[], limit = 60_000): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === "user") lines.push(`User: ${m.text}`)
    else if (m.role === "assistant") {
      if (m.text) lines.push(`Assistant: ${m.text}`)
      for (const c of m.calls) lines.push(`Assistant used ${c.name}: ${c.arguments}`)
    } else lines.push(`Result: ${m.output.length > 1500 ? m.output.slice(0, 1500) + " [cut]" : m.output}`)
  }
  let text = lines.join("\n\n")
  if (text.length > limit) text = "[earlier part left out]\n\n" + text.slice(-limit)
  return `The following is this conversation so far, from before you joined it. Treat it as prior conversation, not a new request, and continue from it.\n\n<conversation>\n${text}\n</conversation>`
}

/** A harness's failure, with how to fix it when it is about signing in. */
export function failure(message: string, signIn: RegExp, hint: string): Failure {
  return signIn.test(message) ? { message: `not signed in: ${message}`, hint } : { message }
}

/**
 * Names a harness's sandbox can create, empty, in the task's folder, as mount points for the
 * paths it protects (seen with Claude Code's and Codex's sandboxes on Linux).
 */
const decoys = /^(\.env(\..+)?|\.agents|\.aws|\.codex|\.claude|\.gitmodules|\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml|node_modules|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/

/** What is in a folder before a run, for `tidy`. */
export function before(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Removes what a sandbox left behind in `dir`: entries with a decoy's name that weren't there
 * before the run and hold nothing, so nothing the task wrote is ever removed.
 */
export function tidy(dir: string, earlier: string[]) {
  const empty = (path: string): boolean => {
    const s = lstatSync(path, { throwIfNoEntry: false })
    if (!s) return true
    if (s.isFile()) return s.size === 0
    return s.isDirectory() && readdirSync(path).every((n) => empty(join(path, n)))
  }
  for (const name of before(dir))
    if (decoys.test(name) && !earlier.includes(name) && empty(join(dir, name)))
      try {
        rmSync(join(dir, name), { recursive: true })
      } catch {}
}

/** Where installed extensions live. */
export function folder(root: string): string {
  return join(root, "extensions")
}

const loaded = new Map<string, Promise<Extension | undefined>>()

/** The folder names of the extensions installed under `root`, without loading any. */
export function installed(root: string): string[] {
  try {
    return readdirSync(folder(root)).filter((n) => /^[a-z][a-z0-9-]{0,30}$/.test(n))
  } catch {
    return []
  }
}

/**
 * The named extensions installed under `root`, each imported at most once per process. One that
 * fails to load, or takes over ten seconds, is skipped, and `broken` says why. Only extensions
 * that are turned on should be named: loading one runs its code.
 */
export async function loadInstalled(root: string, names: string[]): Promise<Extension[]> {
  const out: Extension[] = []
  for (const name of names.filter((n) => installed(root).includes(n))) {
    const key = join(folder(root), name)
    if (!loaded.has(key)) loaded.set(key, checked(key, name))
    const ext = await loaded.get(key)!
    if (ext) out.push(ext)
  }
  return out
}

async function checked(dir: string, name: string): Promise<Extension | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    const late = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error("it took over ten seconds to load")), 10_000)))
    const ext = await Promise.race([load(dir), late])
    if (ext.name !== name) throw new Error(`it calls itself ${ext.name}, but is installed as ${name}`)
    return ext
  } catch (err) {
    broken.set(name, (err as Error).message)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Extensions that failed to load, by folder name, with why. */
export const broken = new Map<string, string>()

/** Imports one extension folder and checks what it exports. */
export async function load(dir: string): Promise<Extension> {
  let main = "index.js"
  try {
    main = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).main ?? main
  } catch {}
  const mod = await import(pathToFileURL(join(dir, main)).href)
  const ext = (mod.default ?? mod) as Extension
  if (!ext || typeof ext.name !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(ext.name)) throw new Error("its default export needs a name: lowercase letters, digits and dashes")
  if (ext.harness && (ext.harness.name !== ext.name || typeof ext.harness.run !== "function")) throw new Error("its harness needs the extension's name and a run function")
  return ext
}
