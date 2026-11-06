// What a sandboxed command may touch, the same policy on every platform (the reasoning is in
// docs/contributing/sandbox.md): read the system, the toolchains on PATH, the task's folder and
// its repository's shared .git; write only the task's folder and private scratch, with
// Git metadata protected at execution time. Also the environment commands run in.

import { spawnSync } from "node:child_process"
import { existsSync, realpathSync, readdirSync, lstatSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type Policy = {
  /** The task's folder. */
  dir: string
  /** The private temp folder, which is also HOME for the command. */
  tmp: string
  read: string[]
  write: string[]
  /** Existing Git metadata, including nested repositories, made read-only by the OS. */
  protected: string[]
}

const home = homedir()

/** True when `path` is `root` or inside it. */
export function within(path: string, root: string): boolean {
  const r = relative(root, path)
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

/**
 * Folders a command may read besides the system's own: each folder on PATH and, for one named
 * bin, the installation it belongs to (a Homebrew prefix, a Node version, a package), so tools
 * work through their symlinks. Never the home folder itself, anything holding it, or ~/.local,
 * where other programs keep their data.
 */
export function toolchains(path = process.env.PATH ?? "", extra: string[] = []): string[] {
  const out = new Set<string>()
  const add = (dir: string) => {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    for (const d of basename(real) === "bin" ? [real, dirname(real)] : [real]) {
      if (d === sep || within(home, d) || d === join(home, ".local")) continue
      out.add(d)
    }
  }
  for (const dir of [...path.split(delimiter), ...extra]) if (isAbsolute(dir)) add(dir)
  // Toolchain managers whose shims on PATH need their own folder too.
  for (const d of [".rustup", ".cargo", ".nvm", ".bun", ".deno", ".pyenv", ".volta"]) if (existsSync(join(home, d))) add(join(home, d))
  return [...out]
}

/** The repository's shared .git folder, when it lies outside `dir` (a worktree, or a subfolder of the repository). */
export function gitDir(dir: string): string | undefined {
  const out = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
  const common = out.status === 0 ? out.stdout.trim() : ""
  return common && !within(common, dir) ? common : undefined
}

/** The system folders every command needs to read, on this platform. */
function system(): string[] {
  if (process.platform === "darwin") return ["/usr", "/bin", "/sbin", "/System", "/Library/Developer", "/Library/Frameworks", "/dev", "/private/etc", "/private/var/select", "/private/var/db/xcode_select_link"]
  return ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/proc", "/sys", "/dev", "/run/systemd/resolve", "/nix/store", "/snap"]
}

/** Git includes inside the writable tree are metadata too, even if currently conditional. */
function configuration(repo: string, root: string): string[] {
  const result = spawnSync("git", ["config", "--includes", "--null", "--show-origin", "--list"], {
    cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })
  if (result.status !== 0) throw new Error(`cannot inspect Git configuration in ${repo}`)
  const entries = result.stdout.split("\0")
  const paths = new Set<string>()
  const protect = (path: string) => {
    if (!within(path, root)) return
    if (!existsSync(path)) throw new Error(`Git configuration references a missing writable path: ${path}`)
    if (realpathSync(path) !== path) throw new Error(`symlinked Git configuration is unsupported: ${path}`)
    paths.add(path)
  }
  for (let i = 0; i + 1 < entries.length; i += 2) {
    if (!entries[i].startsWith("file:")) continue
    const origin = resolve(repo, entries[i].slice(5))
    protect(origin)
    const record = entries[i + 1]
    const at = record.indexOf("\n")
    const key = (at < 0 ? record : record.slice(0, at)).toLowerCase()
    const value = at < 0 ? "" : record.slice(at + 1)
    if (/^include(if\..*)?\.path$/.test(key) && value) {
      const path = value.startsWith("~/") ? join(home, value.slice(2)) : resolve(dirname(origin), value)
      protect(path)
    }
  }
  return [...paths]
}

/** The policy for a write task working in `dir`, with `tmp` as its private temp folder. */
export function policy(dir: string, tmp: string, write = true): Policy {
  dir = realpathSync(dir)
  tmp = realpathSync(tmp)
  const git = gitDir(dir)
  const protectedPaths: string[] = []
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.name === ".git") {
        if (entry.isSymbolicLink()) throw new Error(`symlinked Git metadata is unsupported: ${child}`)
        protectedPaths.push(child)
        protectedPaths.push(...configuration(path, dir))
        const common = gitDir(path)
        if (common) protectedPaths.push(realpathSync(common))
      }
      else if (entry.isDirectory()) walk(child)
    }
  }
  if (write) {
    walk(dir)
    if (git) protectedPaths.push(realpathSync(git), ...configuration(dir, dir))
  }
  // A pre-existing writable hardlink would bypass a read-only mount of the other name.
  const check = (path: string) => {
    const s = lstatSync(path)
    if (s.isFile() && s.nlink > 1) throw new Error(`Git metadata has hardlink aliases: ${path}`)
    if (s.isDirectory()) for (const name of readdirSync(path)) check(join(path, name))
  }
  for (const path of protectedPaths) check(path)
  return {
    dir,
    tmp,
    read: [dir, tmp, ...system(), ...toolchains(), ...(git ? [git] : [])],
    write: [...(write ? [dir] : []), tmp, "/dev/null", "/dev/zero", "/dev/full", "/dev/tty"],
    protected: [...new Set(protectedPaths)],
  }
}

/** Ordinary process settings needed by shells and build tools; credentials are not inherited. */
const inherited = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CI|TZ)$/

/** The user's git name and email, read outside the sandbox, since the home folder is hidden inside. */
function identity(dir: string): NodeJS.ProcessEnv {
  const get = (key: string) => spawnSync("git", ["config", "--get", key], { cwd: dir, encoding: "utf8" }).stdout?.trim() || undefined
  const name = get("user.name")
  const email = get("user.email")
  const env: NodeJS.ProcessEnv = {}
  if (name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name
  if (email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email
  return env
}

/**
 * The environment of a sandboxed command: ask's, without secrets or the user's agents; HOME
 * and TMPDIR in the private temp folder (so caches and config land there); the user's git
 * identity. No network or agent credentials are forwarded.
 */
export function environment(p: Policy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (inherited.test(k)) env[k] = v
  // rustup finds its toolchains through HOME unless told where they are; cargo's own folder
  // stays in the temp HOME, where it can download into.
  if (!env.RUSTUP_HOME && existsSync(join(home, ".rustup"))) env.RUSTUP_HOME = join(home, ".rustup")
  Object.assign(env, identity(p.dir), { HOME: join(p.tmp, "home"), TMPDIR: p.tmp, TMP: p.tmp, TEMP: p.tmp, GIT_CONFIG_GLOBAL: "/dev/null" })
  return env
}
