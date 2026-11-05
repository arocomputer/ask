// What ask can run besides its own loop, and with which tools: the harnesses it ships (claude,
// codex) and extensions installed in ~/.ask/extensions. Each is on while config.json's
// "extensions" lists it: `ask install` adds it there, `ask remove` takes it out, and taking it
// out by hand turns it off. Also which agent conversation is calling ask, from the environment
// its commands run in, so each conversation can find the sessions it started.

import { existsSync } from "node:fs"
import { join } from "node:path"
import claude from "./claude.ts"
import codex from "./codex.ts"
import { folder, loadInstalled, type Extension, type Harness, type Settings } from "./harness.ts"
import { readJSON, type Config, type Home } from "../base/home.ts"
import type { Tool } from "../agent/tools.ts"

/** The harnesses ask ships, by name. */
export const builtin: Record<string, Harness> = { claude, codex }

/** True when `name`, built in or installed, is turned on, without loading anything. */
export function enabled(h: Home, name: string): boolean {
  if (!(readJSON<Config>(h.config, {}).extensions ?? []).includes(name)) return false
  return !!builtin[name] || existsSync(join(folder(h.root), name))
}

/** Installed extensions that are turned on, loaded; those turned off never run. */
export async function active(h: Home): Promise<Extension[]> {
  const on = (readJSON<Config>(h.config, {}).extensions ?? []).filter((n) => !builtin[n])
  return loadInstalled(h.root, on)
}

/** Every harness ask can use: the built-ins turned on, then extensions' own. */
export async function harnesses(h: Home): Promise<Harness[]> {
  const on = Object.values(builtin).filter((x) => enabled(h, x.name))
  return [...on, ...(await active(h)).flatMap((e) => (e.harness ? [e.harness] : []))]
}

export async function harness(h: Home, name: string): Promise<Harness | undefined> {
  return (await harnesses(h)).find((x) => x.name === name)
}

/** Tools extensions add to ask's own loop. */
export async function tools(h: Home): Promise<Tool[]> {
  return (await active(h)).flatMap((e) => e.tools ?? [])
}

/** config.json's changes to how a harness runs. */
export function settings(h: Home, name: string): Settings {
  return readJSON<Config>(h.config, {}).harnesses?.[name] ?? {}
}

/**
 * Which agent conversation is calling: ASK_PARENT if set, else what a harness recognizes in
 * the environment its own commands get, else OpenCode's session. Undefined when it can't tell.
 */
export function parent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ASK_PARENT) return env.ASK_PARENT
  for (const x of Object.values(builtin)) {
    const id = x.parent?.(env)
    if (id) return id
  }
  return env.OPENCODE_SESSION_ID ? `opencode:${env.OPENCODE_SESSION_ID}` : undefined
}
