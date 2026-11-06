import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { instructions } from "../../src/agent/system.ts"

test("instruction symlinks cannot send outside files to a provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-instructions-"))
  const outside = mkdtempSync(join(tmpdir(), "ask-secret-"))
  writeFileSync(join(outside, "secret"), "outside-instruction-canary")
  symlinkSync(join(outside, "secret"), join(dir, "AGENTS.md"))
  assert.doesNotMatch(await instructions(dir, false, false), /outside-instruction-canary/)
})

test("prompt construction never executes repository fsmonitor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-instructions-"))
  execFileSync("git", ["init", "-q", dir])
  execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"])
  const marker = join(dir, "monitor-ran")
  execFileSync("git", ["-C", dir, "config", "core.fsmonitor", `touch '${marker}'`])
  await instructions(dir, false, false)
  assert.equal(existsSync(marker), false)
})
