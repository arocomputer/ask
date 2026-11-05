// A scripted model provider for tests: an HTTP server that answers each request with the next
// reply, encoded in the protocol asked for, and records every request body.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Protocol } from "../src/provider.ts"

/**
 * One model turn to play back: text, tool calls, or an HTTP error. A reply with `when` answers a
 * request whose latest message is the user's and contains it (a turn's first model call); the
 * others are played in order.
 */
export type Reply = {
  text?: string
  calls?: { name: string; args: object }[]
  /** A reasoning item first, sealed when `encrypted` is set (Responses only). */
  reasoning?: { encrypted?: string }
  status?: number
  error?: string
  delay?: number
  when?: string
}

/** `requests` holds each request's body; `headers` the matching request headers. */
export type Fake = { url: string; requests: any[]; headers: Record<string, string | string[] | undefined>[]; close(): Promise<void> }

export async function serve(protocol: Protocol, replies: Reply[]): Promise<Fake> {
  const requests: any[] = []
  const headers: Fake["headers"] = []
  let n = 0
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    headers.push(req.headers)
    const plain = replies.filter((x) => !x.when)
    const said = asked(protocol, requests.at(-1))
    const r = replies.find((x) => x.when && said?.includes(x.when)) ?? plain[Math.min(n++, plain.length - 1)]
    if (r.delay) await new Promise((ok) => setTimeout(ok, r.delay))
    if (r.status) {
      res.writeHead(r.status, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: r.error ?? "failed" } }))
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const [event, data] of encode(protocol, r, n)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.end()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v1`, requests, headers, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) }
}

/** The latest message's text when it is the user's, in any protocol's request body. */
function asked(protocol: Protocol, body: any): string | undefined {
  const last = protocol === "responses" ? body.input?.at(-1) : body.messages?.at(-1)
  if (last?.role !== "user") return undefined
  if (typeof last.content === "string") return last.content
  const parts = (last.content ?? []).filter((c: any) => c.type === "text" || c.type === "input_text")
  return parts.length === last.content.length ? parts.map((c: any) => c.text).join("") : undefined
}

function encode(protocol: Protocol, r: Reply, turn: number): [string, object][] {
  const calls = (r.calls ?? []).map((c, i) => ({ id: `call_${turn}_${i}`, name: c.name, args: JSON.stringify(c.args) }))
  switch (protocol) {
    case "responses":
      return [
        ...(r.reasoning ? [["response.output_item.done", { type: "response.output_item.done", item: { type: "reasoning", id: `rs_${turn}`, summary: [], ...(r.reasoning.encrypted ? { encrypted_content: r.reasoning.encrypted } : {}) } }] as [string, object]] : []),
        ...(r.text ? [["response.output_item.done", { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: r.text }] } }] as [string, object]] : []),
        ...calls.map((c): [string, object] => ["response.output_item.done", { type: "response.output_item.done", item: { type: "function_call", call_id: c.id, name: c.name, arguments: c.args } }]),
        ["response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, output_tokens: 10 } } }],
      ]
    case "chat":
      return [
        ...(r.text ? [["", { choices: [{ index: 0, delta: { content: r.text } }] }] as [string, object]] : []),
        ...calls.flatMap((c, i): [string, object][] => [
          ["", { choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] } }] }],
          ["", { choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: c.args } }] } }] }],
        ]),
        ["", { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] }],
        ["", { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }],
      ]
    case "anthropic": {
      const blocks: [string, object][] = []
      let i = 0
      if (r.text) {
        blocks.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }])
        blocks.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: r.text } }])
        blocks.push(["content_block_stop", { type: "content_block_stop", index: i++ }])
      }
      for (const c of calls) {
        blocks.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } }])
        blocks.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: c.args } }])
        blocks.push(["content_block_stop", { type: "content_block_stop", index: i++ }])
      }
      return [
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } }],
        ...blocks,
        ["message_delta", { type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } }],
        ["message_stop", { type: "message_stop" }],
      ]
    }
  }
}
