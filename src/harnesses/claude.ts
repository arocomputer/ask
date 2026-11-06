// The claude harness: a turn for a claude/MODEL model runs with the user's own Claude Code.
// ask starts the unmodified `claude` the user installed, which signs in its own way; ask never
// reads, stores or passes on Claude credentials (code.claude.com/docs/en/legal-and-compliance).
//
// Each run is kept to the task with Claude Code's documented controls. --restricted confines
// its file tools to the task's folder, removes the tools that run code unless --tools names
// them, and ignores every settings file, so neither the user's nor a repository's settings can
// change the run. Also: no hooks, no MCP servers (strict, empty config), no slash commands, no
// auto memory, no background tasks, and nothing that would prompt (--permission-prompts none
// refuses it). A read-only task gets Read, Grep, Glob and WebSearch (Anthropic's hosted search,
// which runs on their side, not here). A write task also gets Edit, Write and Bash; where Claude Code's sandbox can run (macOS, or Linux with bubblewrap and
// socat), Bash runs in it, strictly: writes only to the folder and a temp folder, the home
// folder unreadable, no network, no retrying outside it; where it can't, write tasks are
// refused. Commands never get API keys from the
// environment. Empty decoys its sandbox leaves in the folder are removed after each run. One Claude session backs a run of claude/ turns: --session-id on the first,
// --resume after. Markers Claude Code puts in its children's environment are removed, so the
// Claude ask starts doesn't take itself for part of the session that called ask.
// Explicit sandbox:false omits --restricted and disables Bash confinement; the selected tool
// list and credential environment filtering remain in place.

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { isAbsolute, join, relative } from "node:path"
import { before, environment, execute, failure, home, locate, tidy, which, type Harness, type Outcome, type Run, type Settings } from "./harness.ts"
import type { Message, Usage } from "../providers/stream.ts"
import { framing } from "../agent/system.ts"

const install = "https://code.claude.com/docs/en/setup"
const signIn = "run claude, sign in with /login, then try again"
const tooOld = "update it with claude update"
const unsandboxed = process.platform === "linux" ? "install bubblewrap and socat for write tasks, like sudo apt install bubblewrap socat" : "Claude Code's write tasks need macOS or Linux"
const markers = /^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_\w+|SESSION_ATTENDED)|CLAUDE_PID|CLAUDE_EFFORT)$/

/** The Claude Code to run: config's command (a path, or a name on PATH), else `claude` where its installers put it. */
export function command(settings: Settings): string | undefined {
  return locate(settings.command ?? "claude", [join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"])
}

/** True when Claude Code's Bash sandbox can run here, so write tasks require it. */
export function sandboxed(platform = process.platform): boolean {
  if (platform === "darwin") return true
  return platform === "linux" && !!which("bwrap") && !!which("socat")
}

/** The arguments and extra environment for one run. */
export function invocation(r: Run, session: string, resume: boolean, sandbox = sandboxed()): { args: string[]; env: NodeJS.ProcessEnv } {
  const settings: Record<string, unknown> = { disableAllHooks: true }
  if (r.sandbox === false) settings.sandbox = { enabled: false }
  else if (r.write && sandbox) {
    settings.sandbox = { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }
    settings.permissions = { blockReadsOutsideWorkingDirectories: true }
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    r.model,
    ...(resume ? ["--resume", session] : ["--session-id", session]),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    ...(r.sandbox === false ? [] : ["--restricted"]),
    "--permission-prompts",
    "none",
    "--settings",
    JSON.stringify(settings),
    "--append-system-prompt",
    framing(),
  ]
  if (r.write) args.push("--tools", "Read,Grep,Glob,WebSearch,Edit,Write,Bash", "--allowedTools", "Bash,WebSearch", "--permission-mode", "acceptEdits")
  else args.push("--tools", "Read,Grep,Glob,WebSearch", "--allowedTools", "Read,Grep,Glob,WebSearch", "--permission-mode", "dontAsk")
  if (r.effort) args.push("--effort", r.effort)
  if (r.schema) args.push("--json-schema", JSON.stringify(r.schema))
  // Not CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: on Linux it forces the sandbox on every command, which
  // fails where the sandbox can't run; ask strips API keys from the environment itself.
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }
  if (!r.write) {
    // Claude Code runs git for context: no optional locks, so status never rewrites the index,
    // and core.fsmonitor off, so the repository's config can't start a command.
    const n = Number(process.env.GIT_CONFIG_COUNT) || 0
    Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "core.fsmonitor", [`GIT_CONFIG_VALUE_${n}`]: "false" })
  }
  return { args: [...args, ...(r.settings.args ?? [])], env }
}

/** ask's name and arguments for a Claude Code tool call, with paths relative to the task's folder. */
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
    case "WebSearch":
      return { name: "search", arguments: JSON.stringify({ query: s("query") }) }
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

const carryOn = "Carry on with the task where you left off, and finish it."

