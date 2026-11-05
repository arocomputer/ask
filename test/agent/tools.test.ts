import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fetch, text } from "../../src/agent/fetch.ts"
import { lite, mwmbl, results, search, wikipedia } from "../../src/agent/search.ts"
import { tools } from "../../src/agent/tools.ts"

const all = Object.fromEntries(tools(true).map((t) => [t.name, t]))

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ask-tools-"))
  mkdirSync(join(d, "src/deep"), { recursive: true })
  writeFileSync(join(d, "src/a.ts"), "one\ntwo\nthree\n")
  writeFileSync(join(d, "src/deep/b.ts"), "const two = 2\n")
  writeFileSync(join(d, "notes.md"), "two words\n")
  return d
}

describe("tools", () => {
  test("read numbers lines from the start line", async () => {
    assert.equal(await all.read.run({ path: "src/a.ts", line: 2 }, { dir: dir() }), "2\ttwo\n3\tthree\n")
  })

  test("a symlink can't lead outside the working directory", async () => {
    const d = dir()
    symlinkSync(tmpdir(), join(d, "out"))
    await assert.rejects(all.read.run({ path: "out/x" }, { dir: d }), /outside the working directory/)
  })

  test("a write can't land outside the working directory", async () => {
    const d = dir()
    await assert.rejects(all.write.run({ path: "../escaped.txt", content: "x" }, { dir: d }), /outside the working directory/)
    await assert.rejects(all.write.run({ path: "/tmp/escaped.txt", content: "x" }, { dir: d }), /outside the working directory/)
  })

  test("shell commands can't see provider keys", async () => {
    process.env.SOME_PROVIDER_API_KEY = "secret"
    try {
      assert.equal(await all.shell.run({ command: "echo \"[$SOME_PROVIDER_API_KEY]\"" }, { dir: dir() }), "exit 0\n[]\n")
    } finally {
      delete process.env.SOME_PROVIDER_API_KEY
    }
  })

  test("list with a pattern finds files at any depth", async () => {
    assert.equal(await all.list.run({ pattern: "src/**/*.ts" }, { dir: dir() }), "src/a.ts\nsrc/deep/b.ts")
  })

  test("grep reports path:line:text, limited by glob", async () => {
    assert.equal(await all.grep.run({ pattern: "two", glob: "*.ts" }, { dir: dir() }), "src/a.ts:2:two\nsrc/deep/b.ts:1:const two = 2")
  })

  test("edit refuses text that occurs more than once", async () => {
    const d = dir()
    writeFileSync(join(d, "twice.txt"), "x\nx\n")
    await assert.rejects(all.edit.run({ path: "twice.txt", old: "x", new: "y" }, { dir: d }), /occurs 2 times/)
  })

  test("shell stops a command at its timeout, children included", async () => {
    const start = Date.now()
    const out = await all.shell.run({ command: "sleep 30 & sleep 30; wait", timeout: 1 }, { dir: dir() })
    assert.match(out, /^timed out after 1 seconds/)
    assert.ok(Date.now() - start < 5000)
  })

  test("shell keeps the start and the end of long output", async () => {
    const out = await all.shell.run({ command: "echo first; head -c 100000 /dev/zero | tr '\\0' x; echo; echo last" }, { dir: dir() })
    assert.match(out, /^exit 0\nfirst\n/)
    assert.match(out, /bytes cut/)
    assert.match(out, /last\n$/)
  })
})

describe("fetch", () => {
  test("refuses this machine, the local network and cloud metadata, and anything but http", async () => {
    for (const url of ["http://127.0.0.1:9/", "http://localhost/", "http://169.254.169.254/latest/", "http://[::1]/", "file:///etc/passwd"])
      await assert.rejects(fetch.run({ url }, { dir: "." }), /private address|only http/, url)
  })

  test("turns HTML into readable text", () => {
    assert.equal(text("<html><head><title>x</title></head><body><script>bad()</script><h1>Title</h1><p>A &amp; B&#33;</p><ul><li>one</li></ul></body></html>"), "Title\nA & B!\n- one")
  })
})

describe("search", () => {
  test("lists each result once, with its title, address and snippet, and needs a query", async () => {
    const tool = search(async () => [
      { title: "A", url: "https://a/", snippet: "about a" },
      { title: "A again", url: "https://a/", snippet: "" },
      { title: "B", url: "https://b/", snippet: "" },
    ])
    assert.equal(await tool.run({ query: "x" }, { dir: "." }), "1. A\n   https://a/\n   about a\n2. B\n   https://b/")
    await assert.rejects(tool.run({ query: " " }, { dir: "." }), /query is required/)
  })

  test("reads DuckDuckGo's results page, ads left out, addresses unwrapped", () => {
    const page = `<div class="result results_links results_links_deep result--ad"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
<div class="result results_links results_links_deep web-result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F&amp;rut=abc">Bun &mdash; <b>fast</b></a></h2><a class="result__snippet" href="//x">A <b>JavaScript</b> runtime &amp; toolkit</a></div>`
    assert.deepEqual(results(page), [{ title: "Bun — fast", url: "https://bun.sh/", snippet: "A JavaScript runtime & toolkit" }])
  })

  test("reads the lite page, Mwmbl's and Wikipedia's answers, the engines tried when DuckDuckGo turns a search away", () => {
    const page = `<tr><td><a rel="nofollow" href="https://github.com/oven-sh/bun/releases" class='result-link'>Releases: oven-sh/bun</a></td></tr>
<tr><td class='result-snippet'>
  Fast <b>JavaScript</b> runtime
</td></tr>`
    assert.deepEqual(lite(page), [{ title: "Releases: oven-sh/bun", url: "https://github.com/oven-sh/bun/releases", snippet: "Fast JavaScript runtime" }])
    const answer = [{ url: "https://bun.sh/", title: [{ value: "Bun", is_bold: true }, { value: " docs" }], extract: [{ value: "All in one" }] }, { url: "javascript:x", title: "bad" }]
    assert.deepEqual(mwmbl(answer), [{ title: "Bun docs", url: "https://bun.sh/", snippet: "All in one" }])
    const wiki = { query: { search: [{ title: "Bun (software)", snippet: '<span class="searchmatch">Bun</span> is a runtime' }] } }
    assert.deepEqual(wikipedia(wiki), [{ title: "Bun (software)", url: "https://en.wikipedia.org/wiki/Bun_(software)", snippet: "Bun is a runtime" }])
  })
})

describe("environment files", () => {
  test("read refuses them and grep skips them; their examples stay readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-env-"))
    writeFileSync(join(dir, ".env"), "TOKEN=real\n")
    writeFileSync(join(dir, ".env.local"), "TOKEN=real\n")
    writeFileSync(join(dir, ".env.example"), "TOKEN=example\n")
    const [read, , grep] = tools(false)
    await assert.rejects(read.run({ path: ".env" }, { dir }), /environment file/)
    assert.match(await read.run({ path: ".env.example" }, { dir }), /TOKEN=example/)
    assert.doesNotMatch(await grep.run({ pattern: "TOKEN" }, { dir }), /real/)
  })
})
