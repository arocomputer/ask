#!/usr/bin/env bun
// The ask command. Agents send one JSON request on stdin and read one JSON response on stdout
// (see protocol.ts). People run the few commands below to set up and look at sessions.
// Exit status: 0 handled, 1 failed, 2 a request or command ask can't carry out.

import { home } from "./home.ts"
import { guide, handle } from "./protocol.ts"
import { open } from "./sessions.ts"
import { style } from "./term.ts"
import { main as worker } from "./worker.ts"
import * as doctor from "./cmd/doctor.ts"
import * as models from "./cmd/models.ts"
import * as sessions from "./cmd/sessions.ts"
import * as settings from "./cmd/settings.ts"
import * as show from "./cmd/show.ts"

export const version = "3.0.0-dev"

type Command = { help: string; run(h: ReturnType<typeof home>, argv: string[]): Promise<number> }

const commands: Record<string, Command> = { settings, doctor, models, sessions, show }

function overview(): string {
  const b = style().bold
  return `ask hands tasks to subagents that work in the background.

${b("USAGE")}
  ask < request.json    For agents: one JSON request on stdin, one JSON response on stdout
  ask <command>         For people: settings, and a look at what subagents did

${b("COMMANDS")}
  settings:   Providers, keys, models and the default; the first run sets ask up
  doctor:     Check that ask can run tasks, and say how to fix what can't
  models:     List your models
  sessions:   List recent sessions
  show:       Show a session's steps and answer

${b("REQUESTS")}
  {"start": [{"prompt": "Find the retry logic"}], "wait": 300}
  {"collect": ["k3f9a2"], "wait": 300}
  {"continue": "k3f9a2", "prompt": "Now add a test", "write": true}
  {"stop": ["k3f9a2"]}
  {"show": "k3f9a2"}

${b("FILES")}
  ~/.ask/config.json   {"model": "provider/model", "models": [...], "timeout": 900}
  ~/.ask/auth.json     {"provider": {"api_key": "..."}}
  Both are written by ask settings, and can be edited by hand.

${b("LEARN MORE")}
  ask help requests     Every request and response field
  ask help <command>    More about a command
`
}

function page(text: string): string {
  const b = style().bold
  return text.replace(/^([A-Z][A-Z ]+)$/gm, (m) => b(m))
}

async function read(): Promise<string> {
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  return text
}

export async function main(argv: string[]): Promise<number> {
  const h = home()
  const [first, ...rest] = argv
  const st = style(process.stderr)
  if (first === "__worker") {
    await worker(h, open(h, rest[0].split("/").pop()!))
    return 0
  }
  if (first === "-v" || first === "--version") {
    process.stdout.write(`ask ${version}\n`)
    return 0
  }
  if (first === "help" || first === "-h" || first === "--help") {
    const topic = rest[0]
    process.stdout.write(topic === "requests" ? page(guide) : topic && commands[topic] ? page(commands[topic].help) : overview())
    return 0
  }
  if (first === undefined) {
    if (process.stdin.isTTY) {
      process.stdout.write(overview())
      return 0
    }
    let request: unknown
    try {
      request = JSON.parse(await read())
    } catch (err) {
      process.stdout.write(JSON.stringify({ error: { message: `the request isn't JSON: ${(err as Error).message}`, hint: 'send one object, like {"start": [{"prompt": "..."}]}' } }) + "\n")
      return 2
    }
    const response = await handle(h, request)
    process.stdout.write(JSON.stringify(response) + "\n")
    return "error" in response ? 2 : 0
  }
  const command = commands[first]
  if (!command) {
    process.stderr.write(`${st.red("X")} Unknown command ${JSON.stringify(first)}\n${st.gray("  Agents send a JSON request on stdin; ask help shows how")}\n`)
    return 2
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(page(command.help))
    return 0
  }
  return command.run(h, rest)
}

/** Prints an unexpected error as gh does: a red X and the message, and a hint when there is one. */
function report(err: unknown): number {
  const st = style(process.stderr)
  const e = err as Error & { code?: string }
  const usage = !!e?.code?.startsWith("ERR_PARSE_ARGS")
  const message = (e?.message ?? String(err)).replace(/\. To specify a positional argument.*$/s, "")
  process.stderr.write(`${st.red("X")} ${message}\n${usage ? st.gray("  ask help lists the flags") + "\n" : ""}`)
  return usage ? 2 : 1
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => (process.exitCode = report(err)),
  )
}
