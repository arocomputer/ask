// Opt-in native delegation preferences. Edit a single span in each host's config and remember
// that span, not the rest of the config. Undo only a patch we can still identify.

import { createHash, randomUUID } from "node:crypto"
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { writeJSON } from "../base/home.ts"

type Edit = { at: number; before: string; after: string }
type Receipt = { caller: Caller; file: string; original?: string; installed: string; edit: Edit }
export type Caller = "claude" | "codex" | "opencode"

/** Reads a regular config file without replacing symlinks or disconnecting hardlinks. */
function config(file: string) {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`${file} is not a standalone config file`)
  return stat ? { text: readFileSync(file, "utf8"), mode: stat.mode & 0o777 } : undefined
}

/** Replace a user's config atomically, provided it still matches what we inspected. */
function save(file: string, text: string, original: ReturnType<typeof config>) {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, text, { mode: original?.mode ?? 0o600, flag: "wx" })
    if (original) chmodSync(tmp, original.mode)
    if (config(file)?.text !== original?.text) throw new Error(`${file} changed during setup; try again`)
    renameSync(tmp, file)
  } finally { rmSync(tmp, { force: true }) }
}

const digest = (source: string) => createHash("sha256").update(source).digest("hex")

type Token = { text: string; at: number; end: number }
type Entry = { first: Token; last: Token; comma?: Token; value?: Container }
type Container = { open: Token; entries: Entry[]; fields: Map<string, Entry> }

/** Find JSON/JSONC container spans, treating comments and trailing commas as trivia. */
function containers(source: string, jsonc: boolean): Container {
  const tokens: Token[] = []
  for (const m of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}\[\]:,]|[^\s"/{}\[\]:,]+|\S/g)) {
    if (jsonc && (m[0].startsWith("//") || m[0].startsWith("/*"))) continue
    tokens.push({ text: m[0], at: m.index, end: m.index + m[0].length })
  }
  // JSON.parse does syntax validation before we inspect spans or write an edit.
  try {
    JSON.parse(tokens.filter((t, i) => !jsonc || t.text !== "," || !/^[\]}]$/.test(tokens[i + 1]?.text ?? "")).map((t) => t.text).join(" "))
  } catch { throw new Error("caller settings are not valid JSON") }
  let i = 0
  function read(): Container | undefined {
    const open = tokens[i++]
    if (open.text !== "{" && open.text !== "[") return
    const fields = new Map<string, Entry>()
    const entries: Entry[] = []
    const end = open.text === "{" ? "}" : "]"
    while (tokens[i].text !== end) {
      const first = tokens[i]
      const key = open.text === "{" ? JSON.parse(first.text) as string : undefined
      if (key !== undefined) i += 2
      const value = read()
      const item: Entry = { first, last: tokens[i - 1], value, comma: tokens[i].text === "," ? tokens[i++] : undefined }
      if (key !== undefined) {
        if (fields.has(key)) throw new Error("duplicate config key")
        fields.set(key, item)
      }
      entries.push(item)
    }
    i++
    return { open, entries, fields }
  }
  const root = read()
  if (root?.open.text !== "{") throw new Error("expected a config object")
  return root
}

/** Append the supplied property or array item without reformatting the config. */
function append(target: Container, value: string): Edit {
  const last = target.entries.at(-1)
  return { at: (last?.last ?? target.open).end, before: "", after: (last ? ", " : "") + value }
}

const rule = '{"action":"subagent","resource":"*","effect":"deny"}'

/** Prepare a JSON preference; an existing native deny rule does not belong to ask. */
function jsonEdit(source: string, caller: "claude" | "opencode"): Edit | undefined {
  const root = containers(source, caller === "opencode")
  const permissions = root.fields.get("permissions")?.value
  if (!root.fields.has("permissions"))
    return append(root, caller === "claude" ? '"permissions":{"deny":["Agent"]}' : `"permissions":[${rule}]`)
  if (caller === "claude" && permissions?.open.text === "{") {
    const deny = permissions.fields.get("deny")?.value
    if (!permissions.fields.has("deny")) return append(permissions, '"deny":["Agent"]')
    if (deny?.open.text === "[") {
      if (deny.entries.some((item) => ["\"Agent\"", "\"Task\""].includes(item.first.text))) return
      return append(deny, '"Agent"')
    }
  }
  if (caller === "opencode" && permissions?.open.text === "[") {
    // An existing deny with no later matching rules is already in force.
    for (const item of [...permissions.entries].reverse()) {
      if (denyRule(item)) return
      const action = item.value?.fields.get("action")?.last.text
      if (!action?.startsWith('"')) break
      const pattern = (JSON.parse(action) as string).split(/([*?])/).map((part) =>
        part === "*" ? ".*" : part === "?" ? "." : part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
      ).join("")
      if (new RegExp(`^${pattern}$`).test("subagent")) break
    }
    return append(permissions, rule)
  }
  throw new Error("permissions layout is not supported; set the native delegation preference manually")
}

