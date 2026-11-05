// The subagent's tools: read, list, grep, git (git.ts) and fetch (fetch.ts), plus write, edit
// and shell in a write turn. A read turn has no way to change a file or start a process; that is how ask
// enforces read-only. Paths are confined to the working directory, symlinks included. Every result is
// bounded, and says how to get more when it was cut.

import { execFile, spawn } from "node:child_process"
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path"
import type { ToolSpec } from "../providers/stream.ts"
import type { Sandbox } from "../sandbox/confine.ts"
import { fetch } from "./fetch.ts"
import { git } from "./git.ts"

/**
 * What a tool runs with: the task's folder, the turn's stop signal, and in a write turn the
 * sandbox every command must run in.
 */
export type Context = { dir: string; signal?: AbortSignal; sandbox?: Sandbox }

/** A tool the model may call. `readonly` tools may run in parallel. Errors become "error: ..." for the model. */
export type Tool = ToolSpec & {
  readonly: boolean
  run(args: Args, ctx: Context): Promise<string>
}

export type Args = Record<string, unknown>

const readLimit = 64 * 1024
const lineLimit = 2000
const outputLimit = 32 * 1024
const listLimit = 500
const matchLimit = 200
const fileLimit = 20_000

/** The tools for a turn: read-only, or with write, edit and shell too. */
export function tools(write: boolean): Tool[] {
  return write ? [read, list, grep, git, fetch, writeTool, edit, shell] : [read, list, grep, git, fetch]
}

function schema(properties: object, required: string[] = []): object {
  return { type: "object", properties, required, additionalProperties: false }
}

/**
 * Environment files hold a project's real secrets, so read refuses them and grep skips them;
 * their examples stay readable. A write task's shell can still open them: the sandbox works by
 * folder, not by file.
 */
export function secret(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? ""
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist|defaults)$/.test(name)
}

const patternNote = "A pattern without a slash matches file names anywhere, like *.ts; with a slash it matches paths, like src/**/*.ts."

const read: Tool = {
  name: "read",
  description: `Read a text file. Each line comes numbered as N<tab>text. Returns up to ${lineLimit} lines or 64 KiB from the optional 1-based start line; call again with a later line for more.`,
  parameters: schema(
    { path: { type: "string", description: "File path, relative to the working directory" }, line: { type: "integer", description: "1-based line to start from" } },
    ["path"],
  ),
  readonly: true,
  async run(args, { dir }) {
    const path = await resolve(dir, str(args, "path"))
    if (secret(path)) throw new Error(`${str(args, "path")} is an environment file, which holds secrets, so read doesn't open it; its example, like .env.example, is fine`)
    const b = await readFile(path)
    if (b.subarray(0, 8192).includes(0)) return `${str(args, "path")} is a binary file of ${b.length} bytes`
    const lines = b.toString("utf8").split("\n")
    if (lines.at(-1) === "") lines.pop()
    const start = Math.max(1, Math.floor(num(args, "line") ?? 1))
    if (start > Math.max(lines.length, 1)) throw new Error(`${str(args, "path")} has only ${lines.length} lines`)
    let out = ""
    let n = start
    for (; n <= lines.length && n < start + lineLimit; n++) {
      let line = lines[n - 1]
      if (line.length > 2000) line = line.slice(0, 2000) + "…"
      const next = `${n}\t${line}\n`
      if (out.length + next.length > readLimit) break
      out += next
    }
    if (n <= lines.length) out += `[${lines.length - n + 1} more lines; continue from line ${n}]`
    return out || "(empty file)"
  },
}

const list: Tool = {
  name: "list",
  description: `List a directory's entries, directories with a trailing slash; or with pattern, every file below it that matches. ${patternNote} Omit path for the working directory.`,
  parameters: schema({
    path: { type: "string", description: "Directory path, relative to the working directory" },
    pattern: { type: "string", description: "Glob of files to find recursively" },
  }),
  readonly: true,
  async run(args, { dir }) {
    const path = await resolve(dir, str(args, "path"))
    const pattern = str(args, "pattern")
    let names: string[]
    if (pattern) {
      const match = matcher(pattern)
      names = (await files(path)).filter(match)
    } else {
      const entries = await readdir(path, { withFileTypes: true })
      names = entries.filter((e) => e.name !== ".git").map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    }
    names.sort()
    if (!names.length) return pattern ? "(no matches)" : "(empty)"
    if (names.length > listLimit) return [...names.slice(0, listLimit), `[${names.length - listLimit} more; narrow the path or pattern]`].join("\n")
    return names.join("\n")
  },
}

