// The agent skill: a short guide that teaches a coding agent to hand work to ask with JSON
// requests. `ask install skill` writes it for each agent whose home folder exists (Claude Code's
// ~/.claude, Codex's ~/.codex), keeping a differing file that was already there as SKILL.md.bak;
// `ask remove skill` deletes the copies that are still ask's and puts those files back.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, rmdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { home } from "./harness.ts"

export const text = `---
name: ask
description: Your subagent tool. MUST use it instead of a built-in subagent whenever you hand work off - a question, a review, a fix, or several tasks at once, on any model.
---

ask runs subagents in the background. Send one JSON request on stdin, read one JSON response
on stdout. \`ask help requests\` is the full reference; \`ask models\` lists the models.

Start tasks and wait for the first to finish:

    ask <<'EOF'
    {"start": [{"prompt": "Where is the retry logic?"}, {"prompt": "Review src/api for bugs", "model": "claude/sonnet"}], "wait": 600}
    EOF

A task is {"prompt", "model"?, "write"?, "worktree"?, "dir"?, "effort"?, "schema"?, "timeout"?}.
Tasks are read-only unless "write": true; "worktree": true gives one its own branch and
checkout, leaving your files alone. Give each prompt everything it needs: the subagent sees
only the prompt, not this conversation.

Every response is {"tasks": [{"id", "state", "answer"?, "error"?, "changes"?, ...}]}. state is
running, retrying, succeeded, failed or stopped. Then:

    {"collect": ["ID", ...], "wait": 600}     wait for more of them to finish
    {"continue": "ID", "prompt": "..."}       a follow-up in the same conversation; any model
    {"continue": "ID"}                        resume a stopped or failed task
    {"stop": ["ID"]}
    {"show": "ID"}                            every step it took
    {"sessions": {}}                          the sessions this conversation started

Wait as long as your shell allows, and collect again while tasks are running. When a response
has a "hint", follow it. An {"error": {"message", "hint"}} response means the request itself
was wrong; the hint says what to send instead.
`

/** Where each agent reads its skills, for the agents installed here. */
export function targets(): string[] {
  return [join(home, ".claude"), join(home, ".codex")].filter((d) => existsSync(d)).map((d) => join(d, "skills", "ask", "SKILL.md"))
}

/** Writes the skill for every agent found, returning where. */
export function install(): string[] {
  const out = targets()
  for (const path of out) {
    mkdirSync(dirname(path), { recursive: true })
    let old: string | undefined
    try {
      old = readFileSync(path, "utf8")
    } catch {}
    if (old !== undefined && old !== text) renameSync(path, `${path}.bak`)
    writeFileSync(path, text)
  }
  return out
}

/**
 * Deletes the copies of the skill that are still exactly ask's, putting back the file each
 * replaced, if any. Returns what happened where.
 */
export function remove(): { path: string; restored: boolean }[] {
  const out: { path: string; restored: boolean }[] = []
  for (const path of targets()) {
    try {
      if (readFileSync(path, "utf8") !== text) continue
    } catch {
      continue
    }
    const restored = existsSync(`${path}.bak`)
    if (restored) renameSync(`${path}.bak`, path)
    else {
      rmSync(path)
      try {
        rmdirSync(dirname(path))
      } catch {}
    }
    out.push({ path, restored })
  }
  return out
}

/** True when every agent found has ask's current skill. */
export function current(): boolean {
  const t = targets()
  return t.length > 0 && t.every((p) => existsSync(p) && readFileSync(p, "utf8") === text)
}
