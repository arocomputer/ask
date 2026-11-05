// ask's agent loop: send the conversation to a provider, run the tools the model calls, feed
// back their results, and stop at a final answer or a limit. The transcript is the record of
// everything visible: `onUpdate` hears it after every model turn and every tool result, so a
// caller can save it and show progress from it.

import { overflowed, ProviderError, type Message, type Provider, type Usage } from "./provider.ts"
import { instructions } from "./system.ts"
import { tools as builtIn, type Args, type Tool } from "./tools.ts"

export type RunOptions = {
  provider: Provider
  /** The model's id as its provider knows it. */
  model: string
  /** The directory the subagent works in; tool paths are confined to it. */
  dir: string
  /**
   * The user's message for this turn, appended to `messages`. Without one, the loop resumes the
   * conversation as it stands, as for a turn whose worker was stopped partway.
   */
  prompt?: string
  /** The conversation so far, for a follow-up turn. */
  messages?: Message[]
  write?: boolean
  effort?: string
  /** A JSON Schema the final answer must match. */
  schema?: object
  /** Replaces the system prompt `system.ts` builds. */
  instructions?: string
  maxOutput?: number
  /** Model turns before giving up; 100 by default. */
  maxSteps?: number
  /** A stable id for the conversation, sent to gateways that route and cache by it. */
  session?: string
  signal?: AbortSignal
  onUpdate?: (messages: Message[], usage: Usage) => void
}

/** Why a turn ended without an answer, and what the caller can do about it. */
export type Failure = { message: string; hint?: string }

/** A turn's outcome. `messages` is the whole conversation, complete up to where it ended. */
export type RunResult = { answer?: string; error?: Failure; messages: Message[]; usage: Usage; steps: number }

const elided = "[output elided to fit the context window; run the tool again if you need it]"

export async function run(o: RunOptions): Promise<RunResult> {
  const messages: Message[] = o.prompt === undefined ? interrupted(o.messages ?? []) : [...(o.messages ?? []), { role: "user", text: o.prompt }]
  const usage: Usage = { input: 0, output: 0, cached: 0 }
  const tools = builtIn(o.write ?? false)
  const system = o.instructions ?? instructions(o.dir, o.write ?? false, !!o.schema)
  const maxSteps = o.maxSteps ?? 100
  const update = () => o.onUpdate?.(messages, usage)
  const end = (r: Partial<RunResult>, steps: number): RunResult => ({ ...r, messages, usage, steps })
  for (let step = 1; step <= maxSteps; step++) {
    let res
    try {
      res = await o.provider.complete({
        model: o.model,
        instructions: system,
        messages,
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        effort: o.effort,
        schema: o.schema,
        maxOutput: o.maxOutput,
        session: o.session,
        signal: o.signal,
      })
    } catch (err) {
      if (o.signal?.aborted) return end({ error: { message: "stopped" } }, step)
      if (overflowed(err) && elide(messages)) {
        step--
        continue
      }
      return end({ error: describe(err) }, step)
    }
    messages.push(res.message)
    usage.input += res.usage.input
    usage.output += res.usage.output
    usage.cached += res.usage.cached
    update()
    if (res.incomplete)
      return end({ error: { message: `the model stopped early (${res.incomplete})`, hint: "ask for less in one step, or use a model with more output room" } }, step)
    const calls = res.message.calls
    if (!calls.length) {
      const answer = res.message.text.trim()
      return end(answer ? { answer } : { error: { message: "the model gave no answer", hint: "continue the session to ask again" } }, step)
    }
    const parallel = calls.every((c) => tools.find((t) => t.name === c.name)?.readonly)
    const outputs: string[] = []
    if (parallel) outputs.push(...(await Promise.all(calls.map((c) => call(tools, c.name, c.arguments, o)))))
    for (const [i, c] of calls.entries()) {
      if (o.signal?.aborted) return end({ error: { message: "stopped" } }, step)
      const output = parallel ? outputs[i] : await call(tools, c.name, c.arguments, o)
      messages.push({ role: "tool", id: c.id, name: c.name, output })
      update()
    }
  }
  return end({ error: { message: `hit the ${maxSteps}-step limit without answering`, hint: "continue the session to let it go on, or split the task" } }, maxSteps)
}

const cut = "error: this call was interrupted before it finished, so its result is unknown. If it could have changed something, check whether it took effect before running it again."

/**
 * Gives every tool call the conversation left without a result an "interrupted" result, so a
 * resumed model knows the call may or may not have happened instead of silently repeating it.
 */
export function interrupted(messages: Message[]): Message[] {
  const out = [...messages]
  const answered = new Set(out.filter((m) => m.role === "tool").map((m) => (m as { id: string }).id))
  const last = out.findLastIndex((m) => m.role === "assistant")
  const m = out[last]
  if (m?.role === "assistant")
    for (const c of m.calls) if (!answered.has(c.id)) out.push({ role: "tool", id: c.id, name: c.name, output: cut })
  return out
}

/** Runs one tool call and returns what the model sees, errors included. */
async function call(tools: Tool[], name: string, text: string, o: RunOptions): Promise<string> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return `error: no tool named ${name}; the tools are ${tools.map((t) => t.name).join(", ")}`
  let args: Args
  try {
    args = text.trim() ? JSON.parse(text) : {}
  } catch {
    return "error: arguments must be a JSON object"
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return "error: arguments must be a JSON object"
  try {
    return await tool.run(args, { dir: o.dir, signal: o.signal })
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

/**
 * Shortens long tool outputs older than the latest model turn, so the conversation fits again.
 * Returns false when there was nothing left to shorten.
 */
function elide(messages: Message[]): boolean {
  let last = messages.length - 1
  while (last >= 0 && messages[last].role !== "assistant") last--
  let changed = false
  for (let i = 0; i < last; i++) {
    const m = messages[i]
    if (m.role === "tool" && m.output.length > 500) {
      messages[i] = { ...m, output: elided }
      changed = true
    }
  }
  return changed
}

/** Turns a provider error into a failure with a next step. */
function describe(err: unknown): Failure {
  if (!(err instanceof ProviderError)) return { message: (err as Error)?.message ?? String(err) }
  if (overflowed(err)) return { message: `the conversation no longer fits the model's context: ${err.message}`, hint: "start a new session with a narrower task, or use a model with a larger context" }
  if (err.status === 401 || err.status === 403) return { message: `the provider rejected the credential: ${err.message}`, hint: "ask doctor checks the key; ask settings replaces it" }
  if (err.status === 429) return { message: `the provider is rate limiting or out of quota: ${err.message}`, hint: "wait and continue the session, or use another model" }
  if (err.status === 404) return { message: err.message, hint: "ask models lists the models each provider serves" }
  return { message: err.message }
}
