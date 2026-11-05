import assert from "node:assert/strict"
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { find, load, usable, type Catalog } from "../src/catalog.ts"

const catalog: Catalog = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    env: ["OPENCODE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/inference/go/openai/v1",
    models: {
      "glm-5.3": { id: "glm-5.3", name: "GLM 5.3" },
      "beam-free": { id: "beam-free", name: "Beam Free", cost: { input: 0, output: 0 } },
      "minimax-m3": { id: "minimax-m3", name: "MiniMax M3", provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/go/anthropic/v1" } },
    },
  },
  openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], npm: "@ai-sdk/openai", models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } } },
}

describe("catalog", () => {
  test("a model's protocol and endpoint come from its provider, or its own override", () => {
    assert.equal(find(catalog, "opencode-go/glm-5.3").protocol, "chat")
    const m = find(catalog, "opencode-go/minimax-m3")
    assert.equal(m.protocol, "anthropic")
    assert.equal(m.baseURL, "https://opencode.ai/inference/go/anthropic/v1")
    assert.equal(find(catalog, "openai/gpt-5.5").baseURL, "https://api.openai.com/v1")
  })

  test("OpenCode's free-tier models, which answer 403 outside OpenCode, aren't offered", () => {
    assert.throws(() => find(catalog, "opencode-go/beam-free"), /free only inside OpenCode/)
    assert.deepEqual(usable(catalog, "opencode-go").map((m) => m.id), ["glm-5.3", "minimax-m3"])
  })

  test("a model named without its provider gets a suggestion", () => {
    assert.throws(() => find(catalog, "glm-5.3"), /did you mean opencode-go\/glm-5.3\?/)
  })

  test("a stale cache is used when models.dev can't be reached", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ask-catalog-")), "models.json")
    writeFileSync(path, JSON.stringify(catalog))
    utimesSync(path, new Date(0), new Date(0))
    const c = await load(path, { url: "http://127.0.0.1:9/api.json" })
    assert.ok(c.openai)
  })
})
