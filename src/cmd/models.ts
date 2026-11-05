// ask models: the models ask can use, from the models.dev catalog.

import { parseArgs } from "node:util"
import { providers, usable } from "../catalog.ts"
import { catalog, credential, readJSON, type Config, type Home } from "../home.ts"
import { count, style, table } from "../term.ts"
import { Usage } from "./common.ts"

export const help = `List the models ask can use: by default those of providers you have keys for.

USAGE
  ask models [provider] [flags]

FLAGS
      --refresh   Fetch the catalog from models.dev now
      --json      Print them as JSON

EXAMPLES
  $ ask models
  $ ask models openrouter
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { refresh: { type: "boolean" }, json: { type: "boolean" } } })
  const c = await catalog(h, !!v.refresh)
  let ids = positionals
  if (ids.length) {
    for (const id of ids) if (!c[id]) throw new Usage(`no provider ${id} in the catalog`, "ask auth login lists them")
  } else {
    ids = providers(c).filter((p) => credential(h, p.id, p.env)).map((p) => p.id)
    if (!ids.length) throw new Usage("no provider has a key yet", "ask setup")
  }
  const models = ids.flatMap((id) => usable(c, id))
  if (v.json) {
    process.stdout.write(JSON.stringify(models.map((m) => ({ model: `${m.provider}/${m.id}`, name: m.name, context: m.context, reasoning: m.reasoning })), null, 2) + "\n")
    return 0
  }
  const st = style()
  const chosen = readJSON<Config>(h.config, {}).model
  table(
    models.map((m) => {
      const name = `${m.provider}/${m.id}`
      const mark = name === chosen ? "default" : ""
      return [
        [name, name === chosen ? st.bold(st.cyan(name)) : st.cyan(name)],
        [m.name, m.name],
        [m.context ? count(m.context) : "", st.gray(m.context ? count(m.context) : "")],
        [mark, st.green(mark)],
      ]
    }),
    { header: ["MODEL", "NAME", "CONTEXT", ""], flex: 1 },
  )
  return 0
}
