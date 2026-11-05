// The OpenAI chat completions protocol, the one most providers and gateways serve. Streamed;
// tool calls arrive as fragments keyed by index and are joined here.

import { events, send, ProviderError, type Call, type Endpoint, type Message, type Provider, type Response } from "./stream.ts"

export function chat(endpoint: Endpoint): Provider {
  return {
    async complete(req) {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [...(req.instructions ? [{ role: "system", content: req.instructions }] : []), ...req.messages.map(encode)],
        stream: true,
        stream_options: { include_usage: true },
      }
      if (req.effort) body.reasoning_effort = req.effort
      if (req.maxOutput) body.max_tokens = req.maxOutput
      if (req.tools.length)
        body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
      if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: req.schema } }
      const res = await send(endpoint, "/chat/completions", (key) => ({ authorization: `Bearer ${key}` }), req, body)
      return decode(res)
    },
  }
}

function encode(m: Message): unknown {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.text }
    case "tool":
      return { role: "tool", tool_call_id: m.id, content: m.output }
    case "assistant":
      return {
        role: "assistant",
        content: m.text || null,
        ...(m.calls.length
          ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      }
  }
}

async function decode(res: globalThis.Response): Promise<Response> {
  let text = ""
  const parts: { id: string; name: string; arguments: string }[] = []
  let finish = ""
  let usage = { input: 0, output: 0, cached: 0 }
  let ended = false
  for await (const { data } of events(res)) {
    if (data.error) throw new ProviderError(data.error.message || "the provider reported an error", 200, String(data.error.code ?? data.error.type ?? ""))
    if (data.usage)
      usage = { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0, cached: data.usage.prompt_tokens_details?.cached_tokens ?? 0 }
    const choice = data.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === "string") text += delta.content
    for (const t of delta.tool_calls ?? []) {
      const i = t.index ?? parts.length
      const p = (parts[i] ??= { id: "", name: "", arguments: "" })
      if (t.id) p.id = t.id
      if (t.function?.name) p.name += t.function.name
      if (t.function?.arguments) p.arguments += t.function.arguments
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason
      ended = true
    }
  }
  if (!ended) throw new ProviderError("the response stream ended before the response completed")
  const calls: Call[] = parts.filter(Boolean).map((p, i) => ({ id: p.id || `call_${i}`, name: p.name, arguments: p.arguments }))
  return {
    message: { role: "assistant", text, calls },
    usage,
    incomplete: finish === "length" ? "max_output_tokens" : finish === "content_filter" ? "content_filter" : undefined,
  }
}
