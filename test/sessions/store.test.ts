import assert from "node:assert/strict"
import { mkdtempSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { home } from "../../src/base/home.ts"
import { alive, claim, create, latest, lock, save, worker } from "../../src/sessions/store.ts"

describe("sessions", () => {
  test("each restart of a turn can be claimed by one caller only", () => {
    const s = create(home(mkdtempSync(join(tmpdir(), "ask-sessions-"))), tmpdir(), { prompt: "x", model: "p/m", write: false, timeout: 60 })
    assert.deepEqual([claim(s), claim(s)], [true, false])
    utimesSync(join(s.folder, "resume-1-1"), new Date(0), new Date(0))
    assert.equal(alive(s), true)
    assert.equal(claim(s), false, "a live transition owner does not expire with wall-clock age")
    latest(s).resumed = 1
    save(s)
    assert.equal(claim(s), true)
  })

  test("the worker recognizes its own lock without an external process listing", () => {
    const s = create(home(mkdtempSync(join(tmpdir(), "ask-sessions-"))), tmpdir(), { prompt: "x", model: "p/m", write: false, timeout: 60 })
    lock(s, process.pid)
    const path = process.env.PATH
    try {
      process.env.PATH = "/nonexistent"
      assert.equal(worker(s), process.pid)
    } finally {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  })
})
