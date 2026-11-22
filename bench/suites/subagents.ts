// Measure ask's subagent loop on pinned repositories and grade each answer once.

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { tasks, type Task } from "../fixtures/tasks.ts"
import { goModel, pick, pool, type Suite } from "../suite.ts"

const here = import.meta.dirname
const self = join(here, "../..")
/** The commit of ask that "ask" tasks study, so every variant studies the same code. */
const askCommit = "d3cd456"
const requestsTag = "v2.32.3"

function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@ask", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@ask" } }).toString()
}

/** A fresh copy of the task's repository. */
function prepare(t: Task, dir: string, scratch: string, env: NodeJS.ProcessEnv) {
  if (t.repo.kind === "ask") {
    git(dir, env, "clone", "--quiet", "--no-local", "--no-checkout", self, ".")
    git(dir, env, "checkout", "--quiet", askCommit)
  } else if (t.repo.kind === "requests") {
    const cache = join(scratch, "requests")
    if (!existsSync(cache)) git(scratch, env, "clone", "--quiet", "--depth", "1", "--branch", requestsTag, "https://github.com/psf/requests", cache)
    git(dir, env, "clone", "--quiet", "--shared", cache, ".")
  } else {
    for (const [name, text] of Object.entries(t.repo.files)) writeFileSync(join(dir, name), text)
    git(dir, env, "init", "--quiet")
    git(dir, env, "add", ".")
    git(dir, env, "commit", "--quiet", "-m", "start")
    for (const [name, text] of Object.entries(t.repo.after ?? {})) writeFileSync(join(dir, name), text)
  }
}

function ask(checkout: string, env: NodeJS.ProcessEnv, dir: string, request: object): Promise<any> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(checkout, "src", "cli.ts")], { cwd: dir, env: { ...env, NO_COLOR: "1", ASK_PARENT: "bench" } })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.resume()
    child.on("error", () => done({ error: { message: "could not start ask" } }))
    child.on("close", () => {
      try {
        done(JSON.parse(out))
      } catch {
        done({ error: { message: "ask did not return JSON" } })
      }
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

async function one(checkout: string, env: NodeJS.ProcessEnv, scratch: string, model: string, t: Task, rep: number) {
  const dir = mkdtempSync(join(scratch, `subagent-${t.id}-`))
  const began = Date.now()
  try {
    prepare(t, dir, scratch, env)
    const r = await ask(checkout, env, dir, { start: [{ prompt: t.prompt, model, write: t.write ?? false }], wait: 900 })
    const result = r.tasks?.[0] ?? { state: "failed", error: r.error }
    const answer: string = result.answer ?? ""
    const seconds = (Date.now() - began) / 1000
    let steps = 0, input = 0, output = 0
    try {
      const turn = JSON.parse(readFileSync(join(env.ASK_HOME!, "sessions", result.id, "session.json"), "utf8")).turns[0]
      steps = turn.steps ?? 0
      input = turn.usage?.input ?? 0
      output = turn.usage?.output ?? 0
    } catch {}
    const base = { group: model, case: t.id, model, kind: t.kind, rep, steps, input, output, seconds, chars: answer.length, answer }
    if (result.state !== "succeeded") {
      if (result.id) await ask(checkout, env, dir, { stop: [result.id] })
      return { ...base, error: `${result.state}: ${result.error?.message ?? "ask did not complete"}`.slice(0, 200) }
    }
    return { ...base, ...t.grade(answer, dir) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Plan without touching fixtures; prepare a fresh repository for each actual task. */
export const suite: Suite = {
  live: true,
  compareFiles: [import.meta.filename, join(here, "../fixtures/tasks.ts")],
  repetitions: 3,
  select(args, reps) {
    const { values } = parseArgs({ args, options: { models: { type: "string" }, tasks: { type: "string" } } })
    const models = (values.models ?? goModel).split(",")
    if (models.some((m) => !/^[^/\s]+\/\S+$/.test(m)) || new Set(models).size !== models.length)
      throw new Error("--models expects distinct provider/model IDs")
    const ids = pick(values.tasks, tasks.map((t) => t.id), "--tasks")
    const chosen = tasks.filter((t) => ids.includes(t.id))
    const cases = models.flatMap((model) => chosen.flatMap((t) => Array.from({ length: reps }, (_, rep) => ({ model, t, rep }))))
    return {
      inputs: { models, tasks: ids, repositories: { ask: askCommit, requests: requestsTag } },
      count: cases.length,
      async run(ctx) {
        await pool(cases, ctx.parallel, async ({ model, t, rep }) => {
          try { ctx.record(await one(ctx.checkout, ctx.env, ctx.scratch, model, t, rep)) }
          catch (err) { ctx.record({ group: model, case: t.id, rep, error: (err as Error).message }) }
        })
      },
    }
  },
}
