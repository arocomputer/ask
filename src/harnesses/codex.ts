// The codex harness: a turn for a codex/MODEL model runs with the user's own Codex (`codex
// exec`), signed in its own way; ask never reads Codex's credentials. Each run skips the user's
// config.toml (its MCP servers, profiles and hooks) and execution-policy rules, never asks for
// approval, and runs its commands under a Codex permission profile ask defines: they may read
// the task's folder, the system and the toolchains on PATH, and nothing else (the home folder
// stays hidden); a write task may also write the folder and temp folders. No network for
// commands; the model searches with OpenAI's hosted search from its index ("cached"), which
// runs on OpenAI's side. Codex
// keeps .git read-only, so a Codex write task changes files but can't commit. One Codex thread
// backs a run of codex/ turns: `exec` on the first, `exec resume THREAD` after. codex/default
// uses Codex's own default model. Markers Codex puts in its children's environment are
// removed, so the Codex ask starts doesn't take itself for part of the thread that called ask.
// Explicit sandbox:false replaces the permission profile with account-level access; read-only
// task intent is then an instruction, not an OS boundary.

import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path"
import { before, environment, execute, failure, home, locate, tidy, type Harness, type Outcome, type Run, type Settings } from "./harness.ts"
import type { Message, Usage } from "../providers/stream.ts"
import { framing } from "../agent/system.ts"

const install = "https://developers.openai.com/codex/cli"
const signIn = "run codex login, then try again"
/** The oldest Codex whose permission profiles ask has checked. */
const minimum = [0, 166, 0]
const tooOld = `ask needs Codex ${minimum.join(".")} or newer; update it`
const markers = /^CODEX_(THREAD_ID|SESSION_ID|TOOL_CALL_ID|CI|SANDBOX\w*|VERSION|APPLY_PATCH\w*)$/

