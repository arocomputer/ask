#!/usr/bin/env node
// The ask command. Agents send one JSON request on stdin and read one JSON response on stdout
// (see protocol.ts). Human help uses compact monochrome headings and stacked descriptions
// on phones. Machine requests, exit codes and version output remain independent of presentation.
// Exit status: 0 handled, 1 failed, 2 a request or command ask can't carry out.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { home } from "./base/home.ts"
import { guide, handle } from "./sessions/protocol.ts"
import { open } from "./sessions/store.ts"
import { style, text, wrap } from "./base/term.ts"
import { version } from "./base/version.ts"
import { main as worker } from "./sessions/worker.ts"
import { toolMain } from "./agent/tools.ts"
import * as doctor from "./commands/doctor.ts"
import * as install from "./commands/install.ts"
import * as legacy from "./commands/legacy.ts"
import * as models from "./commands/models.ts"
import * as remove from "./commands/remove.ts"
import * as sessions from "./commands/sessions.ts"
import * as settings from "./commands/settings.ts"
import * as show from "./commands/show.ts"
import * as toolsCommand from "./commands/tools.ts"
import { Usage, type Command } from "./commands/command.ts"


const commands: Record<string, Command> = { settings, doctor, models, sessions, show, legacy, tools: toolsCommand, install, remove }

const environment = `ask reads these environment variables.

ASK_HOME: where ask keeps its settings, keys, model catalog and sessions (default: ~/.ask)

ASK_PARENT: the agent conversation calling ask, when ask can't tell by itself; the sessions
request lists the sessions this conversation started

NO_COLOR: set to any value to turn terminal emphasis off

CLICOLOR_FORCE: set to a value other than 0 to force monochrome emphasis (tables stay TSV in pipes)

A provider's own key variable, like OPENAI_API_KEY, works without ask settings. ask models
lists the models of every provider it finds a key for.
`

const topics: Record<string, [string, string]> = {
  requests: ["How agents use ask, with JSON on stdin", guide],
  environment: ["Environment variables ask reads", environment],
}

/** Two aligned columns, as help pages list commands and flags. */
function columns(rows: [string, string][]): string {
  const room = Math.max(10, (process.stdout.columns || 80) - 1)
  const w = Math.max(...rows.map(([a]) => a.length))
  return rows.map(([a, b]) => room < 60
    ? `  ${a}\n${wrap(b, room - 4).map((l) => "    " + l).join("\n")}`
    : `  ${a.padEnd(w)}  ${wrap(b, room - w - 4).join("\n" + " ".repeat(w + 4))}`).join("\n")
}

/** Renders a help page: the opening text, then each titled section. */
function page(about: string, sections: [string, string][]): string {
  const b = style().bold
  return [about.trimEnd(), ...sections.filter(([, body]) => body).map(([title, body]) => `${b(title)}\n${body}`)].join("\n\n") + "\n"
}

function overview(): string {
  return page(`${style().bold("Ask")}\nBackground tasks, handled.`, [
    ["Get started", "  ask settings     Connect a provider\n  ask doctor       Check your setup"],
    ["Commands", columns(Object.entries(commands).map(([n, c]) => [n, c.summary]))],
    ["For agents", "  ask < request.json\n  ask help requests"],
    ["Help", "  ask <command> --help\n  ask help environment\n  ask --version"],
  ])
}

function commandPage(c: Command): string {
  return page(`${style().bold(c.usage)}\n\n${c.about.replace(/([^\n])\n(?=\S)/g, "$1 ")}`, [
    ["Options", columns([...(c.flags ?? []), ["--help", "Show this help"]])],
    ["Examples", (c.examples ?? []).map((e) => "  " + e).join("\n")],
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
  if (first === "__tool") {
    process.stdout.write(await toolMain(rest[0], await read()))
    return 0
  }
  if (first === "__worker") {
    await worker(h, open(h, rest[0].split("/").pop()!))
    return 0
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`ask version ${version}\n`)
    return 0
  }
  if (first === "clean") throw new Usage("automatic cleanup was removed; no files were deleted. Review work with git worktree list and ask legacy. See docs/migration.md before removing a checkout.")
  if (first === "help" || first === "--help" || first === "-h") {
    const topic = rest[0]
    if (!topic) text(overview().trimEnd())
    else if (commands[topic]) text(commandPage(commands[topic]).trimEnd())
    else if (topics[topic]) text(topicPage(topics[topic][1]).trimEnd())
    else return unknown(topic, "help topic")
    return 0
  }
  if (first === undefined) {
    if (process.stdin.isTTY) {
      text(overview().trimEnd())
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
    text(commandPage(command).trimEnd())
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
    text(`${style(process.stderr).bold("error")}  ${message}\n\n${command.usage}\nSee ask ${first} --help`, process.stderr)
    return 2
  }
}

/** An unknown command or topic, with what there is instead. */
function unknown(name: string, what: string): number {
  const names = what === "command" ? Object.keys(commands) : [...Object.keys(commands), ...Object.keys(topics)]
  text(`error  unknown ${what} ${JSON.stringify(name)}\n\nAvailable ${what === "command" ? "commands" : "topics"}\n${names.map((n) => "  " + n).join("\n")}\n\nSee ask --help`, process.stderr)
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
      text(`error  ${(err as Error)?.message ?? String(err)}`, process.stderr)
      process.exitCode = 1
    },
  )
}
