import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, mkdirSync, linkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { open, support } from "../../src/sandbox/confine.ts"
import { blocked } from "../../src/sandbox/address.ts"

const can = support()

test("explicitly disabled confinement runs directly while filtering credentials", async () => {
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = "test-credential"
  const dir = repo()
  const sb = await open(dir, false, false)
  try {
    assert.equal(sb.enabled, false)
    const command = sb.command("printf unrestricted > .git/probe")
    assert.equal(command.file, "/bin/sh")
    assert.equal(command.env.DATABASE_URL, undefined)
    assert.equal(command.env.HOME, homedir())
    const result = spawnSync(command.file, command.args, { cwd: dir, env: command.env })
    assert.equal(result.status, 0)
    assert.equal(readFileSync(join(dir, ".git/probe"), "utf8"), "unrestricted")
  } finally {
    await sb.close()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

/** Runs a script in a fresh sandbox for `dir`; returns its exit status and output, and what close put back. */
async function inside(dir: string, script: string) {
  const sb = await open(dir)
  const c = sb.command(script)
  const r = spawnSync(c.file, c.args, { cwd: dir, env: c.env, encoding: "utf8" })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, reverted: await sb.close() }
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ask-sandbox-")))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  return dir
}

describe("sandbox", { skip: !can.ok && `this machine can't sandbox: ${!can.ok && can.detail}` }, () => {
  test("a hard-link alias created during execution cannot make existing Git metadata writable", async () => {
    const dir = repo()
    const original = readFileSync(join(dir, ".git/config"), "utf8")
    const r = await inside(dir, "ln .git/config alias && printf poison > alias")
    assert.notEqual(r.code, 0, r.out)
    assert.equal(readFileSync(join(dir, ".git/config"), "utf8"), original)
  })

  test("failed policy construction removes all newly created scratch state", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ask-bad-policy-")))
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ask-scratch-parent-")))
    symlinkSync(dir, join(dir, ".git"))
    const before = process.env.TMPDIR
    try {
      process.env.TMPDIR = scratch
      await assert.rejects(open(dir), /symlinked Git/)
      assert.deepEqual(readdirSync(scratch), [])
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })

  test("a command writes its own folder and temp folder, and nothing else", async () => {
    const dir = repo()
    const outside = mkdtempSync(join(tmpdir(), "ask-outside-"))
    const r = await inside(dir, `echo a > in.txt && echo b > "$TMPDIR/t" && echo c > ${outside}/escape.txt; echo $?`)
    assert.equal(readFileSync(join(dir, "in.txt"), "utf8"), "a\n")
    assert.ok(!existsSync(join(outside, "escape.txt")))
    assert.match(r.out, /Permission denied|Operation not permitted|Read-only file system/)
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

  test("sandbox commands do not inherit arbitrary credential-bearing variables", async () => {
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = "database-secret"
    try {
      const r = await inside(repo(), "env")
      assert.doesNotMatch(r.out, /DATABASE_URL|database-secret/)
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  test("git hooks and config are protected during execution", async () => {
    const dir = repo()
    const config = readFileSync(join(dir, ".git", "config"), "utf8")
    const r = await inside(dir, "echo evil > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git config core.hooksPath /tmp")
    assert.ok(!existsSync(join(dir, ".git", "hooks", "pre-commit")))
    assert.equal(readFileSync(join(dir, ".git", "config"), "utf8"), config)
    assert.notEqual(r.code, 0, r.out)
    assert.deepEqual(r.reverted, [])
  })

  test("git hook symlinks cannot be replaced", async () => {
    const dir = repo()
    const hooks = join(dir, ".git", "hooks")
    symlinkSync("original", join(hooks, "post-commit"))
    const r = await inside(dir, "ln -s ../../payload .git/hooks/pre-commit && rm .git/hooks/post-commit && ln -s ../../payload .git/hooks/post-commit")
    assert.notEqual(r.code, 0, r.out)
    assert.equal(lstatSync(join(hooks, "pre-commit"), { throwIfNoEntry: false }), undefined)
    assert.ok(lstatSync(join(hooks, "post-commit")).isSymbolicLink())
    assert.equal(readlinkSync(join(hooks, "post-commit")), "original")
    assert.deepEqual(r.reverted, [])
  })

  test("working files are writable but staging is refused", async () => {
    const dir = repo()
    const r = await inside(dir, "echo a > a && git add a && git commit -qm one && git log --format=%ae")
    assert.notEqual(r.code, 0, r.out)
    assert.equal(readFileSync(join(dir, "a"), "utf8"), "a\n")
    assert.ok(!existsSync(join(dir, ".git", "index")))
  })

  test("closing concurrent sandboxes preserves the user's Git changes", async () => {
    const dir = repo()
    const first = await open(dir)
    const second = await open(dir)
    const config = join(dir, ".git", "config")
    const updated = readFileSync(config, "utf8") + "\n# user changed this while tasks ran\n"
    writeFileSync(config, updated)
    await first.close()
    await second.close()
    assert.equal(readFileSync(config, "utf8"), updated)
  })

  test("linked worktree configuration cannot be planted", async () => {
    const dir = repo()
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"], { cwd: dir })
    execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: dir })
    const tree = join(mkdtempSync(join(tmpdir(), "ask-linked-")), "tree")
    execFileSync("git", ["worktree", "add", "-qb", "test", tree], { cwd: dir })
    const r = await inside(tree, "git config --worktree core.hooksPath payload")
    assert.notEqual(r.code, 0, r.out)
    assert.equal(spawnSync("git", ["config", "--worktree", "--get", "core.hooksPath"], { cwd: tree }).status, 1)
  })

  test("nested Git metadata cannot be moved out of protection", async () => {
    const dir = repo()
    mkdirSync(join(dir, "nested"))
    execFileSync("git", ["init", "-q", join(dir, "nested")])
    const original = readFileSync(join(dir, "nested", ".git", "config"), "utf8")
    const r = await inside(dir, "mv nested moved && echo poison > moved/.git/config")
    assert.notEqual(r.code, 0, r.out)
    const location = existsSync(join(dir, "nested")) ? "nested" : "moved"
    assert.equal(readFileSync(join(dir, location, ".git", "config"), "utf8"), original)
  })

  test("Git metadata with writable hardlink aliases is refused", async () => {
    const dir = repo()
    linkSync(join(dir, ".git", "config"), join(dir, "alias"))
    await assert.rejects(open(dir), /hardlink aliases/)
  })

  test("included Git configuration in the workspace is read-only", async () => {
    const dir = repo()
    writeFileSync(join(dir, "..included.conf"), "[core]\n\tfilemode = true\n")
    execFileSync("git", ["config", "include.path", "../..included.conf"], { cwd: dir })
    const original = readFileSync(join(dir, "..included.conf"), "utf8")
    const r = await inside(dir, "echo poison > ..included.conf")
    assert.notEqual(r.code, 0, r.out)
    assert.equal(readFileSync(join(dir, "..included.conf"), "utf8"), original)
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

  test("commands cannot connect to a host service on a nonstandard port", async () => {
    const server = (await import("node:net")).createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as import("node:net").AddressInfo).port
      const r = await inside(repo(), `node -e 'require("net").connect(${port},"127.0.0.1").on("connect",()=>console.log("reached")).on("error",e=>console.log(e.code))'`)
      assert.doesNotMatch(r.out, /reached/)
      assert.match(r.out, /EPERM|EACCES|Operation not permitted|Permission denied/)
    } finally {
      server.close()
    }
  })
})

describe("public addresses", () => {
  test("private, loopback, link-local and mapped addresses are blocked; public ones aren't", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "not-an-ip"])
      assert.equal(blocked(a), true, a)
    for (const a of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) assert.equal(blocked(a), false, a)
  })

})
