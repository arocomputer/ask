// ask settings: the one interactive command. The first time, it walks through adding a
// provider, choosing its models and a default. After that it opens a menu: default model,
// models, providers (add, change key, remove) and timeout. Everything it saves is in
// config.json and auth.json, which can also be edited by hand.

import { randomUUID } from "node:crypto"
import { cheapest, connect, providers, usable, type Catalog, type Model } from "../catalog.ts"
import { catalog, credential, readJSON, writeJSON, type Auth, type Config, type Home } from "../home.ts"
import { confirm, interactive, pick, secret, text } from "../input.ts"
import { ProviderError } from "../provider.ts"
import { spinner, style } from "../term.ts"

export const help = `Set ask up: the providers it can use, their keys, your models and the default.

USAGE
  ask settings

The first run adds a provider. After that it opens a menu. Everything is saved in
~/.ask/config.json and ~/.ask/auth.json, which you can also edit; a provider's usual
environment variable, like OPENAI_API_KEY, works too.
`

/** The providers listed first, in order. */
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

/** Models chosen for a new provider before the user changes anything. */
const suggested: Record<string, string[]> = {
  "opencode-go": ["glm-5.3", "kimi-k3", "minimax-m3"],
  opencode: ["gpt-5.5"],
  openai: ["gpt-5.5"],
}

const st = () => style(process.stderr)
const say = (line: string) => process.stderr.write(line + "\n")
const config = (h: Home) => readJSON<Config>(h.config, {})
const update = (h: Home, change: (c: Config) => void) => {
  const c = config(h)
  change(c)
  writeJSON(h.config, c)
}

export async function run(h: Home): Promise<number> {
  if (!interactive()) {
    say(`${st().red("X")} ask settings needs a terminal`)
    say(st().gray(`  Instead, set the provider's key variable, like OPENAI_API_KEY, and put {"model": "openai/gpt-5.5"} in ${h.config}`))
    return 2
  }
  const spin = spinner("Loading models from models.dev")
  const c = await catalog(h).finally(() => spin.stop())
  if (!keyed(h, c).length) {
    say(st().bold("Welcome to ask.") + " Add a model provider to start.\n")
    if (!(await addProvider(h, c))) return 1
  }
  for (;;) {
    const cfg = config(h)
    const names = keyed(h, c).map((p) => c[p].name)
    const choice = await pick({
      title: "Settings",
      search: false,
      items: [
        { label: "Default model", hint: cfg.model ?? "not set", value: "default" },
        { label: "Models", hint: cfg.models?.length ? `${cfg.models.length} chosen` : "none chosen", value: "models" },
        { label: "Providers", hint: names.join(", ") || "none", value: "providers" },
        { label: "Timeout", hint: `${cfg.timeout ?? 900}s per task`, value: "timeout" },
        { label: "Done", value: "done" },
      ],
    })
    if (!choice || choice === "done") return 0
    if (choice === "default") await chooseDefault(h, c)
    if (choice === "models") {
      const ids = keyed(h, c)
      const p = ids.length === 1 ? ids[0] : await pick({ title: "Models from which provider?", search: false, items: ids.map((id) => ({ label: c[id].name, value: id })) })
      if (p) await chooseModels(h, c, p)
    }
    if (choice === "providers") await providersMenu(h, c)
    if (choice === "timeout") {
      const v = await text("Seconds before a task is stopped:", String(cfg.timeout ?? 900))
      if (v !== undefined) {
        const n = Number(v)
        if (n > 0) {
          update(h, (x) => (x.timeout = n))
          say(`${st().green("✓")} Timeout is ${n}s`)
        } else say(`${st().red("X")} The timeout is a number of seconds, like 900`)
      }
    }
  }
}

/** Providers ask has a key for, pasted or in the environment. */
function keyed(h: Home, c: Catalog): string[] {
  return providers(c)
    .filter((p) => credential(h, p.id, p.env))
    .map((p) => p.id)
}

async function providersMenu(h: Home, c: Catalog) {
  for (;;) {
    const ids = keyed(h, c)
    const choice = await pick({
      title: "Providers",
      search: false,
      items: [{ label: "Add a provider", value: "" }, ...ids.map((id) => ({ label: c[id].name, hint: credential(h, id, c[id].env ?? [])!.source, value: id }))],
    })
    if (choice === undefined) return
    if (choice === "") {
      await addProvider(h, c)
      continue
    }
    const pasted = !!readJSON<Auth>(h.auth, {})[choice]?.api_key
    const action = await pick({
      title: c[choice].name,
      search: false,
      items: [
        { label: "Choose models", value: "models" },
        { label: "Change key", value: "key" },
        ...(pasted ? [{ label: "Remove", hint: "forget its key and models", value: "remove" }] : []),
      ],
    })
    if (action === "models") await chooseModels(h, c, choice)
    if (action === "key") await paste(h, c, choice)
    if (action === "remove" && (await confirm(`Remove ${c[choice].name}?`, false))) {
      const auth = readJSON<Auth>(h.auth, {})
      delete auth[choice]
      writeJSON(h.auth, auth)
      update(h, (x) => {
        x.models = x.models?.filter((m) => !m.startsWith(choice + "/"))
        if (x.model?.startsWith(choice + "/")) delete x.model
      })
      say(`${st().green("✓")} Removed ${c[choice].name}`)
      if (!config(h).model && config(h).models?.length) await chooseDefault(h, c)
    }
  }
}

