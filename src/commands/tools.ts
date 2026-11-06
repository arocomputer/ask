// ask tools: the tools ask's own loop gives a subagent, where each comes from, and turning
// one off or on. A tool is off when config.json's "tools" sets it to false. An extension's tool
// with a built-in's name replaces it. Claude Code and Codex use their own tools, not these.

import { readJSON, writeJSON, type Config, type Home } from "../base/home.ts"
import { style, table } from "../base/term.ts"
import { search } from "../agent/search.ts"
import { tools as builtIn, type Tool } from "../agent/tools.ts"
import { active } from "../harnesses/extensions.ts"
import { Usage } from "./command.ts"

export const summary = "List, turn off or turn on a subagent's tools"
export const about = `List the tools ask's own loop gives a subagent: where each comes from, whether read-only tasks
get it, and whether it is on. Turn one off, or back on, by name.

An extension's tool with a built-in's name replaces the built-in; ask install adds extensions.
Claude Code and Codex use their own tools, not these.`
export const usage = "ask tools [off <name> | on <name>]"
export const examples = ["ask tools", "ask tools off shell", "ask tools on shell"]

type Row = { name: string; from: string; tasks: string; on: boolean }

/** Every tool, built-in or added, as a turn would get it before any are turned off. */
async function rows(h: Home): Promise<Row[]> {
  const off = readJSON<Config>(h.config, {}).tools ?? {}
  const out = new Map<string, Row>()
  const kind = (t: Tool) => (t.readonly ? "every task" : "write tasks")
  const write = builtIn(true).filter((t) => !t.readonly)
  for (const t of [...builtIn(false), search(), ...write]) out.set(t.name, { name: t.name, from: "built-in", tasks: kind(t), on: off[t.name] !== false })
  for (const e of await active(h))
    for (const t of e.tools ?? [])
      out.set(t.name, { name: t.name, from: out.has(t.name) ? `${e.name}, replacing the built-in` : e.name, tasks: kind(t), on: off[t.name] !== false })
  return [...out.values()]
}

export async function run(h: Home, argv: string[]): Promise<number> {
  const [verb, name, ...rest] = argv
  if (rest.length) throw new Usage(`unexpected argument: ${rest[0]}`)
  const all = await rows(h)
  if (!verb) {
    const st = style()
    table(
      all.map((r) => [[r.name, r.name], [r.from, st.gray(r.from)], [r.tasks, r.tasks], [r.on ? "on" : "off", r.on ? st.green("on") : st.yellow("off")]]),
      { header: ["TOOL", "FROM", "TASKS", "STATUS"], flex: 1 },
    )
    return 0
  }
  if (verb !== "off" && verb !== "on") throw new Usage(`unknown action: ${verb}`)
  if (!name) throw new Usage(`name the tool to turn ${verb}`)
  if (!all.some((r) => r.name === name)) {
    process.stderr.write(`no tool named ${name}; the tools are ${all.map((r) => r.name).join(", ")}\n`)
    return 1
  }
  const c = readJSON<Config>(h.config, {})
  const tools = { ...c.tools }
  if (verb === "off") tools[name] = false
  else delete tools[name]
  if (Object.keys(tools).length) c.tools = tools
  else delete c.tools
  writeJSON(h.config, c)
  process.stderr.write(`${style(process.stderr).green("✓")} Turned ${name} ${verb}\n`)
  return 0
}
