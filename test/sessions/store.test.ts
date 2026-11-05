import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { home } from "../../src/base/home.ts"
import { claim, create, latest, save } from "../../src/sessions/store.ts"

describe("sessions", () => {
  test("each restart of a turn can be claimed by one caller only", () => {
    const s = create(home(mkdtempSync(join(tmpdir(), "ask-sessions-"))), tmpdir(), { prompt: "x", model: "p/m", write: false, timeout: 60 })
    assert.deepEqual([claim(s), claim(s)], [true, false])
    latest(s).resumed = 1
    save(s)
    assert.equal(claim(s), true)
  })
})
