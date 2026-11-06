// ask show ID: a session to read, turn by turn: the prompt with its status symbol, a line of
// details, the steps, the files changed, and the answer or the error.

import type { Home } from "../base/home.ts"
import { open, status, transcript, type Turn } from "../sessions/store.ts"
import { steps } from "../agent/steps.ts"
import { ago, clean, count, duration, style, symbol, type Style } from "../base/term.ts"
import { Usage } from "./command.ts"

export const summary = "View a session"
export const about = "View a session: each prompt, the steps the subagent took, and its answer."
export const usage = "ask show <id>"
export const examples = ["ask show k3f9a2"]

export async function run(h: Home, argv: string[]): Promise<number> {
  if (argv.length !== 1) throw new Usage(argv.length ? "accepts 1 arg, received " + argv.length : "a session id is required")
  const s = open(h, argv[0])
  const messages = transcript(s)
  const st = style()
  const out = (line = "") => process.stdout.write(line + "\n")
  out(`${st.bold(s.id)} ${st.gray(`· ${s.dir}${s.worktree ? ` · on ${s.worktree.branch}` : ""}`)}`)
  s.turns.forEach((recorded, i) => {
    const t = i === s.turns.length - 1 ? status(s) : recorded
    const [title, ...more] = clean(t.prompt).split("\n")
    out()
    out(`${symbol(t.state, st)} ${st.bold(title)}`)
    for (const line of more.slice(0, 5)) out(st.gray(`  ${line}`))
    if (more.length > 5) out(st.gray(`  …`))
    for (const line of details(t)) out(st.gray(line))
    const done = steps(messages, i + 1)
    if (done.length) out()
    for (const step of done) out(step.startsWith("error:") ? `  ${step}` : `${st.gray("•")} ${step}`)
    for (const c of t.changes ?? []) out(`${c.change === "added" ? st.green("+") : c.change === "deleted" ? st.red("-") : st.yellow("~")} ${c.path}`)
    end(t, st, out)
    if (t.changesError) out(st.yellow(clean(t.changesError)))
  })
  return 0
}

/** Two lines: "Succeeded about 2 minutes ago in 4s", then "model · read-only · 3k tokens". */
function details(t: Turn): string[] {
  const seconds = ((t.finished ? Date.parse(t.finished) : Date.now()) - Date.parse(t.started)) / 1000
  const when =
    t.state === "running" ? `Running for ${duration(seconds)}` : t.state === "retrying" ? `Retrying after ${duration(seconds)}` : `${t.state[0].toUpperCase()}${t.state.slice(1)} ${ago(t.finished ?? t.started)} in ${duration(seconds)}`
  const parts = [t.model, t.write ? "write" : "read-only"]
  if (t.usage) parts.push(`${count(t.usage.input + t.usage.output)} tokens`)
  if (t.commits) parts.push(`${t.commits} commit${t.commits === 1 ? "" : "s"}`)
  return [when, parts.join(" · ")]
}

function end(t: Turn, st: Style, out: (line?: string) => void) {
  if (t.retry) {
    out()
    out(`${st.yellow("!")} ${clean(t.retry)}`)
  }
  if (t.state === "succeeded") {
    out()
    out(clean(t.answer ?? ""))
  } else if (t.error) {
    out()
    out(`${st.red("X")} ${t.error.message}`)
    if (t.error.hint) out(st.gray(`  ${t.error.hint}`))
  }
}
