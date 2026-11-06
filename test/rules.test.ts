import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
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

  test("the engine names no coding agent but the two harnesses it ships", () => {
    const others = files.filter(({ text }) => /\b(Cursor|Copilot|Aider|Gemini CLI)\b/.test(text)).map((f) => f.name)
    assert.deepEqual(others, [])
  })

  test("each harness's command line lives only in its own file", () => {
    const flags: Record<string, RegExp> = {
      "src/harnesses/claude.ts": /--session-id|disableAllHooks|stream-json|--setting-sources/,
      "src/harnesses/codex.ts": /--ignore-user-config|--skip-git-repo-check|approval_policy/,
    }
    const stray = Object.entries(flags).flatMap(([own, re]) => files.filter(({ name, text }) => name !== own && re.test(text)).map((f) => `${f.name} has ${own}'s flags`))
    assert.deepEqual(stray, [])
  })

  test("each layer imports only from itself and the layers below it", () => {
    // Lowest first. The entry points, cli.ts and index.ts, sit above them all.
    const layers = ["base", "providers", "sandbox", "agent", "harnesses", "sessions", "commands"]
    const rank = (file: string) => {
      const top = relative(join(root, "src"), file).split("/")
      return top.length === 1 ? layers.length : layers.indexOf(top[0])
    }
    const upward = files.flatMap(({ name, text }) => {
      const from = join(root, name)
      return [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["'](\.[^"']+)["']/gm)]
        .map((m) => join(dirname(from), m[1]))
        .filter((to) => to.startsWith(join(root, "src")) && rank(to) > rank(from))
        .map((to) => `${name} imports ${relative(root, to)}`)
    })
    assert.deepEqual(upward, [])
  })

  test("every module says what it is for", () => {
    const silent = files.filter(({ text }) => !text.replace(/^#!.*\n/, "").startsWith("//")).map((f) => f.name)
    assert.deepEqual(silent, [])
  })
})
