// ask sessions: recent sessions, newest first. On a terminal, a status symbol, the task, the
// id and when its latest turn started; piped, tab-separated with the state word and an ISO time.

import { parseArgs } from "node:util"
import type { Home } from "../home.ts"
import { list, status } from "../sessions.ts"
import { ago, clean, style, symbol, table } from "../term.ts"
import { Usage } from "./usage.ts"

export const summary = "List recent sessions"
export const about = "List recent sessions, newest first."
export const usage = "ask sessions [flags]"
export const flags: [string, string][] = [["-L, --limit <n>", "Maximum number of sessions to list (default 20)"]]
export const examples = ["ask sessions", "ask sessions -L 5"]

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, options: { limit: { type: "string", short: "L" } } })
  const limit = Number(v.limit ?? 20)
  if (!Number.isInteger(limit) || limit < 1) throw new Usage(`invalid limit: ${v.limit}`)
  const all = list(h)
  if (!all.length) {
    process.stderr.write("no sessions yet\n")
    return 0
  }
  const st = style()
  table(
    all.slice(0, limit).map((s) => {
      const t = status(s)
      const task = clean(s.turns[0].prompt.split("\n")[0])
      const turns = s.turns.length > 1 ? ` (${s.turns.length} turns)` : ""
      return [
        [t.state, symbol(t.state, st)],
        [task, task + st.gray(turns)],
        [s.id, s.id],
        [t.started, st.gray(ago(t.started))],
      ]
    }),
    { header: ["STATUS", "TASK", "ID", "AGE"], flex: 1 },
  )
  return 0
}
