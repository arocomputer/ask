// ask's home folder (~/.ask, or $ASK_HOME): where config.json, auth.json, the models.dev cache,
// sessions and worktrees live, their shapes, and reading and writing them. Files are written
// atomically and private to the user. Which model and key a task uses is sessions/models.ts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
 * settings offers first; any catalog model still works in a request), the turn timeout in
 * seconds, what `ask install` turned on, changes to how each harness runs, and tools set to
 * false, which ask's own loop leaves out.
 */
export type Config = { model?: string; models?: string[]; timeout?: number; sandbox?: boolean; extensions?: string[]; harnesses?: Record<string, Settings>; tools?: Record<string, boolean> }

/** What config.json's "harnesses" entry may say about one harness: another command, extra arguments, extra environment. */
export type Settings = { command?: string; args?: string[]; env?: Record<string, string> }

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
