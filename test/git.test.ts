import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { changes, slug, snapshot, worktree } from "../src/git.ts"

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

  test("a slug comes from the prompt's first words", () => {
    assert.equal(slug("Add rate limiting to the login route."), "add-rate-limiting-to")
  })
})
