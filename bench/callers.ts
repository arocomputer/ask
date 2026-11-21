// The caller benchmark: Claude Code, Codex or OpenCode is given work that suits a subagent, and
// graded on the outcome and on the route it took: ask, its own built-in subagents, or neither.
// Each arm changes one thing, so arms compare:
//
//   none    ask is on PATH, nothing tells the agent about it
//   skill   ask's skill, installed as a project skill (only its description sits in context)
//   deny    the skill, with the agent's built-in subagents turned off
//   hook    no skill; built-in subagent calls are handed to ask (bench/hook.ts)
//
// The callers reuse existing sign-ins, but hide the installed ask skill and override settings
// that deny native subagents. Jobs never name ask: three ask for a subagent, one asks for
// nothing. It spends real quota.
//
//   bun bench/callers.ts --ask PATH --label NAME [--arms none,skill,deny,hook]
//       [--drivers claude,codex,opencode] [--jobs ID,...] [--reps N] [--lanes N] [--skill FILE]
//   bun bench/callers.ts --compare NAME...

import { execFile, execFileSync, spawn } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { tasks as subagentTasks } from "./tasks.ts"
import { routed } from "./hook.ts"

const here = import.meta.dirname
const runs = join(here, ".runs")
const hook = join(here, "hook.ts")
const allArms = ["none", "skill", "deny", "hook"] as const
const allDrivers = ["claude", "codex", "opencode"]

type Job = { id: string; prompt: string; files: Record<string, string>; after?: Record<string, string>; grade(answer: string, dir: string): { pass: boolean; notes: string } }
type Arm = typeof allArms[number]

const fix = subagentTasks.find((t) => t.id === "fix-dates")!
const review = subagentTasks.find((t) => t.id === "review-diff")!
const files = (t: typeof fix) => (t.repo.kind === "files" ? t.repo : { files: {}, after: undefined })
const questionFiles = { ...files(subagentTasks.find((t) => t.id === "fix-pagination")!).files, ...files(fix).files, ...files(subagentTasks.find((t) => t.id === "fix-feature")!).files }
const questions =
  "(1) What does page() in pages.py return for page 0? (2) Which function in parse.py could raise 'month must be in 1..12', and for what input? (3) Does total.py accept a --json flag?"