/** Recognize exactly the OpenCode permission ask adds. */
function denyRule(entry?: Entry): boolean {
  const fields = entry?.value?.fields
  return fields?.size === 3 && fields.get("action")?.last.text === '"subagent"'
    && fields.get("resource")?.last.text === '"*"' && fields.get("effect")?.last.text === '"deny"'
}

/** Remove one JSON item including one separator, leaving comments and other items alone. */
function drop(source: string, target: Container, item: Entry) {
  const comma = item.comma ?? target.entries[target.entries.indexOf(item) - 1]?.comma
  if (!comma) return source.slice(0, item.first.at) + source.slice(item.last.end)
  return comma.at < item.first.at
    ? source.slice(0, comma.at) + source.slice(comma.end, item.first.at) + source.slice(item.last.end)
    : source.slice(0, item.first.at) + source.slice(item.last.end, comma.at) + source.slice(comma.end)
}

/** Find the owned JSON rule at its documented path even when neighboring settings changed. */
function undoJSON(source: string, caller: "claude" | "opencode", patch: Edit): string | undefined {
  const root = containers(source, caller === "opencode")
  const permissions = root.fields.get("permissions")
  if (!permissions) return source
  if (!permissions.value) return
  const deny = caller === "claude" ? permissions.value.fields.get("deny") : permissions
  if (!deny && permissions.value.open.text === "{") return source
  const array = deny?.value
  if (!array || array.open.text !== "[") return
  const items = array.entries.filter(caller === "claude" ? (item) => item.first.text === '"Agent"' : denyRule)
  if (!items.length) return source
  if (items.length !== 1) return
  if (array.entries.length === 1 && patch.after.includes('"permissions"') &&
      (caller === "opencode" || permissions.value.fields.size === 1)) return drop(source, root, permissions)
  if (caller === "claude" && deny && array.entries.length === 1 && patch.after.includes('"deny"'))
    return drop(source, permissions.value, deny)
  return drop(source, array, items[0])
}

