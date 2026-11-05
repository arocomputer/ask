#!/usr/bin/env node
// The ask command. Agents send one JSON request on stdin and read one JSON response on stdout
// (see protocol.ts). People run the commands below. Help pages share one layout: what the
// command does, then USAGE, FLAGS, INHERITED FLAGS, EXAMPLES and LEARN MORE, titles in bold.
// Exit status: 0 handled, 1 failed, 2 a request or command ask can't carry out.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { home } from "./home.ts"
import { guide, handle } from "./protocol.ts"
import { open } from "./sessions.ts"
import { style } from "./term.ts"
import { version } from "./version.ts"
import { main as worker } from "./worker.ts"
import * as doctor from "./cmd/doctor.ts"
import * as models from "./cmd/models.ts"
import * as sessions from "./cmd/sessions.ts"
import * as settings from "./cmd/settings.ts"
import * as show from "./cmd/show.ts"
import { Usage, type Command } from "./cmd/usage.ts"


const commands: Record<string, Command> = { settings, doctor, models, sessions, show }

const environment = `ask reads these environment variables.

ASK_HOME: where ask keeps its settings, keys, model catalog and sessions (default: ~/.ask)

NO_COLOR: set to any value to turn color off

CLICOLOR_FORCE: set to a value other than 0 to keep color when output is piped

A provider's own key variable, like OPENAI_API_KEY, works without ask settings. ask models
lists the models of every provider it finds a key for.
`

const topics: Record<string, [string, string]> = {
  requests: ["How agents use ask, with JSON on stdin", guide],
  environment: ["Environment variables ask reads", environment],
}

/** Two aligned columns, as help pages list commands and flags. */
function columns(rows: [string, string][], colon = false): string {
  const w = Math.max(...rows.map(([a]) => a.length + (colon ? 1 : 0)))
  return rows.map(([a, b]) => `  ${(colon ? a + ":" : a).padEnd(w)}  ${b}`).join("\n")
}

/** Renders a help page: the opening text, then each titled section. */
function page(about: string, sections: [string, string][]): string {
  const b = style().bold
  return [about.trimEnd(), ...sections.filter(([, body]) => body).map(([title, body]) => `${b(title)}\n${body}`)].join("\n\n") + "\n"
}

const learn = "  Use `ask <command> --help` for more information about a command.\n  Use `ask help requests` to see how agents hand ask work."

function overview(): string {
  return page("Hand tasks to subagents that work in the background.", [
    ["USAGE", "  ask <command> [flags]\n  ask < request.json"],
    ["COMMANDS", columns(Object.entries(commands).map(([n, c]) => [n, c.summary]), true)],
    ["HELP TOPICS", columns(Object.entries(topics).map(([n, [s]]) => [n, s]), true)],
    ["FLAGS", columns([["--help", "Show help for command"], ["--version", "Show ask version"]])],
    ["EXAMPLES", ["$ ask settings", "$ ask sessions", `$ echo '{"start": [{"prompt": "Where is the retry logic?"}], "wait": 300}' | ask`].map((e) => "  " + e).join("\n")],
    ["LEARN MORE", learn],
  ])
}

function commandPage(c: Command): string {
  return page(c.about, [
    ["USAGE", "  " + c.usage],
    ["FLAGS", c.flags ? columns(c.flags) : ""],
    ["INHERITED FLAGS", columns([["--help", "Show help for command"]])],
    ["EXAMPLES", (c.examples ?? []).map((e) => "  $ " + e).join("\n")],
    ["LEARN MORE", learn],
  ])
}

function topicPage(text: string): string {
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
  if (first === "__worker") {
    await worker(h, open(h, rest[0].split("/").pop()!))
    return 0
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`ask version ${version}\n`)
    return 0
  }
  if (first === "help" || first === "--help" || first === "-h") {
    const topic = rest[0]
    if (!topic) process.stdout.write(overview())
    else if (commands[topic]) process.stdout.write(commandPage(commands[topic]))
    else if (topics[topic]) process.stdout.write(topicPage(topics[topic][1]))
    else return unknown(topic, "help topic")
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
  if (!command) return unknown(first, "command")
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(commandPage(command))
    return 0
  }
  try {
    return await command.run(h, rest)
  } catch (err) {
    const e = err as Error & { code?: string }
    if (!(err instanceof Usage) && !e.code?.startsWith("ERR_PARSE_ARGS")) throw err
    const message = e.message
      .replace(/^Unknown option '(.*?)'.*$/s, "unknown flag: $1")
      .replace(/^Unexpected argument '(.*?)'.*$/s, "unexpected argument: $1")
      .replace(/^Option '(.*?)' argument missing$/, "flag needs an argument: $1")
    process.stderr.write(`${message}\n\nUsage:  ${command.usage}\n\nRun 'ask ${first} --help' for more.\n`)
    return 2
  }
}

/** An unknown command or topic, with what there is instead. */
function unknown(name: string, what: string): number {
  const names = what === "command" ? Object.keys(commands) : [...Object.keys(commands), ...Object.keys(topics)]
  process.stderr.write(`unknown ${what} ${JSON.stringify(name)} for "ask"\n\nUsage:  ask <command> [flags]\n\nAvailable ${what === "command" ? "commands" : "topics"}:\n${names.map((n) => "  " + n).join("\n")}\n`)
  if (what === "command") process.stderr.write(`\nAgents send work as JSON on stdin; see 'ask help requests'.\n`)
  return 2
}

/** True when this file is what was run, even through a symlink like npm's bin link. */
function entry(): boolean {
  if (typeof import.meta.main === "boolean") return import.meta.main
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (entry()) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      process.stderr.write(`${(err as Error)?.message ?? String(err)}\n`)
      process.exitCode = 1
    },
  )
}
