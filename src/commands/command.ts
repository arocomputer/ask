// What every command declares, and the error for a command called the wrong way.

import type { Home } from "../base/home.ts"

/**
 * A command for people. `about` opens its help page; `flags` are [flag, description] pairs;
 * `run` returns the exit status.
 */
export type Command = {
  summary: string
  about: string
  usage: string
  flags?: [string, string][]
  examples?: string[]
  run(h: Home, argv: string[]): Promise<number>
}

/** Rejects what a command doesn't take: any flag, and arguments past the first `max`. */
export function positional(argv: string[], max = 0) {
  const flag = argv.find((a) => a.startsWith("-"))
  if (flag) throw new Usage(`unknown flag: ${flag}`)
  if (argv.length > max) throw new Usage(`unexpected argument: ${argv[max]}`)
}

/** A command called the wrong way; ask prints the message and the command's usage, and exits 2. */
export class Usage extends Error {}
