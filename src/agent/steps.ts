// What a subagent did, in a few words per step, read from its transcript: tool calls like
// "read src/a.ts:40" or "shell npm test", and failed tool results.

import type { Message } from "../providers/stream.ts"
import { clean } from "../base/term.ts"

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

/** The steps of turn `turn` (1-based): each tool call, and "error: ..." when one failed. */
export function steps(messages: Message[], turn: number): string[] {
  const out: string[] = []
  let n = 0
  for (const m of messages) {
    if (m.role === "user") n++
    else if (n !== turn) continue
    else if (m.role === "assistant") for (const c of m.calls) out.push(describe(c.name, c.arguments))
    else if (m.role === "tool" && m.output.startsWith("error:")) out.push(clean(m.output.split("\n")[0]))
  }
  return out
}

/** The latest step of a transcript, for a running task. */
export function activity(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user") return "thinking"
    if (m.role === "assistant" && m.calls.length) return describe(m.calls.at(-1)!.name, m.calls.at(-1)!.arguments)
  }
  return "starting"
}
