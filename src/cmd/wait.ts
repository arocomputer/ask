// ask wait ID...: block until a session finishes and print its answer.

import { parseArgs } from "node:util"
import type { Home } from "../home.ts"
import { open } from "../sessions.ts"
import { style } from "../term.ts"
import { block, finished, waitFor, Usage } from "./common.ts"

export const help = `Wait for a session to finish and print its answer. Given several, returns when the first
finishes; the rest keep running.

USAGE
  ask wait <id>... [flags]

FLAGS
      --timeout seconds   Give up waiting after this long (the sessions keep running)
      --json              Print the result as JSON

EXAMPLES
  $ ask wait k3f9a2
  $ ask wait k3f9a2 p0q8zz --json
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { timeout: { type: "string" }, json: { type: "boolean" } } })
  if (!positionals.length) throw new Usage("give the session ids to wait for", "ask wait k3f9a2")
  const sessions = positionals.map((id) => open(h, id))
  const limit = v.timeout === undefined ? undefined : Number(v.timeout)
  if (limit !== undefined && !(limit > 0)) throw new Usage("--timeout takes seconds, like 120")
  if (sessions.length === 1 && limit === undefined) return block(sessions[0], !!v.json)
  const done = await waitFor(sessions, { timeout: limit })
  if (!done) {
    const st = style(process.stderr)
    if (v.json) process.stdout.write(JSON.stringify({ finished: null, running: sessions.map((s) => s.id) }) + "\n")
    else process.stderr.write(st.yellow("!") + ` still running after ${limit}s: ${sessions.map((s) => s.id).join(" ")}\n`)
    return 1
  }
  return finished(done, !!v.json)
}
