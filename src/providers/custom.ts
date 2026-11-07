// User-defined OpenAI Chat Completions endpoints. Keep their manually supplied model IDs
// separate from models.dev, whose provider metadata does not describe custom auth reliably.

import type { Catalog } from "./catalog.ts"

export type Custom = { id: string; name: string; baseURL: string; models: string[] }

/** Build one catalog entry for a custom endpoint; requests use Ask's OpenAI-compatible adapter. */
export function entry(provider: Custom): Catalog {
  return {
    [provider.id]: {
      id: provider.id,
      name: provider.name,
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: provider.baseURL,
      models: Object.fromEntries(provider.models.map((id) => [id, { id, name: id, tool_call: true }])),
    },
  }
}

/** Create a stable provider ID from a display name. */
export function id(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/g, "")
  if (!slug) throw new Error("Use a provider name with letters or numbers")
  return `custom-${slug}`
}

/** Validate a base URL and require TLS before sending a key to a non-local HTTP endpoint. */
export function baseURL(value: string, hasKey: boolean): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Enter a full endpoint URL, such as https://api.example.com/v1") }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTP(S) endpoint URL without credentials, query or fragment")
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" || /^127\./.test(url.hostname)
  if (hasKey && url.protocol !== "https:" && !local) throw new Error("Use HTTPS when sending an API key; HTTP is allowed only for localhost")
  return url.toString().replace(/\/+$/, "")
}

/** Parse comma-separated model IDs, retaining slashes used by some local model names. */
export function modelIDs(value: string): string[] {
  const models = [...new Set(value.split(",").map((x) => x.trim()).filter(Boolean))]
  if (!models.length) throw new Error("Enter at least one model ID")
  if (models.some((x) => /[\s\x00-\x1f]/.test(x))) throw new Error("Model IDs cannot contain spaces or control characters")
  return models
}
