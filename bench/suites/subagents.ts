// Measure ask's subagent loop on pinned repositories and grade each answer once.

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { Message } from "../../src/providers/stream.ts"
import type { Action } from "../../src/agent/steps.ts"
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

/** Trace call shape and repeated targets without copying scripts or tool output. */
export function trace(messages: Message[], actions: Action[]) {
  return messages.flatMap((message, at): object[] => {
    if (message.role === "tool")
      return [{ result: message.name, chars: message.output.length, error: message.output.startsWith("error:") }]
    if (message.role === "assistant") return message.calls.map((call, script) => {
      let target: string | undefined
      try {
        const args = JSON.parse(call.arguments)
        if (["read", "list", "grep", "edit", "write"].includes(call.name) && typeof args.path === "string") target = args.path
        if (call.name === "git" && ["status", "diff", "log", "show", "blame"].includes(args.args?.[0])) target = args.args[0]
      } catch {}
      return {
        call: call.name, target, chars: call.arguments.length,
        ...(call.name === "execute" ? { actions: actions.filter((a) => a.at === at && a.script === script).map(({ label, state }) => ({ label, state })) } : {}),
      }
    })
    return []
  })
}

async function one(checkout: string, env: NodeJS.ProcessEnv, scratch: string, model: string, t: Task, rep: number, timeout: number, traces?: string) {
  const dir = mkdtempSync(join(scratch, `subagent-${t.id}-`))
  const began = Date.now()
  try {
    prepare(t, dir, scratch, env)
    const r = await ask(checkout, env, dir, { start: [{ prompt: t.prompt, model, write: t.write ?? false, timeout }], wait: timeout + 10 })
    const result = r.tasks?.[0] ?? { state: "failed", error: r.error }
    const answer: string = result.answer ?? ""
    const seconds = (Date.now() - began) / 1000
    let steps = 0, input = 0, output = 0, cached = 0
    try {
      const session = join(env.ASK_HOME!, "sessions", result.id)
      const turn = JSON.parse(readFileSync(join(session, "session.json"), "utf8")).turns[0]
      steps = turn.steps ?? 0
      input = turn.usage?.input ?? 0
      output = turn.usage?.output ?? 0
      cached = turn.usage?.cached ?? 0
      if (traces && /^[a-z0-9]+$/.test(result.id) && existsSync(join(session, "transcript.json"))) {
        const messages = JSON.parse(readFileSync(join(session, "transcript.json"), "utf8"))
        writeFileSync(join(traces, `${result.id}.json`), JSON.stringify({ task: t.id, model, rep, steps: trace(messages, turn.actions ?? []) }, null, 2) + "\n", { mode: 0o600 })
      }
    } catch {}
    const base = { group: model, case: t.id, model, kind: t.kind, rep, steps, input, output, cached, seconds, chars: answer.length, answer }
    if (result.state !== "succeeded") {
      if (result.id) await ask(checkout, env, dir, { stop: [result.id] })
      return { ...base, error: `${result.state}: ${result.error?.message ?? "ask did not complete"}`.slice(0, 200) }
    }
    return { ...base, ...await t.grade(answer, dir) }
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
    const { values } = parseArgs({ args, options: { models: { type: "string" }, tasks: { type: "string" }, timeout: { type: "string" } } })
    const models = (values.models ?? goModel).split(",")
    if (models.some((m) => !/^[^/\s]+\/\S+$/.test(m)) || new Set(models).size !== models.length)
      throw new Error("--models expects distinct provider/model IDs")
    const ids = pick(values.tasks, tasks.map((t) => t.id), "--tasks")
    const timeout = Number(values.timeout ?? 900)
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900) throw new Error("--timeout must be seconds in 1..900")
    const chosen = tasks.filter((t) => ids.includes(t.id))
    const cases = models.flatMap((model) => chosen.flatMap((t) => Array.from({ length: reps }, (_, rep) => ({ model, t, rep }))))
    return {
      inputs: { models, tasks: ids, timeout, repositories: { ask: askCommit, requests: requestsTag } },
      count: cases.length,
      async run(ctx) {
        await pool(cases, ctx.parallel, async ({ model, t, rep }) => {
          try { ctx.record(await one(ctx.checkout, ctx.env, ctx.scratch, model, t, rep, timeout, ctx.traces)) }
          catch (err) { ctx.record({ group: model, case: t.id, rep, error: (err as Error).message }) }
        })
      },
    }
  },
}
