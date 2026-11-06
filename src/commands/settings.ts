// ask settings: a persistent monochrome settings hub. Each action saves independently; Esc
// returns to the hub and Done exits. Provider setup uses keys or ChatGPT sign-in, then models.

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cheapest, connect, harnessMarker, providers, usable, type Catalog, type Model } from "../providers/catalog.ts"
import { readJSON, writeJSON, type Auth, type Config, type Home } from "../base/home.ts"
import { catalog, credential } from "../sessions/models.ts"
import { account, begin, CallbackError, remote, signOut, signedIn, usagePage } from "../providers/chatgpt.ts"
import { harness, settings } from "../harnesses/extensions.ts"
import { Back, confirm, input, interactive, line, multi, secret, select } from "../base/input.ts"
import { ProviderError, type Key } from "../providers/stream.ts"
import { heading, spinner, style, text } from "../base/term.ts"

export const summary = "Providers, models and defaults"
export const about = `Manage providers, models and task defaults. Changes are saved as you go.
Esc returns to settings; choose Done to exit.

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

const say = (line: string) => text(line, process.stderr)
const config = (h: Home) => readJSON<Config>(h.config, {})
const update = (h: Home, change: (c: Config) => void) => {
  const c = config(h)
  change(c)
  writeJSON(h.config, c)
}

/** A readable model name and provider, falling back to the saved identifier. */
function modelLabel(c: Catalog, id: string): string {
  const slash = id.indexOf("/")
  const provider = c[id.slice(0, slash)]
  const model = provider?.models[id.slice(slash + 1)]
  return model ? `${model.name} · ${provider.name}` : id
}

/** Show whole minutes when possible while keeping unusual timeout values exact. */
function timeoutLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} second${seconds === 1 ? "" : "s"}`
}

