package test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestCommands pins ask NAME: arguments, exit codes, signals and the documented review workflow.
func TestCommands(t *testing.T) {
	t.Run("the documented review command sends large diffs intact", func(t *testing.T) {
		if _, e := exec.LookPath("jq"); e != nil {
			t.Skip("the documented review example requires jq")
		}
		s := fresh(t)
		dir, git := s.repo()
		s.cwd = dir
		s.write(filepath.Join(dir, "a.txt"), strings.Repeat("a \"quote\" and \\ path\n", 10000))
		git("add", ".")
		git("commit", "-qm", "large change")
		diff := strings.TrimRight(git("diff", "HEAD~1..HEAD"), "\n")
		_, example, ok := strings.Cut(s.read(filepath.Join(root, "docs", "commands.md")), "```sh\n#!/bin/sh\n# ~/.ask/commands/review:")
		if !ok {
			t.Fatal("review example not found")
		}
		body, _, ok := strings.Cut(example, "\n```")
		if !ok {
			t.Fatal("review example has no closing fence")
		}
		body = strings.NewReplacer("claude:opus-5.5", "fake:small", "codex:gpt-6.1-sol", "fake:big", "opencode:glm-5.3-flash", "fake:small#high").Replace(body)
		s.script("commands", "review", "# ~/.ask/commands/review:"+body)
		r := s.ask("review", "HEAD~1..HEAD")
		eq(t, r.code, 0)
		calls := s.calls()
		eq(t, len(calls), 3)
		for _, call := range calls {
			eq(t, call.s("stdin"), "Review this diff for HEAD~1..HEAD. List real bugs only, with file and line.\n\n"+diff)
		}
	})
	t.Run("a command gets the resolved ask binary, even through a symlink", func(t *testing.T) {
		s := fresh(t)
		link := filepath.Join(s.tmp, "ask-link")
		if e := os.Symlink(askBin, link); e != nil {
			t.Fatal(e)
		}
		s.script("commands", "seen", `printf '%s\n' "$ASK_BIN"`)
		old := askBin
		askBin = link
		t.Cleanup(func() { askBin = old })
		r := s.ask("seen")
		eq(t, r.code, 0)
		// The binary's own path, symlinks resolved too: macOS's temp folder sits under a symlink.
		want, e := filepath.EvalSymlinks(old)
		if e != nil {
			t.Fatal(e)
		}
		eq(t, r.stdout, want+"\n")
	})
	t.Run("a command replaces ask's process, so it gets signals directly", func(t *testing.T) {
		s := fresh(t)
		s.script("commands", "hold", `echo $$ > "$HOME/command-pid"; exec sleep 30`)
		run := s.start([]string{"hold"}, "", nil)
		until(t, func() bool { return exists(filepath.Join(s.tmp, "command-pid")) })
		if e := run.cmd.Process.Signal(syscall.SIGTERM); e != nil {
			t.Fatal(e)
		}
		select {
		case <-run.done:
		case <-time.After(2 * time.Second):
			t.Fatal("command survived ask signal")
		}
	})
	t.Run("a command runs as ask NAME with its arguments and exit code, and can run ask itself", func(t *testing.T) {
		s := fresh(t)
		s.script("commands", "twice", "# ask-command: ask the same question twice\n\"$ASK_BIN\" -m fake:small \"$@\" 2>/dev/null\n\"$ASK_BIN\" -m fake:small \"$@\" 2>/dev/null\nexit 3")
		r := s.ask("twice", "hello")
		eq(t, r.code, 3)
		eq(t, r.stdout, "fake: hello\nfake: hello\n")
		match(t, s.ask("--help").stdout, `Your commands\n {2}twice +ask the same question twice`)
	})
	t.Run("ask's own commands win over yours of the same name", func(t *testing.T) {
		s := fresh(t)
		s.script("commands", "models", "echo mine")
		match(t, s.ask("models").stdout, `(?m)^fake:small$`)
	})
}