/** The Codex to run: config's command (a path, or a name on PATH), else `codex` where its installers put it. */
export function command(settings: Settings): string | undefined {
  return locate(settings.command ?? "codex", [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin")])
}

/** Codex's version, as numbers, or undefined when it can't be read. */
function version(cli: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "")
  return m ? m.slice(1).map(Number) : undefined
}

function recent(v: number[] | undefined): boolean {
  if (!v) return false
  for (let i = 0; i < 3; i++) if (v[i] !== minimum[i]) return v[i] > minimum[i]
  return true
}

/**
 * Folders a command may read besides the system's own: each folder on PATH and, for one named
 * bin, the installation it belongs to (Homebrew's prefix, a Node version, Codex's package), so
 * tools work through their symlinks. Never the home folder itself, anything holding it, or
 * ~/.local, where other programs keep their data.
 */
export function toolchains(cli: string, path = process.env.PATH ?? ""): string[] {
  const out = new Set<string>()
  const add = (dir: string) => {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    for (const d of basename(real) === "bin" ? [real, dirname(real)] : [real]) {
      const r = relative(d, home)
      if (d === sep || r === "" || !r.startsWith("..") || d === join(home, ".local")) continue
      out.add(d)
    }
  }
  for (const dir of path.split(delimiter)) if (isAbsolute(dir)) add(dir)
  try {
    add(dirname(realpathSync(cli)))
  } catch {}
  return [...out]
}

/** The repository's shared .git folder, when it lies outside the task's folder (a worktree, a subfolder). */
function gitDir(dir: string): string | undefined {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
  const common = out.status === 0 ? out.stdout.trim() : ""
  return common && relative(dir, common).startsWith("..") ? common : undefined
}

/** The filesystem rules of ask's permission profile, as a TOML inline table. */
export function filesystem(r: Run, readable: string[]): string {
  const rules: [string, string][] = [[":minimal", '"read"'], ...readable.map((d): [string, string] => [d, '"read"'])]
  // Environment files hold real secrets; their examples (.env.example) stay readable.
  rules.push([":workspace_roots", `{"." = "${r.write ? "write" : "read"}", "**/.env" = "deny", "**/.env.[!e]*" = "deny"}`], ["glob_scan_max_depth", "6"])
  if (r.write) rules.push([":tmpdir", '"write"'], [":slash_tmp", '"write"'])
  return `{${rules.map(([k, v]) => `${JSON.stringify(k)} = ${v}`).join(", ")}}`
}

/** The arguments for one run; the prompt comes on stdin. */
export function invocation(r: Run, readable: string[], schemaFile?: string): string[] {
  const instructions = framing() + (r.sandbox === false && !r.write ? "\nThis is a read-only task. Do not modify files or run commands with side effects, even though OS confinement is disabled." : "")
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"', "-c", `developer_instructions=${JSON.stringify(instructions)}`]
  if (r.sandbox === false) common.push("--sandbox", "danger-full-access")
  else common.push("-c", 'default_permissions="ask"', "-c", `permissions.ask.filesystem=${filesystem(r, readable)}`)
  common.push("-c", 'web_search="cached"')
  if (r.model !== "default") common.push("-m", r.model)
  if (r.effort) common.push("-c", `model_reasoning_effort=${JSON.stringify(r.effort)}`)
  if (schemaFile) common.push("--output-schema", schemaFile)
  const head = r.session ? ["exec", "resume", r.session, ...common] : ["exec", ...common, "-C", r.dir]
  return [...head, ...(r.settings.args ?? []), "-"]
}


/** A shell command without the `zsh -lc "..."` wrapper Codex reports it in. */
function bare(command: string): string {
  const m = /^\S*(?:ba|z)?sh -lc (["'])([\s\S]*)\1$/.exec(command.trim())
  return m ? m[2] : command
}

const carryOn = "Carry on with the task where you left off, and finish it."

const codex: Harness = {
  name: "codex",
  command: "codex",
  title: "Codex",
  models: (catalog) => [
    { id: "default", name: "Codex's default model" },
    ...Object.values(catalog.openai?.models ?? {})
      .filter((m) => m.tool_call !== false)
      .map((m) => ({ id: m.id, name: m.name })),
  ],
  status(settings) {
    const cli = command(settings)
    if (!cli) return { ready: false, detail: "Codex isn't installed", fix: `install it: ${install}` }
    const v = version(cli)
    const shown = v ? v.join(".") : ""
    if (!recent(v)) return { ready: false, detail: `Codex ${shown} is too old for ask`, fix: tooOld }
    const s = spawnSync(cli, ["login", "status"], { encoding: "utf8", timeout: 15_000 })
    const said = `${s.stdout ?? ""}${s.stderr ?? ""}`.trim().split("\n")[0]
    if (s.status === 0 && /logged in/i.test(said)) return { ready: true, detail: `Codex ${shown}: ${said.charAt(0).toLowerCase()}${said.slice(1)}` }
    return { ready: false, detail: `Codex ${shown} isn't signed in`, fix: "run codex login" }
  },
  async run(r) {
    const messages: Message[] = [...r.messages, ...(r.prompt === undefined ? [] : [{ role: "user" as const, text: r.prompt }])]
    const usage: Usage = { input: 0, output: 0, cached: 0 }
    const end = (o: Partial<Outcome>, steps = 0): Outcome => ({ ...o, messages, usage, steps })
    const cli = command(r.settings)
    if (!cli) return end({ error: { message: "Codex isn't installed", hint: `install it (${install}), sign in, then try again` } })
    // Older versions ignore the permission profile without saying so, so they don't run at all.
    if (!recent(version(cli))) return end({ error: { message: "this Codex is too old for ask", hint: tooOld } })
    const readable = [...toolchains(cli), ...[gitDir(r.dir)].filter((d): d is string => !!d)]
    const earlier = before(r.dir)
    const scratch = r.schema ? mkdtempSync(join(tmpdir(), "ask-codex-")) : undefined
    if (scratch) writeFileSync(join(scratch, "schema.json"), JSON.stringify(r.schema))
    let answer = ""
    let failed: string | undefined
    let steps = 0
    const step = (name: string, args: object, output: string, id: string) => {
      messages.push({ role: "assistant", text: "", calls: [{ id, name, arguments: JSON.stringify(args) }] })
      messages.push({ role: "tool", id, name, output })
      steps++
      r.onUpdate(messages, usage)
    }
    try {
      const done = await execute({
        command: cli,
        args: invocation(r, readable, scratch && join(scratch, "schema.json")),
        env: environment(markers, r.settings),
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
          if (e.type === "thread.started" && e.thread_id) r.onSession(String(e.thread_id))
          else if (e.type === "turn.completed") {
            const u = e.usage ?? {}
            usage.input += u.input_tokens ?? 0
            usage.output += u.output_tokens ?? 0
            usage.cached += u.cached_input_tokens ?? 0
          } else if (e.type === "turn.failed") failed = e.error?.message ?? "Codex's turn failed"
          else if (e.type === "error") failed = e.message ?? "Codex reported an error"
          else if (e.type === "item.completed") {
            const i = e.item ?? {}
            const id = String(i.id ?? steps)
            if (i.type === "agent_message") {
              answer = String(i.text ?? "")
              messages.push({ role: "assistant", text: answer, calls: [] })
              r.onUpdate(messages, usage)
            } else if (i.type === "command_execution") {
              const out = String(i.aggregated_output ?? "").slice(0, 4000)
              step("shell", { command: bare(String(i.command ?? "")) }, i.exit_code ? `error: exit ${i.exit_code}\n${out}` : out, id)
            } else if (i.type === "file_change") {
              for (const c of i.changes ?? []) step(c.kind === "add" ? "write" : "edit", { path: c.path }, String(c.kind ?? "changed"), `${id}-${c.path}`)
            } else if (i.type === "mcp_tool_call") step(String(i.tool ?? "tool"), i.arguments ?? {}, String(i.status ?? ""), id)
            else if (i.type === "web_search") step("search", { query: i.query ?? i.action?.query }, "", id)
          }
        },
      })
      if (r.signal?.aborted) return end({ error: { message: "stopped" } }, steps)
      const signedOut = /not logged in|login|unauthorized|401/i
      if (failed) return end({ error: failure(failed, signedOut, signIn) }, steps)
      if (done.code !== 0 && !answer) return end({ error: failure(done.stderr.trim().split("\n").pop() || `Codex exited with status ${done.code}`, signedOut, signIn) }, steps)
      return end(answer.trim() ? { answer: answer.trim() } : { error: { message: "Codex gave no answer", hint: "continue the session to ask again" } }, steps)
    } finally {
      tidy(r.dir, earlier)
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
  },
  parent: (env) => (env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}` : undefined),
}

export default codex
