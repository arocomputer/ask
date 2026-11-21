import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

test("bubblewrap discovery probes bundled/system candidates and pins only a successful executable", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-discovery-"))
  for (const name of ["src/sandbox", "native/build", "bin"]) mkdirSync(join(dir, name), { recursive: true })
  copyFileSync(new URL("../../src/sandbox/linux.ts", import.meta.url), join(dir, "src/sandbox/linux.ts"))
  const bundled = join(dir, `native/build/ask.bwrap-${process.arch}`), system = join(dir, "bin/bwrap"), log = join(dir, "probes")
  const program = (path: string, code: number) => {
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit ${code}\n`)
    chmodSync(path, 0o755)
  }
  program(join(dir, `native/build/ask.sandbox-${process.arch}`), 0)
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { mounts, wrap } = await import(${JSON.stringify(join(dir, "src/sandbox/linux.ts"))});
    const ok = mounts(); process.env.PATH = '/nonexistent';
    if (!ok) { try { wrap({read:[],write:[],protected:[]}, ['/bin/true']); } catch { console.log('refused'); process.exit(0); } process.exit(1); }
    console.log(wrap({dir:'/tmp',tmp:'/tmp',read:[],write:[],protected:[]}, ['/bin/true'])[0]);
  `], { env: { ...process.env, PATH: join(dir, "bin") }, encoding: "utf8" }).trim()
  program(bundled, 0); program(system, 0)
  assert.equal(run(), bundled)
  program(bundled, 1)
  assert.equal(run(), system)
  program(system, 1)
  assert.equal(run(), "refused")
  const probes = readFileSync(log, "utf8").trim().split("\n")
  assert.equal(probes.length, 5)
  assert.ok(probes.every((line) => line.includes("--unshare-pid") && line.includes("--unshare-net") && line.includes("--ro-bind / /")))
})
