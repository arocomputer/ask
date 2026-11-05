import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, test } from "node:test"

const root = join(import.meta.dirname, "..")
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []))
const files = sources(join(root, "src")).map((f) => ({ name: relative(root, f), text: readFileSync(f, "utf8") }))

// The rules AGENTS.md states, checked on every change. A change that moves a rule moves this
// file in the same diff, where review can see it.
describe("rules", () => {
  test("ask has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])
  })

  test("the engine imports only Node's built-ins and its own files", () => {
    const outside = files.flatMap(({ name, text }) =>
      [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).filter((s) => !s.startsWith("node:") && !s.startsWith(".")).map((s) => `${name}: ${s}`),
    )
    assert.deepEqual(outside, [])
  })

  test("the engine names no particular coding agent", () => {
    const named = files.filter(({ text }) => /\b(Claude Code|Claude|Codex|Cursor|Copilot|Aider|Gemini CLI|claude|codex)\b/.test(text)).map((f) => f.name)
    assert.deepEqual(named, [])
  })

  test("every module says what it is for", () => {
    const silent = files.filter(({ text }) => !text.replace(/^#!.*\n/, "").startsWith("//")).map((f) => f.name)
    assert.deepEqual(silent, [])
  })
})