async function once(r: Run, session: string, resume: boolean): Promise<Outcome> {
  const messages: Message[] = [...r.messages, ...(r.prompt === undefined ? [] : [{ role: "user" as const, text: r.prompt }])]
  const usage: Usage = { input: 0, output: 0, cached: 0 }
  const end = (o: Partial<Outcome>, steps = 0): Outcome => ({ ...o, messages, usage, steps })
  const cli = command(r.settings)
  if (!cli) return end({ error: { message: "Claude Code isn't installed", hint: `install it (${install}), sign in, then try again` } })
  if (r.write && r.sandbox !== false && !sandboxed()) return end({ error: { message: "Claude Code's sandbox can't run here, and write tasks need it", hint: unsandboxed } })
  r.onSession(session)
  const { args, env } = invocation(r, session, resume)
  const earlier = before(r.dir)
  let result: Record<string, any> | undefined
  let steps = 0
  const done = await execute({
    command: cli,
    args,
    env: environment(markers, r.settings, env),
    dir: r.dir,
    input: (r.history ? `${r.history}\n\n` : "") + (r.prompt ?? carryOn),
    signal: r.signal,
    onLine(line) {
      let e: Record<string, any>
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if (e.type === "result") result = e
      else if (e.type === "assistant") {
        const blocks = (e.message?.content ?? []) as Record<string, any>[]
        const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), ...translate(String(b.name), b.input ?? {}, r.dir) }))
        const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("")
        if (!calls.length && !text) return
        messages.push({ role: "assistant", text, calls })
        steps++
        r.onUpdate(messages, usage)
      } else if (e.type === "user") {
        for (const b of (e.message?.content ?? []) as Record<string, any>[]) {
          if (b?.type !== "tool_result") continue
          const content = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : String(b.content ?? "")
          messages.push({ role: "tool", id: String(b.tool_use_id), name: "", output: b.is_error ? `error: ${content.replace(/<\/?tool_use_error>/g, "")}` : content.slice(0, 4000) })
        }
        r.onUpdate(messages, usage)
      }
    },
  })
  tidy(r.dir, earlier)
  if (r.signal?.aborted) return end({ error: { message: "stopped" } }, steps)
  const u = result?.usage ?? {}
  usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  usage.output = u.output_tokens ?? 0
  usage.cached = u.cache_read_input_tokens ?? 0
  const signedOut = /not logged in|\/login|please run.*login/i
  if (!result && /unknown option/i.test(done.stderr)) return end({ error: { message: "this Claude Code is too old for ask", hint: tooOld } }, steps)
  if (!result) return end({ error: failure(done.stderr.trim().split("\n").pop() || `Claude Code exited with status ${done.code}`, signedOut, signIn) }, steps)
  if (result.is_error) return end({ error: failure(String(result.result || result.subtype || "Claude Code reported an error"), signedOut, signIn) }, steps)
  const answer = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : String(result.result ?? "").trim()
  return end(answer ? { answer } : { error: { message: "Claude Code gave no answer", hint: "continue the session to ask again" } }, steps)
}

const claude: Harness = {
  name: "claude",
  command: "claude",
  title: "Claude Code",
  models: (catalog) => [
    { id: "sonnet", name: "Sonnet (Claude Code's current)" },
    { id: "opus", name: "Opus (Claude Code's current)" },
    { id: "fable", name: "Fable (Claude Code's current)" },
    { id: "haiku", name: "Haiku (Claude Code's current)" },
    ...Object.values(catalog.anthropic?.models ?? {}).map((m) => ({ id: m.id, name: m.name })),
  ],
  status(settings) {
    const cli = command(settings)
    if (!cli) return { ready: false, detail: "Claude Code isn't installed", fix: `install it: ${install}` }
    const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout?.trim().split(" ")[0] ?? ""
    const help = spawnSync(cli, ["--help"], { encoding: "utf8", timeout: 15_000 }).stdout ?? ""
    if (!help.includes("--restricted") || !help.includes("--permission-prompts")) return { ready: false, detail: `Claude Code ${version} is too old for ask`, fix: tooOld }
    try {
      const s = JSON.parse(spawnSync(cli, ["auth", "status"], { encoding: "utf8", timeout: 15_000 }).stdout)
      const signedIn = `Claude Code ${version} is signed in${s.authMethod ? ` (${s.authMethod})` : ""}`
      if (s.loggedIn && sandboxed()) return { ready: true, detail: signedIn }
      if (s.loggedIn) return { ready: true, detail: `${signedIn}; read-only tasks only, as its sandbox can't run here`, fix: unsandboxed }
    } catch {}
    return { ready: false, detail: `Claude Code ${version} isn't signed in`, fix: "run claude and sign in with /login" }
  },
  /**
   * Runs a turn. A resumed turn whose Claude session was never saved (stopped before Claude
   * wrote it) starts that session afresh with the turn's prompt.
   */
  async run(r) {
    const resume = !!r.session
    const first = await once(r, r.session ?? randomUUID(), resume)
    if (!resume || !/no conversation found/i.test(first.error?.message ?? "")) return first
    const last = r.messages.findLastIndex((m) => m.role === "user")
    const prompt = r.prompt ?? (last >= 0 ? (r.messages[last] as { text: string }).text : undefined)
    return once({ ...r, prompt, messages: r.prompt === undefined && last >= 0 ? r.messages.slice(0, last) : r.messages }, r.session!, false)
  },
  parent: (env) => (env.CLAUDE_CODE_SESSION_ID ? `claude:${env.CLAUDE_CODE_SESSION_ID}` : undefined),
}

export default claude