/** Picks a provider, takes its key, then its models and, if none is set, the default. */
async function addProvider(h: Home, c: Catalog): Promise<boolean> {
  const all = providers(c)
  const rank = (id: string) => (common.includes(id) ? common.indexOf(id) : common.length)
  const items = [...all]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    .map((p) => ({ label: p.name, hint: credential(h, p.id, p.env) ? "key saved" : `${p.models} models`, value: p.id }))
  const provider = await pick({ title: "Providers", items })
  if (!provider) return false
  const env = credential(h, provider, c[provider].env ?? [])
  if (!(env && (await confirm(`Use the ${c[provider].name} key from ${env.source}?`)))) if (!(await paste(h, c, provider))) return false
  await chooseModels(h, c, provider)
  if (!config(h).model) await chooseDefault(h, c)
  return true
}

/** Takes a key, checks it, saves it. Three tries; false if none worked or the user went back. */
async function paste(h: Home, c: Catalog, provider: string): Promise<boolean> {
  const name = c[provider].name
  if (keyPages[provider]) say(st().gray(`Get a key at ${keyPages[provider]}`))
  for (let tries = 3; tries > 0; tries--) {
    const key = await secret(`${name} API key:`)
    if (!key) return false
    const sp = spinner("Checking the key")
    const problem = await check(cheapest(c, provider)!, key, readJSON<Auth>(h.auth, {})[provider]?.base_url)
    sp.stop()
    if (!problem) {
      const auth = readJSON<Auth>(h.auth, {})
      auth[provider] = { ...auth[provider], api_key: key }
      writeJSON(h.auth, auth)
      say(`${st().green("✓")} Saved the ${name} key`)
      return true
    }
    say(`${st().red("X")} ${problem}`)
  }
  return false
}

/** Toggles which of a provider's models are chosen, then saves. */
async function chooseModels(h: Home, c: Catalog, provider: string) {
  const models = usable(c, provider)
  const cfg = config(h)
  const mine = (cfg.models ?? []).filter((m) => m.startsWith(provider + "/")).map((m) => m.slice(provider.length + 1))
  const start = mine.length ? mine : (suggested[provider] ?? []).filter((id) => models.some((m) => m.id === id))
  const ordered = [...models.filter((m) => start.includes(m.id)), ...models.filter((m) => !start.includes(m.id))]
  const chosen = await pick({
    title: `${c[provider].name} models`,
    items: ordered.map((m) => ({ label: m.name, hint: m.id, value: m.id })),
    multi: true,
    chosen: start,
  })
  if (!chosen) return
  update(h, (x) => {
    x.models = [...(x.models ?? []).filter((m) => !m.startsWith(provider + "/")), ...chosen.map((id) => `${provider}/${id}`)]
    if (x.model?.startsWith(provider + "/") && !x.models.includes(x.model)) delete x.model
  })
  say(`${st().green("✓")} ${chosen.length} ${c[provider].name} model${chosen.length === 1 ? "" : "s"} chosen`)
  if (!config(h).model && config(h).models?.length) await chooseDefault(h, c)
}

/** Picks the default from the chosen models, or from every keyed provider's when none are chosen. */
async function chooseDefault(h: Home, c: Catalog) {
  const cfg = config(h)
  const names = cfg.models?.length ? cfg.models : keyed(h, c).flatMap((p) => usable(c, p).map((m) => `${p}/${m.id}`))
  const label = (name: string) => {
    const [p, ...rest] = name.split("/")
    return c[p]?.models[rest.join("/")]?.name ?? name
  }
  const model = await pick({
    title: "Default model",
    items: names.map((n) => ({ label: label(n), hint: n === cfg.model ? `${n} · current` : n, value: n })),
    start: Math.max(0, cfg.model ? names.indexOf(cfg.model) : names.findIndex((n) => suggested[n.split("/")[0]]?.[0] === n.slice(n.indexOf("/") + 1))),
  })
  if (!model) return
  update(h, (x) => (x.model = model))
  say(`${st().green("✓")} Default model is ${st().bold(model)}`)
}

/** Sends one tiny request; resolves to what went wrong, or undefined when the key works. */
export async function check(model: Model, key: string, baseURL?: string): Promise<string | undefined> {
  try {
    await connect(model, key, baseURL).complete({
      model: model.id,
      instructions: "",
      messages: [{ role: "user", text: "Reply with just: ok" }],
      tools: [],
      maxOutput: 16,
      session: `ask-check-${randomUUID()}`,
      signal: AbortSignal.timeout(60_000),
    })
    return undefined
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) return `The key was refused: ${err.message}`
    return `The check failed: ${(err as Error).message}`
  }
}
