// Benchmark entry point. List, plan and compare are local reads; run owns all mutable state.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { arch, homedir, platform, release, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Row, Suite } from "./suite.ts"
import { suite as callers } from "./suites/callers.ts"
import { suite as subagents } from "./suites/subagents.ts"
import { suite as compaction } from "./suites/compaction.ts"
import { suite as extraction } from "./suites/extraction.ts"
import { suite as sandbox } from "./suites/sandbox.ts"

const directory = import.meta.dirname
const suites = new Map<string, Suite>(Object.entries({ subagents, callers, compaction, extraction, sandbox }))
const runs = join(directory, ".runs")
const help = `bun bench/run.ts list
bun bench/run.ts plan SUITE [--reps N] [--parallel N] [suite options]
bun bench/run.ts run SUITE --label NAME [--live] [--ask CHECKOUT] [--traces] [plan options]
bun bench/run.ts compare SUITE LABEL [LABEL ...]`

type Manifest = {
  schema: 1
  suite: string
  label: string
  revision: string
  suiteHash: string
  inputs: Record<string, unknown>
  variant?: Record<string, string>
  reps: number
  parallel: number
  count: number
  host: { platform: string; arch: string; release: string; runtime: string }
  started: string
  completed?: string
}

/** Prevent labels from escaping the result directory or shadowing suite names. */
function label(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("use a label with letters, numbers, dashes or underscores")
  return name
}

/** Validate run sizes before expanding a suite's cases. */
function positive(input: string | undefined, fallback: number, flag: string) {
  const n = Number(input ?? fallback)
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new Error(`${flag} must be an integer in 1..100`)
  return n
}

/** Hash suite code and fixture/grader inputs apart from the ask revision under test. */
function hash(files: string[]) {
  const digest = createHash("sha256")
  for (const file of files) digest.update(readFileSync(file)).update("\0")
  return digest.digest("hex")
}

/** Use a committed snapshot so builds and toolchain probes never write to the tested checkout. */
function checkout(source: string, target: string): string {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: source, maxBuffer: 16 * 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_OPTIONAL_LOCKS: "0" },
  })
  const revision = git("rev-parse", "--verify", "HEAD").toString().trim()
  if (git("status", "--porcelain", "--", "src", "native", "package.json").length)
    throw new Error("commit changes to src/, native/ and package.json before benchmarking them")
  const archive = git("archive", revision, "--", "src", "native", "package.json")
  mkdirSync(target)
  execFileSync("tar", ["-xf", "-", "-C", target], { input: archive })
  return revision
}

/** Seed scratch profiles with credentials only, leaving the user's configs and state alone. */
function environment(scratch: string, live: boolean): NodeJS.ProcessEnv {
  const real = homedir()
  const user = join(scratch, "user"), home = join(scratch, "ask"), tmp = join(scratch, "tmp")
  const claude = join(user, ".claude"), codex = join(user, ".codex")
  for (const dir of [join(home, "cache"), claude, codex, tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const copy = (from: string, to: string, auth = false) => {
    if (!existsSync(from)) return
    const text = readFileSync(from, "utf8")
    // Reusing a rotating refresh token in the scratch profile can sign out the real profile.
    // Keep the current access credential; require it to be fresh enough for the whole run.
    let bytes = text
    if (auth) {
      try {
        bytes = JSON.stringify(JSON.parse(text, (key, value) =>
          (key === "refreshToken" || key === "refresh_token") && value ? "benchmark-no-refresh" : value))
      } catch { throw new Error(`cannot read benchmark credentials at ${from}: invalid JSON`) }
    }
    writeFileSync(to, bytes, { mode: 0o600, flag: "wx" })
  }
  if (live) {
    const ask = process.env.ASK_HOME || join(real, ".ask")
    copy(join(ask, "cache", "models.json"), join(home, "cache", "models.json"))
    copy(join(ask, "auth.json"), join(home, "auth.json"), true)
    copy(join(process.env.CLAUDE_CONFIG_DIR || join(real, ".claude"), ".credentials.json"), join(claude, ".credentials.json"), true)
    copy(join(process.env.CODEX_HOME || join(real, ".codex"), "auth.json"), join(codex, "auth.json"), true)
  }
  writeFileSync(join(home, "config.json"), JSON.stringify({ extensions: ["claude", "codex"], timeout: 900 }))
  const inherited = /^(ASK_|OPENCODE|CLAUDECODE$|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|SESSION_ATTENDED)$|CLAUDE_PID$|CODEX_(THREAD_ID|SESSION_ID|TOOL_CALL_ID|SANDBOX)|XDG_|GIT_)/
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited.test(name)))
  return { ...env, HOME: user, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, ASK_HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: join(user, ".config"), XDG_DATA_HOME: join(user, ".local", "share"),
    XDG_CACHE_HOME: join(user, ".cache"), XDG_STATE_HOME: join(user, ".local", "state"),
    OPENCODE_API_KEY: live ? process.env.OPENCODE_API_KEY : undefined, NO_COLOR: "1" }
}

