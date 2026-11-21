// ask models: the models ask can use, from the model catalog.

import { parseArgs } from "node:util"
import { providers, usable } from "../providers/catalog.ts"
import { readJSON, type Config, type Home } from "../base/home.ts"
import { catalog, credential } from "../sessions/models.ts"
import { count, heading, style, table, text } from "../base/term.ts"

export const summary = "Available models"
export const about = `List your models: those chosen in ask settings, or else every model of the providers ask
has a key for. Name a provider to list all of its models; any of them works in a request.`
export const usage = "ask models [<provider>] [flags]"
export const flags: [string, string][] = [["--refresh", "Fetch the model catalog again now"]]
export const examples = ["ask models", "ask models openrouter"]

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { refresh: { type: "boolean" } } })
  const c = await catalog(h, !!v.refresh)
  const unknown = positionals.find((id) => !c[id])
  if (unknown) throw new Error(`no provider named ${JSON.stringify(unknown)} in the model catalog`)
  const cfg = readJSON<Config>(h.config, {})
  const keyed = providers(c).filter((p) => credential(h, p.id, p.env)).map((p) => p.id)
  let list = positionals.flatMap((id) => usable(c, id))
  if (!positionals.length) {
    list = keyed.flatMap((id) => usable(c, id))
    if (cfg.models?.length) list = list.filter((m) => cfg.models!.includes(`${m.provider}/${m.id}`))
  }
  if (!list.length) {
    const message = positionals.length
      ? "No supported models found for the requested providers.\nRefresh the catalog with ask models --refresh."
      : !keyed.length
        ? "No providers connected.\nOpen ask settings and choose Connect a provider."
        : cfg.models?.length
          ? "None of your selected models are available from connected providers.\nReview Models and connected providers in ask settings."
          : "No supported models found for your connected providers.\nRefresh the catalog with ask models --refresh."
    text(message, process.stderr)
    return 1
  }
  const st = style()
  heading("models")
  table(
    list.map((m) => {
      const name = `${m.provider}/${m.id}`
      const context = m.context ? count(m.context) : ""
      const mark = name === cfg.model ? "default" : ""
      return [
        [name, name === cfg.model ? st.bold(name) : name],
        [m.name, m.name],
        [context, st.gray(context)],
        [mark, st.gray(mark)],
      ]
    }),
    { header: ["Model", "Name", "Context", ""], flex: 1 },
  )
  return 0
}
