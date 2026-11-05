#!/usr/bin/env bun
// The ask command: dispatch, help and errors. A first argument that names no command is the
// prompt. Exit status: 0 success, 1 a failed task or error, 2 a mistake in the call.

import { home } from "./home.ts"
import { open } from "./sessions.ts"
import { style } from "./term.ts"
import { main as worker } from "./worker.ts"
import * as auth from "./cmd/auth.ts"
import { Usage } from "./cmd/common.ts"
import * as config from "./cmd/config.ts"
import * as follow from "./cmd/continue.ts"
import * as models from "./cmd/models.ts"
import * as start from "./cmd/run.ts"
import * as sessions from "./cmd/sessions.ts"
import * as setup from "./cmd/setup.ts"
import * as show from "./cmd/show.ts"
import * as stop from "./cmd/stop.ts"
import * as wait from "./cmd/wait.ts"

export const version = "3.0.0-dev"

type Command = { help: string; run(h: ReturnType<typeof home>, argv: string[]): Promise<number> }

const commands: Record<string, Command> = { sessions, show, wait, continue: follow, stop, setup, auth, models, config }

function overview(): string {
  const st = style()
  const h = (s: string) => st.bold(s)
  return `Hand tasks to subagents that work in the background.

${h("USAGE")}
  ask <prompt> [flags]
  ask <command> [flags]

${h("SESSION COMMANDS")}
  sessions:    List recent sessions
  show:        Show a session's steps and answer
  wait:        Wait for a session and print its answer
  continue:    Give a finished session its next prompt
  stop:        Stop a running session

${h("SETUP COMMANDS")}
  setup:       Choose a provider, paste its key, pick a default model
  auth:        Add, remove and check provider keys
  models:      List the models you can use
  config:      Read and change settings

${h("FLAGS")}
  -m, --model provider/model   The model to use (default: ask config get model)
  -w, --write                  Let it edit files and run commands
  -C, --dir path               Where it works (default: here)
  -e, --effort level           Reasoning effort, like low, medium or high
      --timeout seconds        Stop after this long (default: 900)
      --schema json            A JSON Schema its answer must match
      --wait                   Block until it finishes and print the answer
      --json                   Print results as JSON
  -h, --help                   Show help for ask or a command
  -v, --version                Show ask's version

${h("EXAMPLES")}
  $ ask setup
  $ ask "Where is the retry logic?"
  $ ask -w --wait "Add a test for parse() and run it"
  $ git diff | ask "Review this change"
  $ ask wait k3f9a2

${h("LEARN MORE")}
  ask <command> --help for more about a command.
`
}

function page(text: string): string {
  const st = style()
  return text.replace(/^([A-Z][A-Z ]+)$/gm, (m) => st.bold(m))
}

export async function main(argv: string[]): Promise<number> {
  const h = home()
  const [first, ...rest] = argv
  if (first === "__worker") {
    await worker(h, open(h, rest[0].split("/").pop()!))
    return 0
  }
  if (first === "-v" || first === "--version") {
    process.stdout.write(`ask ${version}\n`)
    return 0
  }
  if (first === undefined && process.stdin.isTTY) {
    process.stdout.write(overview())
    return 0
  }
  if (first === "help") {
    const c = rest[0] && commands[rest[0]]
    process.stdout.write(c ? page(c.help) : overview())
    return 0
  }
  const command = first !== undefined ? commands[first] : undefined
  const args = command ? rest : argv
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(command ? page(command.help) : overview())
    return 0
  }
  return (command ?? start).run(h, args)
}

/** Prints an error the way gh does: a red X and the message, then what to do, dimmed. */
function report(err: unknown): number {
  const st = style(process.stderr)
  const e = err as Error & { hint?: string; code?: string }
  let message = e?.message ?? String(err)
  let hint = e?.hint
  if (e?.code?.startsWith("ERR_PARSE_ARGS")) {
    message = message.replace(/\. To specify a positional argument.*$/s, "")
    hint = "ask --help lists the flags"
  }
  process.stderr.write(`${st.red("X")} ${message}\n${hint ? st.gray(`  ${hint}`) + "\n" : ""}`)
  return err instanceof Usage || e?.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => (process.exitCode = report(err)),
  )
}
