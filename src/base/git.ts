// Git, for write tasks: what a turn changed, and the worktrees tasks can work in. Every call
// disables fsmonitor and hooks, so ask's own git calls do not execute configured hooks.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, rmdirSync } from "node:fs"
import { join } from "node:path"

/** Runs git and returns its output, or undefined when it fails. */
function git(dir: string, args: string[], input?: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      input,
      env: args[0] === "worktree" || args[0] === "branch" ? process.env : { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
  } catch {
    return undefined
  }
}

/** The top of the checkout holding dir, or undefined outside a repository. */
export function top(dir: string): string | undefined {
  return git(dir, ["rev-parse", "--show-toplevel"])?.trim() || undefined
}

/** HEAD's commit, or "" in a repository without one. */
function head(root: string): string {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() ?? ""
}

/** Tracked and unignored files, without asking Git to run working-tree filters. */
function files(root: string): string[] {
  const result = git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
  if (result === undefined) throw new Error(`cannot list files in ${root}`)
  return [...new Set(result.split("\0").filter(Boolean))]
}

/** Each path's mode and raw content hash, or "" when it isn't a file. */
function hashes(root: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of paths) {
    let value = ""
    try {
      const info = lstatSync(join(root, p))
      if (info.isSymbolicLink()) value = `120000:${createHash("sha256").update(readlinkSync(join(root, p))).digest("hex")}`
      else if (info.isFile()) {
        const hash = createHash("sha256")
        const fd = openSync(join(root, p), "r")
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024)
          for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n))
        } finally { closeSync(fd) }
        value = `${info.mode & 0o111 ? "100755" : "100644"}:${hash.digest("hex")}`
      }
    } catch {}
    out.set(p, value.endsWith(":") ? "" : value)
  }
  return out
}

/** The state of a checkout before a turn: HEAD and its working files, hashed. */
export type Snapshot = { root: string; head: string; files: Map<string, string> }

export type Change = { path: string; change: "added" | "modified" | "deleted" }

/** Takes a snapshot of the checkout holding dir, or undefined outside a repository. */
export function snapshot(dir: string): Snapshot | undefined {
  const root = top(dir)
  if (!root) return undefined
  return { root, head: head(root), files: hashes(root, files(root)) }
}

/**
 * What changed since a snapshot: files whose content or mode differ from where they started
 * including files in commits made on top of it, and how many such commits there are.
 */
export function changes(before: Snapshot): { changes: Change[]; commits: number } {
  const now = head(before.root)
  const current = files(before.root)
  const paths = new Set([...before.files.keys(), ...current])
  let commits = 0
  if (now && before.head && now !== before.head) {
    commits = Number(git(before.root, ["rev-list", "--count", `${before.head}..${now}`])?.trim()) || 0
  }
  const end = hashes(before.root, [...paths])
  const out: Change[] = []
  for (const p of [...paths].sort()) {
    const a = before.files.get(p) ?? ""
    const b = end.get(p) ?? ""
    if (a !== b) out.push({ path: p, change: !a ? "added" : !b ? "deleted" : "modified" })
  }
  return { changes: out, commits }
}

/** A task's worktree: the checkout, its branch, and the folder the task works in inside it. */
export type Worktree = { path: string; branch: string; dir: string }

/** A short name from a prompt's first words, like "add-rate-limiting-login". */
export function slug(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && w.length <= 20)
  return words.slice(0, 4).join("-") || "task"
}

/**
 * Creates a worktree on a new branch ask/NAME from HEAD of the repository holding dir, in
 * `under`/NAME, or NAME-2, NAME-3 and so on when that folder is taken. Claiming the folder
 * is atomic, so tasks started together never share one. The task works in dir's own subfolder
 * of the new checkout.
 */
export function worktree(dir: string, name: string, under: string): Worktree {
  const root = top(dir)
  if (!root) throw new Error(`a worktree needs a git repository, and ${dir} is not in one`)
  if (!head(root)) throw new Error(`a worktree needs a commit to start from, and ${root} has none`)
  // Checkout filters run before the task sandbox exists. Refuse them rather than executing
  // repository-selected programs with the caller's credentials or silently changing checkout.
  const config = git(root, ["config", "--null", "--list"])
  if (config === undefined) throw new Error(`cannot inspect Git configuration in ${root}`)
  if (config.split("\0").some((entry) => /^includeif\./i.test(entry))) {
    throw new Error("worktree creation with conditional Git includes is unsupported; use an existing checkout")
  }
  if (config.split("\0").some((entry) => /^filter\..*\.(smudge|process)\n[^\0]+/.test(entry))) {
    throw new Error("worktree creation with external Git checkout filters is unsupported; use an existing checkout")
  }
  mkdirSync(under, { recursive: true, mode: 0o700 })
  for (let n = 1; ; n++) {
    const used = n === 1 ? name : `${name}-${n}`
    const path = join(under, used)
    const branch = `ask/${used}`
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch {
      continue
    }
    if (git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]) !== undefined) {
      rmdirSync(path)
      continue
    }
    if (git(root, ["worktree", "add", "-b", branch, path, "HEAD"]) === undefined) {
      rmdirSync(path)
      throw new Error(`git could not create a worktree for ${root}`)
    }
    const prefix = git(dir, ["rev-parse", "--show-prefix"])?.trim() ?? ""
    return { path, branch, dir: prefix ? join(path, prefix) : path }
  }
}

/** True when a worktree still exists, checked out on its branch. */
export function present(w: { path: string; branch: string }): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const at = top(w.path)
  return !!at && real(at) === real(w.path) && git(w.path, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() === w.branch
}
