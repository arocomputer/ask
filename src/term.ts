// Terminal output in the manner of GitHub's gh: color and symbols only on a terminal (honoring
// NO_COLOR, CLICOLOR_FORCE and TERM=dumb), tables that fit the width there and turn into
// tab-separated lines when piped, relative times, and a spinner on stderr.

import type { State } from "./sessions.ts"

type Stream = NodeJS.WriteStream

/** Whether a stream gets color. */
export function colored(s: Stream): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.CLICOLOR_FORCE && process.env.CLICOLOR_FORCE !== "0") return true
  return !!s.isTTY && process.env.TERM !== "dumb"
}

const codes = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39] } as const

export type Style = Record<keyof typeof codes, (s: string) => string> & { on: boolean }

/** Styling functions for a stream; plain identity functions when it gets no color. */
export function style(s: Stream = process.stdout): Style {
  const on = colored(s)
  const out = { on } as Style
  for (const [name, [open, close]] of Object.entries(codes))
    out[name as keyof typeof codes] = on ? (t: string) => `\x1b[${open}m${t}\x1b[${close}m` : (t: string) => t
  return out
}

/** A state's symbol, colored: gh's ✓ and X, a dot while running. */
export function symbol(state: State, st: Style): string {
  switch (state) {
    case "succeeded":
      return st.green("✓")
    case "failed":
      return st.red("X")
    case "stopped":
      return st.gray("-")
    case "retrying":
      return st.yellow("!")
    case "running":
      return st.yellow("•")
  }
}

/** A state as a word in its color. */
export function stateWord(state: State, st: Style): string {
  const color = { succeeded: st.green, failed: st.red, stopped: st.gray, retrying: st.yellow, running: st.yellow }[state]
  return color(state)
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(iso: string, from = Date.now()): string {
  const s = Math.max(0, (from - Date.parse(iso)) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** "12s", "4m 3s", "1h 2m". */
export function duration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** "1.2k", "200k", "1M". */
export function count(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${+(n / 1_000_000).toFixed(1)}M`
}

const escapes = /\x1b\[[0-9;]*m/g

/** Display width, ignoring color codes. */
export function width(s: string): number {
  return [...s.replace(escapes, "")].length
}

/** Cuts plain text to a width, ending with … when cut. */
export function truncate(s: string, w: number): string {
  const chars = [...s]
  return chars.length <= w ? s : chars.slice(0, Math.max(0, w - 1)).join("") + "…"
}

const controls = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g")

/** Removes terminal control characters from untrusted text, keeping newlines and tabs. */
export function clean(s: string): string {
  return s.replace(controls, "")
}

/**
 * Prints rows as a table. On a terminal, columns are aligned, a header is shown in bold if
 * given, and the column marked `flex` is truncated to fit (losing its color); piped, rows are
 * tab-separated with plain values and no header, like gh's scriptable output. A cell is
 * [plain, styled]; the styled form is what a terminal shows.
 */
export function table(rows: [string, string][][], opts: { header?: string[]; flex?: number; out?: Stream } = {}) {
  const out = opts.out ?? process.stdout
  if (!out.isTTY && !process.env.CLICOLOR_FORCE) {
    for (const row of rows) out.write(row.map(([plain]) => plain).join("\t") + "\n")
    return
  }
  const st = style(out)
  const all = opts.header ? [opts.header.map((h): [string, string] => [h, st.bold(h)]), ...rows] : rows
  const cols = Math.max(0, ...all.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, i) => Math.max(0, ...all.map((r) => (r[i] ? width(r[i][1]) : 0))))
  const flex = opts.flex ?? cols - 1
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (cols - 1)
  const room = out.columns || 80
  if (total > room && flex >= 0) widths[flex] = Math.max(10, widths[flex] - (total - room))
  for (const row of all) {
    const line = row.map(([plain, styled], i) => {
      const shown = width(styled) > widths[i] ? truncate(plain, widths[i]) : styled
      return i === row.length - 1 ? shown : shown + " ".repeat(Math.max(0, widths[i] - width(shown)))
    })
    out.write(line.join("  ").trimEnd() + "\n")
  }
}

const frames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]

/**
 * A spinner on stderr with a changing label, only on a terminal. `stop` clears its line.
 */
export function spinner(label: string) {
  const err = process.stderr
  if (!err.isTTY) return { update(_: string) {}, stop() {} }
  const st = style(err)
  let text = label
  let i = 0
  const draw = () => err.write(`\r${st.yellow(frames[i++ % frames.length])} ${truncate(text, (err.columns || 80) - 3)}\x1b[K`)
  draw()
  const timer = setInterval(draw, 100)
  return {
    update(t: string) {
      text = t
    },
    stop() {
      clearInterval(timer)
      err.write("\r\x1b[K")
    },
  }
}
