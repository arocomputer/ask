// The caller benchmark: Claude Code, Codex or OpenCode is given work that suits a subagent, and
// graded on the outcome and on the route it took: ask, its own built-in subagents, or neither.
// Each arm changes one thing, so arms compare:
//
//   none    ask is on PATH, nothing tells the agent about it
//   skill   ask's skill, installed as a project skill (only its description sits in context)
//   deny    the skill, with the agent's built-in subagents turned off
//   hook    the skill, with built-in subagent calls handed to ask (bench/hook.ts)
//
// The agents run with HOME set to a bench profile they are signed in to, so the user's own
// skills, hooks and instructions take no part. Jobs never name ask: two ask for subagents, one
// asks for nothing. It spends real quota.
//
//   bun bench/callers.ts --ask PATH --label NAME [--arms none,skill,deny,hook]
//       [--drivers claude,codex,opencode] [--jobs ID,...] [--reps N] [--skill FILE] [--profile DIR]
//   bun bench/callers.ts --compare NAME...

import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { tasks as subagentTasks } from "./tasks.ts"

const here = import.meta.dirname
const runs = join(here, ".runs")
const hook = join(here, "hook.ts")

type Job = { id: string; prompt: string; files: Record<string, string>; after?: Record<string, string>; grade(answer: string, dir: string): { pass: boolean; notes: string } }
type Arm = "none" | "skill" | "deny" | "hook"

const fix = subagentTasks.find((t) => t.id === "fix-dates")!
const review = subagentTasks.find((t) => t.id === "review-diff")!
const files = (t: typeof fix) => (t.repo.kind === "files" ? t.repo : { files: {}, after: undefined })
const questionFiles = { ...files(subagentTasks.find((t) => t.id === "fix-pagination")!).files, ...files(fix).files, ...files(subagentTasks.find((t) => t.id === "fix-feature")!).files }
const questions =
  "(1) What does page() in pages.py return for page 0? (2) Which function in parse.py could raise 'month must be in 1..12', and for what input? (3) Does total.py accept a --json flag?"
const gradeQuestions = (answer: string) => {
  // With the planted bug, page 0 is the first page: items[0:size].
  const ok = [/\bfirst\b|items\[0\s*:|\[0,\s*1,\s*2|0\s*\*\s*size/i.test(answer), /parse/.test(answer) && /(swap|day|month|31|13)/i.test(answer), /\b(no|doesn't|does not|not)\b[\s\S]{0,200}json|json[\s\S]{0,60}\b(no|not|isn't|doesn't)\b/i.test(answer)]
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
  execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@ask", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@ask" } })
}

/**
 * A scratch repository for one run, with the arm's agent configuration inside it (kept out of
 * git status), and a scratch ask home with the user's catalog and keys.
 */
function prepare(j: Job, arm: Arm, skill: string): { dir: string; home: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), `callers-${j.id}-`))
  const dir = join(root, "work")
  const home = join(root, "home")
  const bin = join(root, "bin")
  for (const d of [dir, join(home, "cache"), bin]) mkdirSync(d, { recursive: true })
  for (const [name, text] of Object.entries(j.files)) writeFileSync(join(dir, name), text)
  git(dir, "init", "-q")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "start")
  for (const [name, text] of Object.entries(j.after ?? {})) writeFileSync(join(dir, name), text)
  writeFileSync(join(dir, ".git", "info", "exclude"), ".claude/\n.agents/\n.opencode/\n")
  const put = (path: string, text: string) => (mkdirSync(join(dir, path, ".."), { recursive: true }), writeFileSync(join(dir, path), text))
  if (arm !== "none") {
    // Claude Code reads .claude/skills; Codex and OpenCode read .agents/skills.
    put(".claude/skills/ask/SKILL.md", skill)
    put(".agents/skills/ask/SKILL.md", skill)
  }
  if (arm === "deny") put(".opencode/opencode.json", JSON.stringify({ permissions: [{ action: "subagent", resource: "*", effect: "deny" }] }))
  if (arm === "hook")
    put(".opencode/plugins/ask.js", `import { route } from ${JSON.stringify(hook)}\nexport default { async server() { return { "tool.execute.before": async (input, output) => { if (/^(subagent|task)$/.test(input.tool)) throw new Error(await route(output.args ?? {})) } } } }\n`)
  const real = process.env.ASK_HOME || join(homedir(), ".ask")
  cpSync(join(real, "cache", "models.json"), join(home, "cache", "models.json"))
  cpSync(join(real, "auth.json"), join(home, "auth.json"))
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "opencode-go/glm-5.3" }))
  return { dir, home, bin }
}

