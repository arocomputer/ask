// Interactive prompts on a terminal. They draw on stderr so stdout stays clean, and only work
// when stdin and stderr are terminals; callers check `interactive()` first.
//
// `pick` is the one list control: a title with the list's size, a "> search" line that
// narrows the list as you type, a scrolling window of items, and a key line at the bottom.
// With `multi`, items toggle on and off and a Save row ends the choice. Esc clears the search,
// or goes back when the search is empty.

import { style, truncate, width } from "./term.ts"

export type Item<T> = { label: string; hint?: string; value: T }

export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stderr.isTTY
}

/** Items whose label or hint contains every word of the query, case-insensitively. */
export function filter<T>(items: Item<T>[], query: string): Item<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((o) => {
    const text = `${o.label} ${o.hint ?? ""}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/** Splits raw input into keys: escape sequences whole, everything else a character at a time. */
export function split(data: string): string[] {
  return data.match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO.|\x1b|[\s\S]/gu) ?? []
}

/**
 * Reads keys in raw mode, one at a time even when they arrive together (a paste, or a slow
 * link), until `onKey` returns true; Ctrl-C exits with 130.
 */
function keys(onKey: (key: string) => boolean | void): Promise<void> {
  const stdin = process.stdin
  return new Promise((done) => {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const handler = (data: string) => {
      for (const key of split(data)) {
        if (key === "\x03") {
          cleanup()
          process.stderr.write("\x1b[?25h\n")
          process.exit(130)
        }
        if (onKey(key)) {
          cleanup()
          return done()
        }
      }
    }
    const cleanup = () => {
      stdin.off("data", handler)
      stdin.setRawMode(false)
      stdin.pause()
    }
    stdin.on("data", handler)
  })
}

/** Redraws a block of lines in place on stderr. */
function canvas() {
  let drawn = 0
  return {
    draw(lines: string[]) {
      const cols = (process.stderr.columns || 80) - 1
      const fitted = lines.map((l) => (width(l) > cols ? truncate(l.replace(/\x1b\[[0-9;]*m/g, ""), cols) : l))
      process.stderr.write((drawn ? `\x1b[${drawn}A\r` : "") + "\x1b[J" + fitted.join("\n") + "\n")
      drawn = fitted.length
    },
    clear() {
      if (drawn) process.stderr.write(`\x1b[${drawn}A\r\x1b[J`)
      drawn = 0
    },
  }
}

export type PickOptions<T> = {
  /** Shown at the top with the list's size: "Providers · 235". */
  title: string
  items: Item<T>[]
  /** Where the cursor starts. */
  start?: number
  /** Toggle items on and off; resolves to the chosen values when Save is picked. */
  multi?: boolean
  /** Values chosen at the start, with multi. */
  chosen?: T[]
  /** How many rows of items to show at once. */
  rows?: number
  /** False for a short menu: no count and no search line. */
  search?: boolean
}

/** Asks for one item, or with `multi` a set of them. Resolves to undefined when the user goes back. */
export async function pick<T>(o: PickOptions<T> & { multi?: false }): Promise<T | undefined>
export async function pick<T>(o: PickOptions<T> & { multi: true }): Promise<T[] | undefined>
export async function pick<T>(o: PickOptions<T>): Promise<T | T[] | undefined> {
  const st = style(process.stderr)
  const screen = canvas()
  const rows = Math.min(o.items.length || 1, o.rows ?? Math.max(4, Math.min(10, (process.stderr.rows || 24) - 8)))
  const scrolls = o.items.length > rows
  const searchable = o.search ?? true
  const chosen = new Set<T>(o.chosen ?? [])
  const labelWidth = Math.min(32, Math.max(0, ...o.items.map((i) => width(i.label))))
  let query = ""
  let cursor = o.start ?? 0
  let shown = o.items
  const onSave = () => o.multi && cursor === shown.length

  const render = () => {
    shown = filter(o.items, query)
    cursor = Math.min(cursor, o.multi ? shown.length : Math.max(0, shown.length - 1))
    const count = query ? `${shown.length} of ${o.items.length}` : `${o.items.length}`
    const lines = [searchable ? `${st.bold(o.title)}${st.gray(` · ${count}`)}` : st.bold(o.title)]
    if (searchable) lines.push(query ? `${st.gray(">")} ${query}` : st.gray("> search"))
    const at = Math.min(cursor, shown.length - 1)
    const top = Math.max(0, Math.min(at - Math.floor(rows / 2), shown.length - rows))
    if (scrolls) lines.push(top > 0 ? st.gray(`  ↑ ${top} more`) : "")
    for (let i = top; i < Math.min(shown.length, top + rows); i++) {
      const item = shown[i]
      const here = i === cursor
      const box = o.multi ? (chosen.has(item.value) ? st.cyan("[x] ") : st.gray("[ ] ")) : ""
      const label = item.label + " ".repeat(Math.max(0, labelWidth - width(item.label)))
      lines.push(`${here ? st.cyan("›") : " "} ${box}${here ? st.bold(label) : label}  ${st.gray(item.hint ?? "")}`.trimEnd())
    }
    if (!shown.length) lines.push(st.gray("  No matches"))
    for (let i = Math.max(shown.length, 1); i < rows; i++) lines.push("")
    const below = shown.length - top - rows
    if (scrolls) lines.push(below > 0 ? st.gray(`  ↓ ${below} more`) : "")
    if (o.multi) {
      const note = st.gray(` · ${chosen.size} selected`)
      lines.push(onSave() ? `${st.cyan("›")} ${st.bold(st.cyan("Save"))}${note}` : `  ${st.cyan("Save")}${note}`)
    }
    lines.push(st.gray(o.multi ? "↑↓ move · space select · tab save · esc back" : "↑↓ move · enter choose · esc back"))
    screen.draw(lines)
  }

  let result: T | T[] | undefined
  process.stderr.write("\x1b[?25l")
  render()
  await keys((k) => {
    const last = o.multi ? shown.length : shown.length - 1
    if (k === "\x1b[A") cursor = cursor <= 0 ? last : cursor - 1
    else if (k === "\x1b[B") cursor = cursor >= last ? 0 : cursor + 1
    else if (k === "\x1b[5~") cursor = Math.max(0, cursor - rows)
    else if (k === "\x1b[6~") cursor = Math.min(last, cursor + rows)
    else if (k === "\t" && o.multi) cursor = shown.length
    else if (k === "\x1b") {
      if (!query) return true
      query = ""
      cursor = 0
    } else if (k === "\r" || k === "\n" || (k === " " && o.multi && !query)) {
      if (o.multi) {
        if (onSave()) {
          result = o.items.map((i) => i.value).filter((v) => chosen.has(v))
          return true
        }
        const v = shown[cursor]?.value
        if (v !== undefined) chosen.has(v) ? chosen.delete(v) : chosen.add(v)
      } else if (shown[cursor]) {
        result = shown[cursor].value
        return true
      }
    } else if (k === "\x7f" || k === "\b") {
      query = query.slice(0, -1)
      cursor = 0
    } else if (searchable && !k.startsWith("\x1b") && k >= " ") {
      query += k.replace(/[\r\n\t]/g, "")
      cursor = 0
    }
    render()
  })
  screen.clear()
  process.stderr.write("\x1b[?25h")
  return result
}

/** Asks for a secret without showing it; a pasted value with a trailing newline ends the entry. */
export async function secret(question: string): Promise<string> {
  const st = style(process.stderr)
  process.stderr.write(`${st.bold(question)} ${st.gray("(hidden)")} `)
  let value = ""
  await keys((k) => {
    for (const c of k) {
      if (c === "\r" || c === "\n") return true
      if (c === "\x1b") {
        value = ""
        return true
      }
      if (c === "\x7f" || c === "\b") value = value.slice(0, -1)
      else if (c >= " ") value += c
    }
  })
  process.stderr.write("\n")
  return value.trim()
}

/** Asks for a line of text, offering `initial`; resolves to undefined on Esc. */
export async function text(question: string, initial = ""): Promise<string | undefined> {
  const st = style(process.stderr)
  const screen = canvas()
  let value = initial
  let cancelled = false
  const render = () => screen.draw([`${st.bold(question)} ${value}${st.gray("▏")}`, st.gray("enter save · esc back")])
  render()
  await keys((k) => {
    if (k === "\r" || k === "\n") return true
    if (k === "\x1b") return (cancelled = true)
    if (k === "\x7f" || k === "\b") value = value.slice(0, -1)
    else if (!k.startsWith("\x1b") && k >= " ") value += k
    render()
  })
  screen.clear()
  return cancelled ? undefined : value.trim()
}

/** Asks yes or no. */
export async function confirm(question: string, yes = true): Promise<boolean> {
  const st = style(process.stderr)
  process.stderr.write(`${st.bold(question)} ${st.gray(yes ? "(Y/n)" : "(y/N)")} `)
  let answer = yes
  await keys((k) => {
    const c = k.toLowerCase()
    if (c === "y") answer = true
    else if (c === "n" || c === "\x1b") answer = false
    else if (c !== "\r" && c !== "\n") return
    return true
  })
  process.stderr.write((answer ? "Yes" : "No") + "\n")
  return answer
}
