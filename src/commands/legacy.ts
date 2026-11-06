// Read-only access to Go-era session records and native transcripts. Never resumes, converts,
// moves or removes legacy data; worktrees and extensions remain owned by their original version.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { Home } from "../base/home.ts"
import { clean } from "../base/term.ts"
import { Usage } from "./command.ts"

export const summary = "Read sessions from the previous Go version"
export const about = "List legacy sessions, or print one original record as JSON. --transcript prints its native transcript. All access is read-only."
export const usage = "ask legacy [id] [--transcript]"
export const flags: [string, string][] = [["--transcript", "Print the original native transcript instead of the session record"]]
export const examples = ["ask legacy", "ask legacy k3f9a2", "ask legacy k3f9a2 --transcript"]

/** Prints only session data, never legacy configuration or authentication files. */
export async function run(h: Home, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { transcript: { type: "boolean" } } })
  if (positionals.length > 1 || (positionals[0] && !/^[a-z0-9]{6}$/.test(positionals[0]))) throw new Usage("expected a six-character legacy session id")
  if (values.transcript && !positionals.length) throw new Usage("--transcript requires a session id")
  const root = join(h.root, "agent", "sessions")
  let folders: string[]
  try { folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse() }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    folders = []
  }
  const id = positionals[0]
  if (id) {
    const matches = folders.filter((name) => name.endsWith(`-${id}`))
    if (matches.length !== 1) throw new Usage(matches.length ? `ambiguous legacy session ${id}` : `no legacy session ${id}; see ask legacy`)
    process.stdout.write(readFileSync(join(root, matches[0], values.transcript ? "transcript.json" : "session.json"), "utf8"))
    return 0
  }
  for (const folder of folders) {
    try {
      const record = JSON.parse(readFileSync(join(root, folder, "session.json"), "utf8"))
      const turn = record.turns?.at(-1)
      if (!turn) throw new Error("no turns")
      process.stdout.write([record.id, turn.state, turn.started, record.dir, turn.prompt].map((v) => clean(String(v ?? "")).replace(/[\t\r\n]/g, " ")).join("\t") + "\n")
    } catch {
      process.stderr.write(`cannot read legacy session ${clean(folder)}; original files retained\n`)
    }
  }
  if (!folders.length) process.stderr.write(`no legacy sessions in ${root}\n`)
  return 0
}
