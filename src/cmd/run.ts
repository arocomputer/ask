// ask PROMPT: start a session in the background. Its flags are documented in the overview
// help in cli.ts.

import { rmSync, statSync } from "node:fs"
import { resolve as absolute } from "node:path"
import { parseArgs } from "node:util"
import { resolve, type Home } from "../home.ts"
import { create } from "../sessions.ts"
import { begin, block, started, stdin, timeout, Usage } from "./common.ts"

const options = {
  model: { type: "string", short: "m" },
  write: { type: "boolean", short: "w" },
  dir: { type: "string", short: "C" },
  effort: { type: "string", short: "e" },
  timeout: { type: "string" },
  schema: { type: "string" },
  wait: { type: "boolean" },
  json: { type: "boolean" },
} as const

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options, allowPositionals: true })
  let prompt = positionals.join(" ").trim()
  const piped = (await stdin()).trim()
  if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped
  if (!prompt) throw new Usage("give a prompt", 'ask "Where is the retry logic?"')
  const dir = absolute(v.dir ?? ".")
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Usage(`${v.dir} is not a directory`)
  const { model } = await resolve(h, v.model)
  const s = create(h, dir, {
    prompt,
    model: `${model.provider}/${model.id}`,
    write: !!v.write,
    effort: v.effort,
    schema: schema(v.schema),
    timeout: timeout(h, v.timeout),
  })
  begin(s, () => rmSync(s.folder, { recursive: true, force: true }))
  if (v.wait) return block(s, !!v.json)
  started(s, !!v.json)
  return 0
}

export function schema(text?: string): object | undefined {
  if (text === undefined) return undefined
  try {
    const v = JSON.parse(text)
    if (v && typeof v === "object" && !Array.isArray(v)) return v
  } catch {}
  throw new Usage("--schema takes a JSON Schema object", `--schema '{"type":"object","properties":{"port":{"type":"integer"}}}'`)
}