const gradeQuestions = (answer: string) => {
  // With the planted bug, page 0 is the first page: items[0:size].
  const ok = [/\bfirst\b|items\[0\s*:|\[0,\s*1,\s*2|0\s*\*\s*size/i.test(answer), /parse/.test(answer) && /(swap|day|month|31|13)/i.test(answer), /\b(no|doesn't|does not|not)\b[\s\S]{0,200}json|json[\s\S]{0,60}\b(no|not|isn't|doesn't)\b|(^|\n)\W*3\W[^\n]{0,30}\bno\b/i.test(answer)]
  return { pass: ok.every(Boolean), notes: `${ok.filter(Boolean).length} of 3` }
}

const jobs: Job[] = [
  { id: "parallel-questions", prompt: `Use subagents to answer these about this repository, then give me the three answers: ${questions}`, files: questionFiles, grade: gradeQuestions },
  { id: "plain-questions", prompt: `Answer these about this repository: ${questions}`, files: questionFiles, grade: gradeQuestions },
  {
    id: "delegated-fix",
    prompt: "report.overdue('2026-01-31') crashes with 'month must be in 1..12'. Have a subagent fix it, check the fix, and tell me what was wrong.",
    files: files(fix).files,
    grade: (answer, dir) => {
      const g = fix.grade(answer, dir)
      return { pass: g.pass, notes: g.notes }
    },
  },
  {
    id: "review-handoff",
    prompt: "Get a review of the uncommitted changes in this repository from a subagent, and tell me which bugs it found.",
    files: files(review).files,
    after: files(review).after,
    grade: (answer) => {
      const g = review.grade(answer, "")
      return { pass: g.score >= 2 / 3, notes: g.notes }
    },
  },
]

function git(dir: string, ...args: string[]) {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@ask", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@ask" } })
}

/** Quote executable paths for the shell wrappers and hook commands. */
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/**
 * A scratch repository for one run, with the arm's agent configuration beside it or inside it
 * (kept out of git status), and a scratch ask home with the user's catalog and keys. Claude Code
 * gets the arm's skill and hook as a plugin, the way an ask plugin would ship; Codex reads the
 * skill from .agents/skills; OpenCode from .opencode, whose skill replaces a global one of the
 * same name.
 */
function prepare(j: Job, arm: Arm, skill: string): { dir: string; home: string; bin: string; plugin: string } {
  const root = mkdtempSync(join(tmpdir(), `callers-${j.id}-`))
  const dir = join(root, "work")
  const home = join(root, "home")
  const bin = join(root, "bin")
  const plugin = join(root, "plugin")
  try {
    for (const d of [dir, join(home, "cache"), bin, plugin]) mkdirSync(d, { recursive: true })
    for (const [name, text] of Object.entries(j.files)) writeFileSync(join(dir, name), text)
    git(dir, "init", "-q")
    git(dir, "add", ".")
    git(dir, "commit", "-qm", "start")
    for (const [name, text] of Object.entries(j.after ?? {})) writeFileSync(join(dir, name), text)
    writeFileSync(join(dir, ".git", "info", "exclude"), ".agents/\n.opencode/\n")
    const put = (path: string, text: string) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, text))
    put(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ask" }))
    if (arm === "skill" || arm === "deny") {
      put(join(plugin, "skills", "ask", "SKILL.md"), skill)
      put(join(dir, ".agents", "skills", "ask", "SKILL.md"), skill)
      put(join(dir, ".opencode", "skills", "ask", "SKILL.md"), skill)
    }
    // Project rules come after the user's, so they win: built-in subagents are on unless the arm
    // denies them, even where the user's own config turns them off.
    const rules = [{ action: "subagent", resource: "*", effect: arm === "deny" ? "deny" : "allow" }, ...(arm === "none" || arm === "hook" ? [{ action: "skill", resource: "ask", effect: "deny" }] : [])]
    put(join(dir, ".opencode", "opencode.json"), JSON.stringify({ permissions: rules }))
    if (arm === "hook") {
      const command = `${quote(process.execPath)} ${quote(hook)}`
      put(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command, timeout: 600 }] }] } }))
      // OpenCode 2's plugin API: a throw from execute.before refuses the call, and its message is the result.
      put(join(dir, ".opencode", "plugins", "ask", "index.ts"), `import { Plugin } from "@opencode/plugin"\nimport { route } from ${JSON.stringify(hook)}\nexport default Plugin.define({ id: "ask", async setup(ctx) { await ctx.tool.hook("execute.before", async (event: any) => { if (event.tool === "subagent") throw new Error(await route(event.input ?? {})) }) } })\n`)
    }
    const real = process.env.ASK_HOME || join(homedir(), ".ask")
    cpSync(join(real, "cache", "models.json"), join(home, "cache", "models.json"))
    const auth = join(real, "auth.json")
    if (existsSync(auth)) {
      const key = JSON.parse(readFileSync(auth, "utf8"))["opencode-go"]?.api_key
      if (key) writeFileSync(join(home, "auth.json"), JSON.stringify({ "opencode-go": { api_key: key } }), { mode: 0o600 })
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: "opencode-go/glm-5.3" }))
    return { dir, home, bin, plugin }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** What one caller run did: its answer, and how it got there. */
type Trace = { answer: string; seconds: number; native: number; skill: boolean; calls: number; tokens: number; cost: number | null; redirected: number; error?: string }

