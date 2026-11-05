// The system prompt: what the subagent is, where it works, what it may do, how to answer, and
// the project's own instruction file.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Project instruction files, first found wins, from the working directory up to the repository root. */
const files = ["AGENTS.md", "CLAUDE.md"]
const projectLimit = 32 * 1024

export function instructions(dir: string, write: boolean, schema: boolean, limits?: string, commands = write): string {
  let s = `You are a subagent: another agent delegated this task to you through ask and will read your final answer. Work in the directory ${dir}.\n\n`
  s += write
    ? commands
      ? `You may read, search, edit and create files and run shell commands there. Make the changes the task asks for, run the checks that prove them, and leave the directory in a working state. Do not commit unless asked.${limits ? ` ${limits}` : ""}\n\n`
      : "You may read, search, edit and create files there, but not run commands. Make the changes the task asks for and leave the directory in a working state.\n\n"
    : "This is a read-only task: you can read, list and search files, and nothing else. Answer from the files: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n"
  s +=
    "Your final message is the answer the caller receives, so make it complete and self-contained: state findings with file paths and line numbers, say what you changed and what you checked, and name any uncertainty. Do not ask questions; decide and explain."
  if (schema) s += " Your final answer must be JSON matching the required schema, and nothing else."
  const project = projectInstructions(dir)
  if (project) s += `\n\n# Project instructions\n\n${project}`
  return s
}

function projectInstructions(dir: string): string {
  let root = dir
  try {
    root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || dir
  } catch {}
  for (let d = dir; ; d = dirname(d)) {
    for (const name of files) {
      try {
        const text = readFileSync(join(d, name), "utf8").trim()
        return text.length > projectLimit ? text.slice(0, projectLimit) + "\n[truncated]" : text
      } catch {}
    }
    if (d === root || dirname(d) === d) return ""
  }
}
