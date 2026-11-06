// The Linux sandbox: bubblewrap makes Git metadata read-only; ask.sandbox applies Landlock
// and seccomp inside those mounts. Both helpers ship beside release binaries and in the npm
// package for each architecture. A checkout can compile ask.sandbox with the system C compiler
// and use system bubblewrap when no bundle has been built.

import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Policy } from "./policy.ts"

const source = fileURLToPath(new URL("../../native/sandbox.c", import.meta.url))
const built = fileURLToPath(new URL(`../../native/build/ask.sandbox-${process.arch}`, import.meta.url))

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let found: string | undefined | null = null

/**
 * Where ask.sandbox is: $ASK_SANDBOX_HELPER, next to the running binary, prebuilt in the package, or
 * compiled from source in a checkout (again whenever the source is newer). Undefined when none.
 */
export function helper(): string | undefined {
  if (found !== null) return found
  const shipped = [process.env.ASK_SANDBOX_HELPER, join(dirname(process.execPath), "ask.sandbox"), built].filter((p): p is string => !!p)
  found = shipped.find((p) => runnable(p) && (p !== built || !existsSync(source) || statSync(p).mtimeMs >= statSync(source).mtimeMs))
  if (!found && existsSync(source)) {
    mkdirSync(dirname(built), { recursive: true })
    // Parallel workers must never execute a partially linked helper.
    const tmp = mkdtempSync(join(dirname(built), "compile-"))
    try {
      const output = join(tmp, "ask.sandbox")
      const cc = spawnSync("cc", ["-std=c11", "-O2", "-Wall", "-o", output, source], { encoding: "utf8" })
      if (cc.status === 0) {
        renameSync(output, built)
        found = built
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  return found ?? undefined
}

let version: number | undefined
let bubblewrap: string | undefined

/** Prefer the bundled helper; host policy may require a system copy. Probe the exact policy. */
export function mounts(): boolean {
  const candidates = [join(dirname(process.execPath), "ask.bwrap"), fileURLToPath(new URL(`../../native/build/ask.bwrap-${process.arch}`, import.meta.url)),
    ...(process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, "bwrap"))]
  bubblewrap = undefined
  for (const path of [...new Set(candidates)]) {
    if (!runnable(path)) continue
    const candidate = realpathSync(path)
    if (spawnSync(candidate, [...mountArgs, "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"], { timeout: 5000, stdio: "ignore" }).status !== 0) continue
    bubblewrap = candidate
    return true
  }
  return false
}

/** Namespace/root setup shared by discovery and every tool launch. */
const mountArgs = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/"]

/** The kernel's Landlock ABI version, as ask.sandbox reports it; 0 without Landlock or the helper. */
export function abi(): number {
  if (version !== undefined) return version
  const h = helper()
  version = h ? Number(spawnSync(h, ["--abi"], { encoding: "utf8" }).stdout?.trim()) || 0 : 0
  return version
}

/** The command line that runs `argv` under `p`. */
export function wrap(p: Policy, argv: string[]): string[] {
  const args = [helper()!]
  for (const r of p.read) args.push("-r", r)
  for (const w of p.write) args.push("-w", w)
  args.push("--", ...argv)
  if (!bubblewrap) throw new Error("bubblewrap has not passed its namespace probe")
  const mounted = [bubblewrap, ...mountArgs]
  for (const w of [p.dir, p.tmp].filter((x) => p.write.includes(x))) mounted.push("--bind", w, w)
  for (const r of p.protected) mounted.push("--ro-bind", r, r)
  mounted.push("--proc", "/proc", "--dev", "/dev", "--", ...args)
  return mounted
}
