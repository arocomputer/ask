import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { baseURL, entry, id, modelIDs } from "../../src/providers/custom.ts"
import { find } from "../../src/providers/catalog.ts"

describe("custom endpoints", () => {
  test("creates a valid chat-completions catalog entry from manually supplied models", () => {
    const custom = entry({ id: "custom-local", name: "Local", baseURL: "http://localhost:11434/v1", models: ["qwen3", "org/model"] })
    assert.equal(find(custom, "custom-local/qwen3").protocol, "chat")
    assert.equal(find(custom, "custom-local/org/model").baseURL, "http://localhost:11434/v1")
    assert.equal(id("Mistrál Lab"), "custom-mistral-lab")
    assert.deepEqual(modelIDs("qwen3, org/model, qwen3"), ["qwen3", "org/model"])
  })

  test("validates URLs and avoids sending a key over remote HTTP", () => {
    assert.equal(baseURL("http://127.0.0.1:11434/v1/", true), "http://127.0.0.1:11434/v1")
    assert.equal(baseURL("https://api.example/v1", true), "https://api.example/v1")
    assert.throws(() => baseURL("http://api.example/v1", true), /Use HTTPS/)
    assert.throws(() => baseURL("https://user:pass@api.example/v1", false), /without credentials/)
    assert.throws(() => modelIDs("   "), /at least one model ID/)
  })
})
