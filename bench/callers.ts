// The caller benchmark: a calling agent (Claude Code or Codex) is given work to hand off
// through ask, with a version of ask's skill as part of its instructions, and graded on the
// outcome and on how it delegated: how many sessions, started together or not, and how much
// its task prompts told the subagents. The skill is passed in the agent's own prompt, never
// installed, so the user's agent settings are left alone. It spends real quota.
//
//   bun bench/callers.ts --ask PATH --skill FILE --label NAME [--drivers claude,codex] [--reps N]

import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { tasks as subagentTasks } from "./tasks.ts"

const here = import.meta.dirname
const runs = join(here, ".runs")

type Job = { id: string; prompt: string; files: Record<string, string>; after?: Record<string, string>; grade(answer: string, dir: string): { pass: boolean; notes: string } }

const fix = subagentTasks.find((t) => t.id === "fix-dates")!
const review = subagentTasks.find((t) => t.id === "review-diff")!
const files = (t: typeof fix) => (t.repo.kind === "files" ? t.repo : { files: {}, after: undefined })

const jobs: Job[] = [
  {
    id: "parallel-questions",
    prompt:
      "Use ask subagents to answer these about this repository, then give me the three answers: (1) What does page() in pages.py return for page 0? (2) Which function in parse.py could raise 'month must be in 1..12', and for what input? (3) Does total.py accept a --json flag?",
    files: { ...files(subagentTasks.find((t) => t.id === "fix-pagination")!).files, ...files(fix).files, ...files(subagentTasks.find((t) => t.id === "fix-feature")!).files },
    grade: (answer) => {
      // With the planted bug, page 0 is the first page: items[0:size].
      const ok = [/\bfirst\b|items\[0\s*:|\[0,\s*1,\s*2|0\s*\*\s*size/i.test(answer), /parse/.test(answer) && /(swap|day|month|31|13)/i.test(answer), /\b(no|doesn't|does not|not)\b[\s\S]{0,200}json|json[\s\S]{0,60}\b(no|not|isn't|doesn't)\b/i.test(answer)]
      return { pass: ok.every(Boolean), notes: `${ok.filter(Boolean).length} of 3` }
    },
  },
  {
    id: "delegated-fix",
    prompt: "report.overdue('2026-01-31') crashes with 'month must be in 1..12'. Have an ask subagent fix it, check the fix, and tell me what was wrong.",
    files: files(fix).files,
    grade: (answer, dir) => {
      const g = fix.grade(answer, dir)
      return { pass: g.pass, notes: g.notes }
    },
  },
  {
    id: "review-handoff",
    prompt: "Get a review of the uncommitted changes in this repository from an ask subagent, and tell me which bugs it found.",
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

function prepare(j: Job): { dir: string; home: string; bin: string } {
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
  const real = process.env.ASK_HOME || join(homedir(), ".ask")
  cpSync(join(real, "cache", "models.json"), join(home, "cache", "models.json"))
  cpSync(join(real, "auth.json"), join(home, "auth.json"))
  writeFileSync(join(home, "config.json"), JSON.stringify({ model: "opencode-go/glm-5.3" }))
  return { dir, home, bin }
}

function driver(name: string, skill: string, prompt: string, dir: string, env: NodeJS.ProcessEnv): Promise<{ answer: string; seconds: number }> {
  const [cmd, args] =
    name === "claude"
      ? ["claude", ["-p", "--model", "sonnet", "--output-format", "json", "--append-system-prompt", skill, "--tools", "Bash,Read,Grep,Glob", "--allowedTools", "Bash,Read,Grep,Glob", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}', prompt]]
      : ["codex", ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"', "-c", `developer_instructions=${JSON.stringify(skill)}`, "-C", dir, prompt]]
  const began = Date.now()
  return new Promise((done) => {
    const child = spawn(cmd, args as string[], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000)
    child.on("close", () => {
      clearTimeout(timer)
      let answer = ""
      if (name === "claude") {
        try {
          answer = String(JSON.parse(out).result ?? "")
        } catch {}
      } else
        for (const line of out.split("\n")) {
          try {
            const e = JSON.parse(line)
            if (e.type === "item.completed" && e.item?.type === "agent_message") answer = e.item.text
          } catch {}
        }
      done({ answer, seconds: (Date.now() - began) / 1000 })
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

const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { ask: { type: "string" }, skill: { type: "string" }, label: { type: "string" }, drivers: { type: "string" }, reps: { type: "string" }, compare: { type: "boolean" } } })
mkdirSync(runs, { recursive: true })
if (v.compare) {
  for (const label of positionals) {
    const rows = readFileSync(join(runs, `callers-${label}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    // Graded again with today's graders, except the fix, whose grade came from its folder.
    for (const r of rows) if (r.job !== "delegated-fix") Object.assign(r, jobs.find((j) => j.id === r.job)!.grade(r.answer, ""))
    for (const d of [...new Set(rows.map((r) => r.driver))]) {
      const rs = rows.filter((r) => r.driver === d)
      const m = (k: string) => (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1)
      console.log([label, d, `${rs.filter((r) => r.pass).length}/${rs.length}`, `sessions ${m("sessions")}`, `together ${rs.filter((r) => r.together).length}`, `prompt ${m("prompt")}`, `turns ${m("turns")}`, `secs ${m("seconds")}`].join("\t"))
    }
  }
} else {
  if (!v.ask || !v.skill || !v.label) throw new Error("usage: bun bench/callers.ts --ask PATH --skill FILE --label NAME [--drivers claude,codex] [--reps N]")
  const skill = readFileSync(v.skill, "utf8")
  const file = join(runs, `callers-${v.label}.jsonl`)
  const all = (v.drivers ?? "claude,codex").split(",").flatMap((d) => jobs.flatMap((j) => Array.from({ length: Number(v.reps ?? 2) }, (_, rep) => ({ d, j, rep }))))
  console.error(`${all.length} runs`)
  await Promise.all(
    [0, 1, 2].map(async (lane) => {
      for (let i = lane; i < all.length; i += 3) {
        const { d, j, rep } = all[i]
        const { dir, home, bin } = prepare(j)
        writeFileSync(join(bin, "ask"), `#!/bin/sh\nexec ${process.execPath} ${join(v.ask!, "src", "cli.ts")} "$@"\n`)
        chmodSync(join(bin, "ask"), 0o755)
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASK_HOME: home, NO_COLOR: "1" }
        delete env.ASK_PARENT
        const { answer, seconds } = await driver(d, skill, j.prompt, dir, env)
        const row = { label: v.label, driver: d, job: j.id, rep, ...j.grade(answer, dir), ...usage(home), seconds, answer }
        appendFileSync(file, JSON.stringify(row) + "\n")
        console.error(`${d} ${j.id} ${row.pass ? "pass" : "FAIL"} ${row.notes} sessions=${row.sessions} together=${row.together} prompt=${row.prompt}`)
        rmSync(join(dir, ".."), { recursive: true, force: true })
      }
    }),
  )
}
