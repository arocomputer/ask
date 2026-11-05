// ask sessions: list recent sessions.

import { parseArgs } from "node:util"
import type { Home } from "../home.ts"
import { list, status } from "../sessions.ts"
import { ago, clean, stateWord, style, symbol, table } from "../term.ts"
import { record, Usage } from "./common.ts"

export const help = `List recent sessions, newest first.

USAGE
  ask sessions [flags]

FLAGS
  -L, --limit n   How many to show (default: 20)
      --running   Only those still running
      --json      Print them as JSON
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, options: { limit: { type: "string", short: "L" }, running: { type: "boolean" }, json: { type: "boolean" } } })
  const limit = Number(v.limit ?? 20)
  if (!(limit > 0)) throw new Usage("--limit takes a number")
  let all = list(h)
  if (v.running) all = all.filter((s) => ["running", "retrying"].includes(status(s).state))
  const shown = all.slice(0, limit)
  if (v.json) {
    process.stdout.write(JSON.stringify(shown.map((s) => ({ ...record(s), task: s.turns[0].prompt.split("\n")[0] })), null, 2) + "\n")
    return 0
  }
  const st = style()
  if (!shown.length) {
    process.stderr.write(v.running ? "No sessions are running\n" : `No sessions yet. Start one with ${st.bold('ask "your task"')}\n`)
    return 0
  }
  if (process.stdout.isTTY) process.stdout.write(`\nShowing ${shown.length} of ${all.length} sessions\n\n`)
  table(
    shown.map((s) => {
      const t = status(s)
      const task = clean(s.turns[0].prompt.split("\n")[0])
      const turns = s.turns.length > 1 ? ` (${s.turns.length} turns)` : ""
      return [
        [s.id, st.cyan(s.id)],
        [t.state, `${symbol(t.state, st)} ${stateWord(t.state, st)}`],
        [t.model, st.gray(t.model)],
        [task + turns, task + st.gray(turns)],
        [ago(t.started), st.gray(ago(t.started))],
      ]
    }),
    { header: ["ID", "STATE", "MODEL", "TASK", "STARTED"], flex: 3 },
  )
  return 0
}
