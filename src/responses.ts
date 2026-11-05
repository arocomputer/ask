// The OpenAI Responses protocol, streamed and stateless (store: false), so the whole
// conversation lives in ask's transcript. With `reasoning`, it asks for encrypted reasoning
// items so they replay across turns; only OpenAI's own endpoint returns them, and a gateway's
// bare reasoning items are dropped, since sending them back fails.

import { events, send, ProviderError, type Call, type Endpoint, type Message, type Provider, type Response } from "./provider.ts"

/**
 * A Responses client. With `namespace`, the tools are offered grouped under that name, as
 * ChatGPT's plan route requires.
 */
export function responses(endpoint: Endpoint, reasoning = false, namespace?: string): Provider {
  return {
    async complete(req) {
      const body: Record<string, unknown> = {
        model: req.model,
        input: req.messages.flatMap(encode),
        stream: true,
        store: false,
      }
      if (req.instructions) body.instructions = req.instructions
      if (reasoning) body.include = ["reasoning.encrypted_content"]
      if (req.effort) body.reasoning = { effort: req.effort }
      if (req.tools.length) {
        const functions = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }))
        body.tools = namespace ? [{ type: "namespace", name: namespace, description: "Tools for working in the task's folder.", tools: functions }] : functions
      }
      if (req.schema) body.text = { format: { type: "json_schema", name: "answer", schema: req.schema } }
      const res = await send(endpoint, "/responses", (key) => ({ authorization: `Bearer ${key}` }), req, body)
      return decode(res)
    },
  }
}

function encode(m: Message): unknown[] {
  switch (m.role) {
    case "user":
      return [{ type: "message", role: "user", content: [{ type: "input_text", text: m.text }] }]
    case "tool":
      return [{ type: "function_call_output", call_id: m.id, output: m.output }]
    case "assistant":
      if (m.native?.protocol === "responses") return m.native.items
      return [
        ...(m.text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] }] : []),
        ...m.calls.map((c) => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments })),
      ]
  }
}

/** A tool's own name, whether a namespaced call reports it as "ask.read" or plain "read". */
function bare(name: string): string {
  return name.replace(/^[A-Za-z0-9_-]+[.:/]/, "")
}

async function decode(res: globalThis.Response): Promise<Response> {
  const items: any[] = []
  const calls: Call[] = []
  let text = ""
  for await (const { event, data } of events(res)) {
    switch (data.type ?? event) {
      case "response.output_item.done": {
        const item = data.item
        if (!item || (item.type === "reasoning" && !item.encrypted_content)) break
        items.push(item)
        if (item.type === "function_call") calls.push({ id: item.call_id, name: bare(item.name ?? ""), arguments: item.arguments ?? "" })
        if (item.type === "message")
          for (const c of item.content ?? []) if (c.type === "output_text") text += c.text
        break
      }
      case "response.completed":
      case "response.incomplete": {
        const r = data.response ?? {}
        const u = r.usage ?? {}
        const incomplete = data.type === "response.incomplete" || r.status === "incomplete" ? r.incomplete_details?.reason || "incomplete" : undefined
        return {
          message: { role: "assistant", text, calls, native: { protocol: "responses", items } },
          usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0 },
          incomplete,
        }
      }
      case "response.failed":
        throw new ProviderError(data.response?.error?.message || "the response failed", 200, data.response?.error?.code ?? "")
      case "error":
        throw new ProviderError(data.message || data.error?.message || "the provider reported an error", 200, data.code ?? data.error?.code ?? "")
    }
  }
  throw new ProviderError("the response stream ended before the response completed")
}
