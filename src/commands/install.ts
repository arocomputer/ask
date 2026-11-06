// ask install: turns on what ask can run besides its own loop. `claude` and `codex` are the
// harnesses ask ships; `skill` teaches Claude Code and Codex to use ask; a folder or git
// address is an extension someone wrote, checked by loading it, then copied into
// ~/.ask/extensions/NAME (made only now). A harness also gets a "harnesses" entry in
// config.json to edit. Installing what is already installed updates it. With nothing named, it
// lists what there is.

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { active, builtin, enabled } from "../harnesses/extensions.ts"
import { broken, folder, installed, load, type Extension, type Harness } from "../harnesses/harness.ts"
import { readJSON, writeJSON, type Config, type Home } from "../base/home.ts"
import * as skill from "../harnesses/skill.ts"
import { heading, style, table, text } from "../base/term.ts"
import { Usage } from "./command.ts"

export const summary = "Add harnesses, skills or extensions"
export const about = `Turn on what ask can run besides its own loop.

  claude    Run claude/ models with your installed Claude Code
  codex     Run codex/ models with your installed Codex
  skill     Teach Claude Code and Codex to hand work to ask
  PATH|URL  An extension: a folder or git repository that adds a harness or tools

ask doesn't install Claude Code or Codex themselves, or sign in to them; see each one's
docs. A harness gets an entry under "harnesses" in ~/.ask/config.json, to change the command,
add arguments or set environment variables. An extension runs as part of ask, so install only
ones you trust. With nothing named, lists what there is.`
export const usage = "ask install [claude | codex | skill | PATH | URL]"
export const examples = ["ask install claude", "ask install skill", "ask install https://github.com/someone/ask-gemini"]

const say = (line: string) => text(line, process.stderr)

export async function run(h: Home, argv: string[]): Promise<number> {
  if (argv.length > 1) throw new Usage(`unexpected argument: ${argv[1]}`)
  const name = argv[0]
  if (!name) return list(h)
  if (name.startsWith("-")) throw new Usage(`unknown flag: ${name}`)
  if (name === "skill") return installSkill()
  if (builtin[name]) return turnOn(h, builtin[name])
  if (remote(name) || existsSync(name)) return installExtension(h, name)
  throw new Usage(`no harness, folder or git repository called ${name}`)
}

/** What can be installed and what is, one line each. */
async function list(h: Home): Promise<number> {
  const st = style()
  heading("install")
  const loaded = await active(h)
  const rows: [string, string, string][] = [
    ...Object.values(builtin).map((x): [string, string, string] => [x.name, `${x.title} harness`, enabled(h, x.name) ? "installed" : "not installed"]),
    ["skill", "Agent skill for Claude Code and Codex", skill.current() ? "installed" : "not installed"],
    ...installed(h.root).map((name): [string, string, string] => {
      const e = loaded.find((x) => x.name === name)
      if (e) return [name, describe(e), "installed"]
      return [name, "Extension", broken.has(name) ? "broken" : "turned off"]
    }),
  ]
  table(rows.map(([name, what, on]) => [[name, st.bold(name)], [what, what], [on, on === "broken" ? st.bold(on) : on]]), { header: ["Name", "Description", "Status"], flex: 1 })
  return 0
}

function describe(e: Extension): string {
  const parts = [...(e.harness ? [`${e.harness.title} harness`] : []), ...(e.tools?.length ? [`${e.tools.length} tool${e.tools.length === 1 ? "" : "s"}`] : [])]
  return `Extension: ${parts.join(", ") || "adds nothing"}`
}

/** Lists `name` in config.json's extensions and, for a harness, writes its settings template. */
function enable(h: Home, name: string, x?: Harness) {
  const c = readJSON<Config>(h.config, {})
  c.extensions = [...new Set([...(c.extensions ?? []), name])]
  if (x && !c.harnesses?.[name]) c.harnesses = { ...c.harnesses, [name]: template(x) }
  writeJSON(h.config, c)
}

/** The "harnesses" entry `ask install` writes, which `ask remove` deletes while it is unchanged. */
export function template(x: Harness): NonNullable<Config["harnesses"]>[string] {
  return { ...(x.command ? { command: x.command } : {}), args: [], env: {} }
}

function turnOn(h: Home, x: Harness): number {
  enable(h, x.name, x)
  say(`Installed the ${x.name} harness`)
  ready(h, x)
  return 0
}

/** Says whether a harness can run here, and how to use it. */
function ready(h: Home, x: Harness) {
  const st = style(process.stderr)
  const s = x.status(readJSON<Config>(h.config, {}).harnesses?.[x.name] ?? {})
  if (s.ready) {
    say(`ready  ${s.detail}`)
    if (s.fix) say(st.gray(`  ${s.fix}`))
  } else {
    say(`${st.bold("not ready")}  ${s.detail}`)
    if (s.fix) say(st.gray(`  ${s.fix}`))
  }
  const first = x.models({})[0]
  say(st.gray(`  Use it with a model like ${x.name}/${first?.id ?? "MODEL"}; ask settings adds its models to yours.`))
  say(st.gray(`  To change how it runs, edit "harnesses" › "${x.name}" in ${h.config}`))
}

function installSkill(): number {
  const st = style(process.stderr)
  const paths = skill.install()
  if (!paths.length) {
    say(`${st.bold("error")}  Neither Claude Code nor Codex is set up here (no ~/.claude or ~/.codex)`)
    return 1
  }
  for (const p of paths) say(`Installed skill  ${p}`)
  return 0
}

function remote(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)/.test(source)
}

/** Fetches or finds the extension, loads it to check it, then copies it in under its own name. */
async function installExtension(h: Home, source: string): Promise<number> {
  const st = style(process.stderr)
  let scratch: string | undefined
  try {
    let dir = resolve(source)
    if (remote(source)) {
      scratch = mkdtempSync(join(tmpdir(), "ask-extension-"))
      dir = join(scratch, "repo")
      const git = spawnSync("git", ["clone", "--depth", "1", "--quiet", "--", source, dir], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
      if (git.status !== 0) {
        say(`${st.bold("error")}  git couldn't fetch ${source}: ${(git.stderr || git.error?.message || "").trim().split("\n").pop()}`)
        return 1
      }
    } else if (!statSync(dir).isDirectory()) throw new Usage(`${source} isn't a folder`)
    let ext: Extension
    try {
      ext = await load(dir)
    } catch (err) {
      say(`${st.bold("error")}  ${source} isn't an Ask extension: ${(err as Error).message}`)
      return 1
    }
    if (builtin[ext.name] || ext.name === "skill" || ext.name === "chatgpt") {
      say(`${st.bold("error")}  The extension calls itself ${ext.name}, which is Ask's own; it needs another name`)
      return 1
    }
    if (ext.harness && readJSON<Record<string, unknown>>(h.catalog, {})[ext.name]) {
      say(`${st.bold("error")}  The extension's harness is called ${ext.name}, like a provider Ask already has; it needs another name`)
      return 1
    }
    const dest = join(folder(h.root), ext.name)
    const update = existsSync(dest)
    rmSync(dest, { recursive: true, force: true })
    cpSync(dir, dest, { recursive: true, filter: (p) => !relative(dir, p).split(sep).includes(".git") })
    enable(h, ext.name, ext.harness)
    say(`${update ? "Updated" : "Installed"} ${ext.name}: ${describe(ext).replace(/^Extension: /, "")}`)
    if (ext.harness) ready(h, ext.harness)
    return 0
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}
