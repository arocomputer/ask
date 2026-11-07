// Monochrome terminal prompts. Single choices use a focus bar; multiselect uses checkboxes.
// Focused labels and multiselect checkboxes are bold. Hints sit beneath the list;
// completion leaves a short receipt.
// Rendering is shared with the visual fixtures; raw input and screen ownership live here.

import { plain, style, truncate, width, wrap } from "./term.ts"

export type Item<T> = { label: string; hint?: string; detail?: string; value: T }

/** Esc returns from the current settings action without saving its unfinished prompt. */
export class Back extends Error {}

export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stderr.isTTY && process.env.TERM !== "dumb"
}

/** Items whose label, inline detail or hint contains every word of the query. */
export function filter<T>(items: Item<T>[], query: string): Item<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((o) => words.every((w) => `${o.label} ${o.detail ?? ""} ${o.hint ?? ""}`.toLowerCase().includes(w)))
}

/** Splits raw input into keys; complete escape sequences stay together. */
export function split(data: string): string[] {
  return data.match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO.|\x1b|[\s\S]/gu) ?? []
}

/** Raw input with one redraw per chunk, restored on completion, abort, Esc or Ctrl-C. */
function keys(onKey: (key: string) => boolean | void, redraw: () => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  const stdin = process.stdin
  return new Promise((done, fail) => {
    const raw = stdin.isRaw
    const cleanup = () => {
      stdin.off("data", handler)
      signal?.removeEventListener("abort", aborted)
      stdin.setRawMode(raw)
      stdin.pause()
    }
    const aborted = () => { cleanup(); done() }
    const handler = (data: string) => {
      try {
        for (const key of split(data)) {
          if (key === "\x03") {
            cleanup()
            process.stderr.write("\x1b[?25h\n")
            process.exit(130)
          }
          if (onKey(key)) { cleanup(); done(); return }
        }
        redraw()
      } catch (err) { cleanup(); fail(err) }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    stdin.on("data", handler)
    signal?.addEventListener("abort", aborted, { once: true })
  })
}

/** Owns just the current prompt's lines; wrapped receipts never become future redraw targets. */
function canvas() {
  let drawn = 0
  let previousColumns = process.stderr.columns || 80
  const erase = () => {
    // A resize can reflow old lines unpredictably. Start a fresh block instead of erasing history.
    if (previousColumns !== (process.stderr.columns || 80)) { drawn = 0; process.stderr.write("\n") }
    process.stderr.write((drawn ? `\x1b[${drawn}A\r` : "\r") + "\x1b[J")
    previousColumns = process.stderr.columns || 80
  }
  return {
    draw(lines: string[]) {
      erase()
      const cols = Math.max(1, previousColumns - 1)
      const fitted = lines.map((l) => width(l) > cols ? truncate(plain(l), cols) : l)
      process.stderr.write(fitted.join("\n") + "\n")
      drawn = fitted.length
    },
    settle(receipt = "") {
      erase()
      if (receipt) process.stderr.write(wrap(receipt, Math.max(1, previousColumns - 1)).join("\n") + "\n\n")
      process.stderr.write("\x1b[?25h")
      drawn = 0
    },
  }
}

/** Picker frame with dim inline details; an empty title uses the surrounding screen's context. */
export function menu<T>(title: string, items: Item<T>[], cursor: number, query = "", selected?: Set<T>, out = process.stderr): string[] {
  const st = style(out)
  const cols = Math.max(1, (out.columns || 80) - 1)
  const page = Math.min(7, Math.max(1, (out.rows || 24) - 10))
  const top = Math.max(0, Math.min(cursor - page + 1, items.length - page))
  const lines: string[] = title ? [...wrap(title, cols), ""] : []
  if (query) lines.push(`> ${query}`, "")
  for (const [index, item] of items.slice(top, top + page).entries()) {
    const focused = top + index === cursor
    const prefix = selected ? selected.has(item.value) ? "[x] " : "[ ] " : `${focused ? "❙" : " "} `
    const room = Math.max(1, cols - width(prefix))
    const detail = item.detail ? truncate(item.detail, Math.max(1, Math.floor(room / 2) - 2)) : ""
    const label = truncate(item.label, Math.max(1, room - (detail ? width(detail) + 2 : 0)))
    const row = focused ? selected ? st.bold(prefix + label) : prefix + st.bold(label) : prefix + label
    lines.push(row + (detail ? "  " + st.gray(detail) : ""))
  }
  if (!items.length) lines.push("  No matches")
  const focused = items[cursor]
  if (focused?.hint) lines.push("", ...wrap(focused.hint, cols).map(st.gray))
  if (selected) {
    const count = items.filter((item) => selected.has(item.value)).length
    const footer = `${count} of ${items.length} · ↑↓ move · space toggle · enter save · esc back`
    lines.push("", ...wrap(footer, cols).map(st.gray))
  } else if (items.length > page) lines.push(st.gray(`${cursor + 1} of ${items.length}`))
  return lines
}

/** Shared picker behavior; only lists longer than seven items accept a search query. */
async function pick<T>(title: string, items: Item<T>[], start: number, selected?: Set<T>): Promise<T[]> {
  const screen = canvas()
  const searchable = items.length > 7
  let query = "", cursor = start
  let shown = items
  const refresh = () => {
    shown = filter(items, query)
    cursor = Math.max(0, Math.min(cursor, shown.length - 1))
  }
  const render = () => { refresh(); screen.draw(menu(title, shown, cursor, query, selected)) }
  let picked: Item<T> | undefined
  process.stderr.write("\x1b[?25l")
  render()
  try {
    await keys((k) => {
      if (k === "\r" || k === "\n") {
        if (!selected && !shown.length) return
        picked = shown[cursor]
        return true
      }
      if (k === "\x1b[A" || k === "\x10") cursor = cursor > 0 ? cursor - 1 : shown.length - 1
      else if (k === "\x1b[B" || k === "\x0e") cursor = cursor < shown.length - 1 ? cursor + 1 : 0
      else if (k === "\x1b") { if (query) query = ""; else throw new Back() }
      else if (selected && k === " ") {
        const item = shown[cursor]
        if (item) selected.has(item.value) ? selected.delete(item.value) : selected.add(item.value)
      } else if (selected && k === "\x1b[C") for (const item of shown) selected.add(item.value)
      else if (selected && k === "\x1b[D") for (const item of shown) selected.delete(item.value)
      else if (k === "\x7f" || k === "\b") query = [...query].slice(0, -1).join("")
      else if (searchable && !k.startsWith("\x1b") && k >= " ") { query += k; cursor = 0 }
      refresh()
    }, render)
    const result = selected ? items.filter((item) => selected.has(item.value)) : [picked!]
    screen.settle(title ? `${title}  ${selected ? `${result.length} selected` : picked!.label}` : "")
    return result.map((item) => item.value)
  } catch (err) { screen.settle(); throw err }
}

/** Choose one item; Esc cancels. An empty title omits the heading and navigation receipt. */
export async function select<T>(title: string, items: Item<T>[], start = 0): Promise<T> {
  return (await pick(title, items, start))[0]
}

/** Choose several items; Esc discards changes, Enter saves. */
export function multi<T>(title: string, items: Item<T>[], chosen: T[] = []): Promise<T[]> {
  return pick(title, items, 0, new Set(chosen))
}

/** Input frame with a visible tail and count. Secrets show a fixed mask, never their contents. */
export function field(title: string, value: string, hint: string, secret = false, out = process.stderr): string[] {
  const room = Math.max(1, (out.columns || 80) - 3)
  const chars = [...value]
  const preview = secret
    ? chars.length >= 4 ? chars.slice(0, 4).join("") + "••••••••" : "•".repeat(chars.length)
    : chars.length > room ? "…" + chars.slice(-(room - 1)).join("") : value
  const detail = secret ? value ? "Key received" : "Input hidden" : hint
  return [title, "", `❙ ${preview}`, ...(detail ? ["", style(out).gray(detail)] : [])]
}

/** One editable field. Empty input keeps a default, callback input waits, Esc goes back. */
async function entry(title: string, initial = "", secret = false, signal?: AbortSignal): Promise<string | undefined> {
  const screen = canvas()
  let value = ""
  const render = () => screen.draw(field(title, value, value ? `${[...value].length} characters` : initial ? `Default  ${initial}` : "", secret))
  process.stderr.write("\x1b[?25l")
  render()
  try {
    await keys((k) => {
      if (k === "\r" || k === "\n") return !signal || !!value.trim()
      if (k === "\x1b") throw new Back()
      if (k === "\x7f" || k === "\b") value = [...value].slice(0, -1).join("")
      else if (!k.startsWith("\x1b") && k >= " ") value += k
    }, render, signal)
    const result = value.trim() || initial
    screen.settle(`${title}  ${signal?.aborted ? "received in browser" : secret || signal ? "received" : result}`)
    return signal?.aborted ? undefined : result
  } catch (err) { screen.settle(); throw err }
}

/** API keys stay hidden, with a visible acknowledgement that input arrived. */
export async function secret(title: string): Promise<string> { return (await entry(title, "", true))! }

/** A plain field with an optional default. */
export async function input(title: string, initial = ""): Promise<string> { return (await entry(title, initial))! }

/** Callback input can be completed by the browser; callback values are never left in receipts. */
export function line(title: string, signal: AbortSignal): Promise<string | undefined> { return entry(title, "", false, signal) }

/** Confirmation uses the same focus treatment as every other choice. */
export function confirm(title: string, yes = true): Promise<boolean> {
  return select(title, [{ label: "Yes", value: true }, { label: "No", value: false }], yes ? 0 : 1)
}
