// A prototype of handing a caller's own subagent calls to ask, measured by bench/callers.ts's
// hook arm before anything like it ships. Claude Code (Agent) and Codex (spawn_agent) run it as
// a PreToolUse hook; OpenCode imports `route` from a plugin. It gives the call's prompt to ask,
// waits for the answer, then refuses the native call with that answer as the reason, which is
// what the caller reads back instead of its own subagent's report.
//
//   bun bench/hook.ts < HOOK_INPUT_JSON     prints Claude Code's and Codex's PreToolUse reply

import { execFile } from "node:child_process"

/**
 * Runs a native subagent call's arguments as an ask task and says what came of it. Explore,
 * plan, review and research subagents become read-only tasks; any other kind may write.
 */
export function route(args: Record<string, unknown>): Promise<string> {
  const prompt = [args.description, args.prompt ?? args.message].filter((x) => typeof x === "string" && x).join("\n\n") || JSON.stringify(args)
  const kind = String(args.subagent_type ?? args.agent_type ?? args.agent ?? "")
  const request = { start: [{ prompt, write: !/explor|plan|review|research/i.test(kind) }], wait: 540 }
  return new Promise((done) => {
    const child = execFile("ask", [], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 590_000 }, (err, stdout) => {
      let reply: { error?: { message: string }; tasks?: { id: string; state: string; answer?: string; error?: { message: string }; changes?: { path: string; change: string }[] }[] }
      try {
        reply = JSON.parse(stdout)
      } catch {
        return done(`This subagent call was handed to ask, which failed: ${err?.message ?? stdout.slice(0, 2000)}`)
      }
      const t = reply.tasks?.[0]
      if (!t) return done(`This subagent call was handed to ask, which refused it: ${reply.error?.message ?? "no task"}`)
      const head = `This subagent call was handed to ask, which ran it as session ${t.id}; this is its result, not an error.`
      if (t.state === "running" || t.state === "retrying")
        return done(`${head} It is still running. Collect it with: ask <<< '{"collect": ["${t.id}"], "wait": 600}'`)
      if (t.state !== "succeeded") return done(`${head} It ${t.state}: ${t.error?.message ?? "no answer"}`)
      const changed = t.changes?.length ? `\n\nFiles it changed: ${t.changes.map((c) => `${c.path} (${c.change})`).join(", ")}` : ""
      done(`${head} Its answer:\n\n${t.answer}${changed}`)
    })
    child.stdin!.end(JSON.stringify(request))
  })
}

if (import.meta.main) {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  const input = JSON.parse(text)
  const reason = await route((input.tool_input ?? {}) as Record<string, unknown>)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }))
}
