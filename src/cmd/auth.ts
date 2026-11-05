// ask auth: add, remove and check provider keys. Keys are pasted (hidden on a terminal, or
// piped on stdin), checked with one tiny request, and saved in auth.json.

import { randomUUID } from "node:crypto"
import { connect, providers, cheapest, type Catalog, type Model, type ProviderInfo } from "../catalog.ts"
import { catalog, credential, readJSON, writeJSON, type Auth, type Home } from "../home.ts"
import { interactive, secret, select } from "../input.ts"
import { ProviderError } from "../provider.ts"
import { spinner, style, table } from "../term.ts"
import { stdin, Usage } from "./common.ts"

export const help = `Add, remove and check the keys ask uses to reach model providers.

USAGE
  ask auth login [provider]    Paste a key; piped keys are read from stdin
  ask auth logout <provider>   Forget a pasted key
  ask auth status              Show which providers ask can use

EXAMPLES
  $ ask auth login
  $ ask auth login opencode-go
  $ printf %s "$KEY" | ask auth login openai
`

/** Providers in the order to offer them: those with keys, then the common ones, then the rest. */
export function ordered(h: Home, c: Catalog): ProviderInfo[] {
  const featured = ["opencode-go", "opencode", "openai", "anthropic", "openrouter", "deepseek", "xai", "mistral", "groq"]
  const rank = (p: ProviderInfo) => (credential(h, p.id, p.env) ? 0 : featured.includes(p.id) ? 1 + featured.indexOf(p.id) / 100 : 2)
  return providers(c).sort((a, b) => rank(a) - rank(b))
}

/** Asks which provider, filterable, on a terminal. */
export function pick(h: Home, c: Catalog, question: string): Promise<string> {
  const st = style(process.stderr)
  return select(
    question,
    ordered(h, c).map((p) => ({ label: p.name, hint: `${p.id} · ${p.models} models${credential(h, p.id, p.env) ? " · " + st.green("key set") : ""}`, value: p.id })),
    { filterable: true },
  )
}

/** Sends one tiny request; resolves to an error message, or undefined when the key works. */
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
    return err instanceof ProviderError && err.status ? `${err.message} (HTTP ${err.status})` : (err as Error).message
  }
}

/** Reads a key, checks it against `model`, and saves it. On a terminal, offers three tries. */
export async function login(h: Home, c: Catalog, provider: string, model: Model): Promise<void> {
  const st = style(process.stderr)
  const name = c[provider].name
  const tries = interactive() ? 3 : 1
  for (let i = 1; ; i++) {
    const key = interactive() ? await secret(`Paste your ${name} API key`) : (await stdin()).trim()
    if (!key) throw new Usage(`no key given for ${provider}`, `printf %s "$KEY" | ask auth login ${provider}`)
    const spin = spinner(`Checking the key with ${model.provider}/${model.id}`)
    const problem = await check(model, key, readJSON<Auth>(h.auth, {})[provider]?.base_url)
    spin.stop()
    if (!problem) {
      const auth = readJSON<Auth>(h.auth, {})
      auth[provider] = { ...auth[provider], api_key: key }
      writeJSON(h.auth, auth)
      process.stderr.write(`${st.green("✓")} Logged in to ${name}\n`)
      return
    }
    process.stderr.write(`${st.red("X")} ${name} refused the key: ${problem}\n`)
    if (i >= tries) throw new Error(`could not log in to ${name}`)
  }
}

export async function run(h: Home, argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const st = style()
  switch (sub) {
    case "login": {
      const c = await catalog(h)
      let provider = rest[0]
      if (!provider) {
        if (!interactive()) throw new Usage("name the provider", "printf %s \"$KEY\" | ask auth login opencode-go")
        provider = await pick(h, c, "Which provider?")
      }
      if (!c[provider]) throw new Usage(`no provider ${provider} in the catalog`, "ask auth login, without a name, lists them")
      const model = cheapest(c, provider)
      if (!model) throw new Usage(`ask can't use any of ${provider}'s models yet`)
      await login(h, c, provider, model)
      return 0
    }
    case "logout": {
      const provider = rest[0]
      if (!provider) throw new Usage("name the provider", "ask auth logout opencode-go")
      const auth = readJSON<Auth>(h.auth, {})
      if (!auth[provider]?.api_key) {
        process.stderr.write(`${st.gray("-")} No pasted key for ${provider}\n`)
        return 0
      }
      delete auth[provider].api_key
      if (!Object.keys(auth[provider]).length) delete auth[provider]
      writeJSON(h.auth, auth)
      process.stdout.write(`${st.green("✓")} Logged out of ${provider}\n`)
      const c = await catalog(h).catch(() => undefined)
      const left = c?.[provider] && credential(h, provider, c[provider].env ?? [])
      if (left) process.stderr.write(st.yellow("!") + ` ${left.source} still holds a key for ${provider}\n`)
      return 0
    }
    case "status":
    case undefined: {
      const c = await catalog(h)
      const rows = providers(c).flatMap((p) => {
        const cred = credential(h, p.id, p.env)
        return cred ? [[[p.id, `${st.green("✓")} ${st.bold(p.id)}`], [p.name, p.name], [cred.source, st.gray(cred.source)]] as [string, string][]] : []
      })
      if (!rows.length) {
        process.stderr.write(`Not logged in to any provider. Run ${st.bold("ask setup")}\n`)
        return 1
      }
      table(rows)
      return 0
    }
    default:
      throw new Usage(`unknown command ask auth ${sub}`, "ask auth login, ask auth logout or ask auth status")
  }
}
