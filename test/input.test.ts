import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { split } from "../src/input.ts"

describe("input", () => {
  test("keys that arrive together are read one at a time", () => {
    assert.deepEqual(split("\x1b[B \x1b[6~glm\x1b"), ["\x1b[B", " ", "\x1b[6~", "g", "l", "m", "\x1b"])
  })
})
