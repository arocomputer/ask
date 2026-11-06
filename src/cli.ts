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


const commands: Record<string, Command> = Object.assign(Object.create(null), { settings, doctor, models, sessions, show, legacy, tools: toolsCommand, install, remove })

const environment = `ask reads these environment variables.

ASK_HOME: where ask keeps its settings, keys, model catalog and sessions (default: ~/.ask)

ASK_PARENT: the agent conversation calling ask, when ask can't tell by itself; the sessions
request lists the sessions this conversation started

NO_COLOR: set to any value to turn terminal emphasis off

CLICOLOR_FORCE: set to a value other than 0 to force monochrome emphasis (tables stay TSV in pipes)

A provider's own key variable, like OPENAI_API_KEY, works without ask settings. ask models
lists the models of every provider it finds a key for.
`

const topics: Record<string, [string, string]> = Object.assign(Object.create(null), {
  requests: ["How agents use ask, with JSON on stdin", guide],
  environment: ["Environment variables ask reads", environment],
})

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
    ["For agents", "  ask < request.json\n  ask -h requests"],
    ["Help", "  ask -h\n  ask <command> -h\n  ask -h environment\n  ask --version"],
  ])
}

function commandPage(c: Command): string {
  return page(`${style().bold(c.usage)}\n\n${c.about.replace(/([^\n])\n(?=\S)/g, "$1 ")}`, [
    ["Options", columns([...(c.flags ?? []), ["-h", "Show this help"]])],
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
    if (rest.length) return advice(`unexpected argument: ${rest[0]}`, "Use ask --version by itself, or ask -h for help.")
    process.stdout.write(`ask version ${version}\n`)
    return 0
  }
  if (first === "clean") throw new Usage("automatic cleanup was removed; no files were deleted. Review work with git worktree list and ask legacy. See docs/migration.md before removing a checkout.")
  if (first === "help" || first === "--help" || first === "-h") {
    if (rest.length > 1) return advice("help takes one command or topic", "Use ask -h, ask <command> -h, or ask -h requests.")
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
    if ((first === "settings" || first === "doctor") && rest.length)
      throw new Usage(`${rest[0].startsWith("-") ? "unknown flag" : "unexpected argument"}: ${rest[0]}`)
    if (["show", "install", "remove", "tools"].includes(first) && rest[0]?.startsWith("-"))
      throw new Usage(`unknown flag: ${rest[0]}`)
    return await command.run(h, rest)
  } catch (err) {
    const e = err as Error & { code?: string }
    if (!(err instanceof Usage) && !e.code?.startsWith("ERR_PARSE_ARGS")) throw err
    const message = e.message
      .replace(/^Unknown option '(.*?)'.*$/s, "unknown flag: $1")
      .replace(/^Unexpected argument '(.*?)'.*$/s, "unexpected argument: $1")
      .replace(/^Option '(.*?)' argument missing$/, "flag needs an argument: $1")
    const flag = message.match(/^unknown flag: (\S+)/)?.[1]
    const argument = message.match(/^(?:unexpected argument|unknown action): (\S+)/)?.[1]
    let hint = flag ? flagAdvice(flag, first) : ""
    if (argument === "help") hint = `Did you mean ask ${first} -h?`
    else if (argument && commands[argument]) hint = `Use ask ${argument} as a separate command. See ask ${argument} -h.`
    else if (argument && first === "tools") {
      const nearest = suggest(argument, ["on", "off"])
      if (nearest) hint = `Did you mean ask tools ${nearest} <name>?`
    }
    return advice(message, `${hint ? hint + "\n\n" : ""}${command.usage}\nSee ask ${first} -h`)
  }
}

/** Report a command-line error with a concrete recovery action, never executing a correction. */
function advice(message: string, hint: string): number {
  text(`${style(process.stderr).bold("error")}  ${message}\n\n${hint}`, process.stderr)
  return 2
}

/** The unique closest spelling within one or two edits; transposed adjacent letters count once. */
function suggest(value: string, choices: string[]): string | undefined {
  const input = value.toLowerCase()
  const scored = choices.filter((choice) => Math.abs(choice.length - input.length) <= 2).map((choice) => {
    const target = choice.toLowerCase()
    const d = Array.from({ length: input.length + 1 }, (_, i) => Array.from({ length: target.length + 1 }, (_, j) => i ? j ? 0 : i : j))
    for (let i = 1; i <= input.length; i++) for (let j = 1; j <= target.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + Number(input[i - 1] !== target[j - 1]))
      if (i > 1 && j > 1 && input[i - 1] === target[j - 2] && input[i - 2] === target[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
    return { choice, distance: d[input.length][target.length] }
  }).sort((a, b) => a.distance - b.distance)
  const [best, second] = scored
  return best && best.distance <= (input.length < 4 ? 1 : 2) && best.distance !== second?.distance ? best.choice : undefined
}

/** Flags are taken from the command's help contract, keeping spelling hints in sync with help. */
function flags(command: Command): string[] {
  return (command.flags ?? []).flatMap(([names]) => names.match(/--?[\w-]+/g) ?? [])
}

/** Correct a nearby spelling or name the command that owns a misplaced flag. */
function flagAdvice(flag: string, current?: string): string {
  const canonical = (name: string) => name === "--help" ? "-h" : name
  const owner = Object.entries(commands).find(([name, command]) => name !== current && flags(command).includes(flag))
  if (owner) return `That flag belongs after ${owner[0]}. Use ask ${owner[0]} ${flag}; see ask ${owner[0]} -h for its arguments.`
  if (current && ["--version", "-v"].includes(flag)) return "Use ask --version by itself."
  const local = [...(current ? flags(commands[current]) : []), "-h", "--help", ...(!current ? ["--version", "-v"] : [])]
  const nearest = suggest(flag, local)
  if (nearest) return `Did you mean ask${current ? ` ${current}` : ""} ${canonical(nearest)}?`
  if (!current) {
    const known = [...new Set(Object.values(commands).flatMap(flags))]
    const corrected = suggest(flag, known)
    const command = corrected && Object.entries(commands).find(([, c]) => flags(c).includes(corrected))
    if (command) return `Did you mean ask ${command[0]} ${corrected}? See ask ${command[0]} -h for its arguments.`
  }
  return ""
}

/** Guide unknown commands/topics toward close spellings or their correct location. */
function unknown(name: string, what: string): number {
  const names = what === "command" ? [...Object.keys(commands), "help"] : [...Object.keys(commands), ...Object.keys(topics)]
  const nearest = suggest(name, names)
  let hint = name.startsWith("-") ? flagAdvice(name) : ""
  if (!hint && what === "command" && topics[name]) hint = `That's a help topic. Use ask -h ${name}.`
  if (!hint && name === "h" && what === "command") hint = "Did you mean ask -h?"
  if (!hint && nearest) hint = `Did you mean ask ${what === "help topic" ? "-h " : ""}${nearest === "help" ? "-h" : nearest}?`
  if (!hint && what === "command" && ["start", "run", "collect", "wait", "continue", "stop"].includes(name))
    hint = "Tasks use JSON on stdin. See ask -h requests for examples."
  return advice(`unknown ${what} ${JSON.stringify(name)}`, `${hint ? hint + "\n\n" : ""}See ask -h${what === "help topic" ? " requests or ask -h environment for topics." : " for available commands."}`)
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
