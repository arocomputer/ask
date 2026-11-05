// ask's home folder (~/.ask, or $ASK_HOME): config.json, auth.json with pasted keys, the
// models.dev cache, sessions, and the worktrees tasks work in. Files are written atomically
// and private to the user.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { find, load, type Catalog, type Model } from "./catalog.ts"

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

/** auth.json: a pasted key per provider, and optionally an endpoint replacing the catalog's. */
export type Auth = Record<string, { api_key?: string; base_url?: string }>

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

/** A provider's credential: a pasted key, else the first of its catalog environment variables. */
export function credential(h: Home, provider: string, env: string[]): { key: string; source: string } | undefined {
  const pasted = readJSON<Auth>(h.auth, {})[provider]?.api_key
  if (pasted) return { key: pasted, source: "pasted key" }
  for (const name of env) if (process.env[name]) return { key: process.env[name]!, source: `$${name}` }
  return undefined
}

/** The catalog, loaded from the cache in this home. */
export function catalog(h: Home, refresh = false): Promise<Catalog> {
  return load(h.catalog, { refresh, url: process.env.ASK_CATALOG_URL })
}

/**
 * Resolves the model to use: the name given, else config.json's, with its credential and any
 * endpoint override. Throws what to do when it can't.
 */
export async function resolve(h: Home, name?: string): Promise<{ model: Model; key: string; baseURL?: string }> {
  const chosen = name || readJSON<Config>(h.config, {}).model
  if (!chosen) throw new Error("no model chosen; run ask settings, or give the task a model")
  const model = find(await catalog(h), chosen)
  const cred = credential(h, model.provider, model.env)
  if (!cred) throw new Error(`no key for ${model.provider}; run ask auth login ${model.provider}`)
  return { model, key: cred.key, baseURL: readJSON<Auth>(h.auth, {})[model.provider]?.base_url }
}
