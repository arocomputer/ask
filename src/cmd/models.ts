// ask models: the models ask can use, from the models.dev catalog.

import { parseArgs } from "node:util"
import { providers, usable } from "../catalog.ts"
import { catalog, credential, readJSON, type Config, type Home } from "../home.ts"
import { count, style, table } from "../term.ts"

export const help = `List your models: those chosen in ask settings, else every model of the providers you have
keys for. Name a provider to see all of its models; any of them works in a request.

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
  const cfg = readJSON<Config>(h.config, {})
  let list = ids.flatMap((id) => usable(c, id))
  if (!ids.length) {
    const keyed = providers(c).filter((p) => credential(h, p.id, p.env)).map((p) => p.id)
    list = keyed.flatMap((id) => usable(c, id))
    if (cfg.models?.length) list = list.filter((m) => cfg.models!.includes(`${m.provider}/${m.id}`))
  }
  if (!list.length) {
    process.stderr.write(`No models yet. Run ${st.bold("ask settings")}, or name a provider: ${st.bold("ask models openai")}\n`)
    return 1
  }
  const out = style()
  const current = cfg.model
  table(
    list.map((m) => {
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
