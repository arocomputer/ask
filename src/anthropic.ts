// The Anthropic Messages protocol, streamed. Tool results travel as user content blocks;
// thinking blocks carry signatures and replay verbatim through `native`. The system prompt and
// the newest message are marked for prompt caching, since a loop resends the whole conversation
// every turn. Effort maps to a thinking budget. Anthropic has no response schema, so a
// requested schema is stated in the system prompt instead.

import { events, send, ProviderError, type Call, type Endpoint, type Message, type Provider, type Response, type Usage } from "./provider.ts"

const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 16384, high: 32768 }

export function anthropic(endpoint: Endpoint): Provider {
  return {
    async complete(req) {
      let system = req.instructions
      if (req.schema) system += `\n\nThe required schema:\n${JSON.stringify(req.schema)}`
      const budget = req.effort ? budgets[req.effort] : undefined
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: Math.max(req.maxOutput ?? 32000, (budget ?? 0) + 4096),
        stream: true,
        messages: encode(req.messages),
      }
      if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      if (budget) body.thinking = { type: "enabled", budget_tokens: budget }
      if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      const res = await send(endpoint, "/messages", (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }), req, body)
      return decode(res)
    },
  }
}

type Turn = { role: "user" | "assistant"; content: any[] }

/** Converts the transcript into alternating turns, merging tool results into user turns. */
function encode(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  const add = (role: Turn["role"], blocks: any[]) => {
    const last = turns.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }
  for (const m of messages) {
    if (m.role === "user") add("user", [{ type: "text", text: m.text }])
    else if (m.role === "tool") add("user", [{ type: "tool_result", tool_use_id: m.id, content: m.output }])
    else if (m.native?.protocol === "anthropic") add("assistant", structuredClone(m.native.items))
    else
      add("assistant", [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: parse(c.arguments) })),
      ])
  }
  const last = turns.at(-1)?.content.at(-1)
  if (last) last.cache_control = { type: "ephemeral" }
  return turns
}

function parse(args: string): unknown {
  try {
    const v = JSON.parse(args)
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/**
 * Reads Anthropic usage into ask's counts. Anthropic sends input at the start and output at the
 * end, but gateways may send either at the end, so any field present replaces the old value.
 */
function count(u: any, prev: Usage): Usage {
  if (!u) return prev
  const cached = u.cache_read_input_tokens ?? prev.cached
  const input = u.input_tokens != null ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : prev.input
  return { input, output: u.output_tokens ?? prev.output, cached }
}

async function decode(res: globalThis.Response): Promise<Response> {
  const blocks: any[] = []
  const json: string[] = []
  let usage = { input: 0, output: 0, cached: 0 }
  let stop = ""
  for await (const { data } of events(res)) {
    switch (data.type) {
      case "message_start":
        usage = count(data.message?.usage, usage)
        break
      case "content_block_start":
        blocks[data.index] = { ...data.content_block }
        json[data.index] = ""
        break
      case "content_block_delta": {
        const b = blocks[data.index]
        const d = data.delta ?? {}
        if (!b) break
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text
        else if (d.type === "input_json_delta") json[data.index] += d.partial_json
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking
        else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature
        break
      }
      case "content_block_stop": {
        const b = blocks[data.index]
        if (b?.type === "tool_use") b.input = json[data.index] ? parse(json[data.index]) : (b.input ?? {})
        break
      }
      case "message_delta":
        if (data.delta?.stop_reason) stop = data.delta.stop_reason
        usage = count(data.usage, usage)
        break
      case "error":
        throw new ProviderError(data.error?.message || "the provider reported an error", 200, data.error?.type ?? "")
      case "message_stop": {
        const items = blocks.filter(Boolean)
        const text = items.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
        const calls: Call[] = items
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }))
        return {
          message: { role: "assistant", text, calls, native: { protocol: "anthropic", items } },
          usage,
          incomplete: stop === "max_tokens" ? "max_output_tokens" : stop === "refusal" ? "refusal" : undefined,
        }
      }
    }
  }
  throw new ProviderError("the response stream ended before the response completed")
}
