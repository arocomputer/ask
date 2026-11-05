// ask setup: the one interactive command, in the manner of gh auth login. Asks for a provider,
// a key (hidden, checked with one tiny request) and a default model, then saves them to
// auth.json and config.json. Run it again to add a provider or change the model; or edit the
// two files, or set the provider's environment variable, instead.

import { randomUUID } from "node:crypto"
import { cheapest, connect, providers, usable, type Catalog, type Model } from "../catalog.ts"
import { catalog, credential, readJSON, writeJSON, type Auth, type Config, type Home } from "../home.ts"
import { confirm, interactive, secret, select } from "../input.ts"
import { ProviderError } from "../provider.ts"
import { spinner, style } from "../term.ts"

export const help = `Choose a model provider, paste its API key and pick a default model.

USAGE
  ask setup

Run it again to add another provider or change the model. Everything it saves is in
~/.ask/config.json and ~/.ask/auth.json, which you can also edit, and a provider's usual
environment variable, like OPENAI_API_KEY, works without setup.
`

/** The providers offered before anything is typed, in order. */
const common = ["opencode-go", "opencode", "openai", "anthropic", "openrouter", "deepseek", "xai", "mistral"]

/** Where to get a key, for the common providers. */
const keyPages: Record<string, string> = {
  "opencode-go": "https://opencode.ai/console",
  opencode: "https://opencode.ai/console",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  openrouter: "https://openrouter.ai/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai",
  mistral: "https://console.mistral.ai/api-keys",
}

/** The model to suggest first, for providers people start with. */
const suggested: Record<string, string> = { "opencode-go": "glm-5.3", opencode: "gpt-5.5", openai: "gpt-5.5" }

export async function run(h: Home): Promise<number> {
  const st = style(process.stderr)
  if (!interactive()) {
    process.stderr.write(`${st.red("X")} ask setup needs a terminal\n${st.gray("  Instead, set the provider's key variable, like OPENAI_API_KEY, and put {\"model\": \"openai/gpt-5.5\"} in ~/.ask/config.json")}\n`)
    return 2
  }
  const spin = spinner("Loading models from models.dev")
  const c = await catalog(h).finally(() => spin.stop())
  const provider = await pickProvider(h, c)
  const name = c[provider].name
  const base = readJSON<Auth>(h.auth, {})[provider]?.base_url

  const saved = credential(h, provider, c[provider].env ?? [])
  if (!(saved && (await confirm(`Use the ${name} key from your ${saved.source}?`)))) {
    if (keyPages[provider]) process.stderr.write(st.gray(`  Get a key at ${keyPages[provider]}\n`))
    const probe = cheapest(c, provider)!
    for (let tries = 3; ; tries--) {
      const key = await secret(`Paste your ${name} API key`)
      const sp = spinner("Checking the key")
      const problem = key ? await check(probe, key, base) : "no key given"
      sp.stop()
      if (!problem) {
        const auth = readJSON<Auth>(h.auth, {})
        auth[provider] = { ...auth[provider], api_key: key }
        writeJSON(h.auth, auth)
        process.stderr.write(`${st.green("✓")} Logged in to ${name}\n`)
        break
      }
      process.stderr.write(`${st.red("X")} ${problem}\n`)
      if (tries === 1) return 1
    }
  }

  const model = await pickModel(h, c, provider)
  writeJSON(h.config, { ...readJSON<Config>(h.config, {}), model: `${provider}/${model.id}` })
  process.stderr.write(`${st.green("✓")} Default model is ${st.bold(`${provider}/${model.id}`)}\n`)
  process.stderr.write(st.gray(`  Saved in ${h.config}\n`))
  return 0
}

/** Common providers first, with a saved key marked; typing searches all of them. */
function pickProvider(h: Home, c: Catalog): Promise<string> {
  const all = providers(c).map((p) => ({ label: p.name, hint: credential(h, p.id, p.env) ? "key saved" : p.id, value: p.id }))
  const shortlist = common.map((id) => all.find((o) => o.value === id)).filter((o) => o !== undefined)
  return select("Which provider?", all, { shortlist })
}

/** The current or suggested model first; typing searches the provider's models. */
function pickModel(h: Home, c: Catalog, provider: string): Promise<Model> {
  const models = usable(c, provider)
  const current = readJSON<Config>(h.config, {}).model
  const first = current?.startsWith(provider + "/") ? current.slice(provider.length + 1) : suggested[provider]
  const options = models.map((m) => ({ label: m.name, hint: m.id === first ? (current?.endsWith(m.id) ? "current" : "suggested") : m.id, value: m }))
  const start = Math.max(0, models.findIndex((m) => m.id === first))
  return select("Default model?", options, { filterable: true, start })
}

/** Sends one tiny request; resolves to what went wrong, or undefined when the key works. */
async function check(model: Model, key: string, baseURL?: string): Promise<string | undefined> {
  try {
    await connect(model, key, baseURL).complete({
      model: model.id,
      instructions: "",
      messages: [{ role: "user", text: "Reply with just: ok" }],
      tools: [],
      maxOutput: 16,
      session: `ask-setup-${randomUUID()}`,
      signal: AbortSignal.timeout(60_000),
    })
    return undefined
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) return `The key was refused: ${err.message}`
    return `The check failed: ${(err as Error).message}`
  }
}
