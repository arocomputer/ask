// The caller benchmark: Claude Code, Codex or OpenCode is given work that suits a subagent, and
// graded on the outcome and on the route it took: ask, its own built-in subagents, or neither.
// Each arm changes one thing, so arms compare:
//
//   none    ask is on PATH, nothing tells the agent about it
//   skill   ask's skill, installed as a project skill (only its description sits in context)
//   deny    the skill, with the agent's built-in subagents turned off
//
// Caller state lives in scratch profiles. None of the jobs names ask.

import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { tasks as subagentTasks } from "../fixtures/tasks.ts"
import { goModel, pick, pool, type Suite } from "../suite.ts"
const allArms = ["none", "skill", "deny"] as const
const allDrivers = ["claude", "codex", "opencode"] as const
const callerModels = { claude: "claude-haiku-5-5", codex: "gpt-6-luna", opencode: "opencode/deepseek-v4.1-flash-free" }

type Grade = { pass: boolean; notes: string }
type Job = { id: string; prompt: string; files: Record<string, string>; after?: Record<string, string>; grade(answer: string, dir: string): Grade | Promise<Grade> }
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
    grade: async (answer, dir) => {
      const g = await fix.grade(answer, dir)
      return { pass: g.pass, notes: g.notes }
    },
  },
  {
    id: "review-handoff",
    prompt: "Get a review of the uncommitted changes in this repository from a subagent, and tell me which bugs it found.",
    files: files(review).files,
    after: files(review).after,
    grade: async (answer) => {
      const g = await review.grade(answer, "")
      return { pass: g.score >= 2 / 3, notes: g.notes }
    },
  },
]

function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: "ignore", env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@ask", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@ask" } })
}

/** Quote executable paths for the shell wrapper. */
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/**
 * A scratch repository for one run, with the arm's agent configuration beside it or inside it
 * (kept out of git status), and a scratch ask home with the user's catalog and keys. Claude Code
 * gets the arm's skill as a temporary plugin; Codex reads the
 * skill from .agents/skills; OpenCode from .opencode, whose skill replaces a global one of the
 * same name.
 */
function prepare(j: Job, arm: Arm, skill: string, scratch: string, env: NodeJS.ProcessEnv, model: string): { root: string; dir: string; home: string; bin: string; plugin: string } {
  const root = mkdtempSync(join(scratch, `caller-${j.id}-`))
  const dir = join(root, "work")
  const home = join(root, "home")
  const bin = join(root, "bin")
  const plugin = join(root, "plugin")
  try {
    for (const d of [dir, join(home, "cache"), bin, plugin]) mkdirSync(d, { recursive: true })
    for (const [name, text] of Object.entries(j.files)) writeFileSync(join(dir, name), text)
    git(dir, env, "init", "-q")
    git(dir, env, "add", ".")
    git(dir, env, "commit", "-qm", "start")
    for (const [name, text] of Object.entries(j.after ?? {})) writeFileSync(join(dir, name), text)
    writeFileSync(join(dir, ".git", "info", "exclude"), ".agents/\n.opencode/\n")
    const put = (path: string, text: string) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, text))
    put(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ask" }))
    if (arm === "skill" || arm === "deny") {
      put(join(plugin, "skills", "ask", "SKILL.md"), skill)
      put(join(dir, ".agents", "skills", "ask", "SKILL.md"), skill)
      put(join(dir, ".opencode", "skills", "ask", "SKILL.md"), skill)
    }
    // Native subagents are on unless the arm denies them.
    const rules = [{ action: "subagent", resource: "*", effect: arm === "deny" ? "deny" : "allow" }, ...(arm === "none" ? [{ action: "skill", resource: "ask", effect: "deny" }] : [])]
    put(join(dir, ".opencode", "opencode.json"), JSON.stringify({
      model,
      permissions: rules,
      providers: { "opencode-go": { settings: { apiKey: "{env:OPENCODE_API_KEY}" } } },
    }))
    const real = env.ASK_HOME!
    const catalog = join(real, "cache", "models.json")
    if (existsSync(catalog)) cpSync(catalog, join(home, "cache", "models.json"))
    const auth = join(real, "auth.json")
    if (existsSync(auth)) {
      const key = JSON.parse(readFileSync(auth, "utf8"))["opencode-go"]?.api_key
      if (key) writeFileSync(join(home, "auth.json"), JSON.stringify({ "opencode-go": { api_key: key } }), { mode: 0o600 })
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: goModel }))
    return { root, dir, home, bin, plugin }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** What one caller run did: its answer, and how it got there. */
type Trace = { answer: string; seconds: number; native: number; skill: boolean; calls: number; tokens: number; cost: number | null; error?: string }

