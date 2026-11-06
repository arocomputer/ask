// ask show ID: outcome first, then supporting steps and changes. Monochrome section labels
// and wrapped prose make both the result and long paths readable on narrow terminals.

import type { Home } from "../base/home.ts"
import { open, status, transcript, type Turn } from "../sessions/store.ts"
import { steps } from "../agent/steps.ts"
import { ago, clean, count, duration, style, text, type Style } from "../base/term.ts"
import { Usage } from "./command.ts"

export const summary = "Task results and activity"
export const about = "View a session: each prompt, the steps the subagent took, and its answer."
export const usage = "ask show <id>"
export const examples = ["ask show k3f9a2"]

export async function run(h: Home, argv: string[]): Promise<number> {
  if (argv.length !== 1) throw new Usage(argv.length ? "accepts 1 arg, received " + argv.length : "a session id is required")
  const s = open(h, argv[0])
  const messages = transcript(s)
  const st = style()
  const out = (line = "") => text(line)
  out(st.bold(`ask / ${s.id}`))
  out(st.gray(clean(s.dir)))
  if (s.worktree) out(st.gray(clean(s.worktree.branch)))
  s.turns.forEach((recorded, i) => {
    const t = i === s.turns.length - 1 ? status(s) : recorded
    out()
    out(st.bold(s.turns.length > 1 ? `Turn ${i + 1}` : "Task"))
    out(clean(t.prompt))
    for (const line of details(t)) out(st.gray(line))
    end(t, st, out)
    const done = steps(messages, i + 1)
    if (done.length) { out(); out(st.bold("Activity")) }
    for (const step of done) out(`  ${clean(step)}`)
    if (t.changes?.length) { out(); out(st.bold("Changes")) }
    for (const c of t.changes ?? []) out(`${c.change}  ${clean(c.path)}`)
    if (t.changesError) out(`Changes unavailable  ${clean(t.changesError)}`)
  })
  return 0
}

/** Outcome and timing, then model, access and usage. */
function details(t: Turn): string[] {
  const seconds = ((t.finished ? Date.parse(t.finished) : Date.now()) - Date.parse(t.started)) / 1000
  const when =
    t.state === "running" ? `Running for ${duration(seconds)}` : t.state === "retrying" ? `Retrying after ${duration(seconds)}` : `${t.state === "succeeded" ? "Done" : t.state[0].toUpperCase() + t.state.slice(1)} ${ago(t.finished ?? t.started)} in ${duration(seconds)}`
  const parts = [t.model, t.write ? "write" : "read-only"]
  if (t.usage) parts.push(`${count(t.usage.input + t.usage.output)} tokens`)
  if (t.commits) parts.push(`${t.commits} commit${t.commits === 1 ? "" : "s"}`)
  return [when, parts.join(" · ")]
}

function end(t: Turn, st: Style, out: (line?: string) => void) {
  if (t.retry) {
    out()
    out(`Retrying  ${clean(t.retry)}`)
  }
  if (t.state === "succeeded") {
    out()
    out(st.bold("Answer"))
    out(clean(t.answer ?? ""))
  } else if (t.error) {
    out()
    out(st.bold("Error"))
    out(clean(t.error.message))
    if (t.error.hint) out(st.gray(`  ${t.error.hint}`))
  }
}
