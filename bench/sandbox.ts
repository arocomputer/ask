// Local policy/tool overhead, without model calls. Creates disposable small/large repositories;
// reports warm p50/p95 milliseconds, including fresh policy discovery on every write. Never caches
// metadata or changes an existing checkout. Usage: bun bench/sandbox.ts [--files 10000 --reps 10].
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { performance } from "node:perf_hooks"
import { policy, environment } from "../src/sandbox/policy.ts"
import { open, support } from "../src/sandbox/confine.ts"
import { tools } from "../src/agent/tools.ts"

const { values } = parseArgs({ options: { files: { type: "string", default: "10000" }, reps: { type: "string", default: "10" } } })
const files = Number(values.files), reps = Number(values.reps)
if (!Number.isInteger(files) || files < 100 || !Number.isInteger(reps) || reps < 3) throw new Error("files >= 100 and reps >= 3 must be integers")
const can = support()
if (!can.ok) throw new Error(can.detail)
const root = mkdtempSync(join(tmpdir(), "ask-policy-bench-"))
const api = Object.fromEntries(tools(true).map((tool) => [tool.name, tool]))

/** Warm each operation once, then measure independent samples in milliseconds. */
async function measure(run: () => unknown | Promise<unknown>) {
  await run()
  const samples: number[] = []
  for (let i = 0; i < reps; i++) { const start = performance.now(); await run(); samples.push(performance.now() - start) }
  samples.sort((a, b) => a - b)
  return { p50: +samples[Math.floor(samples.length / 2)].toFixed(3), p95: +samples[Math.ceil(samples.length * .95) - 1].toFixed(3) }
}

try {
  const rows = []
  for (const count of [100, files]) {
    const dir = join(root, String(count)), scratch = join(root, `scratch-${count}`)
    mkdirSync(dir); mkdirSync(scratch)
    execFileSync("git", ["init", "-q", dir])
    const folders = Math.max(10, Math.floor(count / 10))
    for (let i = 0; i < folders; i++) mkdirSync(join(dir, `d${i}`))
    for (let i = 0; i < count; i++) writeFileSync(join(dir, `d${i % folders}`, `f${i}.txt`), "benchmark content\n")
    for (let i = 0; i < 5; i++) execFileSync("git", ["init", "-q", join(dir, `d${i}`)])
    const p = policy(dir, scratch)
    const sb = await open(dir)
    try {
      rows.push({ files: count, folders, nestedRepositories: 5,
        readPolicy: await measure(() => policy(dir, scratch, false)),
        writePolicy: await measure(() => policy(dir, scratch)),
        environment: await measure(() => environment(p)),
        process: await measure(() => { const c = sb.execute(["/usr/bin/true"]); const result = spawnSync(c.file, c.args, { cwd: dir, env: c.env }); if (result.status !== 0) throw new Error(result.error?.message ?? String(result.stderr)) }),
        readTool: await measure(() => api.read.run({ path: "d0/f0.txt" }, { dir, sandbox: sb })),
        writeTool: await measure(() => api.write.run({ path: "result.txt", content: "bounded write\n" }, { dir, sandbox: sb })),
      })
    } finally { await sb.close() }
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.version, reps, milliseconds: rows }, null, 2))
} finally { rmSync(root, { recursive: true, force: true }) }
