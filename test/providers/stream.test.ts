import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { chat } from "../../src/providers/chat.ts"
import { withRetries } from "../../src/providers/stream.ts"
import { serve } from "../fake.ts"

const req = { model: "m", instructions: "", messages: [{ role: "user" as const, text: "hi" }], tools: [] }

describe("retries", () => {
  test("a transient failure is retried and reported", async () => {
    const fake = await serve("chat", [{ status: 503, error: "busy" }, { text: "ok" }])
    try {
      const heard: number[] = []
      const p = withRetries(chat({ baseURL: fake.url, key: "k" }), (n, e) => heard.push(e.status), { budget: 10_000, slow: 5_000 })
      const r = await p.complete(req)
      assert.equal(r.message.text, "ok")
      assert.deepEqual(heard, [503])
    } finally {
      await fake.close()
    }
  })

  test("a slow failure is not retried", async () => {
    const fake = await serve("chat", [{ status: 500, error: "crashed", delay: 300 }, { text: "ok" }])
    try {
      const p = withRetries(chat({ baseURL: fake.url, key: "k" }), undefined, { budget: 10_000, slow: 100 })
      await assert.rejects(p.complete(req), /crashed/)
      assert.equal(fake.requests.length, 1)
    } finally {
      await fake.close()
    }
  })
})
