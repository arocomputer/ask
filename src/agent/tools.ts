// The subagent's tools: read, list, grep, git (git.ts) and fetch (fetch.ts), plus write, edit
// and shell in a write turn. Filesystem tools run in credential-free, OS-confined children;
// read-only tools get no workspace write grant. Path checks narrow their interface. Every result is
// bounded, and says how to get more when it was cut.

import { execFile, spawn } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { open as confine } from "../sandbox/confine.ts"
import type { ToolSpec } from "../providers/stream.ts"
import { result, type Context } from "./context.ts"
import { fetch } from "./fetch.ts"
import { git } from "./git.ts"

/** Where a tool comes from and who wrote it. */
export type ToolSource = { extension?: string; builtin?: boolean }

/** What a tool needs to run: set by the loop, not by whoever registered it. */
export type ToolSpace = { source?: ToolSource }

/** A capability Code Mode may call. `readonly` tools may run in parallel. Throws reject in the script. */
export type Tool = ToolSpec & {
  readonly: boolean
  /**
   * The fields a script finds on this tool's result besides its text, written as a type like
   * "{ stdout: string, exitCode: number }". When set, Code Mode calls `run` with
   * `format: "json"` added to the arguments and expects JSON `{ text, data }` back; see
   * `result` in context.ts. Other callers get the text. A `paths` field makes the result the
   * array of those paths in a script.
   */
  structured?: string
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
  const files = [read, list, grep, git, ...(write ? [writeTool, edit] : [])]
  return [...files.map((tool) => ({ ...tool, run: (args: Args, ctx: Context) => isolated(tool, args, ctx) })), fetch, ...(write ? [{ ...shell, async run(args: Args, ctx: Context) {
    if (ctx.sandbox) return shell.run(args, ctx)
    const sandbox = await confine(ctx.dir)
    try { return await shell.run(args, { ...ctx, sandbox }) }
    finally { await sandbox.close() }
  } }] : [])]
}

/** Run filesystem tools in a credential-filtered child, honoring the turn's confinement choice. */
async function isolated(tool: Tool, args: Args, ctx: Context): Promise<string> {
  const sb = await confine(ctx.dir, !tool.readonly, ctx.sandbox?.enabled ?? true)
  try {
    const script = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../files.ts" : "../files.js", import.meta.url))
    const bundled = script.startsWith("/$bunfs")
    const command = sb.execute([process.execPath, ...(bundled ? ["__tool"] : [script]), tool.name], [process.execPath, ...(bundled ? [] : [dirname(script), join(dirname(script), "..", "package.json")])])
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command.file, command.args, { cwd: ctx.dir, env: command.env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
      const chunks: Buffer[] = []
      const stderr = collector()
      let bytes = 0
      let failure = ""
      const kill = (reason: string) => {
        failure ||= reason
        group(child.pid, "SIGKILL")
      }
      const stop = () => kill("stopped")
      const timer = setTimeout(() => kill("timed out after 120 seconds"), 120_000)
      ctx.signal?.addEventListener("abort", stop, { once: true })
      if (ctx.signal?.aborted) stop()
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) kill("output limit exceeded")
        else chunks.push(chunk)
      })
      child.stderr.on("data", stderr.add)
      child.on("error", (err) => { failure = err.message })
      child.on("close", (code) => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener("abort", stop)
        if (failure || code !== 0) return reject(new Error(`confined ${tool.name} failed: ${failure || stderr.text(4000) || `exit ${code}`}`))
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          if (response.error) reject(new Error(response.error))
          else resolve(response.result)
        } catch (error) { reject(error) }
      })
      child.stdin?.on("error", () => {})
      child.stdin?.end(JSON.stringify(args))
    })
  } finally { await sb.close() }
}

/** Internal child entry point. Only local filesystem tools are available here. */
export async function toolMain(name: string, input: string): Promise<string> {
  const tool = [read, list, grep, git, writeTool, edit, project].find((t) => t.name === name)
  try {
    if (!tool) throw new Error("unknown filesystem tool")
    return JSON.stringify({ result: await tool.run(JSON.parse(input), { dir: process.cwd() }) })
  } catch (err) { return JSON.stringify({ error: (err as Error).message }) }
}

/** Load parent-directory instructions without giving the credential-bearing process file access. */
export function projectInstructions(dir: string, root: string, sandbox?: Context["sandbox"]): Promise<string> {
  return isolated(project, { path: dir }, { dir: root, sandbox })
}