/** The ask skills the user installed for Codex, which a run turns off by path. */
const installed = [join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"), ...[".agents/skills", ".claude/skills"].map((d) => join(homedir(), d))]
  .map((d) => join(d, "ask", "SKILL.md")).filter((p) => existsSync(p))

/** The command line for a driver in an arm. */
function command(name: string, arm: Arm, prompt: string, dir: string, plugin: string): [string, string[]] {
  if (name === "claude") {
    const tools = "Bash,Read,Grep,Glob,Edit,Write,Agent,Skill"
    return ["claude", ["-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", tools, "--allowedTools", tools, ...(arm === "deny" ? ["--disallowedTools", "Agent"] : []), "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "project,local", "--settings", JSON.stringify({ skillOverrides: { ask: "off" } }), "--plugin-dir", plugin, "--", prompt]]
  }
  if (name === "codex") {
    const off = `skills.config=[${installed.map((p) => `{path=${JSON.stringify(p)}, enabled=false}`).join(", ")}]`
    return ["codex", ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"', "-c", `agents.enabled=${arm !== "deny"}`, "-c", off, "-C", dir, prompt]]
  }
  // Named, as a standalone run left to choose billed pay-as-you-go credits instead of OpenCode Go.
  if (name === "opencode") return ["opencode", ["run", "--format", "json", "--standalone", "--auto", "--archived", "-m", "opencode-go/deepseek-v4.1-flash", "--title", "callers benchmark", prompt]]
  throw new Error(`no driver ${name}`)
}

/** Reads one line of a driver's JSON events into the trace. */
function observe(name: string, e: Record<string, any>, t: Trace) {
  if (name === "claude") {
    // A subagent's own messages carry its parent call's id; only the caller's count.
    if (e.type === "assistant" && !e.parent_tool_use_id)
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue
        t.calls++
        if (b.name === "Agent" || b.name === "Task") t.native++
        if (b.name === "Skill" && /ask/.test(JSON.stringify(b.input))) t.skill = true
      }
    if (e.type === "result") {
      const u = e.usage ?? {}
      t.answer = String(e.result ?? "")
      t.tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      t.cost = e.total_cost_usd ?? null
      if (e.is_error) t.error ??= "Claude Code reported a failed turn"
    }
    if (e.type === "user" && !e.parent_tool_use_id && Array.isArray(e.message?.content))
      for (const b of e.message.content)
        if (b.type === "tool_result" && JSON.stringify(b.content)?.includes(routed)) t.redirected++
  } else if (name === "codex") {
    const item = e.item ?? {}
    if (e.type === "item.completed") {
      if (item.type === "agent_message") t.answer = item.text
      else if (item.type === "collab_tool_call") {
        t.calls++
        if (item.tool === "spawn_agent") t.native++
      }
      else if (item.type !== "reasoning" && item.type !== "todo_list" && item.type !== "error") t.calls++
      if (item.type === "command_execution" && /skills\/ask\/SKILL\.md/.test(item.command ?? "")) t.skill = true
    }
    if (e.type === "turn.completed") t.tokens += e.usage?.input_tokens ?? 0
    if (e.type === "turn.failed") t.error ??= "Codex reported a failed turn"
  } else {
    const part = e.part ?? {}
    if (e.type === "tool_use") {
      t.calls++
      if (part.tool === "subagent" || part.tool === "task") t.native++
      if ((part.tool === "subagent" || part.tool === "task") && JSON.stringify(part.state?.error)?.includes(routed)) t.redirected++
      if (part.tool === "skill" && part.state?.input?.id === "ask") t.skill = true
    }
    if (e.type === "text") t.answer = part.text ?? t.answer
    if (e.type === "step_finish") {
      const k = part.tokens ?? {}
      t.tokens += (k.input ?? 0) + (k.cache?.read ?? 0) + (k.cache?.write ?? 0)
      if (typeof part.cost === "number") t.cost = (t.cost ?? 0) + part.cost
    }
    if (e.type === "error") t.error ??= `OpenCode error (${e.error?.type ?? "unknown"})`
  }
}

/** Runs a caller to its end, keeping its raw events in `trace` to read when a route surprises. */
function drive(name: string, arm: Arm, prompt: string, dir: string, plugin: string, env: NodeJS.ProcessEnv, trace: string): Promise<Trace> {
  const [cmd, args] = command(name, arm, prompt, dir, plugin)
  const t: Trace = { answer: "", seconds: 0, native: 0, skill: false, calls: 0, tokens: 0, cost: null, redirected: 0 }
  const began = Date.now()
  return new Promise((done) => {
    // OpenCode takes its directory from PWD, not the process's working directory.
    const child = spawn(cmd, args, { cwd: dir, env: { ...env, PWD: dir }, stdio: ["ignore", "pipe", "pipe"] })
    let buffer = ""
    const take = (line: string) => {
      try {
        observe(name, JSON.parse(line), t)
      } catch {}
    }
    child.stderr.resume()
    child.on("error", (e: NodeJS.ErrnoException) => { t.error ??= `${cmd} could not start (${e.code ?? "unknown"})` })
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      appendFileSync(trace, d, { mode: 0o600 })
      buffer += d
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) take(buffer.slice(0, nl)), (buffer = buffer.slice(nl + 1))
    })
    const timer = setTimeout(() => {
      t.error ??= `${cmd} timed out`
      child.kill("SIGKILL")
    }, 20 * 60_000)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (buffer) take(buffer)
      if (code !== 0) t.error ??= `${cmd} exited (${signal ?? code})`
      if (!t.answer.trim()) t.error ??= `${cmd} produced no final answer`
      t.seconds = (Date.now() - began) / 1000
      done(t)
    })
  })
}