export async function run(h: Home): Promise<number> {
  const st = style(process.stderr)
  if (!interactive()) {
    say("ask settings needs a terminal")
    say(`Instead, set the provider's key variable, like OPENAI_API_KEY, and put {"model": "openai/gpt-5.5"} in ${h.config}`)
    return 2
  }
  const spin = spinner("Loading models")
  let c = await catalog(h).finally(() => spin.stop())
  heading("settings", process.stderr)
  for (;;) {
    const cfg = config(h)
    const ids = keyed(h, c)
    const removable = ids.filter((p) => readJSON<Auth>(h.auth, {})[p]?.api_key || (p === "chatgpt" && signedIn(h)))
    let choice: string
    try {
      choice = await select("", [
        ...(ids.length ? [
          { label: "Default model", hint: cfg.model ? modelLabel(c, cfg.model) : "Not set", value: "default" },
          { label: "Models", hint: cfg.models?.length ? `${cfg.models.length} selected` : "All models from connected providers", value: "models" },
        ] : []),
        { label: "Connect a provider", value: "add" },
        ...(removable.length ? [{ label: "Disconnect a provider", value: "remove" }] : []),
        { label: "Task timeout", hint: timeoutLabel(cfg.timeout ?? 900), value: "timeout" },
        { label: "Done", value: "done" },
      ])
    } catch (err) { if (err instanceof Back) return 0; throw err }
    if (choice === "done") return 0
    try {
      if (choice === "default") await chooseDefault(h, c)
      if (choice === "models") {
        const p = ids.length === 1 ? ids[0] : await select("", ids.map((id) => ({ label: c[id].name, value: id })))
        await chooseModels(h, c, p)
      }
      if (choice === "add") await addProvider(h, c)
      if (choice === "remove") await removeProvider(h, c, removable)
      if (choice === "timeout") {
        const n = Number(await input("Task timeout in seconds", String(cfg.timeout ?? 900)))
        if (!(n > 0) || !Number.isFinite(n)) say(`${st.bold("error")}  Enter a positive number, such as 900.`)
        else { update(h, (x) => (x.timeout = n)); say(`Task timeout saved  ${timeoutLabel(n)}`) }
      }
    } catch (err) { if (!(err instanceof Back)) throw err }
    c = await catalog(h)
  }
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
    .map((p) => {
      const source = credential(h, p.id, p.env)?.source
      return { label: p.name, hint: source === "pasted key" ? "Saved API key" : source ? `From ${source.replace(/^\$/, "")}` : "API key", value: p.id }
    })
  const chatgpt = { label: "ChatGPT", hint: signedIn(h) ? "Signed in" : "Use your ChatGPT subscription", value: "chatgpt" }
  const harnesses = providers(c)
    .filter((p) => c[p.id].npm === harnessMarker)
    .map((p) => ({ label: p.name, hint: `Uses your ${p.name} sign-in`, value: p.id }))
  const provider = await select("Connect a provider", [chatgpt, ...harnesses, ...items])
  if (c[provider]?.npm === harnessMarker) {
    const st = style(process.stderr)
    const x = await harness(h, provider)
    const s = x?.status(settings(h, provider)) ?? { ready: false, detail: `${provider} isn't available` }
    if (!s.ready) {
      say(`${st.bold("not ready")}  ${s.detail}${s.fix ? `: ${s.fix}` : ""}`)
      return false
    }
    say(s.detail)
    await chooseModels(h, c, provider)
    if (!config(h).model) await chooseDefault(h, c)
    return true
  }
  if (provider === "chatgpt") {
    if (!(await signIn(h))) return false
    const fresh = await catalog(h, true)
    if (!fresh.chatgpt) {
      say("error  ChatGPT listed no models for this account")
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
 * Correctable paste errors keep this attempt alive instead of silently replacing its link.
 */
async function signIn(h: Home): Promise<boolean> {
  const st = style(process.stderr)
  const first = !account(h)
  const attempt = await begin(h)
  try {
    const away = remote()
    heading("connect ChatGPT", process.stderr)
    if (away || !open(attempt.url)) {
      say("Open this link in your browser:")
      say(attempt.url)
      say("After signing in, your browser may show a page that cannot load.")
      say("Copy its full address and paste it below.")
    } else {
      say("Your browser is opening. If needed, open this link:")
      say(attempt.url)
    }
    for (;;) {
      const stop = new AbortController()
      const back = attempt.callback.then((address) => (stop.abort(), address))
      const pasted = line("Sign-in return URL", stop.signal)
      const address = (await Promise.race([back, pasted.then((v) => v ?? back)])) as string
      const sp = spinner("Signing in")
      try {
        const a = await attempt.finish(address)
        sp.stop()
        if (!a.scopes?.includes("chatgpt.tokens.use.direct")) {
          say(`${st.bold("not connected")}  ChatGPT plan use wasn't allowed.`)
          say(st.gray("Connect ChatGPT again and allow plan access, or choose a provider with an API key."))
          return false
        }
        say(`Connected to ChatGPT${a.email ? ` as ${a.email}` : ""}`)
        if (first) say(st.gray(`Usage settings  ${usagePage}`))
        return true
      } catch (err) {
        sp.stop()
        say(`${st.bold("error")}  ${(err as Error).message}`)
        if (!(err instanceof CallbackError)) return false
      }
    }
  } finally {
    attempt.close()
  }
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
    say("Create an API key:")
    say(k.page)
    if (k.where) say(st.gray(k.where))
    if (k.prefix) say(st.gray(`Key prefix  ${k.prefix}`))
  } else {
    const doc = c[provider].doc
    say(`Create an API key in your ${name} account.`)
    if (doc) say(doc)
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
      say(`Connected to ${name}`)
      return true
    }
    say(`${st.bold("error")}  ${problem}`)
  }
  return false
}

/** Asks which of a provider's models to use, and saves the choice. */
async function chooseModels(h: Home, c: Catalog, provider: string) {
  const models = usable(c, provider)
  const mine = (config(h).models ?? []).filter((m) => m.startsWith(provider + "/")).map((m) => m.slice(provider.length + 1))
  const start = mine.length
    ? mine
    : provider === "chatgpt"
      ? models.slice(0, 1).map((m) => m.id)
      : (suggested[provider] ?? []).filter((id) => models.some((m) => m.id === id))
  const ordered = [...models.filter((m) => start.includes(m.id)), ...models.filter((m) => !start.includes(m.id))]
  const chosen = await multi("", ordered.map((m) => ({ label: m.name, detail: provider, value: m.id })), start)
  update(h, (x) => {
    x.models = [...(x.models ?? []).filter((m) => !m.startsWith(provider + "/")), ...chosen.map((id) => `${provider}/${id}`)]
    if (x.model && !x.models.includes(x.model) && x.model.startsWith(provider + "/")) delete x.model
  })
  if (!config(h).model && config(h).models?.length) await chooseDefault(h, c)
}

/** Asks for the default among the chosen models, or every keyed provider's when none are chosen. */
async function chooseDefault(h: Home, c: Catalog) {
  const cfg = config(h)
  const names = cfg.models?.length ? cfg.models : keyed(h, c).flatMap((p) => usable(c, p).map((m) => `${p}/${m.id}`))
  const label = (name: string) => {
    const slash = name.indexOf("/")
    return c[name.slice(0, slash)]?.models[name.slice(slash + 1)]?.name ?? name
  }
  const first = cfg.model ? names.indexOf(cfg.model) : names.findIndex((n) => suggested[n.split("/")[0]]?.[0] === n.slice(n.indexOf("/") + 1))
  if (!names.length) { say("No models available from connected providers. Refresh the catalog with ask models --refresh, or connect another provider."); return }
  const model = await select("Default model", names.map((n) => ({ label: label(n), detail: n.slice(0, n.indexOf("/")), value: n })), Math.max(0, first))
  update(h, (x) => (x.model = model))
}

async function removeProvider(h: Home, c: Catalog, removable: string[]) {
  const st = style(process.stderr)
  const p = await select("Disconnect a provider", removable.map((id) => ({ label: c[id].name, value: id })))
  if (!(await confirm(`Remove ${c[p].name}'s saved ${p === "chatgpt" ? "sign-in" : "API key"} and model selections?`, false))) return
  if (p === "chatgpt") {
    if (!(await signOut(h))) say(`${st.bold("note")}  Signed out here, but OpenAI didn't confirm it; disconnect Ask in ChatGPT's settings to be sure`)
  } else {
    const auth = readJSON<Auth>(h.auth, {})
    delete auth[p]
    writeJSON(h.auth, auth)
  }
  update(h, (x) => {
    x.models = x.models?.filter((m) => !m.startsWith(p + "/"))
    if (x.model?.startsWith(p + "/")) delete x.model
  })
  say(p === "chatgpt" ? "Signed out of ChatGPT on this device" : `Removed the saved ${c[p].name} API key and model selections`)
  const remaining = credential(h, p, c[p].env ?? [])
  if (remaining) say(`Still available through ${remaining.source}`)
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
