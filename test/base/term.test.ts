import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { plain, style, table, text, width } from "../../src/base/term.ts"

/** Run terminal capture outside the test reporter's own stdout/stderr. */
const preview = (columns: number, monochrome = true) => execFileSync(process.execPath,
  [fileURLToPath(new URL("../fixtures/terminal.ts", import.meta.url)), String(columns), ...(monochrome ? [] : ["plain"])], { encoding: "utf8" })

test("human fixtures reflow on phones using only monochrome emphasis", () => {
  for (const columns of [32, 40, 80]) {
    const result = preview(columns)
    const lines = plain(result).split("\n")
    assert.ok(lines.every((line) => width(line) < columns), `overflow at ${columns}: ${lines.filter((line) => width(line) >= columns).join("\n")}`)
    assert.doesNotMatch(result, /\x1b\[(?:3\d|4\d|9\d|10\d|38;|48;)/)
    assert.match(result, /│ \x1b\[1mConnect a provider\x1b\[22m/)
    assert.match(result, /  \[x\] Reader\n│ \[ \] \x1b\[1mWriter/)
    assert.doesNotMatch(result, /fixture-only-do-not-display/)
    const session = result.slice(result.indexOf("--- show abc123"), result.indexOf("--- legacy"))
    assert.match(plain(session), /Answer\nThe callback/)
  }
})

test("NO_COLOR produces the same readable fixtures without styling escapes", () => {
  const result = preview(40, false)
  assert.doesNotMatch(result, /\x1b/)
  assert.match(result, /│ Connect a provider/)
})

test("piped table fields stay TSV even when emphasis is forced", () => {
  const before = process.env.CLICOLOR_FORCE
  process.env.CLICOLOR_FORCE = "1"
  let result = ""
  const out = { isTTY: false, write: (s: string) => { result += s } } as NodeJS.WriteStream
  try {
    table([[["succeeded", "done"], ["abc123", style(out).bold("abc123")]]], { header: ["State", "ID"], out })
    assert.equal(result, "succeeded\tabc123\n")
  } finally { if (before === undefined) delete process.env.CLICOLOR_FORCE; else process.env.CLICOLOR_FORCE = before }
})

test("phone output keeps standalone login URLs intact for copying", () => {
  let result = ""
  const out = { isTTY: true, columns: 32, write: (s: string) => { result += s } } as NodeJS.WriteStream
  const url = "https://auth.example/authorize?state=example&code_challenge=long-example"
  text(url, out)
  assert.equal(result, url + "\n")
})
