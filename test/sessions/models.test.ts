import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { home } from "../../src/base/home.ts"
import { readModels, resolve } from "../../src/sessions/models.ts"
import { serve } from "../fake.ts"

test("an explicitly named helper uses its own provider, credential and endpoint", async () => {
  const first = await serve("chat", [{ text: "first" }])
  const second = await serve("chat", [{ text: "helper" }])
  const previous = process.env.ASK_MODEL_SMALL
  try {
    const h = home(mkdtempSync(join(tmpdir(), "ask-models-")))
    mkdirSync(join(h.root, "cache"))
    const entry = (id: string, url: string) => ({ id, name: id, npm: "@ai-sdk/openai-compatible", api: url, env: [], models: { m: { id: "m", name: "M" } } })
    writeFileSync(h.catalog, JSON.stringify({ first: entry("first", first.url), second: entry("second", second.url) }))
    writeFileSync(h.auth, JSON.stringify({ first: { api_key: "first-key" }, second: { api_key: "second-key" } }))
    process.env.ASK_MODEL_SMALL = "second/m"
    const bound = await readModels(h, await resolve(h, "first/m"))
    assert.equal((await bound!.small("instructions", "question", 100)).text, "helper")
    assert.equal(first.requests.length, 0)
    assert.equal(second.requests[0].model, "m")
    assert.equal(second.headers[0].authorization, "Bearer second-key")
  } finally {
    if (previous === undefined) delete process.env.ASK_MODEL_SMALL
    else process.env.ASK_MODEL_SMALL = previous
    await Promise.all([first.close(), second.close()])
  }
})

test("an incomplete helper response is not presented as an answer", async () => {
  const fake = await serve("chat", [{ text: "partial", incomplete: true }])
  const previous = process.env.ASK_MODEL_SMALL
  try {
    delete process.env.ASK_MODEL_SMALL
    const h = home(mkdtempSync(join(tmpdir(), "ask-models-")))
    mkdirSync(join(h.root, "cache"))
    writeFileSync(h.catalog, JSON.stringify({ first: { id: "first", name: "first", npm: "@ai-sdk/openai-compatible", api: fake.url, env: [], models: { m: { id: "m", name: "M" } } } }))
    writeFileSync(h.auth, JSON.stringify({ first: { api_key: "key" } }))
    const bound = await readModels(h, await resolve(h, "first/m"))
    const result = await bound!.small("instructions", "question", 100)
    assert.match(result.text, /incomplete.*fetch again/i)
    assert.equal(result.usage.input, 100)
  } finally {
    if (previous === undefined) delete process.env.ASK_MODEL_SMALL
    else process.env.ASK_MODEL_SMALL = previous
    await fake.close()
  }
})

test("a custom OpenAI-compatible endpoint resolves from its saved URL, model IDs and optional key", async () => {
  const fake = await serve("chat", [{ text: "custom works" }])
  try {
    const h = home(mkdtempSync(join(tmpdir(), "ask-custom-model-")))
    mkdirSync(join(h.root, "cache"))
    writeFileSync(h.catalog, "{}")
    writeFileSync(h.auth, JSON.stringify({ "custom-local": {
      base_url: fake.url,
      custom: { name: "Local", models: ["qwen3"] },
    } }))
    const target = await resolve(h, "custom-local/qwen3")
    assert.equal(target.model.name, "qwen3")
    assert.equal(target.model.baseURL, fake.url)
    assert.equal(target.key, "")
    const bound = await readModels(h, target)
    assert.equal((await bound!.small("instructions", "question", 100)).text, "custom works")
    assert.equal(fake.requests[0].model, "qwen3")
    assert.equal(fake.headers[0].authorization, undefined)
  } finally { await fake.close() }
})
