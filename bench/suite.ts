// The small contract shared by the benchmark suites: plan locally, then emit graded rows.

/** Inexpensive default worker. Free OpenCode chat models can't be called by ask directly. */
export const goModel = "opencode-go/deepseek-v4.1-flash"

export type Row = {
  group: string
  case: string
  rep: number
  pass?: boolean
  error?: string
  seconds?: number
  input?: number
  output?: number
  [field: string]: unknown
}

export type Context = {
  checkout: string
  scratch: string
  env: NodeJS.ProcessEnv
  parallel: number
  traces?: string
  record(row: Row): void
}

export type Suite = {
  live: boolean
  repetitions: number
  compareFiles: string[]
  select(args: string[], reps: number): {
    inputs: Record<string, unknown>
    variant?: Record<string, string>
    count: number
    run(ctx: Context): Promise<void>
  }
}

/** Validate comma-separated selectors before running anything. */
export function pick<T extends string>(value: string | undefined, choices: readonly T[], flag: string): T[] {
  if (value === undefined) return [...choices]
  const list = value.split(",")
  if (list.some((item) => !choices.includes(item as T)) || new Set(list).size !== list.length)
    throw new Error(`${flag} expects a comma-separated list from ${choices.join(", ")}`)
  return list as T[]
}

/** Run at most `parallel` jobs at a time, and wait for all active jobs before cleaning up. */
export async function pool<T>(jobs: T[], parallel: number, one: (job: T) => Promise<void>) {
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (!failed && next < jobs.length) {
      try { await one(jobs[next++]) }
      catch (error) { failed = true; failure = error }
    }
  }))
  if (failed) throw failure
}
