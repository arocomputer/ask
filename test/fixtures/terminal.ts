// Offline visual fixtures using the real CLI/renderers and a disposable home. No credentials,
// account access or models. Preview: node test/fixtures/terminal.ts [40|80] [plain].
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../src/cli.ts"
import { field, menu } from "../../src/base/input.ts"
import { print } from "../../src/commands/doctor.ts"

/** Capture terminal output at a chosen width, restoring process state even when a fixture fails. */
export async function preview(columns: number, monochrome = true): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ask-ui-"))
  const original = { home: process.env.ASK_HOME, color: process.env.NO_COLOR, term: process.env.TERM }
  const now = Date.now
  const restore: (() => void)[] = []
  let output = ""
  try {
    process.env.ASK_HOME = root
    process.env.TERM = "xterm-256color"
    if (monochrome) delete process.env.NO_COLOR
    else process.env.NO_COLOR = "1"
    Date.now = () => Date.parse("2026-11-06T12:00:00Z")
    for (const stream of [process.stdout, process.stderr]) {
      for (const [key, value] of Object.entries({ isTTY: true, columns, rows: 24, write: (chunk: string) => { output += chunk; return true } })) {
        const before = Object.getOwnPropertyDescriptor(stream, key)
        Object.defineProperty(stream, key, { configurable: true, value })
        restore.push(() => before ? Object.defineProperty(stream, key, before) : Reflect.deleteProperty(stream, key))
      }
    }
    mkdirSync(join(root, "cache"))
    writeFileSync(join(root, "cache/models.json"), JSON.stringify({ example: { id: "example", name: "Example", env: [], api: "http://127.0.0.1:1/v1", npm: "@ai-sdk/openai-compatible", models: { reader: { id: "reader", name: "Reader", tool_call: true, limit: { context: 128000 } } } } }))
    writeFileSync(join(root, "config.json"), JSON.stringify({ model: "example/reader" }))
    writeFileSync(join(root, "auth.json"), JSON.stringify({ example: { api_key: "fixture-only" } }))
    mkdirSync(join(root, "sessions/abc123"), { recursive: true })
    writeFileSync(join(root, "sessions/abc123/session.json"), JSON.stringify({
      id: "abc123", dir: "/work/ask", created: "2026-11-06T11:55:00Z", turns: [{
        prompt: "Review callback handling", model: "example/reader", write: false, timeout: 900,
        state: "succeeded", started: "2026-11-06T11:55:00Z", finished: "2026-11-06T11:55:04Z",
        answer: "The callback keeps the active login when a paste needs correcting.", usage: { input: 1400, output: 200, cached: 0 },
      }],
    }))
    const section = (name: string) => { output += `\n--- ${name} ---\n\n` }
    for (const args of [["help"], ["settings", "--help"], ["models"], ["tools"], ["sessions", "--all"], ["show", "abc123"], ["legacy"], ["unknown"]]) {
      section(args.join(" "))
      await main(args)
    }
    section("settings picker")
    output += menu("Settings", [
      { label: "Default model", hint: "example/reader", value: "default" },
      { label: "Connect a provider", hint: "ChatGPT, API keys or installed harnesses", value: "connect" },
      { label: "Timeout", hint: "900 seconds", value: "timeout" },
      { label: "Done", value: "done" },
    ], 1).join("\n") + "\n"
    section("model selection")
    output += menu("Models", [{ label: "Reader", value: "reader" }, { label: "Writer", value: "writer" }], 1, "", new Set(["reader"])).join("\n") + "\n"
    section("empty filter")
    output += menu("Models", [], 0, "not-found").join("\n") + "\n"
    section("callback paste")
    output += field("Callback URL", "http://127.0.0.1:1455/auth/callback?code=example&state=example", "58 characters · enter submit").join("\n") + "\n"
    section("secret paste")
    output += field("API key", "fixture-only-do-not-display", "", true).join("\n") + "\n"
    section("doctor")
    print({ mark: "ok", name: "Runtime", detail: "Node 24" })
    print({ mark: "fail", name: "Model", detail: "No default model", fix: "ask settings, then Default model" })
    return output.replaceAll(root, "/home/you/.ask")
  } finally {
    for (const undo of restore.reverse()) undo()
    Date.now = now
    for (const [key, value] of Object.entries({ ASK_HOME: original.home, NO_COLOR: original.color, TERM: original.term })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith("fixtures/terminal.ts")) {
  const columns = Number(process.argv[2] ?? 80)
  if (!Number.isInteger(columns) || columns < 24) throw new Error("width must be at least 24")
  const output = await preview(columns, process.argv[3] !== "plain")
  process.stdout.write(output)
}
