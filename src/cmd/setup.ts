// ask setup: pick a provider, paste its key, pick a default model. Interactive only; the same
// steps are ask auth login and ask config set model for scripts.

import { usable } from "../catalog.ts"
import { catalog, credential, readJSON, writeJSON, type Auth, type Config, type Home } from "../home.ts"
import { confirm, interactive, select } from "../input.ts"
import { count, spinner, style } from "../term.ts"
import { check, login, pick } from "./auth.ts"
import { Usage } from "./common.ts"

export const help = `Set ask up: choose a model provider, paste its API key and pick a default model.

USAGE
  ask setup

In a script, do the same with:
  printf %s "$KEY" | ask auth login <provider>
  ask config set model <provider>/<model>
`

/** Models to suggest first for the providers people start with. */
const suggested: Record<string, string> = { "opencode-go": "glm-5.3", opencode: "gpt-5.5", openai: "gpt-5.5" }

export async function run(h: Home): Promise<number> {
  if (!interactive()) throw new Usage("ask setup needs a terminal", 'printf %s "$KEY" | ask auth login PROVIDER, then ask config set model PROVIDER/MODEL')
  const st = style(process.stderr)
  const spin = spinner("Loading the model catalog from models.dev")
  const c = await catalog(h).finally(() => spin.stop())
  const cfg = readJSON<Config>(h.config, {})
  if (cfg.model && !(await confirm(`ask uses ${cfg.model}. Set up something else?`, false))) return 0

  const provider = await pick(h, c, "Which provider?")
  const name = c[provider].name
  const models = usable(c, provider)
  const start = Math.max(0, models.findIndex((m) => m.id === (cfg.model?.startsWith(provider + "/") ? cfg.model.slice(provider.length + 1) : suggested[provider])))
  const model = await select(
    "Default model?",
    models.map((m) => ({ label: m.name, hint: `${m.id}${m.context ? ` · ${count(m.context)} context` : ""}${m.reasoning ? " · reasoning" : ""}`, value: m })),
    { filterable: true, start },
  )

  const existing = credential(h, provider, c[provider].env ?? [])
  let keyed = false
  if (existing && (await confirm(`Use the ${name} key from your ${existing.source}?`))) {
    const sp = spinner(`Checking the key with ${provider}/${model.id}`)
    const problem = await check(model, existing.key, readJSON<Auth>(h.auth, {})[provider]?.base_url)
    sp.stop()
    if (!problem) {
      process.stderr.write(`${st.green("✓")} The key works\n`)
      keyed = true
    } else process.stderr.write(`${st.red("X")} ${name} refused it: ${problem}\n`)
  }
  if (!keyed) {
    if (c[provider].doc) process.stderr.write(st.gray(`  Find your key through ${c[provider].doc}\n`))
    await login(h, c, provider, model)
  }

  writeJSON(h.config, { ...readJSON<Config>(h.config, {}), model: `${provider}/${model.id}` })
  process.stderr.write(`${st.green("✓")} Default model set to ${st.bold(`${provider}/${model.id}`)}\n\n`)
  process.stderr.write(`Try it: ${st.bold('ask --wait "What does this project do?"')}\n`)
  return 0
}
