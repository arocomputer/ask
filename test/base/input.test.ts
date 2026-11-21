import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { split } from "../../src/base/input.ts"

describe("input", () => {
  test("keys that arrive together are read one at a time", () => {
    assert.deepEqual(split("\x1b[B \x1b[6~glm\x1b"), ["\x1b[B", " ", "\x1b[6~", "g", "l", "m", "\x1b"])
  })

  test("mouse reports, paste markers and Alt-keys are never read as the Esc key", () => {
    assert.deepEqual(split("\x1b[<0;10;5M\x1b[200~a\x1b[201~\x1bx"), ["\x1b[<0;10;5M", "\x1b[200~", "a", "\x1b[201~", "\x1bx"])
  })
})
