// ask models: the models ask can use, from the models.dev catalog.

import { parseArgs } from "node:util"
import { providers, usable } from "../catalog.ts"
import { catalog, credential, readJSON, type Config, type Home } from "../home.ts"
import { count, style, table } from "../term.ts"

export const help = `List the models ask can use: by default, those of the providers you have keys for.

USAGE
  ask models [provider] [--refresh]

FLAGS
  --refresh   Fetch the catalog from models.dev now

EXAMPLES
  $ ask models
  $ ask models openrouter
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { refresh: { type: "boolean" } } })
  const st = style(process.stderr)
  const c = await catalog(h, !!v.refresh)
  let ids = positionals
  const unknown = ids.find((id) => !c[id])
  if (unknown) {
    process.stderr.write(`${st.red("X")} No provider ${unknown} in the catalog\n`)
    return 2
  }
  if (!ids.length) ids = providers(c).filter((p) => credential(h, p.id, p.env)).map((p) => p.id)
  if (!ids.length) {
    process.stderr.write(`No provider has a key yet. Run ${st.bold("ask setup")}, or name one: ${st.bold("ask models openai")}\n`)
    return 1
  }
  const out = style()
  const current = readJSON<Config>(h.config, {}).model
  table(
    ids.flatMap((id) => usable(c, id)).map((m) => {
      const name = `${m.provider}/${m.id}`
      const context = m.context ? count(m.context) : ""
      return [
        [name, name === current ? out.bold(name) : name],
        [m.name, m.name],
        [context, out.gray(context)],
        [name === current ? "default" : "", out.gray(name === current ? "default" : "")],
      ]
    }),
    { header: ["MODEL", "NAME", "CONTEXT", ""], flex: 1 },
  )
  return 0
}
