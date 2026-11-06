// Which model and key a task uses: the catalog with ask's own providers added (each harness's,
// ChatGPT's when signed in), a provider's credential, resolving a model name to all of it, and
// the model a turn's tools may ask when a helper is explicitly configured.

import { connect, find, harnessMarker, load, type Catalog, type Model } from "../providers/catalog.ts"
import { access, api, models, signedIn } from "../providers/chatgpt.ts"
import type { Key } from "../providers/stream.ts"
import type { Models } from "../agent/context.ts"
import { token } from "../agent/context.ts"
import { builtin, enabled, harnesses } from "../harnesses/extensions.ts"
import { readJSON, type Auth, type Config, type Home } from "../base/home.ts"

/**
 * A provider's credential: for ChatGPT, its sign-in's renewable token; for a harness, none, as it
 * signs in itself; otherwise a pasted key, else the first of the provider's catalog environment
 * variables.
 */
export function credential(h: Home, provider: string, env: string[]): { key: Key; source: string } | undefined {
  if (provider === "chatgpt") return signedIn(h) ? { key: (renew) => access(h, renew), source: "ChatGPT sign-in" } : undefined
  if (enabled(h, provider)) return { key: "", source: `${builtin[provider]?.title ?? provider}'s own sign-in` }
  const pasted = readJSON<Auth>(h.auth, {})[provider]?.api_key
  if (pasted) return { key: pasted, source: "pasted key" }
  for (const name of env) if (process.env[name]) return { key: process.env[name]!, source: `$${name}` }
  return undefined
}

/**
 * The catalog, loaded from the cache in this home, with providers of ask's own: one for each
 * harness ask can use (claude, codex, an extension's), with the models it offers; and "chatgpt"
 * when signed in to ChatGPT (the models the account may use, through OpenAI's Responses API).
 */
export async function catalog(h: Home, refresh = false): Promise<Catalog> {
  let c = await load(h.catalog, { refresh, url: process.env.ASK_CATALOG_URL })
  for (const x of await harnesses(h)) {
    const models = Object.fromEntries(x.models(c).map((m) => [m.id, { id: m.id, name: m.name }]))
    c = { ...c, [x.name]: { id: x.name, name: x.title, env: [], npm: harnessMarker, models } }
  }
  if (!signedIn(h)) return c
  const list = await models(h, refresh).catch(() => [])
  if (!list.length) return c
  const entries = Object.fromEntries(list.map((m) => [m.slug, { id: m.slug, name: m.name, tool_call: true, reasoning: true }]))
  return { ...c, chatgpt: { id: "chatgpt", name: "ChatGPT", env: [], npm: "@ai-sdk/openai", api: api(), models: entries } }
}

/**
 * Resolves the model to use: the name given, else config.json's, with its credential and any
 * endpoint override. Throws what to do when it can't.
 */
export async function resolve(h: Home, name?: string): Promise<{ model: Model; key: Key; baseURL?: string }> {
  const chosen = name || readJSON<Config>(h.config, {}).model
  if (!chosen) throw new Error("no model chosen; run ask settings, or give the task a model")
  const model = find(await catalog(h), chosen)
  const cred = credential(h, model.provider, model.env)
  if (!cred) throw new Error(`no key for ${model.provider}; add one with ask settings, or set ${model.env[0] ?? "its key variable"}`)
  return { model, key: cred.key, baseURL: readJSON<Auth>(h.auth, {})[model.provider]?.base_url }
}




/**
 * Bind tool calls to the turn's resolved model, or an explicitly named provider/model for
 * the helper. Resolve its credential and endpoint independently; never infer a model family
 * from its name or send one provider's credentials to another provider.
 */
export async function readModels(h: Home, target: { model: Model; key: Key; baseURL?: string }): Promise<Models | undefined> {
  if (target.model.protocol === "harness") return undefined
  const helper = process.env.ASK_MODEL_SMALL ? await resolve(h, process.env.ASK_MODEL_SMALL) : target
  if (helper.model.protocol === "harness") throw new Error("the helper model must use a provider, not a harness")
  const one = (use: typeof target): Models["small"] => {
    const provider = connect(use.model, use.key, use.baseURL)
    return async (instructions, prompt, maxOutput, signal) => {
      const r = await provider.complete({
        model: use.model.id,
        instructions,
        messages: [{ role: "user", text: prompt }],
        tools: [],
        maxOutput,
        session: `ask-read-${token()}`,
        signal,
      })
      const text = r.incomplete || r.message.calls.length
        ? "The extraction was incomplete; fetch again without a question to read the page directly."
        : r.message.text
      return { text, usage: r.usage }
    }
  }
  return { small: one(helper), large: one(target) }
}
