// Measures whether a real model's checkpoint carries task-critical facts into its continuation.
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { Message, Provider } from "../../src/providers/stream.ts"
import type { RunResult } from "../../src/agent/loop.ts"
import type { Suite } from "../suite.ts"

const messages: Message[] = [
  { role: "user", text: "Investigate the service. Constraints: never edit config/production.yml. The objective is to fix the Orion timeout. " + "Background detail. ".repeat(400) },
  { role: "assistant", text: "Decision: use a 37 second timeout because retries need room. Next, inspect src/orion.ts. The deployment is blocked by approval from Mira. A write to migrations/043.sql was interrupted; verify whether it took effect before retrying.", calls: [] },
  { role: "user", text: "Continue the investigation." },
  { role: "assistant", text: "Preparing the handoff.", calls: [] },
  { role: "user", text: "Report the objective, constraint, decision and reason, next file, blocker and interrupted action." },
]
/** Force a context overflow and record which facts survive in the continuation. */
export const suite: Suite = {
  live: true,
  repetitions: 1,
  compareFiles: [import.meta.filename],
  select(args, reps) {
    const { values: { model } } = parseArgs({ args, options: { model: { type: "string" } } })
    if (!model?.includes("/")) throw new Error("compaction requires --model provider/model")
    return {
      inputs: { model }, count: reps,
      async run(ctx) {
        const from = (file: string) => import(join(ctx.checkout, "src", file))
        const { home } = await from("base/home.ts"), { run } = await from("agent/loop.ts")
        const { connect } = await from("providers/catalog.ts"), { ProviderError } = await from("providers/stream.ts")
        const { resolve } = await from("sessions/models.ts")
        const target = await resolve(home(ctx.env.ASK_HOME), model)
        if (target.model.protocol === "harness") throw new Error("choose an API provider/model, not a harness")
        const provider: Provider = connect(target.model, target.key, target.baseURL)
        for (let rep = 0; rep < reps; rep++) {
          const start = Date.now()
          let first = true
          const wrapped: Provider = { complete(request) {
            if (first) { first = false; throw new ProviderError("maximum context length exceeded", 400) }
            return provider.complete(request)
          } }
          const result: RunResult = await run({
            provider: wrapped, model: target.model.id, session: `bench-compact-${Date.now()}`,
            dir: ctx.scratch, instructions: "Answer from the conversation alone. Do not use tools or infer facts about the current directory.",
            off: ["read", "list", "grep", "git", "fetch", "search"], messages: structuredClone(messages),
            maxOutput: target.model.output, signal: AbortSignal.timeout(120_000),
          })
          const answer = result.answer ?? ""
          const checks = {
            objective: /orion/i.test(answer) && /timeout/i.test(answer),
            constraint: /config\/production\.yml/i.test(answer),
            decision: /37/.test(answer) && /retr/i.test(answer),
            nextFile: /src\/orion\.ts/i.test(answer),
            blocker: /mira/i.test(answer) && /approv/i.test(answer),
            interrupted: /migrations\/043\.sql/i.test(answer) && /interrupt|verify|check/i.test(answer),
          }
          ctx.record({ group: model, case: "checkpoint", rep, checks, pass: Object.values(checks).every(Boolean),
            input: result.usage.input, output: result.usage.output, usage: result.usage,
            seconds: (Date.now() - start) / 1000, answer, error: result.error?.message })
        }
      },
    }
  },
}
