// The Linux sandbox: runs commands through sandybox (native/sandybox.c), which applies Landlock
// and seccomp. sandybox ships next to the release binary, and in the npm package for each
// architecture; a checkout of ask compiles it from source with the system's C compiler.

import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Policy } from "./policy.ts"

const source = fileURLToPath(new URL("../../native/sandybox.c", import.meta.url))
const built = fileURLToPath(new URL(`../../native/build/sandybox-${process.arch}`, import.meta.url))

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
 * Where sandybox is: $ASK_SANDYBOX, next to the running binary, prebuilt in the package, or
 * compiled from source in a checkout (again whenever the source is newer). Undefined when none.
 */
export function helper(): string | undefined {
  if (found !== null) return found
  const shipped = [process.env.ASK_SANDYBOX, join(dirname(process.execPath), "sandybox"), built].filter((p): p is string => !!p)
  found = shipped.find((p) => runnable(p) && (p !== built || !existsSync(source) || statSync(p).mtimeMs >= statSync(source).mtimeMs))
  if (!found && existsSync(source)) {
    mkdirSync(dirname(built), { recursive: true })
    const cc = spawnSync("cc", ["-std=c11", "-O2", "-Wall", "-o", built, source], { encoding: "utf8" })
    found = cc.status === 0 ? built : undefined
  }
  return found ?? undefined
}

let version: number | undefined

/** The kernel's Landlock ABI version, as sandybox reports it; 0 without Landlock or sandybox. */
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
  args.push("--net", p.network.mode === "proxy" ? "ports" : "none", "--", ...argv)
  return args
}