/** What one caller run did: its answer, and how it got there. */
type Trace = { answer: string; seconds: number; native: number; skill: boolean; calls: number; tokens: number; cost: number }

/** The command line for a driver in an arm. */
function command(name: string, arm: Arm, prompt: string, dir: string): [string, string[]] {
  const hookCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`
  if (name === "claude") {
    const tools = "Bash,Read,Grep,Glob,Edit,Write,Agent,Skill"
    const settings = arm === "hook" ? { hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: hookCommand, timeout: 600 }] }] } } : { disableAllHooks: true }
    return ["claude", ["-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--tools", tools, "--allowedTools", tools, ...(arm === "deny" ? ["--disallowedTools", "Agent"] : []), "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", JSON.stringify(settings), prompt]]
  }
  if (name === "codex") {
    const extra = arm === "deny" ? ["-c", "agents.enabled=false"] : arm === "hook" ? ["--dangerously-bypass-hook-trust", "-c", `hooks.PreToolUse=[{matcher="^spawn_agent$", hooks=[{type="command", command=${JSON.stringify(hookCommand)}, timeout=600}]}]`] : []
    return ["codex", ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"', ...extra, "-C", dir, prompt]]
  }
  if (name === "opencode") return ["opencode", ["run", "--format", "json", "--standalone", "--auto", "--title", "ask-bench", prompt]]
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
      t.cost = e.total_cost_usd ?? 0
    }
  } else if (name === "codex") {
    const item = e.item ?? {}
    if (e.type === "item.completed") {
      if (item.type === "agent_message") t.answer = item.text
      else if (item.type === "collab_tool_call") item.tool === "spawn_agent" && t.native++
      else if (item.type !== "reasoning" && item.type !== "todo_list" && item.type !== "error") t.calls++
      if (item.type === "command_execution" && /skills\/ask\/SKILL\.md/.test(item.command ?? "")) t.skill = true
    }
    if (e.type === "turn.completed") t.tokens += e.usage?.input_tokens ?? 0
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
      t.cost += part.cost ?? 0
    }
  }
}

function drive(name: string, arm: Arm, prompt: string, dir: string, env: NodeJS.ProcessEnv): Promise<Trace> {
  const [cmd, args] = command(name, arm, prompt, dir)
  const t: Trace = { answer: "", seconds: 0, native: 0, skill: false, calls: 0, tokens: 0, cost: 0 }
  const began = Date.now()
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
    let buffer = ""
    const take = (line: string) => {
      try {
        observe(name, JSON.parse(line), t)
      } catch {}
    }
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buffer += d
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) take(buffer.slice(0, nl)), (buffer = buffer.slice(nl + 1))
    })
    const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000)
    child.on("close", () => {
      clearTimeout(timer)
      if (buffer) take(buffer)
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
    together: sessions.length > 1 && starts[starts.length - 1] - starts[0] < 5000,
    prompt: sessions.length ? Math.round(sessions.reduce((a, s) => a + s.turns[0].prompt.length, 0) / sessions.length) : 0,
    turns: sessions.reduce((a, s) => a + s.turns.length, 0),
  }
}

/**
 * The environment of a caller: the profile as HOME, without the variables that would point it
 * back at the user's own configuration or mark it as part of a running agent session.
 */
function environment(profile: string, bin: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|CODEX_|OPENCODE_|ASK_)/.test(k)) env[k] = v
  return { ...env, HOME: profile, PATH: `${bin}:${process.env.PATH}`, ASK_HOME: home, NO_COLOR: "1" }
}

/** Refuses a profile that would let a skill in by the back door, and says how to make one. */
function checkProfile(profile: string, drivers: string[]) {
  if (!existsSync(profile))
    throw new Error(`no bench profile at ${profile}. Make one and sign each agent in, once:\n  mkdir -p ${profile}\n` + drivers.map((d) => `  HOME=${profile} ${d === "claude" ? "claude   # then /login" : d === "codex" ? "codex login" : "opencode # then connect a provider and choose a default model"}`).join("\n"))
  for (const d of [".claude/skills", ".codex/skills", ".agents/skills", ".config/opencode/skills"])
    if (existsSync(join(profile, d)) && readdirSync(join(profile, d)).length) throw new Error(`${join(profile, d)} holds skills; empty it so only the arm decides what the agent knows`)
}

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: { ask: { type: "string" }, skill: { type: "string" }, label: { type: "string" }, arms: { type: "string" }, drivers: { type: "string" }, jobs: { type: "string" }, reps: { type: "string" }, profile: { type: "string" }, compare: { type: "boolean" } },
})
mkdirSync(runs, { recursive: true })
if (v.compare) {
  const mean = (rs: Record<string, any>[], k: string) => rs.reduce((a, r) => a + r[k], 0) / rs.length
  console.log(["label", "arm", "driver", "passed", "ask", "native", "both", "self", "skill", "tokens", "cost", "calls", "secs"].join("\t"))
  for (const label of positionals) {
    const rows = readFileSync(join(runs, `callers-${label}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    // Graded again with today's graders, except the fix, whose grade came from its folder.
    for (const r of rows) if (r.job !== "delegated-fix") Object.assign(r, jobs.find((j) => j.id === r.job)!.grade(r.answer, ""))
    for (const arm of [...new Set(rows.map((r) => r.arm))])
      for (const d of [...new Set(rows.map((r) => r.driver))]) {
        const rs = rows.filter((r) => r.arm === arm && r.driver === d)
        if (!rs.length) continue
        const n = (route: string) => rs.filter((r) => r.route === route).length
        console.log([label, arm, d, `${rs.filter((r) => r.pass).length}/${rs.length}`, n("ask"), n("native"), n("both"), n("self"), rs.filter((r) => r.skill).length, `${Math.round(mean(rs, "tokens") / 1000)}k`, `$${mean(rs, "cost").toFixed(2)}`, mean(rs, "calls").toFixed(1), Math.round(mean(rs, "seconds"))].join("\t"))
      }
  }
} else {
  if (!v.ask || !v.label) throw new Error("usage: bun bench/callers.ts --ask PATH --label NAME [--arms ...] [--drivers ...] [--jobs ...] [--reps N] [--skill FILE] [--profile DIR]")
  const drivers = (v.drivers ?? "claude,codex,opencode").split(",")
  const arms = (v.arms ?? "none,skill,deny,hook").split(",") as Arm[]
  const profile = v.profile ?? join(homedir(), ".ask-bench")
  checkProfile(profile, drivers)
  const skill = v.skill ? readFileSync(v.skill, "utf8") : ((await import(join(v.ask, "src", "harnesses", "skill.ts"))).text as string)
  const chosen = v.jobs ? jobs.filter((j) => v.jobs!.split(",").includes(j.id)) : jobs
  const file = join(runs, `callers-${v.label}.jsonl`)
  const all = arms.flatMap((arm) => drivers.flatMap((d) => chosen.flatMap((j) => Array.from({ length: Number(v.reps ?? 2) }, (_, rep) => ({ arm, d, j, rep })))))
  console.error(`${all.length} runs`)
  await Promise.all(
    [0, 1, 2].map(async (lane) => {
      for (let i = lane; i < all.length; i += 3) {
        const { arm, d, j, rep } = all[i]
        const { dir, home, bin } = prepare(j, arm, skill)
        writeFileSync(join(bin, "ask"), `#!/bin/sh\nexec ${process.execPath} ${join(v.ask!, "src", "cli.ts")} "$@"\n`)
        chmodSync(join(bin, "ask"), 0o755)
        const t = await drive(d, arm, j.prompt, dir, environment(profile, bin, home))
        const u = usage(home)
        // In the hook arm, "both" is the native calls ask took over.
        const route = u.sessions ? (t.native ? "both" : "ask") : t.native ? "native" : "self"
        const row = { label: v.label, arm, driver: d, job: j.id, rep, route, ...j.grade(t.answer, dir), ...u, ...t }
        appendFileSync(file, JSON.stringify(row) + "\n")
        console.error(`${arm} ${d} ${j.id} ${row.pass ? "pass" : "FAIL"} ${row.notes} route=${route} sessions=${u.sessions} native=${t.native} tokens=${t.tokens}`)
        rmSync(join(dir, ".."), { recursive: true, force: true })
      }
    }),
  )
}
