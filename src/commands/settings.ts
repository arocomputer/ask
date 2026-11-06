// ask settings: the one interactive command. Until there is a default model, it adds a provider: its key or,
// for ChatGPT, a sign-in, then its models and the default. After that it asks what to change,
// does that and exits. Everything is saved in config.json and auth.json, which can also be
// edited by hand.

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cheapest, connect, harnessMarker, providers, usable, type Catalog, type Model } from "../providers/catalog.ts"
import { readJSON, writeJSON, type Auth, type Config, type Home } from "../base/home.ts"
import { catalog, credential } from "../sessions/models.ts"
import { account, begin, remote, signOut, signedIn, usagePage } from "../providers/chatgpt.ts"
import { harness, settings } from "../harnesses/extensions.ts"
import { confirm, input, interactive, line, multi, secret, select } from "../base/input.ts"
import { ProviderError, type Key } from "../providers/stream.ts"
import { spinner, style } from "../base/term.ts"

export const summary = "Choose providers, keys, models and the default"
export const about = `Choose the providers ask uses, their keys, your models and the default model. The first run
adds a provider; after that it asks what to change.

Everything is saved in ~/.ask/config.json and ~/.ask/auth.json, which you can also edit. A
provider's own key variable, like OPENAI_API_KEY, works without settings.`
export const usage = "ask settings"

/** The providers listed first, in order. */
const common = ["opencode-go", "opencode", "openai", "anthropic", "openrouter", "deepseek", "xai", "mistral"]

/**
 * Where to get a key for the common providers: the page, where on it when that isn't obvious,
 * and how the key starts. Other providers get the catalog's documentation link.
 */
const keyPages: Record<string, { page: string; where?: string; prefix?: string }> = {
  "opencode-go": { page: "https://opencode.ai/console", where: "Account › Personal API keys, in a workspace with Go", prefix: "oc_sk_" },
  opencode: { page: "https://opencode.ai/console", where: "Account › Personal API keys", prefix: "oc_sk_" },
  openai: { page: "https://platform.openai.com/api-keys", where: "Create new secret key", prefix: "sk-" },
  anthropic: { page: "https://platform.claude.com/settings/keys", where: "Create Key", prefix: "sk-ant-" },
  openrouter: { page: "https://openrouter.ai/settings/keys", where: "Create API Key", prefix: "sk-or-" },
  deepseek: { page: "https://platform.deepseek.com/api_keys", where: "Create new API key", prefix: "sk-" },
  xai: { page: "https://console.x.ai", where: "API Keys › Create API Key", prefix: "xai-" },
  mistral: { page: "https://console.mistral.ai/api-keys", where: "Create new key" },
  groq: { page: "https://console.groq.com/keys", where: "Create API Key", prefix: "gsk_" },
  togetherai: { page: "https://api.together.ai/settings/api-keys", where: "Create API key" },
  "fireworks-ai": { page: "https://app.fireworks.ai/account/api-keys", where: "Create API key", prefix: "fw_" },
  cerebras: { page: "https://cloud.cerebras.ai", where: "API Keys in the sidebar", prefix: "csk-" },
  zai: { page: "https://z.ai/manage-apikey/apikey-list", where: "Add new API key" },
  moonshotai: { page: "https://platform.kimi.ai/console/api-keys", where: "Create API Key", prefix: "sk-" },
  deepinfra: { page: "https://deepinfra.com/dash/api_keys", where: "New API key" },
}

/** Models chosen for a new provider before the user changes anything. */
const suggested: Record<string, string[]> = {
  claude: ["sonnet"],
  codex: ["default"],
  "opencode-go": ["glm-5.3", "kimi-k3", "minimax-m3"],
  opencode: ["gpt-5.5"],
  openai: ["gpt-5.5"],
}

const say = (line: string) => process.stderr.write(line + "\n")
const config = (h: Home) => readJSON<Config>(h.config, {})
const update = (h: Home, change: (c: Config) => void) => {
  const c = config(h)
  change(c)
  writeJSON(h.config, c)
}

export async function run(h: Home): Promise<number> {
  const st = style(process.stderr)
  if (!interactive()) {
    say("ask settings needs a terminal")
    say(`Instead, set the provider's key variable, like OPENAI_API_KEY, and put {"model": "openai/gpt-5.5"} in ${h.config}`)
    return 2
  }
  const spin = spinner("Loading models from models.dev")
  const c = await catalog(h).finally(() => spin.stop())
  if (!config(h).model) return (await addProvider(h, c)) ? 0 : 1

  const cfg = config(h)
  const removable = keyed(h, c).filter((p) => readJSON<Auth>(h.auth, {})[p]?.api_key || (p === "chatgpt" && signedIn(h)))
  const choice = await select("What do you want to change?", [
    { label: "Default model", hint: cfg.model ?? "not set", value: "default" },
    { label: "Models", hint: cfg.models?.length ? `${cfg.models.length} chosen` : "none chosen", value: "models" },
    { label: "Add a provider", value: "add" },
    ...(removable.length ? [{ label: "Remove a provider", value: "remove" }] : []),
    { label: "Timeout", hint: `${cfg.timeout ?? 900}s`, value: "timeout" },
  ])
  if (choice === "default") await chooseDefault(h, c)
  if (choice === "models") {
    const ids = keyed(h, c)
    const p = ids.length === 1 ? ids[0] : await select("Which provider's models?", ids.map((id) => ({ label: c[id].name, value: id })))
    await chooseModels(h, c, p)
  }
  if (choice === "add") return (await addProvider(h, c)) ? 0 : 1
  if (choice === "remove") await removeProvider(h, c, removable)
  if (choice === "timeout") {
    const n = Number(await input("Seconds before a task is stopped:", String(cfg.timeout ?? 900)))
    if (!(n > 0)) {
      say(`${st.red("X")} The timeout is a number of seconds, like 900`)
      return 1
    }
    update(h, (x) => (x.timeout = n))
    say(`${st.green("✓")} Timeout set to ${n}s`)
  }
  return 0
}

