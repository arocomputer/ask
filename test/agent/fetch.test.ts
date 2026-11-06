import assert from "node:assert/strict"
import { test } from "node:test"
import { answer } from "../../src/agent/fetch.ts"

test("cancelling question-focused extraction aborts the helper rather than returning fallback text", async () => {
  const stop = new AbortController()
  const result = answer(async (_instructions, _prompt, _max, signal) => {
    assert.equal(signal, stop.signal)
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }))
  }, "what is the limit?", "untrusted document", stop.signal)
  stop.abort(new Error("cancelled extraction"))
  await assert.rejects(result, /cancelled extraction/)
})

test("helper failure explicitly offers raw fetch and never substitutes an invented answer", async () => {
  const result = await answer(async () => { throw new Error("provider unavailable") }, "what is the limit?", "untrusted document")
  assert.match(result, /provider unavailable/)
  assert.match(result, /fetch again without question/)
})
