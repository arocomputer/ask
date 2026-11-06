// ask sessions: recent sessions started from this repository (or folder), newest first, or
// everyone's with --all. On a terminal, a status word, the task, the id and when its latest
// turn started; piped, tab-separated with the state word and an ISO time.

import { parseArgs } from "node:util"
import type { Home } from "../base/home.ts"
import { top } from "../base/git.ts"
import { list, scoped, status } from "../sessions/store.ts"
import { ago, clean, heading, style, symbol, table, text } from "../base/term.ts"
import { Usage } from "./command.ts"

export const summary = "Recent tasks"
export const about = `List recent sessions started from this repository, or this folder outside one, newest first.
--all lists every session.`
export const usage = "ask sessions [flags]"
export const flags: [string, string][] = [
  ["-a, --all", "List sessions from everywhere"],
  ["-L, --limit <n>", "Maximum number of sessions to list (default 20)"],
]
export const examples = ["ask sessions", "ask sessions --all -L 5"]

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, options: { all: { type: "boolean", short: "a" }, limit: { type: "string", short: "L" } } })
  const limit = Number(v.limit ?? 20)
  if (!Number.isInteger(limit) || limit < 1) throw new Usage(`invalid limit: ${v.limit}`)
  const all = v.all ? list(h) : scoped(list(h), { origin: top(process.cwd()) ?? process.cwd() })
  if (!all.length) {
    text(v.all ? "No sessions yet." : "No sessions in this folder.\nSee all sessions with ask sessions --all.", process.stderr)
    return 0
  }
  const st = style()
  heading("sessions")
  table(
    all.slice(0, limit).map((s) => {
      const t = status(s)
      const task = clean(s.turns[0].prompt.split("\n")[0])
      const turns = s.turns.length > 1 ? ` (${s.turns.length} turns)` : ""
      const row: [string, string][] = [
        [t.state, symbol(t.state, st)],
        [task, task + st.gray(turns)],
        [s.id, s.id],
        [t.started, st.gray(ago(t.started))],
      ]
      return process.stdout.isTTY ? [row[1], row[2], row[0], row[3]] : row
    }),
    { header: ["Task", "ID", "State", "Started"], flex: 0 },
  )
  return 0
}
