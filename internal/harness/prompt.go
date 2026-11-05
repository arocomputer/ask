package harness

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/arocomputer/ask/internal/config"
)

// instructionFiles are the project instruction files a session reads, first found wins, from the
// working directory up to the repository root.
var instructionFiles = []string{"AGENTS.md", "CLAUDE.md"}

const projectLimit = 32 * 1024

// Instructions builds the system prompt: what the subagent is, its directory and access, the
// project's instruction file, and what extensions say about the tools they add.
func Instructions(dir string, write, schema bool, notes []string) string {
	var b strings.Builder
	b.WriteString("You are a subagent: another agent delegated this task to you through ask and will read your final answer. Work in the directory " + dir + ".\n\n")
	if write {
		b.WriteString("You may read, search, edit and create files and run shell commands there. Make the changes the task asks for, run the checks that prove them, and leave the directory in a working state. Do not commit unless asked.\n\n")
	} else {
		b.WriteString("This is a read-only task: you can read, list and search files, and nothing else. Answer from the files: search and read them before answering. Never guess file names, functions or facts; if you cannot find something, say so.\n\n")
	}
	b.WriteString("Your final message is the answer the caller receives, so make it complete and self-contained: state findings with file paths and line numbers, say what you changed and what you checked, and name any uncertainty. Do not ask questions; decide and explain.")
	if schema {
		b.WriteString(" Your final answer must be JSON matching the required schema, and nothing else.")
	}
	if project := projectInstructions(dir); project != "" {
		b.WriteString("\n\n# Project instructions\n\n" + project)
	}
	for _, note := range notes {
		b.WriteString("\n\n# Tool notes\n\n" + note)
	}
	return b.String()
}

// projectInstructions reads the nearest instruction file between dir and its repository root.
func projectInstructions(dir string) string {
	root := dir
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel")
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	if out, err := cmd.Output(); err == nil {
		if top := config.Trim(string(out)); top != "" {
			root = top
		}
	}
	for d := dir; ; d = filepath.Dir(d) {
		for _, name := range instructionFiles {
			if b, err := os.ReadFile(filepath.Join(d, name)); err == nil {
				text := config.Trim(config.UTF8(b))
				if len(text) > projectLimit {
					text = text[:projectLimit] + "\n[truncated]"
				}
				return text
			}
		}
		if d == root || filepath.Dir(d) == d {
			return ""
		}
	}
}
