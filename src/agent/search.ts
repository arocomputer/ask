// The search tool: ask's own web search, run in ask's process like fetch, with no model and no
// provider behind it. It returns each result's title, address and snippet, for fetch to read
// in full. `web`, the default engine, is free and needs no key: DuckDuckGo's page, then its
// lite page (each limits a busy address on its own), then Mwmbl's open API, then Wikipedia's,
// so one engine turning searches away doesn't stop the task. Each says it is ask; none is
// asked in a way meant to look like a browser. An `Engine` is all the tool knows, so another
// engine, such as one of ask's own, is one function away.

import { download, text } from "./fetch.ts"
import type { Tool } from "./tools.ts"

/** One search result. */
export type Result = { title: string; url: string; snippet: string }

/** Searches the web for `query`. */
export type Engine = (query: string, signal?: AbortSignal) => Promise<Result[]>

/** The address behind a DuckDuckGo result link, or undefined for an ad or anything odd. */
function target(href: string): string | undefined {
  let url = href.replace(/&amp;/g, "&")
  const wrapped = /[?&]uddg=([^&]+)/.exec(url)
  if (wrapped) url = decodeURIComponent(wrapped[1])
  else if (url.startsWith("//")) url = `https:${url}`
  return /^https?:\/\//.test(url) && !/duckduckgo\.com\/y\.js/.test(url) ? url : undefined
}

/** The results on DuckDuckGo's results page, ads left out. */
export function results(html: string): Result[] {
  const out: Result[] = []
  for (const block of html.split(/<div[^>]+class="[^"]*\bresult\b/).slice(1)) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    const url = link && target(link[1])
    if (!url) continue
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div)>/.exec(block)
    out.push({ title: text(link[2]), url, snippet: snippet ? text(snippet[1]) : "" })
  }
  return out
}

/** The results on DuckDuckGo's lite page, ads left out. */
export function lite(html: string): Result[] {
  const out: Result[] = []
  for (const block of html.split(/(?=<a[^>]+class='result-link')/).slice(1)) {
    const link = /<a[^>]+href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/.exec(block)
    const url = link && target(link[1])
    if (!url) continue
    const snippet = /class='result-snippet'[^>]*>([\s\S]*?)<\/td>/.exec(block)
    out.push({ title: text(link[2]), url, snippet: snippet ? text(snippet[1]) : "" })
  }
  return out
}

/** Mwmbl's results, whose titles and extracts come as runs of text. */
export function mwmbl(json: unknown): Result[] {
  const join = (runs: unknown) => (Array.isArray(runs) ? runs.map((r: { value?: string }) => r.value ?? "").join("") : String(runs ?? ""))
  return (Array.isArray(json) ? json : [])
    .filter((r) => typeof r?.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => ({ title: join(r.title).trim(), url: r.url, snippet: join(r.extract).trim() }))
}

/** Wikipedia's search answer, as articles. */
export function wikipedia(json: unknown): Result[] {
  const hits = (json as { query?: { search?: { title?: string; snippet?: string }[] } })?.query?.search ?? []
  return hits
    .filter((h) => typeof h.title === "string")
    .map((h) => ({ title: h.title!, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title!.replace(/ /g, "_"))}`, snippet: text(h.snippet ?? "") }))
}

const turnedAway = /anomaly|captcha|unusual traffic/i

/** Free web search: DuckDuckGo, its lite page, Mwmbl, then Wikipedia; the first with results wins. */
export const web: Engine = async (query, signal) => {
  const form = `q=${encodeURIComponent(query)}`
  const engines: [string, () => Promise<Result[]>][] = [
    ["DuckDuckGo", async () => {
      const page = (await download("https://html.duckduckgo.com/html/", signal, form)).body.toString("utf8")
      return results(page).length || !turnedAway.test(page) ? results(page) : Promise.reject(new Error("turned the search away"))
    }],
    ["DuckDuckGo lite", async () => {
      const page = (await download("https://lite.duckduckgo.com/lite/", signal, form)).body.toString("utf8")
      return lite(page).length || !turnedAway.test(page) ? lite(page) : Promise.reject(new Error("turned the search away"))
    }],
    ["Mwmbl", async () => mwmbl(JSON.parse((await download(`https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(query)}`, signal)).body.toString("utf8")))],
    ["Wikipedia", async () => wikipedia(JSON.parse((await download(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(query)}`, signal)).body.toString("utf8")))],
  ]
  const why: string[] = []
  for (const [name, run] of engines) {
    signal?.throwIfAborted()
    try {
      const found = await run()
      if (found.length) return found
      why.push(`${name} found nothing`)
    } catch (err) {
      why.push(`${name} ${(err as Error).message}`)
    }
  }
  if (why.every((w) => w.endsWith("found nothing"))) return []
  throw new Error(`no search engine answered (${why.join("; ")}); try again in a minute, or fetch a page you know`)
}

const most = 8

export function search(engine: Engine = web): Tool {
  return {
    name: "search",
    description:
      "Search the web, such as for documentation, error messages or recent releases. Returns results with their title, address and a snippet; read one in full with fetch.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    readonly: true,
    async run(args, { signal }) {
      const query = String(args.query ?? "").trim()
      if (!query) throw new Error("query is required")
      const seen = new Set<string>()
      const found = (await engine(query, signal)).filter((r) => !seen.has(r.url) && seen.add(r.url)).slice(0, most)
      if (!found.length) return "No results; try other words."
      return found.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n")
    },
  }
}