/** Report saved outcomes without regrading, including runs interrupted partway through. */
function summary(name: string, rows: Row[]) {
  const groups = Map.groupBy(rows, (r) => typeof r.p50 === "number" ? `${r.group}/${r.case}` : r.group)
  const mean = (items: Row[], key: string, digits = 0) => {
    const numbers = items.map((r) => r[key]).filter((v): v is number => typeof v === "number")
    return numbers.length ? (numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(digits) : "-"
  }
  for (const [group, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const completed = items.filter((r) => !r.error)
    const scores = completed.filter((r) => typeof r.pass === "boolean")
    const routes = ["ask", "native", "mixed", "self"].map((route) => completed.filter((r) => r.route === route).length).join("/")
    console.log([name, group, scores.length ? `${scores.filter((r) => r.pass).length}/${scores.length}` : "-",
      items.length - completed.length, routes, mean(completed, "input"), mean(completed, "output"), mean(completed, "seconds", 2),
      mean(completed, "p50", 3), mean(completed, "p95", 3)].join("\t"))
  }
}

const header = "label\tgroup\tpassed\terrors\task/native/mixed/self\tinput\toutput\tseconds\tp50 ms\tp95 ms"

/** Warn on mismatched protocols or workloads, without treating the tested revision as a mismatch. */
function compare(suite: string, names: string[]) {
  if (!names.length) throw new Error("compare needs at least one run label")
  let baseline: Manifest | undefined
  console.log(header)
  for (const name of names.map(label)) {
    const dir = join(runs, suite, name)
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest
    if (m.schema !== 1 || m.suite !== suite || m.label !== name) throw new Error(`invalid manifest for ${suite}/${name}`)
    const rows = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
    if (!m.completed || rows.length !== m.count) console.error(`${name}: incomplete (${rows.length}/${m.count} rows)`)
    if (baseline) {
      const different = (["suiteHash", "inputs", "reps", "parallel", "host"] as const)
        .filter((key) => JSON.stringify(m[key]) !== JSON.stringify(baseline![key]))
      if (different.length) console.error(`${name} and ${baseline.label} are not directly comparable: ${different.join(", ")}`)
      if (JSON.stringify(m.variant) !== JSON.stringify(baseline.variant)) console.error(`${name}: experiment variant differs from ${baseline.label}`)
    }
    baseline ??= m
    summary(name, rows)
  }
}

/** Claim a run directory once and save its manifest before executing any suite cases. */
async function main([action, suiteName, ...args]: string[]) {
  if (!action || action === "--help" || action === "-h") return console.log(help)
  if (action === "list" && !suiteName) {
    for (const [name, suite] of suites) console.log(`${name}\t${suite.live ? "live" : "local"}`)
    return
  }
  const suite = suites.get(suiteName)
  if (!suite) throw new Error(`unknown suite: ${suiteName ?? "(none)"}\n${help}`)
  if (action === "compare") return compare(suiteName, args)
  if (action !== "plan" && action !== "run") throw new Error(help)
  const common = parseArgs({ args, strict: false, tokens: true, options: {
    ask: { type: "string" }, label: { type: "string" }, reps: { type: "string" }, parallel: { type: "string" },
    live: { type: "boolean" }, traces: { type: "boolean" },
  } })
  const { values } = common
  const consumed = new Set<number>()
  for (const token of common.tokens) {
    if (token.kind === "option" && ["ask", "label", "reps", "parallel", "live", "traces"].includes(token.name)) {
      if (["live", "traces"].includes(token.name) && token.value !== undefined)
        throw new Error(`--${token.name} does not take a value`)
      consumed.add(token.index)
      if (!token.inlineValue && token.value !== undefined) consumed.add(token.index + 1)
    }
  }
  const reps = positive(values.reps as string | undefined, suite.repetitions, "--reps")
  const parallel = positive(values.parallel as string | undefined, 1, "--parallel")
  for (const key of ["ask", "label", "reps", "parallel"] as const)
    if (values[key] === true) throw new Error(`--${key} needs a value`)
  const plan = suite.select(args.filter((_, index) => !consumed.has(index)), reps)
  if (action === "plan") return console.log(JSON.stringify({ suite: suiteName, live: suite.live, reps, parallel, count: plan.count, inputs: plan.inputs, variant: plan.variant }, null, 2))
  if (suite.live && values.live !== true) throw new Error(`${suiteName} calls real models; pass --live to run it`)
  if (typeof values.label !== "string") throw new Error("run needs --label NAME")
  const name = label(values.label)
  const scratch = mkdtempSync(join(tmpdir(), "ask-benchmark-"))
  try {
    const copy = join(scratch, "checkout"), revision = checkout(resolve((values.ask as string | undefined) ?? join(directory, "..")), copy)
    const result = join(runs, suiteName, name)
    for (const parent of [runs, join(runs, suiteName)]) {
      const stat = lstatSync(parent, { throwIfNoEntry: false })
      if (!stat) mkdirSync(parent, { mode: 0o700 })
      else if (!stat.isDirectory()) throw new Error("benchmark results must be in regular directories under bench/.runs")
    }
    mkdirSync(result, { mode: 0o700 })
    const manifest = join(result, "manifest.json"), file = join(result, "results.jsonl"), traces = values.traces ? join(result, "traces") : undefined
    const m: Manifest = {
      schema: 1, suite: suiteName, label: name, revision,
      suiteHash: hash([import.meta.filename, join(directory, "suite.ts"), ...suite.compareFiles]),
      inputs: plan.inputs, variant: plan.variant, reps, parallel, count: plan.count,
      host: { platform: platform(), arch: arch(), release: release(), runtime: process.versions.bun ?? process.version },
      started: new Date().toISOString(),
    }
    const save = () => writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 })
    save()
    writeFileSync(file, "", { mode: 0o600 })
    if (traces) mkdirSync(traces, { mode: 0o700 })
    const rows: Row[] = []
    await plan.run({ checkout: copy, scratch, env: environment(scratch, suite.live), parallel, traces, record(row) {
      rows.push(row)
      appendFileSync(file, JSON.stringify(row) + "\n")
      console.error(`${rows.length}/${plan.count} ${row.group} ${row.case} ${row.error ? "error" : row.pass === false ? "fail" : "ok"}`)
    } })
    if (rows.length !== plan.count) throw new Error(`suite emitted ${rows.length}/${plan.count} rows`)
    m.completed = new Date().toISOString()
    save()
    console.log(header)
    summary(name, rows)
    if (rows.some((r) => r.error || r.pass === false)) process.exitCode = 1
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

try { await main(process.argv.slice(2)) }
catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