const grep: Tool = {
  name: "grep",
  description: `Search file contents with a JavaScript regular expression, recursively from path (default: the working directory): the quickest way to find where something is defined or used. Returns matching lines as path:line:text, at most ${matchLimit}; several narrow searches beat one broad one. ${patternNote}`,
  parameters: schema(
    {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "File or directory to search" },
      glob: { type: "string", description: "Only files matching this pattern" },
    },
    ["pattern"],
  ),
  readonly: true,
  async run(args, { dir, signal }) {
    const source = str(args, "pattern")
    if (!source) throw new Error("pattern is required")
    let re: RegExp
    try {
      re = new RegExp(source)
    } catch (err) {
      throw new Error(`bad regular expression: ${(err as Error).message}`)
    }
    const path = await resolve(dir, str(args, "path"))
    const root = await realpath(dir)
    const isFile = (await stat(path)).isFile()
    const base = isFile ? dirname(path) : path
    let list = isFile ? [relative(base, path)] : await files(path)
    if (str(args, "glob")) list = list.filter(matcher(str(args, "glob")))
    const out: string[] = []
    for (const rel of list) {
      signal?.throwIfAborted()
      if (secret(rel)) continue
      const full = join(base, rel)
      const b = await readFile(full).catch(() => undefined)
      if (!b || b.length > 2 * 1024 * 1024 || b.subarray(0, 8192).includes(0)) continue
      const shown = relative(root, full)
      const lines = b.toString("utf8").split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        if (out.length === matchLimit) return out.join("\n") + "\n[more matches not shown; narrow the pattern or path]"
        const line = lines[i].length > 300 ? lines[i].slice(0, 300) + "…" : lines[i]
        out.push(`${shown}:${i + 1}:${line}`)
      }
    }
    return out.length ? out.join("\n") : "(no matches; try a shorter pattern, another spelling, or a wider path)"
  },
}

const writeTool: Tool = {
  name: "write",
  description: "Create or replace a file with the given content, creating parent directories.",
  parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  readonly: false,
  async run(args, { dir }) {
    const path = await resolve(dir, str(args, "path"))
    if (typeof args.content !== "string") throw new Error("content is required")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, args.content)
    return `wrote ${str(args, "path")}`
  },
}

