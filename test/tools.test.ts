import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { tools } from "../src/tools.ts"

const all = Object.fromEntries(tools(true).map((t) => [t.name, t]))

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ask-tools-"))
  mkdirSync(join(d, "src/deep"), { recursive: true })
  writeFileSync(join(d, "src/a.ts"), "one\ntwo\nthree\n")
  writeFileSync(join(d, "src/deep/b.ts"), "const two = 2\n")
  writeFileSync(join(d, "notes.md"), "two words\n")
  return d
}

describe("tools", () => {
  test("read numbers lines from the start line", async () => {
    assert.equal(await all.read.run({ path: "src/a.ts", line: 2 }, { dir: dir() }), "2\ttwo\n3\tthree\n")
  })

  test("a symlink can't lead outside the working directory", async () => {
    const d = dir()
    symlinkSync(tmpdir(), join(d, "out"))
    await assert.rejects(all.read.run({ path: "out/x" }, { dir: d }), /outside the working directory/)
  })

  test("a write can't land outside the working directory", async () => {
    const d = dir()
    await assert.rejects(all.write.run({ path: "../escaped.txt", content: "x" }, { dir: d }), /outside the working directory/)
    await assert.rejects(all.write.run({ path: "/tmp/escaped.txt", content: "x" }, { dir: d }), /outside the working directory/)
  })

  test("shell commands can't see provider keys", async () => {
    process.env.SOME_PROVIDER_API_KEY = "secret"
    try {
      assert.equal(await all.shell.run({ command: "echo \"[$SOME_PROVIDER_API_KEY]\"" }, { dir: dir() }), "exit 0\n[]\n")
    } finally {
      delete process.env.SOME_PROVIDER_API_KEY
    }
  })

  test("list with a pattern finds files at any depth", async () => {
    assert.equal(await all.list.run({ pattern: "src/**/*.ts" }, { dir: dir() }), "src/a.ts\nsrc/deep/b.ts")
  })

  test("grep reports path:line:text, limited by glob", async () => {
    assert.equal(await all.grep.run({ pattern: "two", glob: "*.ts" }, { dir: dir() }), "src/a.ts:2:two\nsrc/deep/b.ts:1:const two = 2")
  })

  test("edit refuses text that occurs more than once", async () => {
    const d = dir()
    writeFileSync(join(d, "twice.txt"), "x\nx\n")
    await assert.rejects(all.edit.run({ path: "twice.txt", old: "x", new: "y" }, { dir: d }), /occurs 2 times/)
  })

  test("shell stops a command at its timeout, children included", async () => {
    const start = Date.now()
    const out = await all.shell.run({ command: "sleep 30 & sleep 30; wait", timeout: 1 }, { dir: dir() })
    assert.match(out, /^timed out after 1 seconds/)
    assert.ok(Date.now() - start < 5000)
  })

  test("shell keeps the start and the end of long output", async () => {
    const out = await all.shell.run({ command: "echo first; head -c 100000 /dev/zero | tr '\\0' x; echo; echo last" }, { dir: dir() })
    assert.match(out, /^exit 0\nfirst\n/)
    assert.match(out, /bytes cut/)
    assert.match(out, /last\n$/)
  })
})
