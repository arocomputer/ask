package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/arocomputer/ask/internal/config"
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
	p := config.Paths{Worktrees: filepath.Join(dir, "worktrees")}
	if e := os.MkdirAll(filepath.Join(p.Worktrees, "fix"), 0700); e != nil {
		t.Fatal(e)
	}
	w, e := Add(p, repo, "fix", nil)
	if e != nil || w.Path != filepath.Join(p.Worktrees, "fix-2") || w.Branch != "ask/fix-2" {
		t.Fatal(w, e)
	}
	again, e := Add(p, repo, "fix-2", &Worktree{Path: w.Path, Branch: w.Branch})
	if e != nil || again.Path != w.Path {
		t.Fatal(again, e)
	}
}

// TestCleanDetection pins the advisory checks behind ask clean's --contained and --superseded:
// a branch another branch holds, and work main already had before moving on.
func TestCleanDetection(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	env := append(os.Environ(), "HOME="+dir, "GIT_CONFIG_NOSYSTEM=1")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = env
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatal(e, string(out))
		}
	}
	write := func(name, text string) {
		t.Helper()
		if e := os.WriteFile(filepath.Join(repo, name), []byte(text), 0600); e != nil {
			t.Fatal(e)
		}
	}
	cmd := exec.Command("git", "init", "-q", "-b", "main", repo)
	cmd.Env = env
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatal(e, string(out))
	}
	run("config", "user.name", "T")
	run("config", "user.email", "t@example.com")
	write("a.txt", "one\n")
	run("add", ".")
	run("commit", "-qm", "first")

	run("switch", "-q", "-c", "ask/x")
	write("a.txt", "two\n")
	run("commit", "-qam", "branch")
	if got, ok := Contained(repo, "ask/x"); ok {
		t.Fatalf("unmerged branch is contained in %s", got)
	}
	run("branch", "feature/keep", "ask/x")
	if got, ok := Contained(repo, "ask/x"); !ok || got != "feature/keep" {
		t.Fatalf("Contained = %q, %v; want feature/keep", got, ok)
	}

	// Main gets the same file content as part of a wider commit, then moves on. The branch's
	// patch is not upstream, but its final file matches one main had, which --superseded allows.
	run("switch", "-q", "main")
	write("a.txt", "two\n")
	write("b.txt", "rework\n")
	run("add", ".")
	run("commit", "-qm", "rework")
	write("a.txt", "three\n")
	run("commit", "-qam", "later")
	if landed, why := Landed(repo, "ask/x"); landed {
		t.Fatalf("Landed = true (%s); want false", why)
	}
	if likely, why := LikelyLanded(repo, "ask/x"); !likely || why != "likely landed in main" {
		t.Fatalf("LikelyLanded = %v, %q", likely, why)
	}
}
