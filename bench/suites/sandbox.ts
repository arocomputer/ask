// Local policy/tool overhead, without model calls. Creates disposable small/large repositories;
// reports warm p50/p95 milliseconds, including fresh policy discovery on every write. Never caches
// metadata or changes an existing checkout.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { performance } from "node:perf_hooks"
import type { Tool } from "../../src/agent/tools.ts"
import type { Suite } from "../suite.ts"

/** Warm each operation once, then measure independent samples in milliseconds. */
async function measure(reps: number, run: () => unknown | Promise<unknown>) {
  await run()
  const samples: number[] = []
  for (let i = 0; i < reps; i++) { const start = performance.now(); await run(); samples.push(performance.now() - start) }
  samples.sort((a, b) => a - b)
  return { p50: +samples[Math.floor(samples.length / 2)].toFixed(3), p95: +samples[Math.ceil(samples.length * .95) - 1].toFixed(3) }
}

/** Measure fresh policy and tool work in disposable repositories, with no model involved. */
export const suite: Suite = {
  live: false,
  repetitions: 10,
  compareFiles: [import.meta.filename],
  select(args, reps) {
    const { values } = parseArgs({ args, options: { files: { type: "string", default: "10000" } } })
    const files = Number(values.files)
    if (!Number.isSafeInteger(files) || files < 100 || reps < 3) throw new Error("sandbox needs --files >= 100 and --reps >= 3")
    const counts = [...new Set([100, files])]
    return {
      inputs: { files: counts },
      count: counts.length * 6,
      async run(ctx) {
        const from = (file: string) => import(join(ctx.checkout, "src", file))
        const { policy, environment } = await from("sandbox/policy.ts"), { open, support } = await from("sandbox/confine.ts")
        const can = support()
        if (!can.ok) throw new Error(can.detail)
        const { tools } = await from("agent/tools.ts")
        const api = Object.fromEntries((tools(true) as Tool[]).map((tool) => [tool.name, tool]))
        for (const count of counts) {
          const dir = join(ctx.scratch, String(count)), scratch = join(ctx.scratch, `policy-${count}`)
          mkdirSync(dir); mkdirSync(scratch)
          const git = (path: string) => execFileSync("git", ["init", "-q", path], {
            env: { ...ctx.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          })
          git(dir)
          const folders = Math.max(10, Math.floor(count / 10))
          for (let i = 0; i < folders; i++) mkdirSync(join(dir, `d${i}`))
          for (let i = 0; i < count; i++) writeFileSync(join(dir, `d${i % folders}`, `f${i}.txt`), "benchmark content\n")
          for (let i = 0; i < 5; i++) git(join(dir, `d${i}`))
          const p = policy(dir, scratch), sb = await open(dir)
          try {
            const operations = {
              readPolicy: () => policy(dir, scratch, false),
              writePolicy: () => policy(dir, scratch),
              environment: () => environment(p),
              process: () => {
                const c = sb.execute(["/usr/bin/true"])
                const result = spawnSync(c.file, c.args, { cwd: dir, env: c.env })
                if (result.status !== 0) throw new Error(result.error?.message ?? String(result.stderr))
              },
              readTool: () => api.read.run({ path: "d0/f0.txt" }, { dir, sandbox: sb }),
              writeTool: () => api.write.run({ path: "result.txt", content: "bounded write\n" }, { dir, sandbox: sb }),
            }
            for (const [name, fn] of Object.entries(operations)) {
              const sample = await measure(reps, fn)
              ctx.record({ group: `${count} files`, case: name, rep: 0, ...sample, files: count, folders, nestedRepositories: 5 })
            }
          } finally { await sb.close() }
        }
      },
    }
  },
}