/** Providers ask has a key for, pasted or in the environment. */
function keyed(h: Home, c: Catalog): string[] {
  return providers(c)
    .filter((p) => credential(h, p.id, p.env))
    .map((p) => p.id)
}

/** Picks a provider, takes its key, then its models and, if none is set, the default. */
async function addProvider(h: Home, c: Catalog): Promise<boolean> {
  const rank = (id: string) => (common.includes(id) ? common.indexOf(id) : common.length)
  const items = providers(c)
    .filter((p) => p.id !== "chatgpt" && c[p.id].npm !== harnessMarker)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    .map((p) => ({ label: p.name, hint: credential(h, p.id, p.env) ? "key saved" : undefined, value: p.id }))
  const chatgpt = { label: "ChatGPT", hint: signedIn(h) ? "signed in" : "Continue with ChatGPT, on your Plus or Pro plan", value: "chatgpt" }
  const harnesses = providers(c)
    .filter((p) => c[p.id].npm === harnessMarker)
    .map((p) => ({ label: p.name, hint: "installed, signs in its own way", value: p.id }))
  const provider = await select("Which provider?", [chatgpt, ...harnesses, ...items])
  if (c[provider]?.npm === harnessMarker) {
    const st = style(process.stderr)
    const x = await harness(h, provider)
    const s = x?.status(settings(h, provider)) ?? { ready: false, detail: `${provider} isn't available` }
    if (!s.ready) {
      say(`${st.yellow("!")} ${s.detail}${s.fix ? `: ${s.fix}` : ""}. Then run ask settings again.`)
      return false
    }
    say(`${st.green("✓")} ${s.detail}`)
    await chooseModels(h, c, provider)
    if (!config(h).model) await chooseDefault(h, c)
    return true
  }
  if (provider === "chatgpt") {
    if (!(await signIn(h))) return false
    const fresh = await catalog(h, true)
    if (!fresh.chatgpt) {
      say(`${style(process.stderr).red("X")} ChatGPT listed no models for this account`)
      return false
    }
    await chooseModels(h, fresh, "chatgpt")
    if (!config(h).model) await chooseDefault(h, fresh)
    return true
  }
  const env = credential(h, provider, c[provider].env ?? [])
  const reuse = env && (await confirm(`Use the ${c[provider].name} key from ${env.source}?`))
  if (!reuse && !(await paste(h, c, provider))) return false
  await chooseModels(h, c, provider)
  if (!config(h).model) await chooseDefault(h, c)
  return true
}

/**
 * Signs in with ChatGPT. It waits for the browser's return to ask's 127.0.0.1 callback and, at
 * the same time, for the address the browser landed on to be pasted, so signing in works from
 * another device too. A browser is opened only when ask runs at the screen the user sees.
 */
async function signIn(h: Home): Promise<boolean> {
  const st = style(process.stderr)
  const first = !account(h)
  for (let tries = 2; tries > 0; tries--) {
    const attempt = await begin(h)
    try {
      const away = remote()
      if (away || !open(attempt.url)) {
        say(`${st.yellow("!")} Open this link on any device to sign in with ChatGPT:`)
        say(attempt.url)
        say(st.gray("  After you approve, your browser lands on a page that won't load. Copy that page's address and paste it here."))
      } else {
        say(`${st.yellow("!")} Your browser is opening to sign in with ChatGPT. If it doesn't, open:`)
        say(attempt.url)
      }
      const stop = new AbortController()
      const back = attempt.callback.then((address) => (stop.abort(), address))
      const pasted = line("Paste callback URL:", stop.signal, "finished in the browser")
      const address = (await Promise.race([back, pasted.then((v) => v ?? back)])) as string
      const sp = spinner("Signing in")
      try {
        const a = await attempt.finish(address)
        sp.stop()
        if (!a.scopes?.includes("chatgpt.tokens.use.direct")) {
          say(`${st.red("X")} Signed in, but ChatGPT plan use wasn't allowed, so ask can't use your plan`)
          say(st.gray("  Run ask settings again to allow it, or use a provider with an API key"))
          return false
        }
        say(`${st.green("✓")} Signed in to ChatGPT${a.email ? ` as ${a.email}` : ""}`)
        if (first) say(`${st.yellow("!")} You're using your ChatGPT plan. Manage how much ask may use at ${usagePage}`)
        return true
      } catch (err) {
        sp.stop()
        say(`${st.red("X")} ${(err as Error).message}`)
      }
    } finally {
      attempt.close()
    }
  }
  return false
}

