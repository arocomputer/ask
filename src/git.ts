// Git, for write tasks: what a turn changed, and the worktrees tasks can work in. Every call
// turns core.fsmonitor off, so a write task can't plant a command for ask's own git calls to run.

import { execFileSync } from "node:child_process"
import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmdirSync } from "node:fs"
import { join } from "node:path"

/** Runs git and returns its output, or undefined when it fails. */
function git(dir: string, args: string[], input?: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
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

/** Paths git reports as changed or untracked, both sides of renames included. */
function dirty(root: string): string[] {
  const fields = (git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "").split("\0")
  const out: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.length < 4) continue
    out.push(f.slice(3))
    if (f[0] === "R" || f[0] === "C") out.push(fields[++i] ?? "")
  }
  return out.filter(Boolean)
}

/** Each path's mode and blob hash as git would store it, or "" when it isn't a file. */
function hashes(root: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of paths) {
    let value = ""
    try {
      const info = lstatSync(join(root, p))
      if (info.isSymbolicLink()) value = `120000:${git(root, ["hash-object", "--stdin"], readlinkSync(join(root, p)))?.trim() ?? ""}`
      else if (info.isFile()) value = `${info.mode & 0o111 ? "100755" : "100644"}:${git(root, ["hash-object", "--", p])?.trim() ?? ""}`
    } catch {}
    out.set(p, value.endsWith(":") ? "" : value)
  }
  return out
}

/** Each path's mode and blob hash in a commit, or "" when it isn't there. */
function hashesAt(root: string, commit: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of paths) {
    out.set(p, "")
    if (!commit) continue
    for (const entry of (git(root, ["ls-tree", "-z", commit, "--", p]) ?? "").split("\0")) {
      const [meta, name] = entry.split("\t")
      const bits = meta?.split(" ") ?? []
      if (name === p && bits.length === 3 && bits[1] === "blob") out.set(p, `${bits[0]}:${bits[2]}`)
    }
  }
  return out
}

/** The state of a checkout before a turn: HEAD, and the files already dirty, hashed. */
export type Snapshot = { root: string; head: string; files: Map<string, string> }

export type Change = { path: string; change: "added" | "modified" | "deleted" }

/** Takes a snapshot of the checkout holding dir, or undefined outside a repository. */
export function snapshot(dir: string): Snapshot | undefined {
  const root = top(dir)
  if (!root) return undefined
  return { root, head: head(root), files: hashes(root, dirty(root)) }
}

/**
 * What changed since a snapshot: files whose content or mode differ from where they started
 * (the snapshot for files already dirty, the starting commit for the rest), including files
 * in commits made on top of it, and how many such commits there are.
 */
export function changes(before: Snapshot): { changes: Change[]; commits: number } {
  const now = head(before.root)
  const paths = new Set([...before.files.keys(), ...dirty(before.root)])
  let commits = 0
  if (now && before.head && now !== before.head) {
    for (const p of (git(before.root, ["diff", "--name-only", "-z", before.head, now]) ?? "").split("\0")) if (p) paths.add(p)
    commits = Number(git(before.root, ["rev-list", "--count", `${before.head}..${now}`])?.trim()) || 0
  }
  const start = hashesAt(before.root, before.head, [...paths].filter((p) => !before.files.has(p)))
  for (const [p, h] of before.files) start.set(p, h)
  const end = hashes(before.root, [...paths])
  const out: Change[] = []
  for (const p of [...paths].sort()) {
    const a = start.get(p) ?? ""
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