/** Internal instruction loader; never offered as a model tool. */
const project: Tool = {
  name: "__project", description: "Load repository instructions", parameters: {}, readonly: true,
  async run(args, { dir }) {
    const root = await realpath(dir)
    for (let d = await resolve(dir, str(args, "path")); ; d = dirname(d)) {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        try {
          const path = await resolve(root, join(d, name))
          const text = (await contents(path)).toString("utf8").trim()
          return text.length > 32 * 1024 ? text.slice(0, 32 * 1024) + "\n[truncated]" : text
        } catch {}
      }
      if (d === root || dirname(d) === d) return ""
    }
  },
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

/** Read one regular, singly linked file; aliases cannot bypass the environment-file guard. */
async function contents(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error("only regular files without hard-link aliases can be read")
    return await file.readFile()
  } finally { await file.close() }
}

const patternNote = "A pattern without a slash matches file names anywhere, like *.ts; with a slash it matches paths, like src/**/*.ts."

const read: Tool = {
  name: "read",
  description: `Read a text file, up to ${lineLimit} lines or 64 KiB from an optional 1-based line. It prints with line numbers, as N<tab>text, for citing lines; content is the same text without them, for parsing; nextLine is where to continue, or null at the end.`,
  parameters: schema(
    {
      path: { type: "string", description: "File path, relative to the working directory" },
      line: { type: "integer", description: "1-based line to start from" },
      limit: { type: "integer", description: `Maximum lines to read (1–${lineLimit})` },
    },
    ["path"],
  ),
  readonly: true,
  structured: "{ content: string, startLine: number, nextLine: number | null, clipped: boolean, binary: boolean }",
  async run(args, { dir }) {
    const path = await resolve(dir, str(args, "path"))
    if (secret(path)) throw new Error(`${str(args, "path")} is an environment file, which holds secrets, so read doesn't open it; its example, like .env.example, is fine`)
    const b = await contents(path)
    const start = Math.max(1, Math.floor(num(args, "line") ?? 1))
    const limit = Math.min(lineLimit, Math.max(1, Math.floor(num(args, "limit") ?? lineLimit)))
    if (b.subarray(0, 8192).includes(0))
      return result(args, `${str(args, "path")} is a binary file of ${b.length} bytes`, { content: "", startLine: start, nextLine: null, clipped: false, binary: true })
    const lines = b.toString("utf8").split("\n")
    const newline = lines.at(-1) === "" && b.length > 0
    if (lines.at(-1) === "") lines.pop()
    if (start > Math.max(lines.length, 1)) throw new Error(`${str(args, "path")} has only ${lines.length} lines`)
    // One page serves both views: whole lines within a budget that counts their JSON-escaped
    // size and line number, so neither the numbered text nor the content outgrows the bridge.
    const budget = readLimit - 256
    const page: string[] = []
    let bytes = 0
    let clipped = false
    let n = start
    for (; n <= lines.length && n < start + limit; n++) {
      const line = lines[n - 1] + (newline || n < lines.length ? "\n" : "")
      const size = Buffer.byteLength(JSON.stringify(line)) + 8
      if (bytes + size > budget) {
        if (page.length) break
        let lo = 0
        let hi = Math.min(line.length, readLimit)
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          if (Buffer.byteLength(JSON.stringify(line.slice(0, mid))) + 8 <= budget) lo = mid
          else hi = mid - 1
        }
        if (/[\uD800-\uDBFF]/.test(line[lo - 1] ?? "")) lo--
        page.push(line.slice(0, lo))
        clipped = true
        n++
        break
      }
      page.push(line)
      bytes += size
    }
    let text = ""
    for (const [i, raw] of page.entries()) {
      const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw
      text += `${start + i}\t${line.length > 2000 ? line.slice(0, 2000) + "…" : line}\n`
    }
    if (n <= lines.length) text += `[${lines.length - n + 1} more lines; continue from line ${n}]`
    return result(args, text || "(empty file)", { content: page.join(""), startLine: start, nextLine: n <= lines.length ? n : null, clipped, binary: false })
  },
}

const list: Tool = {
  name: "list",
  description: `List a directory's entries, directories with a trailing slash; or with pattern, every file below it that matches. ${patternNote} Omit path for the working directory. Paths are relative to the working directory, as read takes them, and the result is also their array: for (const path of await tools.list({ pattern: "*.json" })).`,
  parameters: schema({
    path: { type: "string", description: "Directory path, relative to the working directory" },
    pattern: { type: "string", description: "Glob of files to find recursively" },
  }),
  readonly: true,
  structured: "{ paths: string[], truncated: boolean }",
  async run(args, { dir }) {
    const path = await resolve(dir, str(args, "path"))
    const root = await realpath(dir)
    const pattern = str(args, "pattern")
    let names: string[]
    if (pattern) {
      const match = matcher(pattern)
      names = (await files(path)).filter(match)
    } else {
      const entries = await readdir(path, { withFileTypes: true })
      names = entries.filter((e) => e.name !== ".git").map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    }
    // Shown from the working directory, like grep's paths, so each can go straight to read.
    const paths = names.map((name) => relative(root, join(path, name)) + (name.endsWith("/") ? "/" : "")).sort()
    const truncated = paths.length > listLimit
    const shown = paths.slice(0, listLimit)
    const text = !paths.length ? (pattern ? "(no matches)" : "(empty)")
      : truncated ? [...shown, `[${paths.length - listLimit} more; narrow the path or pattern]`].join("\n") : shown.join("\n")
    return result(args, text, { paths: shown, truncated })
  },
}

