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