/** Opens a link in the default browser; false when there is no way to. */
function open(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined
  if (!command) return false
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref()
    return true
  } catch {
    return false
  }
}

/** Takes a key, checks it, saves it. Three tries. */
async function paste(h: Home, c: Catalog, provider: string): Promise<boolean> {
  const st = style(process.stderr)
  const name = c[provider].name
  const k = keyPages[provider]
  if (k) {
    say(`${st.yellow("!")} Get a key at ${k.page}${k.where ? `, under ${k.where}` : ""}`)
    if (k.prefix) say(st.gray(`  It starts with ${k.prefix}`))
  } else {
    const doc = c[provider].doc
    say(`${st.yellow("!")} Get a key from your ${name} account${doc ? `; its docs: ${doc}` : ""}`)
  }
  for (let tries = 3; tries > 0; tries--) {
    const key = await secret(`Paste your ${name} API key:`)
    if (!key) continue
    const sp = spinner("Checking the key")
    const problem = await check(cheapest(c, provider)!, key, readJSON<Auth>(h.auth, {})[provider]?.base_url)
    sp.stop()
    if (!problem) {
      const auth = readJSON<Auth>(h.auth, {})
      auth[provider] = { ...auth[provider], api_key: key }
      writeJSON(h.auth, auth)
      say(`${st.green("✓")} Logged in to ${name}`)
      return true
    }
    say(`${st.red("X")} ${problem}`)
  }
  return false
}

/** Asks which of a provider's models to use, and saves the choice. */
async function chooseModels(h: Home, c: Catalog, provider: string) {
  const st = style(process.stderr)
  const models = usable(c, provider)
  const mine = (config(h).models ?? []).filter((m) => m.startsWith(provider + "/")).map((m) => m.slice(provider.length + 1))
  const start = mine.length
    ? mine
    : provider === "chatgpt"
      ? models.slice(0, 1).map((m) => m.id)
      : (suggested[provider] ?? []).filter((id) => models.some((m) => m.id === id))
  const ordered = [...models.filter((m) => start.includes(m.id)), ...models.filter((m) => !start.includes(m.id))]
  const chosen = await multi(`Which ${c[provider].name} models do you want?`, ordered.map((m) => ({ label: m.name, value: m.id })), start)
  update(h, (x) => {
    x.models = [...(x.models ?? []).filter((m) => !m.startsWith(provider + "/")), ...chosen.map((id) => `${provider}/${id}`)]
    if (x.model && !x.models.includes(x.model) && x.model.startsWith(provider + "/")) delete x.model
  })
  say(`${st.green("✓")} Saved ${chosen.length} model${chosen.length === 1 ? "" : "s"}`)
  if (!config(h).model && config(h).models?.length) await chooseDefault(h, c)
}

/** Asks for the default among the chosen models, or every keyed provider's when none are chosen. */
async function chooseDefault(h: Home, c: Catalog) {
  const st = style(process.stderr)
  const cfg = config(h)
  const names = cfg.models?.length ? cfg.models : keyed(h, c).flatMap((p) => usable(c, p).map((m) => `${p}/${m.id}`))
  const label = (name: string) => {
    const slash = name.indexOf("/")
    return c[name.slice(0, slash)]?.models[name.slice(slash + 1)]?.name ?? name
  }
  const first = cfg.model ? names.indexOf(cfg.model) : names.findIndex((n) => suggested[n.split("/")[0]]?.[0] === n.slice(n.indexOf("/") + 1))
  const model = await select("Default model?", names.map((n) => ({ label: label(n), hint: n, value: n })), Math.max(0, first))
  update(h, (x) => (x.model = model))
  say(`${st.green("✓")} Default model set to ${model}`)
}

async function removeProvider(h: Home, c: Catalog, removable: string[]) {
  const st = style(process.stderr)
  const p = await select("Which provider?", removable.map((id) => ({ label: c[id].name, value: id })))
  if (!(await confirm(`Remove ${c[p].name} and its models?`, false))) return
  if (p === "chatgpt") {
    if (!(await signOut(h))) say(`${st.yellow("!")} Signed out here, but OpenAI didn't confirm it; disconnect ask in ChatGPT's settings to be sure`)
  } else {
    const auth = readJSON<Auth>(h.auth, {})
    delete auth[p]
    writeJSON(h.auth, auth)
  }
  update(h, (x) => {
    x.models = x.models?.filter((m) => !m.startsWith(p + "/"))
    if (x.model?.startsWith(p + "/")) delete x.model
  })
  say(`${st.green("✓")} Removed ${c[p].name}`)
  if (!config(h).model && keyed(h, c).length) await chooseDefault(h, c)
}

/** Sends one tiny request; resolves to what went wrong, or undefined when the key works. */
export async function check(model: Model, key: Key, baseURL?: string): Promise<string | undefined> {
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
