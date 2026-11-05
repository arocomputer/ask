// ask show ID: a session's turns, what it did in each, and its answers.

import { parseArgs } from "node:util"
import type { Home } from "../home.ts"
import type { Message } from "../provider.ts"
import { open, status, transcript, type Turn } from "../sessions.ts"
import { ago, clean, count, duration, stateWord, style, symbol } from "../term.ts"
import { describe, elapsed, record, Usage } from "./common.ts"

export const help = `Show a session: each prompt, the steps it took, and the answer.

USAGE
  ask show <id> [flags]

FLAGS
      --json   Print the latest turn's record as JSON, with its transcript
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } })
  if (positionals.length !== 1) throw new Usage("give one session id", "ask show k3f9a2")
  const s = open(h, positionals[0])
  const messages = transcript(s)
  if (v.json) {
    process.stdout.write(JSON.stringify({ ...record(s), transcript: messages }, null, 2) + "\n")
    return 0
  }
  const st = style()
  const out = (line = "") => process.stdout.write(line + "\n")
  const last = status(s)
  out(`${st.bold(st.cyan(s.id))} ${symbol(last.state, st)} ${stateWord(last.state, st)}`)
  out(st.gray(`${s.dir} · started ${ago(s.created)} · ${s.turns.length} turn${s.turns.length > 1 ? "s" : ""}`))
  const turns = split(messages)
  s.turns.forEach((recorded, i) => {
    const t = i === s.turns.length - 1 ? last : recorded
    out()
    out(`${st.bold("›")} ${st.bold(clean(t.prompt).split("\n").join("\n  "))}`)
    out(st.gray(`  ${meta(t)}`))
    for (const m of turns[i] ?? []) {
      if (m.role === "assistant") {
        for (const c of m.calls) out(`  ${st.gray("•")} ${clean(describe(c.name, c.arguments))}`)
      } else if (m.role === "tool" && m.output.startsWith("error:")) {
        out(`    ${st.red(clean(m.output.split("\n")[0]))}`)
      }
    }
    if (t.retry) out(`  ${st.yellow("!")} retrying: ${clean(t.retry)}`)
    for (const c of t.changes ?? []) out(`  ${c.change === "added" ? st.green("+") : c.change === "deleted" ? st.red("-") : st.yellow("~")} ${c.path}`)
    if (t.state === "succeeded") {
      out()
      out(clean(t.answer ?? ""))
    } else if (t.error) {
      out(`  ${st.red("X")} ${t.error.message}`)
      if (t.error.hint) out(st.gray(`    ${t.error.hint}`))
    }
  })
  return 0
}

function meta(t: Turn): string {
  const parts = [t.model, t.write ? "write" : "read-only", duration(elapsed(t))]
  if (t.usage) parts.push(`${count(t.usage.input)} in, ${count(t.usage.output)} out`)
  return parts.join(" · ")
}

/** Splits a transcript at each user message, one part per turn, without the user messages. */
function split(messages: Message[]): Message[][] {
  const out: Message[][] = []
  for (const m of messages) {
    if (m.role === "user") out.push([])
    else out.at(-1)?.push(m)
  }
  return out
}
