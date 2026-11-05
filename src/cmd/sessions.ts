// ask sessions: recent sessions, for a person to look over.

import { parseArgs } from "node:util"
import type { Home } from "../home.ts"
import { list, status } from "../sessions.ts"
import { ago, clean, style, symbol, table } from "../term.ts"

export const help = `List recent sessions, newest first.

USAGE
  ask sessions [-L n]

FLAGS
  -L, --limit n   How many to show (default: 20)
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, options: { limit: { type: "string", short: "L" } } })
  const limit = Math.max(1, Number(v.limit ?? 20) || 20)
  const all = list(h)
  const st = style()
  if (!all.length) {
    process.stderr.write("No sessions yet\n")
    return 0
  }
  const shown = all.slice(0, limit)
  if (process.stdout.isTTY) process.stdout.write(`\nShowing ${shown.length} of ${all.length} sessions\n\n`)
  table(
    shown.map((s) => {
      const t = status(s)
      const task = clean(s.turns[0].prompt.split("\n")[0])
      const turns = s.turns.length > 1 ? ` (${s.turns.length} turns)` : ""
      return [
        [s.id, s.id],
        [t.state, `${symbol(t.state, st)} ${t.state}`],
        [task + turns, task + st.gray(turns)],
        [ago(t.started), st.gray(ago(t.started))],
      ]
    }),
    { header: ["ID", "STATE", "TASK", "STARTED"], flex: 2 },
  )
  return 0
}
