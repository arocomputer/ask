// Per-turn command confinement. OS policy protects Git metadata during execution; cleanup
// removes only ask's private scratch directory and never restores repository files.

import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { abi, helper, mounts, wrap as linux } from "./linux.ts"
import { wrap as macos } from "./macos.ts"
import { environment, policy } from "./policy.ts"

/** Platform enforcement availability; command networking is always disabled. */
export type Support = { ok: true; network: "none"; sockets: "precise" | "blocked"; detail: string } | { ok: false; detail: string; fix: string }
let cached: Support | undefined

/** Probe enforcement prerequisites before accepting a confined built-in turn. */
export function support(): Support {
  if (cached) return cached
  if (process.platform === "darwin") {
    const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"], { timeout: 5000 })
    return cached = probe.status === 0
      ? { ok: true, network: "none", sockets: "precise", detail: "Seatbelt; no command network; read-only Git metadata" }
      : { ok: false, detail: "Seatbelt is unavailable", fix: "use a supported harness" }
  }
  if (process.platform !== "linux") return cached = { ok: false, detail: `ask can't sandbox commands on ${process.platform}`, fix: "run write tasks on Linux or macOS" }
  if (!helper()) return cached = { ok: false, detail: "ask.sandbox, ask's sandbox helper, is missing", fix: "reinstall ask" }
  const v = abi()
  if (v < 1) return cached = { ok: false, detail: "this Linux kernel has no Landlock", fix: "use a kernel with Landlock enabled" }
  if (!mounts()) return cached = { ok: false, detail: "bubblewrap cannot establish user and network namespaces", fix: "install bubblewrap and enable unprivileged user namespaces, or use a supported harness" }
  return cached = { ok: true, network: "none", sockets: v >= 9 ? "precise" : "blocked", detail: `bubblewrap + Landlock ${v}; no command network; read-only Git metadata` }
}

/** A command boundary owned by one turn. */
export type Sandbox = {
  enabled: boolean
  limits: string
  command(script: string): { file: string; args: string[]; env: NodeJS.ProcessEnv }
  execute(argv: string[], read?: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv }
  /** Removes private scratch state. The empty list preserves the existing cleanup contract. */
  close(): Promise<string[]>
}

/** Create a turn execution context, optionally unconfined; failure cleans private scratch. */
export async function open(dir: string, write = true, enabled = true): Promise<Sandbox> {
  const s = enabled ? support() : undefined
  if (s && !s.ok) throw new Error(`${s.detail}; ${s.fix}`)
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ask-")))
  try {
    mkdirSync(join(tmp, "home"))
    const p = enabled ? policy(dir, tmp, write) : { dir: realpathSync(dir), tmp, read: [], write: [], protected: [] }
    const env = environment(p)
    if (!enabled) env.HOME = homedir()
    const wrap = enabled ? (process.platform === "darwin" ? macos : linux) : (_p: typeof p, argv: string[]) => argv
    return {
      enabled,
      limits: !enabled ? "OS sandboxing is disabled by user configuration. Commands have normal account-level filesystem and network access. Follow the task's requested scope." : (write ? "Commands can write only the task directory and $TMPDIR. " : "The task directory is read-only; only private scratch is writable. ") + "Git metadata is read-only: do not stage or commit. HOME is private scratch space. Commands have no network access. " + (s?.ok && s.sockets === "blocked" ? "Unix sockets are disabled; run tools with one worker. " : "") + "If the sandbox prevents the task, report it rather than bypassing it.",
      command(script) {
        const [file, ...args] = wrap(p, ["/bin/sh", "-c", script])
        return { file, args, env }
      },
      execute(argv, read = []) {
        const [file, ...args] = wrap({ ...p, read: [...p.read, ...read] }, argv)
        return { file, args, env }
      },
      async close() {
        rmSync(tmp, { recursive: true, force: true })
        return []
      },
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw err
  }
}
