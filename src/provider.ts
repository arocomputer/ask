// The provider layer: one model turn in, one model turn out, over any of the three protocols
// ask speaks. It owns the transcript format every protocol translates to and from, the
// server-sent-events reader they share, provider errors and the retry policy. It knows nothing
// about sessions; the loop owns the conversation.

import { version } from "./version.ts"

/** One entry of a conversation, independent of the protocol that produced it. */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: Call[]; native?: Native }
  | { role: "tool"; id: string; name: string; output: string }

/** A tool call the model made; `arguments` is the JSON text it produced. */
export type Call = { id: string; name: string; arguments: string }

/**
 * The provider's own items for an assistant message, replayed verbatim only to the same
 * protocol: Responses' encrypted reasoning, Anthropic's signed thinking blocks.
 */
export type Native = { protocol: Protocol; items: unknown[] }

export type Protocol = "responses" | "chat" | "anthropic"

/** A function the model may call, with a JSON Schema for its arguments. */
export type ToolSpec = { name: string; description: string; parameters: object }

/** Token counts. `cached` is the part of `input` served from the provider's cache. */
export type Usage = { input: number; output: number; cached: number }

/** One model turn to send. */
export type Request = {
  model: string
  instructions: string
  messages: Message[]
  tools: ToolSpec[]
  effort?: string
  /** A JSON Schema the final answer must match. */
  schema?: object
  /** Most output tokens; required by Anthropic, optional elsewhere. */
  maxOutput?: number
  /** A stable id for the conversation, which gateways use to route and cache. */
  session?: string
  signal?: AbortSignal
}

/**
 * What one turn produced. `incomplete` names why the model stopped before finishing, such as
 * running out of output tokens.
 */
export type Response = { message: Extract<Message, { role: "assistant" }>; usage: Usage; incomplete?: string }

/** Completes one model turn. Implementations retry nothing; see `withRetries`. */
export type Provider = { complete(req: Request): Promise<Response> }

/** A failure the provider reported. `status` is 0 when no HTTP response arrived. */
export class ProviderError extends Error {
  status: number
  code: string
  /** Seconds the provider asked to wait before retrying, from Retry-After. */
  retryAfter?: number
  constructor(message: string, status = 0, code = "", retryAfter?: number) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

/** Where a protocol client sends its requests and with what credential. */
export type Endpoint = { baseURL: string; key: string; headers?: Record<string, string> }

/** The headers that identify ask and the conversation to a provider. */
export function identity(req: Request): Record<string, string> {
  return { "user-agent": `ask/${version}`, ...(req.session ? { "x-opencode-session": req.session } : {}) }
}

/** POSTs a JSON body and returns the streaming response, or throws the provider's error. */
export async function post(url: string, headers: Record<string, string>, body: object, signal?: AbortSignal): Promise<globalThis.Response> {
  let res: globalThis.Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ProviderError(`cannot reach ${new URL(url).host}: ${(err as Error).message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    const retry = Number(res.headers.get("retry-after"))
    throw decodeError(res.status, text, Number.isFinite(retry) && retry > 0 ? retry : undefined)
  }
  return res
}

/** Reads `{"error": {"message", "code" | "type"}}` bodies, the shape all three protocols use. */
export function decodeError(status: number, text: string, retryAfter?: number): ProviderError {
  let message = `HTTP ${status}`
  let code = ""
  try {
    const v = JSON.parse(text)
    const e = typeof v.error === "object" && v.error ? v.error : v
    if (typeof e.message === "string" && e.message) message = e.message
    else if (typeof v.error === "string") message = v.error
    code = String(e.code ?? e.type ?? "")
  } catch {
    if (text.trim()) message = `HTTP ${status}: ${text.trim().slice(0, 300)}`
  }
  return new ProviderError(message, status, code, retryAfter)
}

/** Yields each server-sent event's name and parsed JSON data; `[DONE]` and non-JSON are skipped. */
export async function* events(res: globalThis.Response): AsyncGenerator<{ event: string; data: any }> {
  if (!res.body) return
  const decoder = new TextDecoder()
  let buffer = ""
  let event = ""
  let data: string[] = []
  const flush = function* () {
    if (data.length) {
      const text = data.join("\n")
      if (text !== "[DONE]") {
        try {
          yield { event, data: JSON.parse(text) }
        } catch {}
      }
    }
    event = ""
    data = []
  }
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "")
        buffer = buffer.slice(nl + 1)
        if (line === "") yield* flush()
        else if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err
    throw new ProviderError(`the response stream was interrupted: ${(err as Error).message}`)
  }
  yield* flush()
}

/** How long retries may take in total, and how slow a failed attempt may be and still be retried. */
export type RetryPolicy = { budget: number; slow: number }

const defaultPolicy: RetryPolicy = { budget: 60_000, slow: 20_000 }

/**
 * Wraps a provider so transient failures (no response, 408, 429, 5xx, 529) are retried with
 * backoff. Retries stop once the total budget is spent, and a failure that itself took longer
 * than `slow` is not retried, so one slow outage can't multiply into minutes. `onRetry` hears
 * each retry before its wait.
 */
export function withRetries(p: Provider, onRetry?: (attempt: number, err: ProviderError) => void, policy = defaultPolicy): Provider {
  return {
    async complete(req) {
      const start = Date.now()
      for (let attempt = 1; ; attempt++) {
        const began = Date.now()
        try {
          return await p.complete(req)
        } catch (err) {
          if (!(err instanceof ProviderError) || !transient(err) || req.signal?.aborted) throw err
          const wait = Math.min((err.retryAfter ?? 2 ** (attempt - 1)) * 1000, 30_000)
          if (Date.now() - began > policy.slow || Date.now() - start + wait > policy.budget) throw err
          onRetry?.(attempt, err)
          await sleep(wait, req.signal)
        }
      }
    },
  }
}

/** Errors reported inside a stream arrive with status 200 and are transient only by their code. */
function transient(e: ProviderError): boolean {
  if (e.status === 200) return /overloaded|server_error|rate_limit|timeout/i.test(e.code)
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })
}

/** True when an error says the conversation no longer fits the model's context window. */
export function overflowed(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false
  if (err.code === "context_length_exceeded") return true
  return err.status === 400 && /context (length|window)|too long|maximum context|too many tokens|exceeds? the (model|context)/i.test(err.message)
}
