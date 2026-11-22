// Exercise the benchmark's local commands without touching the real results or calling models.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

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
