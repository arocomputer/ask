// ask's home folder (~/.ask, or $ASK_HOME): config.json, auth.json with pasted keys, the
// models.dev cache, sessions, and the worktrees tasks work in. Files are written atomically
// and private to the user.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { claudeCode, find, load, type Catalog, type Model } from "./catalog.ts"
import { aliases, binary } from "./claude.ts"
import { access, api, models, signedIn } from "./chatgpt.ts"
import type { Key } from "./provider.ts"

export type Home = { root: string; config: string; auth: string; catalog: string; sessions: string; worktrees: string }

export function home(root = process.env.ASK_HOME || join(homedir(), ".ask")): Home {
  return {
    root,
    config: join(root, "config.json"),
    auth: join(root, "auth.json"),
    catalog: join(root, "cache", "models.json"),
    sessions: join(root, "sessions"),
    worktrees: join(root, "worktrees"),
  }
}

/**
 * config.json: the default model, the models chosen in ask settings (which ask models lists and
 * settings offers first; any catalog model still works in a request), and the turn timeout in
 * seconds.
 */
export type Config = { model?: string; models?: string[]; timeout?: number }

/**
 * auth.json: a pasted key per provider, and optionally an endpoint replacing the catalog's; and
 * under "chatgpt", the ChatGPT sign-in (see chatgpt.ts).
 */
export type Auth = Record<string, { api_key?: string; base_url?: string; [field: string]: unknown }>

export function readJSON<T>(path: string, fallback: T): T {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it`)
  }
}

/** Writes JSON through a temporary file, so readers never see half a file. */
export function writeJSON(path: string, value: unknown, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode })
  renameSync(tmp, path)
}

/**
 * A provider's credential: for ChatGPT, its sign-in's renewable token; for Claude Code, none, as
 * it signs in itself; otherwise a pasted key, else the first of the provider's catalog
 * environment variables.
 */
export function credential(h: Home, provider: string, env: string[]): { key: Key; source: string } | undefined {
  if (provider === "chatgpt") return signedIn(h) ? { key: (renew) => access(h, renew), source: "ChatGPT sign-in" } : undefined
  if (provider === "claude") return binary() ? { key: "", source: "Claude Code's own sign-in" } : undefined
  const pasted = readJSON<Auth>(h.auth, {})[provider]?.api_key
  if (pasted) return { key: pasted, source: "pasted key" }
  for (const name of env) if (process.env[name]) return { key: process.env[name]!, source: `$${name}` }
  return undefined
}

/**
 * The catalog, loaded from the cache in this home, with two providers of ask's own: "claude"
 * when Claude Code is installed (its aliases, then Anthropic's models), and "chatgpt" when
 * signed in to ChatGPT (the models the account may use, through OpenAI's Responses API).
 */
export async function catalog(h: Home, refresh = false): Promise<Catalog> {
  let c = await load(h.catalog, { refresh, url: process.env.ASK_CATALOG_URL })
  if (binary()) {
    const models = Object.fromEntries([...aliases.map((a) => [a.id, { id: a.id, name: a.name }]), ...Object.values(c.anthropic?.models ?? {}).map((m) => [m.id, { id: m.id, name: m.name }])])
    c = { ...c, claude: { id: "claude", name: "Claude Code", env: [], npm: claudeCode, models } }
  }
  if (!signedIn(h)) return c
  const list = await models(h, refresh).catch(() => [])
  if (!list.length) return c
  const entries = Object.fromEntries(list.map((m) => [m.slug, { id: m.slug, name: m.name, tool_call: true, reasoning: true }]))
  return { ...c, chatgpt: { id: "chatgpt", name: "ChatGPT", env: [], npm: "@ai-sdk/openai", api: api(), models: entries } }
}

/**
 * Resolves the model to use: the name given, else config.json's, with its credential and any
 * endpoint override. Throws what to do when it can't.
 */
export async function resolve(h: Home, name?: string): Promise<{ model: Model; key: Key; baseURL?: string }> {
  const chosen = name || readJSON<Config>(h.config, {}).model
  if (!chosen) throw new Error("no model chosen; run ask settings, or give the task a model")
  const model = find(await catalog(h), chosen)
  const cred = credential(h, model.provider, model.env)
  if (!cred) throw new Error(`no key for ${model.provider}; add one with ask settings, or set ${model.env[0] ?? "its key variable"}`)
  return { model, key: cred.key, baseURL: readJSON<Auth>(h.auth, {})[model.provider]?.base_url }
}
