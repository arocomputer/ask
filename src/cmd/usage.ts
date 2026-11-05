// What every command declares, and the error for a command called the wrong way.

import type { Home } from "../home.ts"

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

/** A command called the wrong way; ask prints the message and the command's usage, and exits 2. */
export class Usage extends Error {}
