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

ask runs subagents in the background, each in a fresh context of its own. Send one JSON request
on stdin, read one JSON response on stdout. \`ask -h requests\` is the full reference; \`ask
models\` lists the models.

## When to hand work off

- A question that needs a lot of searching and reading: the subagent spends its context, you
  get the answer with path:line evidence.
- Independent pieces of work: start them all in one request and they run at once.
- A review or a second opinion, possibly on another model.
- Not a single file read or a one-line edit: doing those yourself is faster.

## Writing the task

The subagent sees only its prompt: not this conversation, not your notes. Write it like a
handoff to a capable colleague who just arrived:

- The goal, and why it matters.
- What you already know: the files, functions and findings involved, errors verbatim.
- The boundaries: what not to touch, what is out of scope.
- What done means: the tests that must pass, the question that must be answered.
- What to return: "each call site with path:line", "the diff and the test output".

For several tasks at once, give each its own slice, so they don't overlap or leave gaps.

## Choosing

- Read-only (the default) for questions and reviews. \`"write": true\` lets it change files in
  your folder; \`"worktree": true\` gives it its own branch and checkout instead, which suits
  bigger changes and several write tasks at once.
- \`"model"\` and \`"effort"\`: the default for most tasks; a stronger model, or \`"effort":
  "high"\`, for hard bugs and design questions.
- \`"schema"\` when you'll process the answer: it comes back as JSON matching it.

## Requests

    ask <<'EOF'
    {"start": [{"prompt": "..."}, {"prompt": "...", "write": true}], "wait": 600}
    EOF

A task is {"prompt", "model"?, "write"?, "worktree"?, "dir"?, "effort"?, "schema"?, "timeout"?}.
Every response is {"tasks": [{"id", "state", "answer"?, "error"?, "changes"?, ...}]}; state is
running, retrying, succeeded, failed or stopped. Then:

    {"collect": ["ID", ...], "wait": 600}     wait for more of them to finish
    {"continue": "ID", "prompt": "..."}       a follow-up in the same conversation; any model
    {"continue": "ID"}                        resume a stopped or failed task
    {"stop": ["ID"]}
    {"show": "ID"}                            every step it took
    {"sessions": {}}                          the sessions this conversation started

Wait as long as your shell allows, and collect again while tasks are running. Follow a
response's "hint". An {"error": {"message", "hint"}} means the request itself was wrong.

## Using the results

- Check the claims you'll build on: open the path:line it cites. For a write task, look at
  "changes" and the diff before you rely on it.
- To correct or extend a task, continue it rather than starting over: it keeps everything it
  read and did.
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
