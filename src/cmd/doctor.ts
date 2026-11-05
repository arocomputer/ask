// ask doctor: checks everything a task needs, one line each, with what to do about any that
// fail. Exits 1 when something is broken.

import { execFile } from "node:child_process"
import { accessSync, constants, mkdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { find, providers, type Catalog } from "../catalog.ts"
import { catalog, credential, readJSON, type Auth, type Config, type Home } from "../home.ts"
import { alive, latest, list } from "../sessions.ts"
import { ago, spinner, style } from "../term.ts"
import { status } from "../claude.ts"
import { check } from "./settings.ts"

export const summary = "Check that ask can run tasks"
export const about = `Check that ask can run tasks: its runtime, its home folder, the model catalog, the default
model and its key, the background worker and git. Anything broken comes with how to fix it.`
export const usage = "ask doctor"

type Line = { mark: "ok" | "warn" | "fail"; name: string; detail: string; fix?: string }

export async function run(h: Home): Promise<number> {
  const out: Line[] = []
  const add = (l: Line) => {
    out.push(l)
    print(l)
  }

  const bun = (process.versions as Record<string, string>).bun
  const major = Number(process.versions.node.split(".")[0])
  add(bun ? { mark: "ok", name: "Runtime", detail: `Bun ${bun}` } : major >= 24 ? { mark: "ok", name: "Runtime", detail: `Node ${process.versions.node}` } : { mark: "fail", name: "Runtime", detail: `Node ${process.versions.node}`, fix: "ask needs Node 24 or newer, or Bun" })

  try {
    mkdirSync(h.root, { recursive: true, mode: 0o700 })
    accessSync(h.root, constants.W_OK)
    add({ mark: "ok", name: "Home", detail: `${h.root} is writable` })
  } catch {
    add({ mark: "fail", name: "Home", detail: `${h.root} isn't writable`, fix: "fix its permissions, or point ASK_HOME somewhere writable" })
  }

  let c: Catalog | undefined
  try {
    c = await catalog(h)
    const age = statSync(h.catalog).mtime.toISOString()
    const stale = Date.now() - Date.parse(age) > 7 * 86400_000
    add({ mark: stale ? "warn" : "ok", name: "Catalog", detail: `${providers(c).length} providers, updated ${ago(age)}`, fix: stale ? "models.dev can't be reached; ask models --refresh retries" : undefined })
  } catch (err) {
    add({ mark: "fail", name: "Catalog", detail: (err as Error).message, fix: "check the network; ask needs models.dev once" })
  }

  const cfg = readJSON<Config>(h.config, {})
  if (c) {
    if (!cfg.model) add({ mark: "fail", name: "Model", detail: "no default model", fix: "ask settings" })
    else {
      try {
        const m = find(c, cfg.model)
        add({ mark: "ok", name: "Model", detail: cfg.model })
        const cred = credential(h, m.provider, m.env)
        if (m.protocol === "claude") {
          const s = status()
          add(
            s.signedIn
              ? { mark: "ok", name: "Key", detail: `Claude Code ${s.version ?? ""} is signed in${s.method ? ` (${s.method})` : ""}`.replace("  ", " ") }
              : { mark: "fail", name: "Key", detail: s.installed ? "Claude Code isn't signed in" : "Claude Code isn't installed", fix: s.installed ? "run claude and sign in with /login" : "install it from https://claude.com/claude-code" },
          )
        } else if (!cred) add({ mark: "fail", name: "Key", detail: `no key for ${m.provider}`, fix: "ask settings" })
        else {
          const sp = spinner(`Checking the ${c[m.provider].name} key`)
          const problem = await check(m, cred.key, readJSON<Auth>(h.auth, {})[m.provider]?.base_url)
          sp.stop()
          add(problem ? { mark: "fail", name: "Key", detail: problem, fix: "ask settings, then Providers" } : { mark: "ok", name: "Key", detail: `${c[m.provider].name} accepts the ${cred.source}` })
        }
      } catch (err) {
        add({ mark: "fail", name: "Model", detail: (err as Error).message, fix: "ask settings, then Default model" })
      }
    }
  }

  const cli = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url))
  const args = cli.startsWith("/$bunfs") ? ["--version"] : [cli, "--version"]
  const started = await output(process.execPath, args)
  add(started?.startsWith("ask ") ? { mark: "ok", name: "Worker", detail: "background tasks can start" } : { mark: "fail", name: "Worker", detail: `${process.execPath} can't run ask`, fix: "reinstall ask" })

  const git = await output("git", ["--version"])
  add(git ? { mark: "ok", name: "Git", detail: git.replace(/^git version /, "git ") } : { mark: "warn", name: "Git", detail: "not found", fix: "install git to see what write tasks changed" })

  const lost = list(h).filter((s) => ["running", "retrying"].includes(latest(s).state) && !alive(s))
  if (lost.length) add({ mark: "warn", name: "Sessions", detail: `${lost.length} ended without their worker: ${lost.slice(0, 3).map((s) => s.id).join(", ")}${lost.length > 3 ? ", …" : ""}`, fix: "ask show ID tells you why; continue them to try again" })

  return out.some((l) => l.mark === "fail") ? 1 : 0
}

function print(l: Line) {
  const st = style()
  const mark = l.mark === "ok" ? st.green("✓") : l.mark === "warn" ? st.yellow("!") : st.red("X")
  process.stdout.write(`${mark} ${l.name.padEnd(9)} ${l.detail}\n`)
  if (l.fix) process.stdout.write(st.gray(`  ${" ".repeat(9)} ${l.fix}`) + "\n")
}

/** Runs a command and resolves to its trimmed output, or undefined when it fails. */
function output(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => execFile(cmd, args, { timeout: 15_000 }, (err, out) => done(err ? undefined : out.trim())))
}
