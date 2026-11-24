// What a subagent did, in a few words per step: local Code Mode activity, earlier direct calls
// or harness calls from the transcript, and failed tool results.

import type { Message } from "../providers/stream.ts"
import { clean } from "../base/term.ts"
import type { Notice } from "./code.ts"

/** Position of a local action in the transcript and in its script. */
export type Action = Notice & { at: number; script: number }

/** A tool call in a few words. */
export function describe(name: string, args: string): string {
  let a: Record<string, unknown> = {}
  try {
    a = JSON.parse(args)
  } catch {}
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "")
  let text: string
  switch (name) {
    case "read":
      text = `read ${s("path")}${typeof a.line === "number" ? `:${a.line}` : ""}`
      break
    case "list":
      text = `list ${[s("path"), s("pattern")].filter(Boolean).join(" ") || "."}`
      break
    case "grep":
      text = `grep ${s("pattern")}${s("path") ? ` in ${s("path")}` : ""}${s("glob") ? ` (${s("glob")})` : ""}`
      break
    case "shell":
      text = `shell ${s("command").split("\n")[0]}`
      break
    case "fetch":
      text = `fetch ${s("url")}`
      break
    case "git":
      text = `git ${Array.isArray(a.args) ? a.args.join(" ") : ""}`
      break
    case "search":
      text = `search ${s("query")}`
      break
    default:
      text = `${name} ${s("path")}`.trim()
  }
  return clean(text)
}

/** The steps of turn `turn` (1-based); started actions may not have finished. */
export function steps(messages: Message[], turn: number, actions: Action[] = []): string[] {
  const byPosition = Map.groupBy(actions, (a) => `${a.at}:${a.script}`)
  const out: string[] = []
  let n = 0
  for (const [at, m] of messages.entries()) {
    if (m.role === "user") n++
    else if (n !== turn) continue
    else if (m.role === "assistant") for (const [script, c] of m.calls.entries()) {
      const nested = c.name === "execute" ? byPosition.get(`${at}:${script}`) : undefined
      if (!nested?.length) out.push(describe(c.name, c.arguments))
      else for (const a of nested) out.push(clean(a.label + (a.state === "started" ? " (outcome unknown)" : a.state === "failed" ? " (failed)" : "")))
    }
    else if (m.role === "tool" && m.output.startsWith("error:")) out.push(clean(m.output.split("\n")[0]))
  }
  return out
}

/** The latest step of a transcript, for a running task. */
export function activity(messages: Message[], actions: Action[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user") return "thinking"
    if (m.role === "assistant" && m.calls.length) {
      const nested = actions.findLast((a) => a.at === i)
      return nested ? clean(nested.label) : describe(m.calls.at(-1)!.name, m.calls.at(-1)!.arguments)
    }
  }
  return "starting"
}
