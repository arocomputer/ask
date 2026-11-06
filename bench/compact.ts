// Measures whether a real model's checkpoint carries task-critical facts into its continuation.
// Usage: bun bench/compact.ts provider/model. This sends two model calls and spends quota.
import { home } from "../src/base/home.ts"
import { run } from "../src/agent/loop.ts"
import { connect } from "../src/providers/catalog.ts"
import { ProviderError, type Message } from "../src/providers/stream.ts"
import { resolve } from "../src/sessions/models.ts"

const name = process.argv[2]
if (!name || !name.includes("/")) throw new Error("usage: bun bench/compact.ts provider/model")
const target = await resolve(home(), name)
if (target.model.protocol === "harness") throw new Error("choose an API provider/model, not a harness")
const provider = connect(target.model, target.key, target.baseURL)
let first = true
const messages: Message[] = [
  { role: "user", text: "Investigate the service. Constraints: never edit config/production.yml. The objective is to fix the Orion timeout. " + "Background detail. ".repeat(400) },
  { role: "assistant", text: "Decision: use a 37 second timeout because retries need room. Next, inspect src/orion.ts. The deployment is blocked by approval from Mira. A write to migrations/043.sql was interrupted; verify whether it took effect before retrying.", calls: [] },
  { role: "user", text: "Continue the investigation." },
  { role: "assistant", text: "Preparing the handoff.", calls: [] },
  { role: "user", text: "Report the objective, constraint, decision and reason, next file, blocker and interrupted action." },
]
const start = Date.now()
const result = await run({
  provider: { complete(request) {
    if (first) { first = false; throw new ProviderError("maximum context length exceeded", 400) }
    return provider.complete(request)
  } },
  model: target.model.id,
  session: `bench-compact-${Date.now()}`,
  dir: process.cwd(),
  instructions: "Answer from the conversation alone. Do not use tools or infer facts about the current directory.",
  off: ["read", "list", "grep", "git", "fetch", "search"],
  messages,
  maxOutput: target.model.output,
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
console.log(JSON.stringify({ model: name, checks, passed: Object.values(checks).filter(Boolean).length, usage: result.usage, seconds: (Date.now() - start) / 1000, answer, error: result.error }, null, 2))
if (result.error || Object.values(checks).some((value) => !value)) process.exitCode = 1
