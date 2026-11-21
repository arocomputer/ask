// A prototype of handing a caller's own subagent calls to ask, measured by bench/callers.ts's
// hook arm before anything like it ships. Claude Code runs it as a PreToolUse hook; OpenCode
// imports `route` from a plugin. It gives the call's prompt to ask,
// waits for the answer, then refuses the native call with that answer as the reason, which is
// what the caller reads back instead of its own subagent's report.
//
//   bun bench/hook.ts < HOOK_INPUT_JSON     prints Claude Code's PreToolUse reply

import { execFile } from "node:child_process"
import { join } from "node:path"

export const routed = "This subagent call was handed to ask"

/**
 * Runs a native subagent prompt in the benchmark's scratch checkout. Only a fixture that
 * explicitly expects edits grants write access; native agent names don't grant permissions.
 */
export async function route(args: Record<string, unknown>): Promise<string> {
  const dir = process.env.ASK_BENCH_DIR
  if (!dir || typeof args.prompt !== "string" || !args.prompt.trim())
    return "The benchmark hook requires a scratch checkout and a subagent prompt."
  const prompt = [args.description, args.prompt].filter((x) => typeof x === "string" && x).join("\n\n")
  const request = { start: [{ prompt, write: process.env.ASK_BENCH_WRITE === "1", timeout: 480 }], wait: 540 }
  return new Promise((done) => {
    const child = execFile(join(dir, "..", "bin", "ask"), [], { cwd: dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 590_000 }, (_err, stdout) => {
      let reply: { error?: { message: string }; tasks?: { id: string; state: string; answer?: string; error?: { message: string }; changes?: { path: string; change: string }[] }[] }
      try {
        reply = JSON.parse(stdout)
      } catch {
        return done(`${routed}, but ask did not return a task response.`)
      }
      const t = reply.tasks?.[0]
      if (!t) return done(`${routed}, which refused it: ${reply.error?.message ?? "no task"}`)
      const head = `${routed}, which ran it as session ${t.id}; this is its result, not an error.`
      if (t.state === "running" || t.state === "retrying")
        return done(`${head} It is still running. Collect it with: ask <<< '{"collect": ["${t.id}"], "wait": 600}'`)
      if (t.state !== "succeeded") return done(`${head} It ${t.state}: ${t.error?.message ?? "no answer"}`)
      const changed = t.changes?.length ? `\n\nFiles it changed: ${t.changes.map((c) => `${c.path} (${c.change})`).join(", ")}` : ""
      done(`${head} Its answer:\n\n${t.answer}${changed}`)
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify(request))
  })
}

if (import.meta.main) {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  const input = JSON.parse(text)
  const reason = await route((input.tool_input ?? {}) as Record<string, unknown>)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }))
}
