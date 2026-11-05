// Running a turn with the user's own Claude Code, for models named claude/MODEL. ask starts the
// unmodified `claude` the user installed, which signs in its own way; ask never reads, stores
// or passes on Claude credentials (code.claude.com/docs/en/legal-and-compliance). This is the
// one engine module that names a coding agent.
//
// Each run is kept to the task through Claude Code's documented controls: no hooks
// (disableAllHooks), no MCP servers (strict, empty config), no slash commands, only the user's
// own settings (a repository's .claude/ settings can't change the run), no auto memory and no
// background tasks. A read-only task gets only Read, Grep and Glob, with every other tool
// refused; a write task gets Claude Code's tools without permission prompts. One Claude session
// backs each ask session: --session-id on the first turn, --resume after.

import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, relative } from "node:path"
import type { Failure } from "./loop.ts"
import type { Message, Usage } from "./provider.ts"

/** The aliases Claude Code takes for its current models, offered before full ids. */
export const aliases = [
  { id: "sonnet", name: "Sonnet (Claude Code's current)" },
  { id: "opus", name: "Opus (Claude Code's current)" },
  { id: "fable", name: "Fable (Claude Code's current)" },
  { id: "haiku", name: "Haiku (Claude Code's current)" },
]

/** The installed claude: the first on PATH, else where Claude Code's installers put it. */
export function binary(env = process.env): string | undefined {
  const home = homedir()
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"]
  for (const dir of dirs) {
    const path = join(dir, "claude")
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return path
    } catch {}
  }
  return undefined
}

/** What `claude auth status` says about the sign-in, without ask touching any credential. */
export function status(): { installed: boolean; signedIn: boolean; method?: string; version?: string } {
  const cli = binary()
  if (!cli) return { installed: false, signedIn: false }
  const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout?.trim().split(" ")[0]
  const out = spawnSync(cli, ["auth", "status"], { encoding: "utf8", timeout: 15_000 })
  try {
    const s = JSON.parse(out.stdout)
    return { installed: true, signedIn: !!s.loggedIn, method: s.authMethod, version }
  } catch {
    return { installed: true, signedIn: false, version }
  }
}

export type ClaudeOptions = {
  model: string
  dir: string
  /** The prompt; without one, Claude carries on with the session where it stopped. */
  prompt?: string
  write: boolean
  effort?: string
  schema?: object
  /** The Claude session to resume; a new one is made when absent. */
  session?: string
  signal?: AbortSignal
  /** Hears the session id as soon as it is chosen, then the conversation after every step. */
  onSession?: (id: string) => void
  onUpdate?: (messages: Message[], usage: Usage) => void
  messages?: Message[]
}

export type ClaudeResult = { answer?: string; error?: Failure; messages: Message[]; usage: Usage; steps: number }

const carryOn = "Carry on with the task where you left off, and finish it."

/** The arguments and environment for one run. */
export function command(o: ClaudeOptions, session: string, resume: boolean): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    o.model,
    ...(resume ? ["--resume", session] : ["--session-id", session]),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--setting-sources",
    "user",
    "--settings",
    '{"disableAllHooks":true}',
  ]
  if (o.write) args.push("--permission-mode", "bypassPermissions")
  else args.push("--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write,NotebookEdit", "--permission-mode", "manual")
  if (o.effort) args.push("--effort", o.effort)
  if (o.schema) args.push("--json-schema", JSON.stringify(o.schema))
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }
  if (!o.write) {
    // Claude Code runs git for context: no optional locks, so status never rewrites the index,
    // and core.fsmonitor off, so the repository's config can't start a command.
    const n = Number(env.GIT_CONFIG_COUNT) || 0
    Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "core.fsmonitor", [`GIT_CONFIG_VALUE_${n}`]: "false" })
  }
  return { args, env }
}

/**
 * ask's name and arguments for a Claude Code tool call, so its steps read like any other task's,
 * with paths relative to the task's folder.
 */
function translate(name: string, input: Record<string, unknown>, dir: string): { name: string; arguments: string } {
  const s = (k: string) => {
    const v = typeof input[k] === "string" ? (input[k] as string) : undefined
    if (!v || !isAbsolute(v) || k === "command" || k === "pattern") return v
    const rel = relative(dir, v)
    return rel.startsWith("..") ? v : rel || "."
  }
  switch (name) {
    case "Read":
      return { name: "read", arguments: JSON.stringify({ path: s("file_path"), line: input.offset }) }
    case "Grep":
      return { name: "grep", arguments: JSON.stringify({ pattern: s("pattern"), path: s("path"), glob: s("glob") }) }
    case "Glob":
      return { name: "list", arguments: JSON.stringify({ pattern: s("pattern"), path: s("path") }) }
    case "Bash":
      return { name: "shell", arguments: JSON.stringify({ command: s("command") }) }
    case "Write":
      return { name: "write", arguments: JSON.stringify({ path: s("file_path") }) }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { name: "edit", arguments: JSON.stringify({ path: s("file_path") ?? s("notebook_path") }) }
    default:
      return { name, arguments: JSON.stringify(input) }
  }
}

