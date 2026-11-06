// The benchmark runner: runs bench/tasks.ts through a given ask checkout, on real models, and
// grades every answer. Each run gets a fresh copy of its repository and its own session; the
// results go to bench/.runs/LABEL.jsonl, and a summary to stdout. It spends real quota.
//
//   bun bench/run.ts --ask PATH --label NAME [--models a,b] [--reps N] [--tasks id,...] [--parallel N]
//   bun bench/run.ts --compare LABEL LABEL...

import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { tasks, type Task } from "./tasks.ts"

const here = import.meta.dirname
const self = join(here, "..")
const runs = join(here, ".runs")
/** The commit of ask that "ask" tasks study, so every variant studies the same code. */
const askCommit = "d3cd456"
const requestsTag = "v2.32.3"

type Row = { label: string; model: string; task: string; kind: string; rep: number; state: string; pass: boolean; score: number; notes: string; steps: number; input: number; output: number; seconds: number; chars: number; answer: string }

function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@ask", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@ask" } }).toString()
}

/** A fresh copy of the task's repository. */
function prepare(t: Task): string {
  const dir = mkdtempSync(join(tmpdir(), `bench-${t.id}-`))
  if (t.repo.kind === "ask") {
    git(dir, "clone", "--quiet", "--shared", "--no-checkout", self, ".")
    git(dir, "checkout", "--quiet", askCommit)
  } else if (t.repo.kind === "requests") {
    const cache = join(here, ".cache", "requests")
    if (!existsSync(cache)) git(here, "clone", "--quiet", "--depth", "1", "--branch", requestsTag, "https://github.com/psf/requests", cache)
    git(dir, "clone", "--quiet", "--shared", cache, ".")
  } else {
    for (const [name, text] of Object.entries(t.repo.files)) writeFileSync(join(dir, name), text)
    git(dir, "init", "--quiet")
    git(dir, "add", ".")
    git(dir, "commit", "--quiet", "-m", "start")
    for (const [name, text] of Object.entries(t.repo.after ?? {})) writeFileSync(join(dir, name), text)
  }
  return dir
}

/** A scratch ask home with the user's keys and catalog, and both harnesses on. */
function scratch(): string {
  const home = mkdtempSync(join(tmpdir(), "bench-home-"))
  const real = process.env.ASK_HOME || join(homedir(), ".ask")
  mkdirSync(join(home, "cache"))
  cpSync(join(real, "cache", "models.json"), join(home, "cache", "models.json"))
  if (existsSync(join(real, "auth.json"))) cpSync(join(real, "auth.json"), join(home, "auth.json"))
  writeFileSync(join(home, "config.json"), JSON.stringify({ extensions: ["claude", "codex"], timeout: 900 }))
  return home
}

