// The model catalog: models.dev's api.json, the registry of providers and models ask connects
// to. A model's `npm` field (its provider's, or its own override) names the SDK that speaks
// to it, which picks ask's protocol; its `api` field is the endpoint. The catalog is cached on
// disk and refreshed when stale; a stale copy beats none when models.dev can't be reached.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { anthropic } from "./anthropic.ts"
import { chat } from "./chat.ts"
import type { Key, Protocol, Provider } from "./stream.ts"
import { responses } from "./responses.ts"

export const source = "https://models.dev/api.json"

/** models.dev's api.json: providers by id, each with its models by id. */
export type Catalog = Record<string, Entry>

type Entry = {
  id: string
  name: string
  env?: string[]
  npm?: string
  api?: string
  doc?: string
  models: Record<string, ModelEntry>
}

type ModelEntry = {
  id: string
  name: string
  tool_call?: boolean
  reasoning?: boolean
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number }
  provider?: { npm?: string; api?: string }
}

/** A model ask can talk to: where, how, and what it can do. */
export type Model = {
  provider: string
  id: string
  name: string
  protocol: Protocol
  baseURL: string
  /** Environment variables that may hold the provider's credential, in order. */
  env: string[]
  context?: number
  output?: number
  reasoning: boolean
}

/**
 * Endpoints for SDK packages the catalog names without an address. All but the first two serve
 * OpenAI-compatible chat completions there.
 */
const endpoints: Record<string, string> = {
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
}

/**
 * OpenCode's free-tier models, the ones priced at zero, work only inside OpenCode: other tools
 * get HTTP 403 even with a key (opencode.ai/v2/docs/console/harnesses).
 */
function freeOnlyInOpenCode(provider: string, m: ModelEntry): boolean {
  return (provider === "opencode" || provider === "opencode-go") && m.cost?.input === 0 && m.cost?.output === 0
}

/** The marker ask gives a harness's provider entry: a coding agent ask runs, not an HTTP API. */
export const harnessMarker = "ask-harness"

/** SDKs whose providers don't speak any of ask's three protocols. */
const foreign = /^@ai-sdk\/(google|google-vertex|azure|amazon-bedrock|gateway)$/

const day = 24 * 60 * 60 * 1000

/**
 * Loads the catalog from the cache at `path`, fetching a fresh copy when the cache is older
 * than `maxAge` (or `refresh` is set). Fails only when there is neither a cache nor a network.
 */
export async function load(path: string, opts: { maxAge?: number; refresh?: boolean; url?: string } = {}): Promise<Catalog> {
  const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => Infinity)
  if (!opts.refresh && age < (opts.maxAge ?? day)) {
    const cached = await read(path)
    if (cached) return cached
  }
  try {
    const res = await fetch(opts.url ?? source, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const catalog = check(JSON.parse(text))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, text)
    await rename(`${path}.tmp`, path)
    return catalog
  } catch (err) {
    const cached = await read(path)
    if (cached) return cached
    throw new Error(`cannot load the model catalog from ${opts.url ?? source}: ${(err as Error).message}`)
  }
}

