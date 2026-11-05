// ask show ID: a session for a person to read: each prompt, its steps and its answer.

import type { Home } from "../home.ts"
import { open, status, transcript, type Turn } from "../sessions.ts"
import { steps } from "../steps.ts"
import { ago, clean, count, duration, style, symbol } from "../term.ts"

export const help = `Show a session: each prompt, the steps it took, and the answer.

USAGE
  ask show <id>
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const st = style()
  if (argv.length !== 1) {
    process.stderr.write(`${st.red("X")} Give one session id\n${st.gray("  ask sessions lists them")}\n`)
    return 2
  }
  const s = open(h, argv[0])
  const messages = transcript(s)
  const out = (line = "") => process.stdout.write(line + "\n")
  const last = status(s)
  out(`${st.bold(s.id)}  ${symbol(last.state, st)} ${last.state}`)
  out(st.gray(`${s.dir} · started ${ago(s.created)}`))
  s.turns.forEach((recorded, i) => {
    const t = i === s.turns.length - 1 ? last : recorded
    out()
    out(st.bold(clean(t.prompt)))
    out(st.gray(meta(t)))
    for (const step of steps(messages, i + 1)) out(step.startsWith("error:") ? `  ${st.red(step)}` : `  ${st.gray("•")} ${step}`)
    if (t.retry) out(`  ${st.yellow("!")} retrying: ${clean(t.retry)}`)
    for (const c of t.changes ?? []) out(`  ${c.change === "added" ? "+" : c.change === "deleted" ? "-" : "~"} ${c.path}`)
    if (t.state === "succeeded") {
      out()
      out(clean(t.answer ?? ""))
    } else if (t.error) {
      out()
      out(`${st.red("X")} ${t.error.message}`)
      if (t.error.hint) out(st.gray(`  ${t.error.hint}`))
    }
  })
  return 0
}

function meta(t: Turn): string {
  const seconds = ((t.finished ? Date.parse(t.finished) : Date.now()) - Date.parse(t.started)) / 1000
  const parts = [t.model, t.write ? "write" : "read-only", duration(seconds)]
  if (t.usage) parts.push(`${count(t.usage.input)} in, ${count(t.usage.output)} out`)
  return parts.join(" · ")
}