const edit: Tool = {
  name: "edit",
  description: "Replace one exact occurrence of old with new in a file. Fails unless old occurs exactly once. Copy old from the file itself, without read's line numbers.",
  parameters: schema({ path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, ["path", "old", "new"]),
  readonly: false,
  async run(args, { dir }) {
    const path = await resolve(dir, str(args, "path"))
    const old = str(args, "old")
    if (!old) throw new Error("old must not be empty")
    const text = await readFile(path, "utf8")
    const count = text.split(old).length - 1
    if (count === 0) throw new Error(`old text not found in ${str(args, "path")}; read the file again and copy it exactly`)
    if (count > 1) throw new Error(`old text occurs ${count} times in ${str(args, "path")}; include more context`)
    const at = text.indexOf(old)
    await writeFile(path, text.slice(0, at) + str(args, "new") + text.slice(at + old.length))
    return `edited ${str(args, "path")}`
  },
}

const shell: Tool = {
  name: "shell",
  description: "Run a shell command in the working directory, with no input, and return its exit status and output: for building, testing and running things. To look at files, read, list and grep are faster. Long output keeps its start and end. Default timeout 120 seconds, at most 600.",
  parameters: schema(
    { command: { type: "string" }, timeout: { type: "integer", description: "Seconds before the command is stopped" } },
    ["command"],
  ),
  readonly: false,
  run(args, { dir, signal, sandbox }) {
    const command = str(args, "command")
    if (!command.trim()) return Promise.reject(new Error("command is required"))
    const run = sandbox ? sandbox.command(command) : { file: "sh", args: ["-c", command], env: toolEnv() }
    const seconds = Math.min(Math.max(num(args, "timeout") ?? 120, 1), 600)
    return new Promise((done) => {
      const child = spawn(run.file, run.args, { cwd: dir, env: run.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      const stdout = collector()
      const stderr = collector()
      child.stdout.on("data", stdout.add)
      child.stderr.on("data", stderr.add)
      let ended = ""
      const kill = (why: string) => {
        if (ended) return
        ended = why
        group(child.pid, "SIGTERM")
        setTimeout(() => group(child.pid, "SIGKILL"), 2000).unref()
      }
      const timer = setTimeout(() => kill(`timed out after ${seconds} seconds`), seconds * 1000)
      const abort = () => kill("stopped")
      signal?.addEventListener("abort", abort, { once: true })
      child.on("error", (err) => {
        ended ||= `cannot run sh: ${err.message}`
      })
      child.on("close", (code, sig) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        let out = ended ? `${ended}\n` : sig ? `killed by ${sig}\n` : `exit ${code}\n`
        const o = stdout.text(outputLimit)
        const e = stderr.text(outputLimit / 2)
        if (o) out += o.endsWith("\n") ? o : o + "\n"
        if (e) out += `stderr:\n${e}`
        done(out)
      })
    })
  },
}

/** Signals a whole process group, so a command's children stop with it. */
function group(pid: number | undefined, sig: NodeJS.Signals) {
  if (!pid) return
  try {
    process.kill(-pid, sig)
  } catch {}
}

/** Keeps the start and end of a stream, dropping the middle once it outgrows its limit. */
function collector() {
  let head = Buffer.alloc(0)
  let tail = Buffer.alloc(0)
  let total = 0
  const max = outputLimit
  return {
    add(b: Buffer) {
      total += b.length
      if (head.length < max / 4) {
        const room = max / 4 - head.length
        head = Buffer.concat([head, b.subarray(0, room)])
        b = b.subarray(room)
      }
      if (b.length) tail = Buffer.concat([tail, b]).subarray(-max)
    },
    /** The stream within `limit` bytes: whole, or its first quarter and its end. */
    text(limit: number) {
      const whole = total === head.length + tail.length ? Buffer.concat([head, tail]) : undefined
      if (whole && whole.length <= limit) return whole.toString("utf8")
      const start = (whole ?? head).subarray(0, limit / 4)
      const end = (whole ?? tail).subarray(-(limit - start.length))
      return `${start}\n[${total - start.length - end.length} bytes cut]\n${end}`
    },
  }
}

/** The environment commands run in: ask's, minus provider credentials and ask's own variables. */
function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.endsWith("_API_KEY") && !k.startsWith("ASK_")) env[k] = v
  return env
}

/** Confines a tool path to the working directory, resolving symlinks in the part that exists. */
export async function resolve(dir: string, path: string): Promise<string> {
  const root = await realpath(dir)
  const full = normalize(isAbsolute(path) ? path : join(dir, path || "."))
  let probe = full
  let rest = ""
  let real = full
  for (;;) {
    try {
      real = join(await realpath(probe), rest)
      break
    } catch {
      const parent = dirname(probe)
      if (parent === probe) break
      rest = join(probe.slice(parent.length + 1), rest)
      probe = parent
    }
  }
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} is outside the working directory`)
  return real
}

/**
 * Lists files below a directory, relative to it: git's tracked and unignored files inside a
 * repository, otherwise a walk that skips .git and node_modules.
 */
async function files(base: string): Promise<string[]> {
  const listed = await new Promise<string | undefined>((done) =>
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: base, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 },
      (err, out) => done(err ? undefined : out),
    ),
  )
  if (listed !== undefined) return listed.split("\0").filter(Boolean).slice(0, fileLimit)
  const out: string[] = []
  const walk = async (rel: string) => {
    const entries = await readdir(join(base, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= fileLimit) return
      if (e.name === ".git" || e.name === "node_modules") continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  await walk("")
  return out
}

/** Builds a test for a glob: `*`, `?`, `**` and `{a,b}`; without a slash it tests file names. */
export function matcher(glob: string): (path: string) => boolean {
  let re = ""
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      i++
      if (glob[i + 1] === "/") {
        i++
        re += "(?:.*/)?"
      } else re += ".*"
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else if (c === "{") (depth++, (re += "(?:"))
    else if (c === "}" && depth) (depth--, (re += ")"))
    else if (c === "," && depth) re += "|"
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&")
  }
  const test = new RegExp(`^${re}$`)
  return glob.includes("/") ? (p) => test.test(p) : (p) => test.test(p.slice(p.lastIndexOf("/") + 1))
}

function str(args: Args, key: string): string {
  const v = args[key]
  return typeof v === "string" ? v : ""
}

function num(args: Args, key: string): number | undefined {
  const v = args[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}