/**
 * Runs one turn with Claude Code, saving the conversation after every step. A resumed turn
 * whose Claude session was never saved (stopped before Claude wrote it) starts it afresh.
 */
export async function runClaude(o: ClaudeOptions): Promise<ClaudeResult> {
  const first = await once(o)
  if (o.session && /no conversation found/i.test(first.error?.message ?? "")) {
    const all = o.messages ?? []
    const last = all.findLastIndex((m) => m.role === "user")
    const prompt = o.prompt ?? (last >= 0 ? (all[last] as { text: string }).text : undefined)
    return once({ ...o, session: undefined, prompt, messages: o.prompt === undefined && last >= 0 ? all.slice(0, last) : all, fresh: o.session })
  }
  return first
}

async function once(o: ClaudeOptions & { fresh?: string }): Promise<ClaudeResult> {
  const messages: Message[] = [...(o.messages ?? []), ...(o.prompt === undefined ? [] : [{ role: "user" as const, text: o.prompt }])]
  const usage: Usage = { input: 0, output: 0, cached: 0 }
  const end = (r: Partial<ClaudeResult>, steps = 0): ClaudeResult => ({ ...r, messages, usage, steps })
  const cli = binary()
  if (!cli) return end({ error: { message: "Claude Code isn't installed", hint: "install it from https://claude.com/claude-code, sign in, then try again" } })
  const resume = !!o.session
  const session = o.session ?? o.fresh ?? randomUUID()
  o.onSession?.(session)
  const { args, env } = command(o, session, resume)
  const child = spawn(cli, args, { cwd: o.dir, env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
  const stop = () => {
    try {
      process.kill(-child.pid!, "SIGTERM")
    } catch {}
  }
  o.signal?.addEventListener("abort", stop, { once: true })
  child.stdin.on("error", () => {})
  child.stdin.end(o.prompt ?? carryOn)
  let result: Record<string, any> | undefined
  let stderr = ""
  let buffer = ""
  let steps = 0
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)))
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buffer += d
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      let e: Record<string, any>
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e.type === "result") result = e
      else if (e.type === "assistant") {
        const blocks = (e.message?.content ?? []) as Record<string, any>[]
        const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), ...translate(String(b.name), b.input ?? {}, o.dir) }))
        const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("")
        if (!calls.length && !text) continue
        messages.push({ role: "assistant", text, calls })
        steps++
        o.onUpdate?.(messages, usage)
      } else if (e.type === "user") {
        for (const b of (e.message?.content ?? []) as Record<string, any>[]) {
          if (b?.type !== "tool_result") continue
          const content = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : String(b.content ?? "")
          messages.push({ role: "tool", id: String(b.tool_use_id), name: "", output: b.is_error ? `error: ${content.replace(/<\/?tool_use_error>/g, "")}` : content.slice(0, 4000) })
        }
        o.onUpdate?.(messages, usage)
      }
    }
  })
  const code = await new Promise<number | null>((ok) => child.on("close", ok))
  o.signal?.removeEventListener("abort", stop)
  if (o.signal?.aborted) return end({ error: { message: "stopped" } }, steps)
  const u = result?.usage ?? {}
  usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  usage.output = u.output_tokens ?? 0
  usage.cached = u.cache_read_input_tokens ?? 0
  if (!result) {
    const why = stderr.trim().split("\n").pop() || `Claude Code exited with status ${code}`
    return end({ error: explain(why) }, steps)
  }
  if (result.is_error) return end({ error: explain(String(result.result || result.subtype || "Claude Code reported an error")) }, steps)
  const answer = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : String(result.result ?? "").trim()
  if (!answer) return end({ error: { message: "Claude Code gave no answer", hint: "continue the session to ask again" } }, steps)
  return end({ answer }, steps)
}

/** A Claude Code failure, with what to do when it is about signing in. */
function explain(message: string): Failure {
  if (/not logged in|\/login|please run.*login|authenticat/i.test(message))
    return { message: `Claude Code isn't signed in: ${message}`, hint: "run claude, sign in with /login, then try again" }
  return { message }
}