/** How the caller used ask: sessions, whether they started together, and how long their prompts were. */
function usage(home: string) {
  let names: string[] = []
  try {
    names = readdirSync(join(home, "sessions"))
  } catch {}
  const sessions = names.map((n) => JSON.parse(readFileSync(join(home, "sessions", n, "session.json"), "utf8")))
  const starts = sessions.map((s) => Date.parse(s.created)).sort()
  return {
    sessions: sessions.length,
    ids: names,
    together: sessions.length > 1 && starts[starts.length - 1] - starts[0] < 5000,
    prompt: sessions.length ? Math.round(sessions.reduce((a, s) => a + s.turns[0].prompt.length, 0) / sessions.length) : 0,
    turns: sessions.reduce((a, s) => a + s.turns.length, 0),
  }
}

/** Stop outstanding ask workers before removing their session directory. */
async function stop(ids: string[], bin: string, dir: string, env: NodeJS.ProcessEnv) {
  if (!ids.length) return
  await new Promise<void>((done) => {
    const child = execFile(join(bin, "ask"), [], { cwd: dir, env, timeout: 10_000 }, () => done())
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify({ stop: ids }))
  })
}

/**
 * The environment of a caller: the user's, with the scratch ask first on PATH, and without the
 * markers that would make it take itself for part of the agent session running the benchmark.
 * Inside OpenCode that is every OPENCODE_ variable: with them, \`opencode run\` ignores the
 * scratch repository's configuration.
 */
const markers = /^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|SESSION_ATTENDED)|CLAUDE_PID|CODEX_(THREAD_ID|SESSION_ID|TOOL_CALL_ID|SANDBOX\w*)|OPENCODE\w*|ASK_\w+)$/
function environment(bin: string, home: string, dir: string, write: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!markers.test(k)) env[k] = v
  return { ...env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, ASK_HOME: home, ASK_BENCH_DIR: dir, ASK_BENCH_WRITE: write ? "1" : "0", NO_COLOR: "1" }
}

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: { ask: { type: "string" }, skill: { type: "string" }, label: { type: "string" }, arms: { type: "string" }, drivers: { type: "string" }, jobs: { type: "string" }, reps: { type: "string" }, lanes: { type: "string" }, compare: { type: "boolean" } },
})

/** Validate selectors before creating files or spending quota. */
function pick<T extends string>(value: string | undefined, choices: readonly T[], flag: string): T[] {
  if (value === undefined) return [...choices]
  const list = value.split(",")
  if (list.some((item) => !choices.includes(item as T)) || new Set(list).size !== list.length)
    throw new Error(`${flag} expects a comma-separated list from ${choices.join(", ")}`)
  return list as T[]
}

/** Refuse empty, unsafe or unbounded run identifiers and counts. */
function label(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error(`invalid run label: ${value}`)
  return value
}

