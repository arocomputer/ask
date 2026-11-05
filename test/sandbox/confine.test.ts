import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { open, support } from "../../src/sandbox/confine.ts"
import { blocked, start } from "../../src/sandbox/proxy.ts"

const can = support()

/** Runs a script in a fresh sandbox for `dir`; returns its exit status and output, and what close put back. */
async function inside(dir: string, script: string) {
  const sb = await open(dir)
  const c = sb.command(script)
  const r = spawnSync(c.file, c.args, { cwd: dir, env: c.env, encoding: "utf8" })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, reverted: await sb.close() }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-sandbox-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  return dir
}

describe("sandbox", { skip: !can.ok && `this machine can't sandbox: ${!can.ok && can.detail}` }, () => {
  test("a command writes its own folder and temp folder, and nothing else", async () => {
    const dir = repo()
    const outside = mkdtempSync(join(tmpdir(), "ask-outside-"))
    const r = await inside(dir, `echo a > in.txt && echo b > "$TMPDIR/t" && echo c > ${outside}/escape.txt; echo $?`)
    assert.equal(readFileSync(join(dir, "in.txt"), "utf8"), "a\n")
    assert.ok(!existsSync(join(outside, "escape.txt")))
    assert.match(r.out, /Permission denied|Operation not permitted/)
  })

  test("a command can't read outside its folder, the home folder included", async () => {
    const dir = repo()
    const outside = mkdtempSync(join(tmpdir(), "ask-outside-"))
    writeFileSync(join(outside, "secret"), "s3cret")
    const r = await inside(dir, `cat ${outside}/secret; ls ${homedir()} >/dev/null && echo listed; echo "home=$HOME"`)
    assert.doesNotMatch(r.out, /s3cret|listed/)
    assert.doesNotMatch(r.out, new RegExp(`home=${homedir()}\\n`))
  })

  test("a command gets no API keys or agent sockets", async () => {
    process.env.FAKE_API_KEY = "k"
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock"
    const r = await inside(repo(), "env")
    delete process.env.FAKE_API_KEY
    delete process.env.SSH_AUTH_SOCK
    assert.doesNotMatch(r.out, /FAKE_API_KEY|SSH_AUTH_SOCK/)
  })

  test("git hooks and config a command changes are put back, and reported", async () => {
    const dir = repo()
    const config = readFileSync(join(dir, ".git", "config"), "utf8")
    const r = await inside(dir, "echo evil > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git config core.hooksPath /tmp")
    assert.ok(!existsSync(join(dir, ".git", "hooks", "pre-commit")))
    assert.equal(readFileSync(join(dir, ".git", "config"), "utf8"), config)
    assert.deepEqual(r.reverted.map((p) => p.slice(dir.length + 1)).sort(), [".git/config", ".git/hooks/pre-commit"])
  })

  test("a commit works, with the user's name though the home folder is hidden", { skip: !spawnSync("git", ["config", "user.email"]).stdout?.toString().trim() && "no git identity here" }, async () => {
    const dir = repo()
    const r = await inside(dir, "echo a > a && git add a && git commit -qm one && git log --format=%ae")
    assert.equal(r.code, 0, r.out)
  })

  test("a command can't reach a Unix socket made outside it", async () => {
    const dir = repo()
    const sock = join(mkdtempSync(join(tmpdir(), "ask-sock-")), "s")
    const server = (await import("node:net")).createServer().listen(sock)
    await new Promise((ok) => server.once("listening", ok))
    const r = await inside(dir, `${process.execPath} -e 'require("net").connect(${JSON.stringify(sock)}).on("connect",()=>console.log("reached")).on("error",e=>console.log(e.code))'`)
    server.close()
    assert.doesNotMatch(r.out, /reached/)
  })

  test("commands reach the web only through the proxy, and never port 80 or 443 directly", { skip: can.ok && can.network !== "proxy" && "no network here" }, async () => {
    const r = await inside(repo(), `${process.execPath} -e 'require("net").connect(80,"169.254.169.254").on("connect",()=>console.log("reached")).on("error",e=>console.log(e.code))'; echo "proxy=$HTTPS_PROXY"`)
    assert.doesNotMatch(r.out, /reached/)
    assert.match(r.out, /proxy=http:\/\/127\.0\.0\.1:\d+/)
  })
})

describe("proxy", () => {
  test("private, loopback, link-local and mapped addresses are blocked; public ones aren't", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "not-an-ip"])
      assert.equal(blocked(a), true, a)
    for (const a of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) assert.equal(blocked(a), false, a)
  })

  test("CONNECT to a private address, or a name for one, is refused", async () => {
    const p = await start()
    try {
      for (const target of ["127.0.0.1:22", "localhost:22", "169.254.169.254:80"]) {
        const status = await new Promise<number>((done) => request({ host: "127.0.0.1", port: p.port, method: "CONNECT", path: target }).on("connect", (res, socket) => (socket.destroy(), done(res.statusCode ?? 0))).on("error", () => done(-1)).end())
        assert.equal(status, 403, target)
      }
    } finally {
      await p.close()
    }
  })
})

