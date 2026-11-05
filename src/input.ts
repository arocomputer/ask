// Interactive prompts on a terminal, in the manner of gh's: a list picked with the arrow keys
// and narrowed by typing, hidden entry for keys, and yes/no. They draw on stderr so stdout stays
// clean, and only work when stdin and stderr are terminals; callers check `interactive()` first.

import { style, truncate } from "./term.ts"

export type Option<T> = { label: string; hint?: string; value: T }

export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stderr.isTTY
}

/** Options whose label or hint contains every word of the query, case-insensitively. */
export function filter<T>(options: Option<T>[], query: string): Option<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return options.filter((o) => {
    const text = `${o.label} ${o.hint ?? ""}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/** Reads keys in raw mode until `onKey` returns true; Ctrl-C exits with 130. */
function keys(onKey: (key: string) => boolean | void): Promise<void> {
  const stdin = process.stdin
  return new Promise((done) => {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const handler = (data: string) => {
      if (data === "\x03") {
        cleanup()
        process.stderr.write("\n")
        process.exit(130)
      }
      if (onKey(data)) {
        cleanup()
        done()
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

/**
 * Asks for one of the options. With `filterable`, typing narrows the list; with `shortlist`,
 * only those are shown until something is typed, and typing searches every option.
 */
export async function select<T>(question: string, options: Option<T>[], opts: { filterable?: boolean; shortlist?: Option<T>[]; start?: number } = {}): Promise<T> {
  const err = process.stderr
  const st = style(err)
  const size = 7
  let query = ""
  let cursor = opts.start ?? 0
  let drawn = 0
  const draw = () => {
    const shown = !query && opts.shortlist ? opts.shortlist : filter(options, query)
    cursor = Math.min(cursor, Math.max(0, shown.length - 1))
    const top = Math.max(0, Math.min(cursor - Math.floor(size / 2), shown.length - size))
    const help = opts.shortlist ? "[Use arrows to move, type to search all]" : opts.filterable ? "[Use arrows to move, type to filter]" : "[Use arrows to move]"
    const lines = [`${st.green("?")} ${st.bold(question)} ${query ? st.cyan(query) : st.gray(help)}`]
    const cols = (err.columns || 80) - 4
    for (let i = top; i < Math.min(shown.length, top + size); i++) {
      const o = shown[i]
      const text = truncate(o.hint ? `${o.label}  ${o.hint}` : o.label, cols)
      const label = text.slice(0, o.label.length)
      const rest = text.slice(o.label.length)
      lines.push(i === cursor ? st.cyan(`> ${label}`) + st.gray(rest) : `  ${label}${st.gray(rest)}`)
    }
    if (!shown.length) lines.push(st.gray("  no matches"))
    err.write((drawn ? `\x1b[${drawn}A\r` : "") + "\x1b[J" + lines.join("\n") + "\n")
    drawn = lines.length
    return shown
  }
  let shown = draw()
  let picked: Option<T> | undefined
  err.write("\x1b[?25l")
  await keys((k) => {
    if (k === "\r" || k === "\n") {
      if (!shown.length) return
      picked = shown[cursor]
      return true
    }
    if (k === "\x1b[A" || k === "\x10") cursor = (cursor - 1 + shown.length) % Math.max(1, shown.length)
    else if (k === "\x1b[B" || k === "\x0e") cursor = (cursor + 1) % Math.max(1, shown.length)
    else if (k === "\x7f" || k === "\b") query = query.slice(0, -1)
    else if ((opts.filterable || opts.shortlist) && !k.startsWith("\x1b") && k >= " ") {
      query += k.replace(/[\r\n]/g, "")
      cursor = 0
    }
    shown = draw()
  })
  err.write(`\x1b[${drawn}A\r\x1b[J${st.green("?")} ${st.bold(question)} ${st.cyan(picked!.label)}\n\x1b[?25h`)
  return picked!.value
}

/** Asks for a secret without showing it; a pasted value with a trailing newline ends the entry. */
export async function secret(question: string): Promise<string> {
  const err = process.stderr
  const st = style(err)
  err.write(`${st.green("?")} ${st.bold(question)} `)
  let value = ""
  await keys((k) => {
    for (const c of k) {
      if (c === "\r" || c === "\n") return value.length > 0 || undefined
      if (c === "\x7f" || c === "\b") value = value.slice(0, -1)
      else if (c >= " ") value += c
    }
  })
  err.write(st.gray("(hidden)") + "\n")
  return value.trim()
}

/** Asks yes or no. */
export async function confirm(question: string, yes = true): Promise<boolean> {
  const err = process.stderr
  const st = style(err)
  err.write(`${st.green("?")} ${st.bold(question)} ${st.gray(yes ? "(Y/n)" : "(y/N)")} `)
  let answer = yes
  await keys((k) => {
    const c = k.toLowerCase()
    if (c === "y") answer = true
    else if (c === "n") answer = false
    else if (c !== "\r" && c !== "\n") return
    return true
  })
  err.write(st.cyan(answer ? "Yes" : "No") + "\n")
  return answer
}
