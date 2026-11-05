// Confining a write task's commands. `support` says whether, and how far, this machine can
// sandbox; `open` sets one up for a turn: a private temp folder, the proxy when commands may use
// the network, the policy, and a copy of the repository's git hooks and config, which `close`
// puts back. Every command then runs through `command`. A write task that can't be sandboxed
// doesn't run: callers check `support` first.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { abi, helper, wrap as linux } from "./linux.ts"
import { wrap as macos } from "./macos.ts"
import { environment, gitDir, policy, type Policy } from "./policy.ts"
import { start, type Proxy } from "./proxy.ts"

/**
 * What this machine can do. `network`: "proxy" when commands can reach the web through ask's
 * proxy, "none" when the kernel can't limit them to it, so they get no network. `sockets`:
 * "precise" when only Unix sockets made outside are refused, "blocked" when all are.
 */
export type Support = { ok: true; network: "proxy" | "none"; sockets: "precise" | "blocked"; detail: string } | { ok: false; detail: string; fix: string }

let cached: Support | undefined

export function support(): Support {
  if (cached) return cached
  if (process.platform === "darwin") return (cached = { ok: true, network: "proxy", sockets: "precise", detail: "Seatbelt" })
  if (process.platform !== "linux") return (cached = { ok: false, detail: `ask can't sandbox commands on ${process.platform}`, fix: "run write tasks on Linux or macOS" })
  if (!helper()) return (cached = { ok: false, detail: "sandybox, ask's sandbox helper, is missing", fix: "reinstall ask" })
  const v = abi()
  if (v < 1) return (cached = { ok: false, detail: "this Linux kernel has no Landlock", fix: "use Linux 5.13 or newer with Landlock on (it is by default on current Ubuntu, Debian and Fedora)" })
  const network = v >= 4 ? "proxy" : "none"
  const sockets = v >= 9 ? "precise" : "blocked"
  const limits = [network === "none" ? "no network for commands before Linux 6.7" : "", sockets === "blocked" ? "no Unix sockets before Linux 7.1" : ""].filter(Boolean)
  return (cached = { ok: true, network, sockets, detail: `Landlock ${v}${limits.length ? `; ${limits.join(", ")}` : ""}` })
}

/** A sandbox for one turn. */
export type Sandbox = {
  /** What commands can't do here, for the model's instructions. */
  limits: string
  /** The program and arguments that run a shell command inside it, and its environment. */
  command(script: string): { file: string; args: string[]; env: NodeJS.ProcessEnv }
  /** Ends the turn: stops the proxy, puts git's hooks and config back, deletes the temp folder. Says what it put back. */
  close(): Promise<string[]>
}

/** Git's hooks and config, which a command could change to run code outside the sandbox later. */
function guarded(dir: string): string[] {
  const git = gitDir(dir) ?? join(dir, ".git")
  try {
    if (!statSync(git).isDirectory()) return []
  } catch {
    return []
  }
  return [join(git, "config"), join(git, "hooks")]
}

type Copy = Map<string, { data: Buffer; mode: number } | null>

/** Every file under the guarded paths, as they are now; null for a path that doesn't exist. */
function snapshot(paths: string[]): Copy {
  const copy: Copy = new Map()
  const walk = (p: string) => {
    const s = lstatSync(p, { throwIfNoEntry: false })
    if (!s) return copy.set(p, null)
    if (s.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n))
    else if (s.isFile()) copy.set(p, { data: readFileSync(p), mode: s.mode & 0o777 })
  }
  for (const p of paths) walk(p)
  return copy
}

/** Puts the guarded paths back as `before` had them; returns what had changed. */
function restore(paths: string[], before: Copy): string[] {
  const now = snapshot(paths)
  const changed: string[] = []
  for (const [p, was] of before) {
    const is = now.get(p)
    if (was === null ? is === null || is === undefined : is && is.data.equals(was.data) && is.mode === was.mode) continue
    changed.push(p)
    if (was === null) rmSync(p, { recursive: true, force: true })
    else {
      rmSync(p, { recursive: true, force: true })
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, was.data, { mode: was.mode })
      chmodSync(p, was.mode)
    }
  }
  for (const p of now.keys())
    if (!before.has(p)) {
      changed.push(p)
      rmSync(p, { recursive: true, force: true })
    }
  return changed
}

/** Sets up the sandbox for a write turn in `dir`. Call only when `support()` is ok. */
export async function open(dir: string): Promise<Sandbox> {
  const s = support()
  if (!s.ok) throw new Error(`${s.detail}; ${s.fix}`)
  const tmp = mkdtempSync(join(tmpdir(), "ask-"))
  mkdirSync(join(tmp, "home"))
  let proxy: Proxy | undefined
  if (s.network === "proxy") proxy = await start()
  const p: Policy = policy(dir, tmp, proxy ? { mode: "proxy", port: proxy.port } : { mode: "none" })
  const env = environment(p)
  const paths = guarded(dir)
  const before = snapshot(paths)
  const wrap = process.platform === "darwin" ? macos : linux
  const limits = [
    "Your commands run in a sandbox. They can write only this directory and $TMPDIR; HOME is a scratch folder, and the real home folder can't be read.",
    s.network === "proxy"
      ? "They reach the web through a proxy that the usual tools pick up from HTTP_PROXY; nothing private (this machine's services on ports 80 and 443, the local network, cloud metadata) is reachable through it. Servers the commands start themselves on this machine are reachable."
      : "They have no network access at all.",
    s.sockets === "blocked"
      ? "They can't use Unix sockets, so tools that start process pools through them (Python 3.14's multiprocessing, black, autoflake) fail with PermissionError: run those with one worker, like black --workers 1."
      : "",
    "Never try to get around the sandbox; if it stops something the task needs, say so in your answer.",
  ]
    .filter(Boolean)
    .join(" ")
  return {
    limits,
    command(script) {
      const [file, ...args] = wrap(p, ["/bin/sh", "-c", script])
      return { file, args, env }
    },
    async close() {
      await proxy?.close()
      const changed = restore(paths, before)
      rmSync(tmp, { recursive: true, force: true })
      return changed
    },
  }
}
