// ask config: read and change config.json.

import { find } from "../catalog.ts"
import { catalog, credential, readJSON, writeJSON, type Config, type Home } from "../home.ts"
import { style } from "../term.ts"
import { Usage } from "./common.ts"

export const help = `Read and change settings.

USAGE
  ask config get [key]
  ask config set <key> <value>

KEYS
  model     The default model, as provider/model
  timeout   Seconds before a turn is stopped (default: 900)

EXAMPLES
  $ ask config set model opencode-go/glm-5.3
  $ ask config get model
`

const keys = ["model", "timeout"] as const

export async function run(h: Home, argv: string[]): Promise<number> {
  const [sub, key, value, ...extra] = argv
  const cfg = readJSON<Config>(h.config, {})
  if (sub === "get" || sub === undefined) {
    if (key) {
      if (!keys.includes(key as never)) throw new Usage(`unknown key ${key}`, `the keys are ${keys.join(", ")}`)
      const v = cfg[key as keyof Config]
      if (v === undefined) return 1
      process.stdout.write(`${v}\n`)
      return 0
    }
    for (const k of keys) if (cfg[k] !== undefined) process.stdout.write(`${k}=${cfg[k]}\n`)
    return 0
  }
  if (sub !== "set") throw new Usage(`unknown command ask config ${sub}`, "ask config get, or ask config set KEY VALUE")
  if (!key || value === undefined || extra.length) throw new Usage("give a key and a value", "ask config set model opencode-go/glm-5.3")
  const st = style()
  if (key === "model") {
    const m = find(await catalog(h), value)
    cfg.model = `${m.provider}/${m.id}`
    if (!credential(h, m.provider, m.env)) process.stderr.write(`${st.yellow("!")} no key for ${m.provider} yet; run ask auth login ${m.provider}\n`)
  } else if (key === "timeout") {
    const n = Number(value)
    if (!(n > 0)) throw new Usage("timeout takes seconds, like 900")
    cfg.timeout = n
  } else throw new Usage(`unknown key ${key}`, `the keys are ${keys.join(", ")}`)
  writeJSON(h.config, cfg)
  process.stdout.write(`${st.green("✓")} Set ${key} to ${cfg[key as keyof Config]}\n`)
  return 0
}
