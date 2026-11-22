// The agent skill: a short guide that teaches a coding agent to hand work to ask with JSON
// requests. Install only into existing caller directories and keep replaced skills. Removing
// the skill undoes any opt-in delegation preference before removing ask's own skill text.

import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, rmdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Home } from "../base/home.ts"
import { home } from "./harness.ts"
import { prefer, restore, type Caller } from "./delegation.ts"

export const text = `---
name: ask
description: Your subagent tool. MUST use it instead of a built-in subagent whenever you hand work off - a question, a review, a fix, or several tasks at once, on any model.
---

Use ask when the user requests delegation, or when independent work, a substantial
investigation, or a second opinion would help. Do quick reads and edits yourself.

## Start work

    ask <<'EOF'
    {"start":[{"prompt":"Review the retry logic; return findings with path:line evidence."}],"wait":600}
    EOF

Send one JSON request to ask on stdin; don't pass the prompt as a CLI argument. Each
subagent starts with only its own prompt. Include the goal, relevant paths or errors,
what it may change, and what to return. Put independent tasks in the same \`start\`
array so they run together. Use the default model unless you have a reason to choose another.

Tasks are read-only unless you set \`"write":true\`. Use it for an authorized fix
that should land in the current checkout. Use \`"worktree":true\` only when you
want an isolated checkout; its edits won't appear in the caller's checkout.

## Get results

Read the returned \`tasks\` array. If a task is still running or retrying, collect the
pending IDs together: \`{"collect":["ID"],"wait":600}\`. Set the shell tool's timeout
longer than the wait. Don't start a duplicate just because a wait returned early.

Check cited evidence or the diff before relying on an answer. To follow up in the same
session, send \`{"continue":"ID","prompt":"…","wait":600}\`. Use \`ask -h requests\`
for other requests and options.
`

type Target = { caller: Caller; root: string; path: string; config: string }

/** Locations for each configured caller, without creating new agent homes. */
function targets(): Target[] {
  const claude = resolve(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"))
  const codex = resolve(process.env.CODEX_HOME || join(home, ".codex"))
  const opencode = resolve(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
  return ([
    ["claude", claude, "settings.json"],
    ["codex", codex, "config.toml"],
    ["opencode", opencode, existsSync(join(opencode, "opencode.jsonc")) ? "opencode.jsonc" : "opencode.json"],
  ] as const).map(([caller, root, config]) => ({ caller, root, path: join(root, "skills", "ask", "SKILL.md"), config: join(root, config) }))
}

/** The two shipped rewrite-era texts; upgrading must not replace a user's original backup. */
const prior = new Set([
  "c266d6502cd164fbc402c01386089fbed9fa69e0eb2d8dd1c286102f8f8a245c",
  "3f87c4aee97816f8a7eea7eb589f8e777ecabc5df4797b4dc6065c32e1e2c830",
])
const ours = (s: string) => s === text || prior.has(createHash("sha256").update(s).digest("hex"))

/** Read the skill without following a replacement link or masking permission errors. */
function read(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`${path} is not a standalone skill file`)
  return stat ? readFileSync(path, "utf8") : undefined
}

/** Install a caller's skill; preserve an earlier skill once and refuse backup collisions. */
function write(path: string) {
  const old = read(path)
  if (old === text) return
  if (old !== undefined && !ours(old) && lstatSync(`${path}.bak`, { throwIfNoEntry: false }))
    throw new Error(`${path} has local edits and a backup; move the edited skill aside before reinstalling`)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, text, { flag: "wx" })
    if (old !== undefined && !ours(old)) writeFileSync(`${path}.bak`, old, { flag: "wx", mode: 0o600 })
    renameSync(tmp, path)
  } finally { rmSync(tmp, { force: true }) }
}

const receipt = (h: Home, caller: Caller) => join(h.root, "skill", `${caller}.json`)

/** Install into existing caller homes, and optionally turn off each one's native delegation. */
export function install(h: Home, preferAsk: boolean): { path: string; disabled: boolean }[] {
  return targets().filter(({ root }) => existsSync(root)).map(({ caller, path, config }) => {
    write(path)
    const disabled = preferAsk && prefer(caller, config, receipt(h, caller))
    return { path, disabled }
  })
}

/** Restore owned preferences and earlier skills; never overwrite an edited skill. */
export function remove(h: Home) {
  const paths: { path: string; restored: boolean; kind: "skill" | "settings" }[] = []
  const errors: string[] = []
  for (const { caller, path } of targets()) {
    try {
      const config = restore(receipt(h, caller))
      if (config) paths.push({ path: config, restored: true, kind: "settings" })
      const skills = config ? new Set([path, join(dirname(config), "skills", "ask", "SKILL.md")]) : [path]
      for (const file of skills) {
        const old = read(file)
        // Earlier installs didn't record their location; the known skill text establishes ownership.
        if (old === undefined || !ours(old)) continue
        const saved = read(`${file}.bak`)
        const restored = saved !== undefined && !ours(saved)
        if (restored) {
          renameSync(`${file}.bak`, file)
        } else {
          rmSync(file)
          if (saved !== undefined) rmSync(`${file}.bak`)
          try { rmdirSync(dirname(file)) } catch {}
        }
        paths.push({ path: file, restored, kind: "skill" })
      }
    } catch (error) {
      errors.push(`${caller}: ${(error as Error).message}`)
    }
  }
  return { paths, errors }
}

/** True when every agent found has ask's current skill. */
export function current(): boolean {
  const t = targets().filter(({ root }) => existsSync(root))
  return t.length > 0 && t.every(({ path }) => {
    try { return read(path) === text } catch { return false }
  })
}