async function read(path: string): Promise<Catalog | undefined> {
  try {
    return check(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}

function check(v: unknown): Catalog {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a catalog")
  for (const p of Object.values(v)) if (!p || typeof p !== "object" || typeof p.models !== "object") throw new Error("not a catalog")
  return v as Catalog
}

/**
 * Finds a model named `provider/model`; the model id may itself contain slashes. Throws a
 * message that says what to do when the name is malformed, unknown or unusable.
 */
export function find(catalog: Catalog, name: string): Model {
  const slash = name.indexOf("/")
  if (slash <= 0 || slash === name.length - 1) {
    const hits = Object.values(catalog).filter((p) => p.models[name]).map((p) => `${p.id}/${name}`)
    throw new Error(`models are named provider/model${hits.length ? `; did you mean ${hits.slice(0, 3).join(" or ")}?` : ", like openai/gpt-5.5"}`)
  }
  const pid = name.slice(0, slash)
  const mid = name.slice(slash + 1)
  const p = catalog[pid]
  if (!p && (pid === "claude" || pid === "codex")) throw new Error(`${pid}/ models need ask's ${pid} harness; run ask install ${pid}`)
  if (!p) throw new Error(`no provider ${pid} in the catalog; ask models lists them`)
  if (p.npm === harnessMarker) {
    // A harness takes model names the catalog doesn't know yet; never one its CLI could take for a flag.
    if (!/^[A-Za-z0-9][\w.:@-]*$/.test(mid)) throw new Error(`${JSON.stringify(mid)} isn't a model name`)
    return { provider: pid, id: mid, name: p.models[mid]?.name ?? mid, protocol: "harness", baseURL: "", env: [], reasoning: true }
  }
  const m = p.models[mid]
  if (!m) throw new Error(`${pid} has no model ${mid}; ask models ${pid} lists its models`)
  if (m.tool_call === false) throw new Error(`${name} can't call tools, so it can't work as a subagent`)
  if (freeOnlyInOpenCode(pid, m)) throw new Error(`${name} is free only inside OpenCode, and answers 403 to other tools; choose a paid or Go model`)
  const npm = m.provider?.npm ?? p.npm ?? ""
  const baseURL = (m.provider?.api ?? p.api ?? endpoints[npm] ?? "").replace(/\/+$/, "")
  const protocol: Protocol = npm === "@ai-sdk/openai" ? "responses" : npm === "@ai-sdk/anthropic" ? "anthropic" : "chat"
  if (foreign.test(npm) || !baseURL) throw new Error(`${name} needs ${npm || "an SDK"}, which ask doesn't speak yet`)
  return {
    provider: pid,
    id: mid,
    name: m.name,
    protocol,
    baseURL,
    env: p.env ?? [],
    context: m.limit?.context,
    output: m.limit?.output,
    reasoning: m.reasoning ?? false,
  }
}

/** A provider ask can talk to, with how many of its models can work as subagents. */
export type ProviderInfo = { id: string; name: string; models: number; env: string[]; doc?: string }

/**
 * The models of one provider that ask can use, by name; ask's own providers keep their order,
 * which means something there (a harness's aliases first, ChatGPT's models as OpenAI lists them).
 */
export function usable(catalog: Catalog, provider: string): Model[] {
  const p = catalog[provider]
  if (!p) return []
  const out: Model[] = []
  for (const id of Object.keys(p.models)) {
    try {
      out.push(find(catalog, `${provider}/${id}`))
    } catch {}
  }
  const own = provider === "chatgpt" || p.npm === harnessMarker
  return own ? out : out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every provider with at least one usable model, by name. */
export function providers(catalog: Catalog): ProviderInfo[] {
  return Object.values(catalog)
    .map((p) => ({ id: p.id, name: p.name, models: usable(catalog, p.id).length, env: p.env ?? [], doc: p.doc }))
    .filter((p) => p.models > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The usable model with the lowest input price, for a check that costs next to nothing. */
export function cheapest(catalog: Catalog, provider: string): Model | undefined {
  const price = (m: Model) => catalog[provider].models[m.id].cost?.input ?? Infinity
  return usable(catalog, provider).sort((a, b) => price(a) - price(b))[0]
}

/**
 * Opens a provider client for a model with a credential; `baseURL` overrides the catalog's.
 * ChatGPT's plan route wants function tools grouped in a namespace.
 */
export function connect(model: Model, key: Key, baseURL?: string): Provider {
  const endpoint = { baseURL: (baseURL ?? model.baseURL).replace(/\/+$/, ""), key }
  const plan = model.provider === "chatgpt"
  switch (model.protocol) {
    case "responses":
      return responses(endpoint, plan || endpoint.baseURL === endpoints["@ai-sdk/openai"], plan ? "ask" : undefined)
    case "anthropic":
      return anthropic(endpoint)
    case "chat":
      return chat(endpoint)
    case "harness":
      throw new Error(`${model.provider}/ models run through a harness, not a provider client`)
  }
}
