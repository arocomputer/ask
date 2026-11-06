import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { changes, slug, snapshot, worktree } from "../../src/base/git.ts"

/** A repository with one committed file, a.txt. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-git-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  writeFileSync(join(dir, "a.txt"), "one\n")
  git("add", ".")
  git("commit", "-qm", "start")
  return dir
}

const commit = (dir: string, message: string) => {
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "commit", "-qm", message], { stdio: "ignore" })
}

describe("git", () => {
  test("change bookkeeping never runs a repository's clean filter", () => {
    const dir = repo()
    const marker = join(dir, "filter-ran")
    execFileSync("git", ["-C", dir, "config", "filter.evil.clean", `touch ${marker}`])
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n")
    writeFileSync(join(dir, "new.txt"), "new\n")
    const before = snapshot(dir)!
    writeFileSync(join(dir, "new.txt"), "changed\n")
    assert.deepEqual(changes(before).changes, [{ path: "new.txt", change: "modified" }])
    assert.equal(existsSync(marker), false)
  })
  test("files a turn committed count as changes, with the commits", () => {
    const dir = repo()
    const before = snapshot(dir)!
    writeFileSync(join(dir, "b.txt"), "new\n")
    commit(dir, "add b")
    assert.deepEqual(changes(before), { changes: [{ path: "b.txt", change: "added" }], commits: 1 })
  })

  test("a file dirty before the turn counts only if the turn changed it again", () => {
    const dir = repo()
    writeFileSync(join(dir, "a.txt"), "edited before\n")
    writeFileSync(join(dir, "c.txt"), "untracked before\n")
    const before = snapshot(dir)!
    writeFileSync(join(dir, "a.txt"), "edited again\n")
    assert.deepEqual(changes(before).changes, [{ path: "a.txt", change: "modified" }])
  })

  test("a deleted file is reported as deleted", () => {
    const dir = repo()
    const before = snapshot(dir)!
    rmSync(join(dir, "a.txt"))
    assert.deepEqual(changes(before).changes, [{ path: "a.txt", change: "deleted" }])
  })

  test("worktrees started together get their own folder and branch, in the caller's subfolder", () => {
    const dir = repo()
    mkdirSync(join(dir, "sub"))
    writeFileSync(join(dir, "sub", "s.txt"), "s\n")
    commit(dir, "add sub")
    const under = mkdtempSync(join(tmpdir(), "ask-wt-"))
    const a = worktree(join(dir, "sub"), "fix-it", under)
    const b = worktree(join(dir, "sub"), "fix-it", under)
    assert.deepEqual([a.branch, b.branch], ["ask/fix-it", "ask/fix-it-2"])
    assert.equal(a.dir, join(under, "fix-it", "sub/"))
  })

  test("creating a worktree does not execute a repository's post-checkout hook", () => {
    const dir = repo()
    const marker = join(dir, "hook-ran")
    writeFileSync(join(dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    worktree(dir, "safe", mkdtempSync(join(tmpdir(), "ask-wt-")))
    assert.equal(existsSync(marker), false)
  })

  test("worktree creation refuses external checkout filters before running them", () => {
    const dir = repo()
    const marker = join(dir, "filter-ran")
    execFileSync("git", ["config", "filter.probe.smudge", `touch '${marker}'; cat`], { cwd: dir })
    assert.throws(() => worktree(dir, "filtered", mkdtempSync(join(tmpdir(), "ask-wt-"))), /external Git checkout filters/)
    assert.equal(existsSync(marker), false)
  })

  test("a slug comes from the prompt's first words", () => {
    assert.equal(slug("Add rate limiting to the login route."), "add-rate-limiting-to")
  })
})
