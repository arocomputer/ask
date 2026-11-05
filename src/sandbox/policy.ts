// What a sandboxed command may touch, the same policy on every platform (the reasoning is in
// docs/contributing/sandbox.md): read the system, the toolchains on PATH, the task's folder and
// its repository's shared .git; write only the task's folder, that .git, and a private temp
// folder; never the home folder. Also the environment such a command runs in.

import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path"

export type Policy = {
  /** The task's folder. */
  dir: string
  /** The private temp folder, which is also HOME for the command. */
  tmp: string
  read: string[]
  write: string[]
  /** "proxy": web traffic only through ask's proxy on `port`; "none": no internet at all. */
  network: { mode: "proxy"; port: number } | { mode: "none" }
}

const home = homedir()

/** True when `path` is `root` or inside it. */
export function within(path: string, root: string): boolean {
  const r = relative(root, path)
  return r === "" || (!r.startsWith("..") && !isAbsolute(r))
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
  if (process.platform === "darwin") return ["/"]
  return ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/proc", "/sys", "/dev", "/run/systemd/resolve", "/nix/store", "/snap"]
}

/** The policy for a write task working in `dir`, with `tmp` as its private temp folder. */
export function policy(dir: string, tmp: string, network: Policy["network"]): Policy {
  const git = gitDir(dir)
  return {
    dir,
    tmp,
    read: [...system(), ...toolchains()],
    // The shared .git is writable so commits work in a worktree; its hooks and config are put
    // back after the turn, since a path inside a writable folder can't be made read-only.
    write: [dir, tmp, ...(git ? [git] : []), "/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/shm"],
    network,
  }
}

/** Variables that point at secrets or at the user's agents and session, never passed on. */
const withheld = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$|^(ASK_|SSH_AUTH_SOCK$|SSH_AGENT_PID$|GPG_AGENT_INFO$|DBUS_SESSION_BUS_ADDRESS$|XDG_RUNTIME_DIR$|DOCKER_HOST$|KRB5CCNAME$|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|AZURE_)/

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
 * identity; and the proxy, when there is one, for everything but this machine.
 */
export function environment(p: Policy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!withheld.test(k)) env[k] = v
  // rustup finds its toolchains through HOME unless told where they are; cargo's own folder
  // stays in the temp HOME, where it can download into.
  if (!env.RUSTUP_HOME && existsSync(join(home, ".rustup"))) env.RUSTUP_HOME = join(home, ".rustup")
  Object.assign(env, identity(p.dir), { HOME: join(p.tmp, "home"), TMPDIR: p.tmp, TMP: p.tmp, TEMP: p.tmp, GIT_CONFIG_GLOBAL: "/dev/null" })
  if (p.network.mode === "proxy") {
    const url = `http://127.0.0.1:${p.network.port}`
    Object.assign(env, { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" })
  }
  return env
}
