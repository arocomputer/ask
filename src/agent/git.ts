// The git tool: lets every task, read-only ones included, see what changed and why: status,
// diff, log, show and blame. Nothing it runs can write or execute anything a repository's own
// config names: no diff filters or external diff programs, no signature checks (which would
// start gpg.program), no filesystem monitor, no pager, no optional locks; and no option that
// writes a file (--output) or reads outside the repository (--no-index).

import { execFile } from "node:child_process"
import type { Tool } from "./tools.ts"

const commands = ["status", "diff", "log", "show", "blame"]
const refused = /^(--output|--no-index|--ext-diff|--textconv|--exec|--git-dir|--work-tree|--upload-pack|--receive-pack|-c$|-C$|--open-files-in-pager|-O)/
const limit = 32 * 1024

/** git with the repository unable to start anything, whatever its config says. */
const safety = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "gpg.program=false", "-c", "log.showSignature=false", "-c", "diff.external=", "-c", "color.ui=false", "--no-pager"]

/** Flags each command takes to switch off what config could turn on. */
const off: Record<string, string[]> = {
  diff: ["--no-ext-diff", "--no-textconv"],
  log: ["--no-ext-diff", "--no-textconv", "--no-show-signature"],
  show: ["--no-ext-diff", "--no-textconv", "--no-show-signature"],
  blame: ["--no-textconv"],
  status: [],
}

export const git: Tool = {
  name: "git",
  description:
    "Run a read-only git command in the working directory: status, diff, log, show or blame, with their usual arguments, like [\"diff\", \"--stat\"], [\"log\", \"-5\", \"--oneline\"] or [\"show\", \"HEAD~1:src/a.ts\"]. Use it to see what changed (git diff for uncommitted work) and why.",
  parameters: {
    type: "object",
    properties: { args: { type: "array", items: { type: "string" }, description: "The command and its arguments, like [\"diff\", \"--stat\"]" } },
    required: ["args"],
    additionalProperties: false,
  },
  readonly: true,
  run(input, { dir, signal }) {
    const args = Array.isArray(input.args) ? input.args.map(String) : []
    const [command, ...rest] = args
    if (!commands.includes(command)) return Promise.reject(new Error(`git takes one of ${commands.join(", ")}`))
    const bad = rest.find((a) => refused.test(a))
    if (bad) return Promise.reject(new Error(`${bad} isn't allowed here`))
    return new Promise((done) =>
      execFile(
        "git",
        [...safety, command, ...off[command], ...rest],
        { cwd: dir, signal, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_TERMINAL_PROMPT: "0" } },
        (err, stdout, stderr) => {
          let out = stdout || (err ? "" : "(no output)")
          if (out.length > limit) out = `${out.slice(0, limit)}\n[cut at ${limit / 1024} KiB of ${Math.round(stdout.length / 1024)}; narrow it with a path, --stat or -n]`
          done(err ? `exit ${(err as { code?: number }).code ?? 1}\n${out}${stderr ? `stderr:\n${stderr.slice(0, 4000)}` : ""}` : out)
        },
      ),
    )
  },
}