function positive(value: string | undefined, fallback: number, flag: string): number {
  const n = Number(value ?? fallback)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`)
  return n
}

if (v.compare) {
  const mean = (rs: Record<string, any>[], k: string) => {
    const values = rs.map((r) => r[k]).filter((n): n is number => typeof n === "number")
    return values.length ? values.reduce((a, n) => a + n, 0) / values.length : undefined
  }
  console.log(["label", "arm", "driver", "passed", "errors", "ask", "hook", "native", "mixed", "self", "skill", "input", "reported $", "calls", "secs"].join("\t"))
  for (const name of positionals.map(label)) {
    const rows = readFileSync(join(runs, `callers-${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    // Graded again with today's graders, except the fix, whose grade came from its folder.
    for (const r of rows) if (!r.error && r.job !== "delegated-fix") {
      const job = jobs.find((j) => j.id === r.job)
      if (job) Object.assign(r, job.grade(r.answer, ""))
    }
    for (const arm of [...new Set(rows.map((r) => r.arm))])
      for (const d of [...new Set(rows.map((r) => r.driver))]) {
        const group = rows.filter((r) => (r.arm ?? "skill") === (arm ?? "skill") && r.driver === d)
        if (!group.length) continue
        const rs = group.filter((r) => !r.error && r.answer?.trim())
        const n = (route: string) => rs.filter((r) => r.route === route || (route === "mixed" && r.route === "both")).length
        console.log([name, arm ?? "skill", d, `${rs.filter((r) => r.pass).length}/${rs.length}`, group.length - rs.length, n("ask"), n("hook"), n("native"), n("mixed"), n("self"), rs.filter((r) => r.skill).length, mean(rs, "tokens")?.toFixed(0) ?? "-", (d === "codex" ? undefined : mean(rs, "cost"))?.toFixed(2) ?? "-", mean(rs, "calls")?.toFixed(1) ?? "-", mean(rs, "seconds")?.toFixed(1) ?? "-"].join("\t"))
      }
  }
} else {
  if (!v.ask || !v.label) throw new Error("usage: bun bench/callers.ts --ask PATH --label NAME [--arms ...] [--drivers ...] [--jobs ...] [--reps N] [--skill FILE]")
  const ask = resolve(v.ask)
  const name = label(v.label)
  const drivers = pick(v.drivers, allDrivers, "--drivers")
  const arms = pick(v.arms, allArms, "--arms")
  const reps = positive(v.reps, 2, "--reps")
  const lanes = positive(v.lanes, 1, "--lanes")
  const ids = pick(v.jobs, jobs.map((j) => j.id), "--jobs")
  const chosen = jobs.filter((j) => ids.includes(j.id))
  const all = arms.flatMap((arm) => drivers.filter((d) => !(arm === "hook" && d === "codex"))
    .flatMap((d) => chosen.flatMap((j) => Array.from({ length: reps }, (_, rep) => ({ arm, d, j, rep })))))
  if (!all.length) throw new Error("no runs selected (Codex has no benchmark hook adapter)")
  const skill = v.skill ? readFileSync(v.skill, "utf8") : ((await import(join(ask, "src", "harnesses", "skill.ts"))).text as string)
  const file = join(runs, `callers-${name}.jsonl`)
  const traces = join(runs, `callers-${name}`)
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  writeFileSync(file, "", { flag: "wx", mode: 0o600 })
  mkdirSync(traces, { mode: 0o700 })
  console.error(`${all.length} runs`)
  await Promise.all(
    // Lanes share ask's subagent model; too many at once and its provider rate-limits, which
    // shows up as slow, retried tasks the caller has to wait out.
    Array.from({ length: Math.min(lanes, all.length) }, async (_, lane) => {
      for (let i = lane; i < all.length; i += lanes) {
        const { arm, d, j, rep } = all[i]
        const { dir, home, bin, plugin } = prepare(j, arm, skill)
        const env = environment(bin, home, dir, j.id === "delegated-fix")
        try {
          writeFileSync(join(bin, "ask"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(ask, "src", "cli.ts"))} "$@"\n`)
          chmodSync(join(bin, "ask"), 0o755)
          const t = await drive(d, arm, j.prompt, dir, plugin, env, join(traces, `${arm}-${d}-${j.id}-${rep}.jsonl`))
          const { ids: sessions, ...u } = usage(home)
          await stop(sessions, bin, dir, env)
          const native = Math.max(0, t.native - t.redirected)
          const route = t.error ? null : u.sessions ? (native ? "mixed" : t.redirected ? "hook" : "ask") : native ? "native" : "self"
          const grade = t.error ? { pass: false, notes: t.error } : j.grade(t.answer, dir)
          const row = { label: name, arm, driver: d, job: j.id, rep, route, ...grade, ...u, ...t, native }
          appendFileSync(file, JSON.stringify(row) + "\n")
          console.error(`${arm} ${d} ${j.id} ${t.error ? "ERROR" : row.pass ? "pass" : "FAIL"} ${row.notes} route=${route ?? "-"} sessions=${u.sessions} native=${native} tokens=${t.tokens}`)
        } finally {
          rmSync(join(dir, ".."), { recursive: true, force: true })
        }
      }
    }),
  )
}