/** The command line for a driver in an arm. */
function command(name: string, model: string, arm: Arm, prompt: string, dir: string, plugin: string): [string, string[]] {
  if (name === "claude") {
    const tools = "Bash,Read,Grep,Glob,Edit,Write,Agent,Skill"
    return ["claude", ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", tools, "--allowedTools", tools, ...(arm === "deny" ? ["--disallowedTools", "Agent"] : []), "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "project,local", "--settings", JSON.stringify({ skillOverrides: { ask: "off" } }), "--plugin-dir", plugin, "--", prompt]]
  }
  if (name === "codex") {
    return ["codex", ["exec", "--json", "--ephemeral", "--model", model, "--skip-git-repo-check", "--ignore-user-config", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"', "-c", `agents.enabled=${arm !== "deny"}`, "-C", dir, prompt]]
  }
  // Name the free or Go model explicitly; OpenCode's own default can use metered credits.
  if (name === "opencode") return ["opencode", ["run", "--format", "json", "--standalone", "--auto", "--archived", "-m", model, "--title", "callers benchmark", prompt]]
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
function drive(name: string, model: string, arm: Arm, prompt: string, dir: string, plugin: string, env: NodeJS.ProcessEnv, trace?: string): Promise<Trace> {
  const [cmd, args] = command(name, model, arm, prompt, dir, plugin)
  const t: Trace = { answer: "", seconds: 0, native: 0, skill: false, calls: 0, tokens: 0, cost: null }
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
      if (trace) appendFileSync(trace, d, { mode: 0o600 })
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

/** Run each caller/job/arm with a private ask home and scratch caller profile. */
export const suite: Suite = {
  live: true,
  repetitions: 2,
  compareFiles: [import.meta.filename, join(import.meta.dirname, "../fixtures/tasks.ts")],
  select(args, reps) {
    const { values } = parseArgs({ args, options: { skill: { type: "string" }, arms: { type: "string" }, drivers: { type: "string" }, jobs: { type: "string" }, opencode: { type: "string", default: "free" } } })
    if (!["free", "go"].includes(values.opencode)) throw new Error("--opencode expects free or go")
    const models = { ...callerModels, ...(values.opencode === "go" && { opencode: goModel }) }
    const drivers = pick(values.drivers, allDrivers, "--drivers")
    const arms = pick(values.arms, allArms, "--arms")
    const ids = pick(values.jobs, jobs.map((j) => j.id), "--jobs")
    const chosen = jobs.filter((j) => ids.includes(j.id))
    const cases = arms.flatMap((arm) => drivers.flatMap((d) => chosen.flatMap((j) => Array.from({ length: reps }, (_, rep) => ({ arm, d, j, rep })))))
    const custom = values.skill ? readFileSync(resolve(values.skill), "utf8") : undefined
    return {
      inputs: { arms, jobs: ids, callers: Object.fromEntries(drivers.map((d) => [d, models[d]])), workerModel: goModel },
      variant: custom === undefined ? undefined : { skill: createHash("sha256").update(custom).digest("hex") },
      count: cases.length,
      async run(ctx) {
        const skill = custom ?? ((await import(join(ctx.checkout, "src", "harnesses", "skill.ts"))).text as string)
        const key = ctx.env.OPENCODE_API_KEY ?? (existsSync(join(ctx.env.ASK_HOME!, "auth.json"))
          ? JSON.parse(readFileSync(join(ctx.env.ASK_HOME!, "auth.json"), "utf8"))["opencode-go"]?.api_key : undefined)
        await pool(cases, ctx.parallel, async ({ arm, d, j, rep }) => {
          const base = { group: `${d}/${arm}`, case: j.id, rep, model: models[d] }
          let root: string | undefined
          try {
            const setup = prepare(j, arm, skill, ctx.scratch, ctx.env, models.opencode)
            const { dir, home, bin, plugin } = setup
            root = setup.root
            const env = { ...ctx.env, PATH: `${bin}${delimiter}${ctx.env.PATH ?? ""}`, ASK_HOME: home,
              XDG_DATA_HOME: join(root, "data"), OPENCODE_DB: ":memory:", ...(d === "opencode" && { OPENCODE_API_KEY: key }) }
            writeFileSync(join(bin, "ask"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(ctx.checkout, "src", "cli.ts"))} "$@"\n`)
            chmodSync(join(bin, "ask"), 0o755)
            if (d === "opencode" && values.opencode === "go" && !key) throw new Error("OpenCode Go needs an ask Go key or OPENCODE_API_KEY")
            const t = await drive(d, models[d], arm, j.prompt, dir, plugin, env, ctx.traces && join(ctx.traces, `${arm}-${d}-${j.id}-${rep}.jsonl`))
            const { ids: sessions, ...u } = usage(home)
            await stop(sessions, bin, dir, env)
            const route = t.error ? null : u.sessions ? (t.native ? "mixed" : "ask") : t.native ? "native" : "self"
            const grade = t.error ? {} : await j.grade(t.answer, dir)
            ctx.record({ ...base, route, ...grade, ...u, ...t, input: t.tokens })
          } catch (err) {
            ctx.record({ ...base, error: (err as Error).message })
          } finally {
            if (root) rmSync(root, { recursive: true, force: true })
          }
        })
      },
    }
  },
}
