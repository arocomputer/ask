// Exercise the benchmark's local commands without touching the real results or calling models.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { trace } from "../bench/suites/subagents.ts"

/** Copy the runner so the test can verify what it writes next to itself. */
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ask-bench-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bench = join(root, "bench")
  cpSync(join(import.meta.dirname, "../bench"), bench, { recursive: true, filter: (p) => !p.endsWith("/.runs") })
  const runs = join(bench, ".runs")
  const run = (...args: string[]) => spawnSync(process.execPath, [join(bench, "run.ts"), ...args], { cwd: root, encoding: "utf8" })
  return { runs, run }
}

test("planning does not write results or opt in to live model calls", (t) => {
  const { runs, run } = setup(t)
  const plan = run("plan", "callers", "--reps", "1", "--jobs", "parallel-questions")
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).count, 9)
  const denied = run("run", "callers", "--label", "test")
  assert.equal(denied.status, 1)
  assert.match(denied.stderr, /pass --live/)
  assert.ok(!existsSync(runs))
})

test("a subagent run pins the same per-task deadline in both arms", (t) => {
  const { runs, run } = setup(t)
  const plan = run("plan", "subagents", "--tasks", "compose-rollout", "--timeout", "90", "--reps", "1")
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).inputs.timeout, 90)
  assert.match(run("plan", "subagents", "--timeout", "0").stderr, /seconds in 1\.\.900/)
  assert.ok(!existsSync(runs))
})

test("subagent traces keep each script, its nested actions and the start of its result", () => {
  const output = "error: " + "x".repeat(400)
  const result = trace([
    { role: "assistant", text: "", calls: [{ id: "one", name: "execute", arguments: '{"code":"return r.text"}' }] },
    { role: "tool", id: "one", name: "execute", output },
  ], [{ at: 0, script: 0, id: 1, label: "git diff", state: "finished" }])
  assert.deepEqual(result, [
    { call: "execute", chars: '{"code":"return r.text"}'.length, code: "return r.text", actions: [{ label: "git diff", state: "finished" }] },
    { result: "execute", chars: output.length, error: true, head: output.slice(0, 300) },
  ])
})

test("comparison preserves saved grades and warns about mismatched workloads", (t) => {
  const { runs, run } = setup(t)
  const saved = '{"group":"codex/skill","case":"parallel-questions","rep":0,"pass":true,"answer":"saved grade, not regraded"}\n'
  for (const [label, parallel] of [["a", 1], ["b", 2]] as const) {
    const dir = join(runs, "callers", label)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, suite: "callers", label, parallel, completed: "now", count: 1 }))
    writeFileSync(join(dir, "results.jsonl"), saved)
  }
  const compared = run("compare", "callers", "a", "b")
  assert.equal(compared.status, 0, compared.stderr)
  assert.match(compared.stdout, /a\tcodex\/skill\t1\/1/)
  assert.match(compared.stderr, /not directly comparable: parallel/)
  assert.equal(readFileSync(join(runs, "callers", "a", "results.jsonl"), "utf8"), saved)
})

test("failed provider requests do not skew benchmark averages", (t) => {
  const { runs, run } = setup(t)
  const dir = join(runs, "callers", "quota")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, suite: "callers", label: "quota", completed: "now", count: 2 }))
  writeFileSync(join(dir, "results.jsonl"), [
    { group: "opencode/skill", case: "parallel-questions", rep: 0, error: "quota", seconds: 1, input: 0 },
    { group: "opencode/skill", case: "parallel-questions", rep: 1, pass: true, seconds: 9, input: 500 },
  ].map((row) => JSON.stringify(row)).join("\n"))
  const compared = run("compare", "callers", "quota")
  assert.equal(compared.status, 0, compared.stderr)
  assert.match(compared.stdout, /1\/1\t1\t0\/0\/0\/0\t500\t-\t9\.00/)
})
