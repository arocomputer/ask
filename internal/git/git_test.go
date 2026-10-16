package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/arocomputer/ask/internal/home"
)

// TestInspectionDisablesOptionalLocks passes git's read-only lock setting to inspection commands.
func TestInspectionDisablesOptionalLocks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "git")
	if e := os.WriteFile(path, []byte("#!/bin/sh\n[ \"$GIT_OPTIONAL_LOCKS\" = 0 ] || exit 3\necho clean\n"), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if _, ok := git(dir, []string{"status"}, ""); !ok {
		t.Fatal("inspection did not disable optional locks")
	}
}

// TestAddNeverSharesAWorktree gives a new task the next free folder, while a follow-up reuses its own.
func TestAddNeverSharesAWorktree(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	for _, args := range [][]string{{"init", "-q", repo}, {"-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first"}} {
		cmd := exec.Command("git", args...)
		cmd.Env = append(os.Environ(), "HOME="+dir, "GIT_CONFIG_NOSYSTEM=1")
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatal(e, string(out))
		}
	}
	p := home.Paths{Worktrees: filepath.Join(dir, "worktrees")}
	if e := os.MkdirAll(filepath.Join(p.Worktrees, "fix"), 0700); e != nil {
		t.Fatal(e)
	}
	w, e := Add(p, repo, "fix", false)
	if e != nil || w.Path != filepath.Join(p.Worktrees, "fix-2") || w.Branch != "ask/fix-2" {
		t.Fatal(w, e)
	}
	again, e := Add(p, repo, "fix-2", true)
	if e != nil || again.Path != w.Path {
		t.Fatal(again, e)
	}
}