function ask(checkout: string, home: string, dir: string, request: object): Promise<any> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(checkout, "src", "cli.ts")], { cwd: dir, env: { ...process.env, ASK_HOME: home, NO_COLOR: "1", ASK_PARENT: "bench" } })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.on("close", () => {
      try {
        done(JSON.parse(out))
      } catch {
        done({ error: { message: out.slice(0, 300) || "no output" } })
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

async function one(checkout: string, home: string, label: string, model: string, t: Task, rep: number): Promise<Row> {
  const dir = prepare(t)
  const began = Date.now()
  try {
    const r = await ask(checkout, home, dir, { start: [{ prompt: t.prompt, model, write: t.write ?? false }], wait: 900 })
    const result = r.tasks?.[0] ?? { state: "failed", error: r.error }
    const answer: string = result.answer ?? ""
    const seconds = (Date.now() - began) / 1000
    let steps = 0, input = 0, output = 0
    try {
      const turn = JSON.parse(readFileSync(join(home, "sessions", result.id, "session.json"), "utf8")).turns[0]
      steps = turn.steps ?? 0
      input = turn.usage?.input ?? 0
      output = turn.usage?.output ?? 0
    } catch {}
    const g = result.state === "succeeded" ? t.grade(answer, dir) : { pass: false, score: 0, notes: `${result.state}: ${result.error?.message ?? ""}`.slice(0, 200) }
    return { label, model, task: t.id, kind: t.kind, rep, state: result.state, ...g, steps, input, output, seconds, chars: answer.length, answer }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs `jobs` with at most `n` at a time. */
async function pool<T>(jobs: (() => Promise<T>)[], n: number, each: (r: T) => void) {
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length) each(await jobs[next++]())
  }))
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function summary(rows: Row[]) {
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const k = `${r.label}\t${r.model}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const kinds = ["locate", "discipline", "fix", "review", "web"]
  console.log(["label", "model", "pass", ...kinds, "steps", "in k", "out k", "secs", "chars"].join("\t"))
  for (const [k, rs] of groups) {
    const by = (kind: string) => {
      const x = rs.filter((r) => r.kind === kind)
      return x.length ? `${x.filter((r) => r.pass).length}/${x.length}` : "-"
    }
    const ok = rs.filter((r) => r.state === "succeeded")
    console.log([k, `${rs.filter((r) => r.pass).length}/${rs.length}`, ...kinds.map(by), mean(ok.map((r) => r.steps)).toFixed(1), (mean(ok.map((r) => r.input)) / 1000).toFixed(0), (mean(ok.map((r) => r.output)) / 1000).toFixed(1), mean(ok.map((r) => r.seconds)).toFixed(0), mean(ok.map((r) => r.chars)).toFixed(0)].join("\t"))
  }
}

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: { ask: { type: "string" }, label: { type: "string" }, models: { type: "string" }, reps: { type: "string" }, tasks: { type: "string" }, parallel: { type: "string" }, compare: { type: "boolean" } },
})
mkdirSync(runs, { recursive: true })
if (v.compare) {
  const labels = positionals.length ? positionals : readdirSync(runs).map((f) => f.replace(/\.jsonl$/, ""))
  // Answers are graded again with today's graders; a fix's grade came from its folder, which is gone.
  const rows = labels.flatMap((l) => readFileSync(join(runs, `${l}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row))
  for (const r of rows) {
    const t = tasks.find((x) => x.id === r.task)
    if (t && t.kind !== "fix" && r.state === "succeeded") Object.assign(r, t.grade(r.answer, ""))
  }
  summary(rows)
} else {
  if (!v.ask || !v.label) throw new Error("usage: bun bench/run.ts --ask PATH --label NAME [--models a,b] [--reps N] [--tasks id,...] [--parallel N]")
  const models = (v.models ?? "opencode-go/glm-5.3,opencode-go/minimax-m3").split(",")
  const chosen = v.tasks ? tasks.filter((t) => v.tasks!.split(",").includes(t.id)) : tasks
  const reps = Number(v.reps ?? 3)
  const home = scratch()
  const file = join(runs, `${v.label}.jsonl`)
  const jobs = models.flatMap((m) =>
    chosen
      // Claude Code's write tasks need its sandbox, which this machine may not have.
      .filter((t) => !(m.startsWith("claude/") && t.write && process.platform === "linux" && !execFileSync("sh", ["-c", "command -v socat || true"]).toString().trim()))
      .flatMap((t) => Array.from({ length: reps }, (_, rep) => () => one(v.ask!, home, v.label!, m, t, rep))),
  )
  console.error(`${jobs.length} runs`)
  const rows: Row[] = []
  let done = 0
  await pool(jobs, Number(v.parallel ?? 4), (r) => {
    rows.push(r)
    appendFileSync(file, JSON.stringify(r) + "\n")
    console.error(`${++done}/${jobs.length} ${r.model} ${r.task} ${r.pass ? "pass" : "FAIL"} ${r.notes}`.slice(0, 200))
  })
  rmSync(home, { recursive: true, force: true })
  summary(rows)
}
