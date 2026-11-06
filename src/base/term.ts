// Monochrome terminal output: the user's foreground/background, bold emphasis and dim details.
// Tables become stacked records on narrow terminals and stay TSV in pipes. No colored states,
// forced backgrounds or animated decoration; NO_COLOR and TERM=dumb also disable emphasis.

/** A task's state, as sessions/store.ts keeps it. */
type State = "running" | "retrying" | "succeeded" | "failed" | "stopped"

type Stream = NodeJS.WriteStream

/** Whether a stream gets monochrome emphasis (also honors the conventional force-color flag). */
export function colored(s: Stream): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === "dumb") return false
  if (process.env.CLICOLOR_FORCE && process.env.CLICOLOR_FORCE !== "0") return true
  return !!s.isTTY && process.env.TERM !== "dumb"
}

const codes = { bold: [1, 22], gray: [2, 22] } as const

export type Style = Record<keyof typeof codes, (s: string) => string> & { on: boolean }

/** Bold and dim styles, or plain identity functions when emphasis is disabled. */
export function style(s: Stream = process.stdout): Style {
  const on = colored(s)
  const out = { on } as Style
  for (const [name, [open, close]] of Object.entries(codes))
    out[name as keyof typeof codes] = on ? (t: string) => `\x1b[${open}m${t}\x1b[${close}m` : (t: string) => t
  return out
}

/** Human-readable states; the protocol continues to use its original state names. */
export function symbol(state: State, st: Style): string {
  return state === "succeeded" ? "done" : state === "failed" ? st.bold("failed") : state
}

/** "less than a minute ago", "about 5 minutes ago", "about 1 day ago", and so on. */
export function ago(iso: string, from = Date.now()): string {
  const s = Math.max(0, (from - Date.parse(iso)) / 1000)
  const say = (n: number, unit: string) => `about ${n} ${unit}${n === 1 ? "" : "s"} ago`
  if (s < 60) return "less than a minute ago"
  if (s < 3600) return say(Math.floor(s / 60), "minute")
  if (s < 86400) return say(Math.floor(s / 3600), "hour")
  if (s < 30 * 86400) return say(Math.floor(s / 86400), "day")
  if (s < 365 * 86400) return say(Math.floor(s / (30 * 86400)), "month")
  return say(Math.floor(s / (365 * 86400)), "year")
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

/** Plain text without styling, used to measure and reflow our own terminal output. */
export const plain = (s: string): string => s.replace(escapes, "")

/** Display width, ignoring color codes. */
export function width(s: string): number {
  return [...s.replace(escapes, "")].length
}

/** Cuts plain text to a width, ending with … when cut. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return ""
  const chars = [...s]
  return chars.length <= w ? s : chars.slice(0, Math.max(0, w - 1)).join("") + "…"
}

/** Wrap plain prose, retaining explicit newlines and every character of long paths/URLs. */
export function wrap(text: string, columns: number): string[] {
  const size = Math.max(1, columns)
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = []
    let rest = [...paragraph]
    while (rest.length > size) {
      const space = rest.slice(0, size + 1).lastIndexOf(" ")
      const cut = space > 0 ? space : size
      lines.push(rest.slice(0, cut).join(""))
      rest = rest.slice(cut + (space > 0 ? 1 : 0))
    }
    lines.push(rest.join(""))
    return lines
  })
}

/** Reflow prose on phones; standalone URLs soft-wrap in the terminal so they remain clickable. */
export function text(value: string, out: Stream = process.stdout) {
  const room = Math.max(1, (out.columns || 80) - 1)
  for (const line of value.split("\n")) {
    const lines = out.isTTY && width(line) > room && !/^https?:\/\/\S+$/.test(plain(line)) ? wrap(plain(line), room) : [line]
    out.write(lines.join("\n") + "\n")
  }
}

/** A quiet title, only for a human terminal; never adds headers to piped data. */
export function heading(label: string, out: Stream = process.stdout) {
  if (out.isTTY) text(style(out).bold(`ask / ${label}`) + "\n", out)
}

const controls = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g")

/** Removes terminal control characters from untrusted text, keeping newlines and tabs. */
export function clean(s: string): string {
  return s.replace(controls, "")
}

/**
 * Prints aligned columns on wide terminals, labeled records when columns won't fit without
 * squeezing identifiers. Piped rows remain tab-separated plain values without headers. A cell is
 * [plain, styled]; the styled form is what a terminal shows.
 */
export function table(rows: [string, string][][], opts: { header?: string[]; flex?: number; out?: Stream } = {}) {
  const out = opts.out ?? process.stdout
  if (!out.isTTY) {
    for (const row of rows) out.write(row.map(([plain]) => plain).join("\t") + "\n")
    return
  }
  const st = style(out)
  const all = opts.header ? [opts.header.map((h): [string, string] => [h, st.bold(h)]), ...rows] : rows
  const cols = Math.max(0, ...all.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, i) => Math.max(0, ...all.map((r) => (r[i] ? width(r[i][1]) : 0))))
  const flex = opts.flex ?? cols - 1
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (cols - 1)
  const room = Math.max(1, (out.columns || 80) - 1)
  if (room < 60 || (total > room && (flex < 0 || widths[flex] - (total - room) < 20))) {
    for (const [index, row] of rows.entries()) {
      if (index) out.write("\n")
      for (const [i, [, styled]] of row.entries()) {
        const value = plain(styled)
        if (!value) continue
        const label = opts.header?.[i]?.toLowerCase()
        const content = i === 0 ? value : `${label ? label + "  " : ""}${value}`
        for (const line of wrap(content, room - (i ? 2 : 0))) out.write((i ? "  " : "") + (i ? line : st.bold(line)) + "\n")
      }
    }
    return
  }
  if (total > room && flex >= 0) widths[flex] -= total - room
  for (const row of all) {
    const line = row.map(([plain, styled], i) => {
      const shown = width(styled) > widths[i] ? truncate(plain, widths[i]) : styled
      return i === row.length - 1 ? shown : shown + " ".repeat(Math.max(0, widths[i] - width(shown)))
    })
    out.write(line.join("  ").trimEnd() + "\n")
  }
}

/**
 * A stable progress line on stderr. No timer or animation; update changes its label, stop clears it.
 */
export function spinner(label: string) {
  const err = process.stderr
  if (!err.isTTY || process.env.TERM === "dumb") return { update(_: string) {}, stop() {} }
  let text = label
  const draw = () => err.write(`\r${truncate(text + "…", (err.columns || 80) - 1)}\x1b[K`)
  draw()
  return {
    update(t: string) {
      text = t
      draw()
    },
    stop() {
      err.write("\r\x1b[K")
    },
  }
}
