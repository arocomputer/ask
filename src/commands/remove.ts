// ask remove: undoes ask install. A harness or extension comes out of config.json's
// "extensions", with the models chosen from it, and its "harnesses" entry if still as ask wrote
// it; an extension's folder is deleted, and ~/.ask/extensions with it once empty. `skill`
// deletes the skill files that are still ask's.

import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { active, builtin } from "../harnesses/extensions.ts"
import { folder } from "../harnesses/harness.ts"
import { readJSON, writeJSON, type Config, type Home } from "../base/home.ts"
import * as skill from "../harnesses/skill.ts"
import { style, text } from "../base/term.ts"
import { template } from "./install.ts"
import { Usage } from "./command.ts"

export const summary = "Remove an integration"
export const about = `Turn off a harness, the agent skill or an extension that ask install turned on. Its models
leave your chosen models, and an extension's files are deleted. Your own changes to a
harness's "harnesses" entry in ~/.ask/config.json are kept.`
export const usage = "ask remove <name>"
export const examples = ["ask remove codex", "ask remove skill"]

const say = (line: string) => text(line, process.stderr)

export async function run(h: Home, argv: string[]): Promise<number> {
  const st = style(process.stderr)
  if (argv.length !== 1 || argv[0].startsWith("-")) throw new Usage(argv.length ? `unexpected argument: ${argv[1] ?? argv[0]}` : "name what to remove")
  const name = argv[0]
  if (name === "skill") {
    const paths = skill.remove()
    if (!paths.length) say("Ask's skill isn't installed")
    for (const p of paths) say(`${p.restored ? "Restored your earlier skill at" : "Removed"} ${p.path}`)
    return 0
  }
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) {
    say(`${st.bold("error")}  ${name} isn't installed; ask install lists what is`)
    return 1
  }
  const c = readJSON<Config>(h.config, {})
  const ext = (await active(h)).find((e) => e.name === name)
  const dir = join(folder(h.root), name)
  const known = builtin[name] ?? ext?.harness
  if (!c.extensions?.includes(name) && (builtin[name] || !existsSync(dir))) {
    say(`${st.bold("error")}  ${name} isn't installed; ask install lists what is`)
    return 1
  }
  c.extensions = c.extensions?.filter((n) => n !== name)
  if (!c.extensions?.length) delete c.extensions
  c.models = c.models?.filter((m) => !m.startsWith(`${name}/`))
  if (c.model?.startsWith(`${name}/`)) delete c.model
  const entry = c.harnesses?.[name]
  if (entry && known && JSON.stringify(entry) === JSON.stringify(template(known))) delete c.harnesses![name]
  if (c.harnesses && !Object.keys(c.harnesses).length) delete c.harnesses
  writeJSON(h.config, c)
  if (!builtin[name]) {
    rmSync(dir, { recursive: true, force: true })
    try {
      if (!readdirSync(folder(h.root)).length) rmdirSync(folder(h.root))
    } catch {}
  }
  say(`Removed ${name}`)
  if (!c.model) say(st.gray("  There's no default model now; ask settings sets one"))
  return 0
}
