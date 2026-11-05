// Interactive prompts on a terminal: one question line, "? Which provider?", with typed filter
// text after it and short key help in brackets; a page of seven options with the focused one
// marked "> "; and once answered, the prompt collapses to "? Which provider? OpenCode Go",
// which stays on screen as a record.
// They draw on stderr so stdout stays clean, and only work when stdin and stderr are
// terminals; callers check `interactive()` first.

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
 * link), until `onKey` returns true or `signal` aborts; Ctrl-C exits with 130.
 */
function keys(onKey: (key: string) => boolean | void, signal?: AbortSignal): Promise<void> {
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
    signal?.addEventListener(
      "abort",
      () => {
        cleanup()
        done()
      },
      { once: true },
    )
    stdin.on("data", handler)
  })
}

/** Redraws a block of lines in place on stderr, each cut to the terminal's width. */
function canvas() {
  let drawn = 0
  return {
    draw(lines: string[]) {
      const cols = (process.stderr.columns || 80) - 1
      const fitted = lines.map((l) => (width(l) > cols ? truncate(l.replace(/\x1b\[[0-9;]*m/g, ""), cols) : l))
      process.stderr.write((drawn ? `\x1b[${drawn}A\r` : "\r") + "\x1b[J" + fitted.join("\n") + "\n")
      drawn = fitted.length
    },
    /** Replaces the block with the answered question. */
    settle(line: string) {
      process.stderr.write((drawn ? `\x1b[${drawn}A\r` : "\r") + "\x1b[J" + line + "\n\x1b[?25h")
      drawn = 0
    },
  }
}

const page = 7

function question(text: string): string {
  const st = style(process.stderr)
  return `${st.bold(st.green("?"))} ${st.bold(text)}`
}

/** The question line with its key help after it, or on the next line when both don't fit. */
function asking(text: string, query: string, help: string): string[] {
  const st = style(process.stderr)
  const line = `${question(text)}${query ? ` ${query}` : ""}`
  const bracket = st.cyan(`[${help}]`)
  return width(line) + 2 + help.length + 2 < (process.stderr.columns || 80) ? [`${line}  ${bracket}`] : [line, `  ${bracket}`]
}

function answered(text: string, answer: string): string {
  return `${question(text)} ${style(process.stderr).cyan(answer)}`
}

/** A page of options around the cursor, the focused one marked "> " in cyan. */
function options<T>(shown: Item<T>[], cursor: number, mark?: (item: Item<T>) => string): string[] {
  const st = style(process.stderr)
  const top = Math.max(0, Math.min(cursor - page + 1, shown.length - page))
  return shown.slice(top, top + page).map((o, i) => {
    const here = top + i === cursor
    const hint = o.hint ? st.gray(` - ${o.hint}`) : ""
    return `${here ? st.cyan(">") : " "}${mark ? ` ${mark(o)}` : ""} ${o.label}${hint}`
  })
}

/** Asks for one of the items. Typing filters them; Enter picks the focused one. */
export async function select<T>(text: string, items: Item<T>[], start = 0): Promise<T> {
  const screen = canvas()
  let query = ""
  let cursor = start
  let shown = items
  const render = () => {
    shown = filter(items, query)
    cursor = Math.max(0, Math.min(cursor, shown.length - 1))
    screen.draw([...asking(text, query, "Use arrows to move, type to filter"), ...options(shown, cursor)])
  }
  let picked: Item<T> | undefined
  process.stderr.write("\x1b[?25l")
  render()
  await keys((k) => {
    if (k === "\r" || k === "\n") {
      if (!shown.length) return
      picked = shown[cursor]
      return true
    }
    if (k === "\x1b[A" || k === "\x10") cursor = cursor > 0 ? cursor - 1 : shown.length - 1
    else if (k === "\x1b[B" || k === "\x0e") cursor = cursor < shown.length - 1 ? cursor + 1 : 0
    else if (k === "\x1b") query = ""
    else if (k === "\x7f" || k === "\b") query = query.slice(0, -1)
    else if (!k.startsWith("\x1b") && k >= " ") {
      query += k
      cursor = 0
    }
    render()
  })
  screen.settle(answered(text, picked!.label))
  return picked!.value
}

/** Asks for any number of the items. Space toggles, right arrow picks all, left none, Enter finishes. */
export async function multi<T>(text: string, items: Item<T>[], chosen: T[] = []): Promise<T[]> {
  const st = style(process.stderr)
  const screen = canvas()
  const on = new Set(chosen)
  let query = ""
  let cursor = 0
  let shown = items
  const render = () => {
    shown = filter(items, query)
    cursor = Math.max(0, Math.min(cursor, shown.length - 1))
    const help = "Space to select, Enter to finish, type to filter"
    screen.draw([...asking(text, query, help), ...options(shown, cursor, (o) => (on.has(o.value) ? st.green("[x]") : st.bold("[ ]")))])
  }
  process.stderr.write("\x1b[?25l")
  render()
  await keys((k) => {
    if (k === "\r" || k === "\n") return true
    if (k === "\x1b[A" || k === "\x10") cursor = cursor > 0 ? cursor - 1 : shown.length - 1
    else if (k === "\x1b[B" || k === "\x0e") cursor = cursor < shown.length - 1 ? cursor + 1 : 0
    else if (k === " ") {
      const v = shown[cursor]?.value
      if (v !== undefined) on.has(v) ? on.delete(v) : on.add(v)
    } else if (k === "\x1b[C") for (const o of shown) on.add(o.value)
    else if (k === "\x1b[D") for (const o of shown) on.delete(o.value)
    else if (k === "\x1b") query = ""
    else if (k === "\x7f" || k === "\b") query = query.slice(0, -1)
    else if (!k.startsWith("\x1b") && k > " ") {
      query += k
      cursor = 0
    }
    render()
  })
  const result = items.filter((o) => on.has(o.value))
  screen.settle(answered(text, result.map((o) => o.label).join(", ") || "none"))
  return result.map((o) => o.value)
}

/** Asks for a secret, echoing one * per character; a paste ending in a newline submits it. */
export async function secret(text: string): Promise<string> {
  process.stderr.write(`${question(text)} `)
  let value = ""
  await keys((k) => {
    if (k === "\r" || k === "\n") return true
    if (k === "\x7f" || k === "\b") {
      if (value) process.stderr.write("\b \b")
      value = value.slice(0, -1)
    } else if (!k.startsWith("\x1b") && k >= " ") {
      value += k
      process.stderr.write("*")
    }
  })
  process.stderr.write("\n")
  return value.trim()
}

/** Asks for a line of text, offering `initial` in parentheses; Enter alone keeps it. */
export async function input(text: string, initial = ""): Promise<string> {
  const st = style(process.stderr)
  const screen = canvas()
  let value = ""
  const render = () => screen.draw([`${question(text)} ${initial ? st.gray(`(${initial}) `) : ""}${value}`])
  render()
  await keys((k) => {
    if (k === "\r" || k === "\n") return true
    if (k === "\x7f" || k === "\b") value = value.slice(0, -1)
    else if (!k.startsWith("\x1b") && k >= " ") value += k
    render()
  })
  const result = value.trim() || initial
  screen.settle(answered(text, result))
  return result
}

/**
 * Asks for a line of text, shown as it is typed or pasted. Resolves to undefined when `signal`
 * aborts first, leaving `done` as the answer on screen.
 */
export async function line(text: string, signal: AbortSignal, done: string): Promise<string | undefined> {
  const screen = canvas()
  let value = ""
  const render = () => screen.draw([`${question(text)} ${value}`])
  render()
  await keys((k) => {
    if (k === "\r" || k === "\n") return value.trim().length > 0 || undefined
    if (k === "\x7f" || k === "\b") value = value.slice(0, -1)
    else if (!k.startsWith("\x1b") && k >= " ") value += k
    render()
  }, signal)
  screen.settle(answered(text, signal.aborted ? done : "pasted"))
  return signal.aborted ? undefined : value.trim()
}

/** Asks yes or no. */
export async function confirm(text: string, yes = true): Promise<boolean> {
  const st = style(process.stderr)
  const screen = canvas()
  screen.draw([`${question(text)} ${st.gray(yes ? "(Y/n)" : "(y/N)")}`])
  let answer = yes
  await keys((k) => {
    const c = k.toLowerCase()
    if (c === "y") answer = true
    else if (c === "n") answer = false
    else if (c !== "\r" && c !== "\n") return
    return true
  })
  screen.settle(answered(text, answer ? "Yes" : "No"))
  return answer
}
