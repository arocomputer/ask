// ask's home folder (~/.ask, or $ASK_HOME): where config.json, auth.json, the models.dev cache,
// sessions and worktrees live, their shapes, and reading and writing them. Files are written
// atomically and private to the user. Which model and key a task uses is sessions/models.ts.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
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

/** Refuse legacy safety settings that the new task protocol cannot silently honor. */
export function checkConfig(h: Home): void {
  const config = readJSON<Record<string, unknown>>(h.config, {})
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json must be an object")
  const retired = ["max_cost", "worktree", "worktrees", "branches"].filter((key) => key in config)
  if (retired.length) throw new Error(`legacy config settings need migration: ${retired.join(", ")}; back up config.json and remove these fields before starting tasks. See docs/migration.md; existing work is retained.`)
  if (config.sandbox !== undefined && typeof config.sandbox !== "boolean") throw new Error("config.json sandbox must be true or false")
  if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout <= 0 || config.timeout > 2_000_000)) throw new Error("config.json timeout must be seconds above 0 and at most 2000000")
}

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

/** Flushes a private file and its replacement directory entry; readers never see half JSON. */
export function writeJSON(path: string, value: unknown, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, "wx", mode)
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(tmp, path)
    const parent = openSync(dirname(path), "r")
    try {
      try { fsyncSync(parent) }
      catch (err) {
        if (!["EINVAL", "ENOTSUP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err
      }
    } finally { closeSync(parent) }
  } finally { rmSync(tmp, { force: true }) }
}
