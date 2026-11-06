// The fetch tool: reads a web page for the model, in ask's own process, so read-only tasks can
// look things up without a shell; `download` is how search reads its results page too. Only http and https to public addresses: each host, the
// first and every redirect, is resolved and checked like the sandbox's proxy does, and the
// connection goes to the address that was checked. HTML comes back as text; the download and
// the text are both bounded.

import { request as http, type IncomingMessage } from "node:http"
import { request as https } from "node:https"
import { reach } from "../sandbox/address.ts"
import { askInstructions, askPrompt, type Ask } from "./context.ts"
import type { Tool } from "./tools.ts"

/** A string argument, trimmed, or undefined. */
const str = (args: Record<string, unknown>, k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : undefined)
const downloadLimit = 2 * 1024 * 1024
/** Characters of a page per call; a long page is read on with `offset`, so a model reads only as far as it needs. */
const textLimit = 16 * 1024
const redirects = 5

/**
 * One request to the checked address of `url`'s host, keeping the name for TLS and the Host
 * header: a GET, or with `form`, a POST of it.
 */
async function get(url: URL, signal?: AbortSignal, form?: string): Promise<IncomingMessage> {
  const target = await reach(url.hostname)
  if ("refused" in target) throw new Error(target.refused)
  const secure = url.protocol === "https:"
  return new Promise((done, fail) => {
    const req = (secure ? https : http)(
      {
        host: target.address,
        port: url.port || (secure ? 443 : 80),
        path: url.pathname + url.search,
        method: form === undefined ? "GET" : "POST",
        servername: url.hostname,
        headers: {
          host: url.host,
          "user-agent": "ask (https://github.com/arocomputer/ask)",
          accept: "text/html, text/plain, application/json, */*;q=0.5",
          ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(form)) }),
        },
        signal,
        timeout: 30_000,
      },
      done,
    )
    req.on("timeout", () => req.destroy(new Error("timed out after 30 seconds")))
    req.on("error", fail)
    req.end(form)
  })
}

/** HTML as readable text: no scripts, styles or tags, entities decoded, blank runs collapsed. */
export function text(html: string): string {
  const entities: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", copy: "©", reg: "®", trade: "™", times: "×",
  }
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|pre|section|article)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e.toLowerCase()] ?? m),
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim()
}

/**
 * Downloads `url` with GET, or POSTs `form` to it, following redirects (as GETs), each host
 * checked; at most 2 MiB. What search and fetch both read pages through.
 */
export async function download(href: string, signal?: AbortSignal, form?: string): Promise<{ status: number; url: URL; type: string; body: Buffer; cut: boolean }> {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    throw new Error("url must be an absolute http or https address")
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https addresses")
    const res = await get(url, signal, hop === 0 ? form : undefined)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume()
      if (hop >= redirects) throw new Error(`more than ${redirects} redirects`)
      url = new URL(res.headers.location, url)
      continue
    }
    const chunks: Buffer[] = []
    let size = 0
    let cut = false
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > downloadLimit) {
        cut = true
        res.destroy()
        break
      }
      chunks.push(chunk)
    }
    return { status, url, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks), cut }
  }
}

export const fetch: Tool = {
  name: "fetch",
  description:
    "Read a web page or file over http or https, such as documentation. HTML comes back as plain text: 16k characters at a time, with an offset to read on. Pass question to ask a model to extract an answer instead. Only public addresses; nothing on this machine or the local network.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      offset: { type: "integer", description: "Character to start from, for reading on in a long page" },
      question: { type: "string", description: "What you want to know from the page; the answer comes back, not the page" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  readonly: true,
  async run(args, { signal, models }) {
    const { status, url, type, body, cut: big } = await download(String(args.url ?? ""), signal)
    const binary = !/^(text\/|application\/(json|xml|javascript|x-yaml|yaml)|[^;]*\+(json|xml))/i.test(type) && body.includes(0)
    if (binary) return `${status} ${url.href}\n${type || "binary content"}, ${body.length} bytes; not text`
    const all = /html/i.test(type) ? text(body.toString("utf8")) : body.toString("utf8")
    const want = str(args, "question")
    if (want) {
      if (!models) return `${status} ${url.href}\n\nok, but ask has no model to read it: run without question`
      return answer(models.small, want, all, signal).then((r) => `${status} ${url.href}\n\n${r}${big ? "\n\n[the download stopped at 2 MiB]" : ""}`)
    }
    const from = Math.max(0, Math.floor(Number(args.offset) || 0))
    const out = all.slice(from, from + textLimit)
    const rest = all.length - from - out.length
    const more = rest > 0 ? `\n\n[${rest} more characters; fetch again with offset ${from + out.length} to read on]` : big ? "\n\n[the download stopped at 2 MiB]" : ""
    return `${status} ${url.href}${from ? ` (from character ${from} of ${all.length})` : ""}\n\n${out}${more}`
  },
}

/** The page answered: the model's reply, or, if it fails, the start of the raw page, said so. */
async function answer(ask: Ask, question: string, all: string, signal?: AbortSignal): Promise<string> {
  try {
    return (await ask(askInstructions, askPrompt(`Question: ${question}`, all), 2000, signal)).text.trim() || "(no answer)"
  } catch (err) {
    signal?.throwIfAborted()
    return `couldn't be read by the answering model (${(err as Error).message}); fetch again without question to read the page`
  }
}