/** Find the agents table while skipping nested arrays and inline values on earlier lines. */
function agentsTable(source: string): { start: number; at: number; body: string } | undefined {
  if (/"""|'''|^\s*(?:(?:["']agents["']|agents)\s*[.=]|\[\[\s*agents\s*\]|(?:["']multi_agent_v2["']|multi_agent_v2)\s*=\s*true)/m.test(source))
    throw new Error("Codex config layout is not supported; set agents.enabled = false manually")
  let agents: { start: number; at: number; end: number } | undefined
  let depth = 0
  for (const line of source.matchAll(/[^\r\n]+/g)) {
    const raw = line[0].replace(/"(?:\\.|[^"\\])*"|'[^']*'|#.*$/g, (m) => m.startsWith("#") ? "" : "@").trim()
    if (!depth && /^\[\[?.*\]\]?$/.test(raw)) {
      const exact = /^[ \t]*\[[ \t]*(?:agents|"agents"|'agents')[ \t]*\][ \t]*(?:#.*)?$/.test(line[0])
      if (agents && agents.end === source.length) agents.end = line.index
      if (exact) {
        if (agents) throw new Error("Codex config has multiple agents tables")
        agents = { start: line.index, at: line.index + line[0].length, end: source.length }
      }
      continue
    }
    if (agents && agents.end === source.length && depth && /^(?:enabled|["']enabled["'])\s*=/.test(line[0].trim()))
      throw new Error("set agents.enabled = false manually")
    for (const m of raw.matchAll(/[[\]{}]/g)) depth += m[0] === "[" || m[0] === "{" ? 1 : -1
    if (depth < 0) throw new Error("Codex config contains an unbalanced value")
  }
  if (depth) throw new Error("Codex config contains an unbalanced value")
  if (agents) return { ...agents, body: source.slice(agents.at, agents.end) }
}

/** Edit Codex's ordinary [agents] table. Refuse ambiguous or unsupported assignments. */
function codexEdit(source: string): Edit | undefined {
  const table = agentsTable(source)
  const nl = source.includes("\r\n") ? "\r\n" : "\n"
  if (!table) return { at: source.length, before: "", after: `${source ? nl : ""}[agents]${nl}enabled = false${nl}` }
  const { at, body } = table
  if ([...body.matchAll(/^[ \t]*(?:enabled|["']enabled["'])\s*=/gm)].length > 1) throw new Error("Codex config has multiple agents.enabled values")
  const enabled = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t]*(?:#[^\r\n]*)?$/m.exec(body)
  if (enabled?.[1] === "false") return
  if (enabled) return { at: at + enabled.index + enabled[0].indexOf("true"), before: "true", after: "false" }
  if (/^\s*(?:enabled|["']enabled["'])\s*=/m.test(body)) throw new Error("set agents.enabled = false manually")
  return { at, before: "", after: `${nl}enabled = false` }
}

/** Undo only the Codex setting, preserving any other entries added to the agents table. */
function undoCodex(source: string, patch: Edit): string | undefined {
  const table = agentsTable(source)
  if (!table) return source
  const { at, body } = table
  const entries = [...body.matchAll(/^[ \t]*(?:enabled|["']enabled["'])\s*=/gm)]
  if (!entries.length) return source
  if (entries.length !== 1) return
  if (/^[ \t]*(?:enabled|["']enabled["'])[ \t]*=[ \t]*true[ \t]*(?:#[^\r\n]*)?$/m.test(body)) return source
  const line = /^([ \t]*enabled[ \t]*=[ \t]*)false[ \t]*(?:#[^\r\n]*)?$/m.exec(body)
  if (!line) return
  const start = at + line.index
  if (patch.before === "true") {
    const value = start + line[1].length
    return source.slice(0, value) + "true" + source.slice(value + 5)
  }
  if (line[0] !== "enabled = false") return
  const end = start + line[0].length
  const nextLine = /^\r?\n/.exec(source.slice(end))?.[0].length ?? 0
  if (patch.after.includes("[agents]") && body.trim() === line[0])
    return source.slice(0, table.start) + source.slice(end + nextLine)
  return source.slice(0, start) + source.slice(end + nextLine)
}

/** Read a receipt without treating permission errors or invalid data as a missing receipt. */
function readReceipt(receipt: string) {
  const old = config(receipt)
  if (!old) return
  try {
    const saved = JSON.parse(old.text) as Receipt
    if (!["claude", "codex", "opencode"].includes(saved.caller) || typeof saved.file !== "string" ||
        typeof saved.installed !== "string" || !Number.isSafeInteger(saved.edit?.at) || saved.edit.at < 0 ||
        typeof saved.edit.before !== "string" || typeof saved.edit.after !== "string") throw new Error()
    return saved
  } catch { throw new Error(`cannot read the delegation receipt at ${receipt}; restore caller settings manually before removing it`) }
}

/** Disable native delegation if needed and record only the change ask made. */
export function prefer(caller: Caller, file: string, receipt: string): boolean {
  const owned = readReceipt(receipt)
  if (owned) {
    if (owned.file !== file) throw new Error(`ask already manages delegation in ${owned.file}; run ask remove skill before changing profiles`)
    return false
  }
  const original = config(file)
  const source = original?.text ?? (caller === "codex" ? "" : "{}\n")
  const patch = caller === "codex" ? codexEdit(source) : jsonEdit(source, caller)
  if (!patch) return false
  const next = source.slice(0, patch.at) + patch.after + source.slice(patch.at + patch.before.length)
  writeJSON(receipt, { caller, file, original: original && digest(original.text), installed: digest(next), edit: patch } satisfies Receipt)
  try { save(file, next, original) }
  catch (e) {
    rmSync(receipt, { force: true })
    throw e
  }
  return true
}

/** Undo an owned edit; stop rather than guessing when the edited span has changed. */
export function restore(receipt: string): string | undefined {
  const saved = readReceipt(receipt)
  if (!saved) return
  const { caller, file, installed, edit: patch } = saved
  const original = config(file)
  if (original && digest(original.text) !== saved.original) {
    const next = digest(original.text) === installed
      ? original.text.slice(0, patch.at) + patch.before + original.text.slice(patch.at + patch.after.length)
      : caller === "codex" ? undoCodex(original.text, patch) : undoJSON(original.text, caller, patch)
    if (next === undefined)
      throw new Error(`${file} was edited; remove only ask's native delegation setting manually (receipt: ${receipt})`)
    if (next !== original.text && !saved.original && (!next.trim() || next.trim() === "{}")) {
      if (config(file)?.text !== original.text) throw new Error(`${file} changed during removal; try again`)
      rmSync(file)
    } else if (next !== original.text) save(file, next, original)
  }
  rmSync(receipt)
  return file
}