const grep: Tool = {
  name: "grep",
  description: `Search file contents with a JavaScript regular expression, recursively from path (default: the working directory): the quickest way to find where something is defined or used. (?i) ignores case. It prints matching lines as path:line:text, at most ${matchLimit}; several narrow searches beat one broad one. ${patternNote}`,
  parameters: schema(
    {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "File or directory to search" },
      glob: { type: "string", description: "Only files matching this pattern" },
      limit: { type: "integer", description: `Maximum matches to return (1–${matchLimit})` },
    },
    ["pattern"],
  ),
  readonly: true,
  structured: "{ matches: { path: string, line: number, text: string }[], truncated: boolean }",
  async run(args, { dir, signal }) {
    const source = str(args, "pattern")
    if (!source) throw new Error("pattern is required")
    // Flags written the way other dialects write them, as (?i), which JavaScript rejects.
    // Wherever one sits, it applies to the whole pattern.
    const flags = new Set<string>()
    const pattern = source.replace(/(?<!\\)\(\?([ims]+)\)/g, (_, set: string) => { for (const flag of set) flags.add(flag); return "" })
    let re: RegExp
    let note = ""
    try {
      re = new RegExp(pattern, [...flags].join(""))
    } catch (err) {
      // Usually a parenthesis whose backslash a string literal swallowed, or a glob: search for
      // the text itself and say so, rather than spend a turn on the error.
      re = new RegExp(pattern.split("|").filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)", [...flags].join(""))
      note = `\n[the pattern is not a valid regular expression (${(err as Error).message}), so ${pattern.includes("|") ? "each |-separated part" : "it"} was searched for as plain text]`
    }
    const path = await resolve(dir, str(args, "path"))
    const root = await realpath(dir)
    const isFile = (await stat(path)).isFile()
    const base = isFile ? dirname(path) : path
    let list = isFile ? [relative(base, path)] : await files(path)
    list.sort()
    if (str(args, "glob")) list = list.filter(matcher(str(args, "glob")))
    const matches: { path: string; line: number; text: string }[] = []
    const limit = Math.min(matchLimit, Math.max(1, Math.floor(num(args, "limit") ?? matchLimit)))
    let truncated = false
    scan: for (const rel of list) {
      signal?.throwIfAborted()
      if (secret(rel)) continue
      const full = await resolve(dir, join(base, rel)).catch(() => undefined)
      if (!full || secret(full)) continue
      const b = await contents(full).catch(() => undefined)
      if (!b || b.length > 2 * 1024 * 1024 || b.subarray(0, 8192).includes(0)) continue
      const shown = relative(root, join(base, rel))
      const lines = b.toString("utf8").split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        if (matches.length === limit) { truncated = true; break scan }
        const line = lines[i].length > 300 ? lines[i].slice(0, 300) + "…" : lines[i]
        matches.push({ path: shown, line: i + 1, text: line })
      }
    }
    const text = matches.length
      ? matches.map(({ path, line, text }) => `${path}:${line}:${text}`).join("\n") + (truncated ? "\n[more matches not shown; narrow the pattern or path]" : "")
      : "(no matches; try a shorter pattern, another spelling, or a wider path)"
    return result(args, text + note, { matches, truncated })
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
    const text = (await contents(path)).toString("utf8")
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
  description: "Run a shell command in the working directory, with no input: for building, testing and running things. It prints the exit status, then the output. To look at files, read, list and grep are faster. Long output keeps its start and end. Default timeout 120 seconds, at most 600.",
  parameters: schema(
    { command: { type: "string" }, timeout: { type: "integer", description: "Seconds before the command is stopped" } },
    ["command"],
  ),
  readonly: false,
  structured: "{ exitCode: number | null, stdout: string, stderr: string }",
  run(args, { dir, signal, sandbox }) {
    const command = str(args, "command")
    if (!command.trim()) return Promise.reject(new Error("command is required"))
    if (!sandbox) return Promise.reject(new Error("shell requires an OS sandbox"))
    const run = sandbox.command(command)
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
      if (signal?.aborted) abort()
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
        done(result(args, out, { exitCode: ended || sig ? null : code, stdout: o, stderr: e }))
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
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
