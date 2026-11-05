package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWorktrees covers write runs in their own worktrees, follow-ups there, and cleaning.
func TestWorktrees(t *testing.T) {
	t.Run("a worktree run gets its own branch named after the prompt", func(t *testing.T) {
		s := fresh(t)
		repo, git := s.repo()
		out := s.in(repo, "-m", "openai/test-model", "--wait", "--worktree", "Add the new file please\n"+`call write {"path":"new.txt","content":"n\n"}`)
		eq(t, out.code, 0)
		id := strings.Fields(out.stderr)[1]
		rec := s.record(id)
		w := rec["worktree"].(map[string]any)
		eq(t, w["path"], filepath.Join(s.home, "agent", "worktrees", "add-the-new-file"))
		eq(t, w["branch"], "ask/add-the-new-file")
		eq(t, rec.s("dir"), w["path"])
		eq(t, rec.s("origin"), repo)
		eq(t, rec.b("write"), true)
		if exists(filepath.Join(repo, "new.txt")) {
			t.Fatal("the run wrote into the main checkout")
		}
		if !exists(filepath.Join(w["path"].(string), "new.txt")) {
			t.Fatal("the run did not write into its worktree")
		}
		match(t, git("branch", "--list", "ask/*"), "ask/add-the-new-file")
	})
	t.Run("the worktree setting applies to every write run", func(t *testing.T) {
		s := fresh(t)
		repo, _ := s.repo()
		s.config(object{"worktree": true, "worktrees": "~/trees/{name}"})
		out := s.in(repo, "-m", "openai/test-model", "-w", "fix it")
		eq(t, out.code, 0)
		rec := s.record(strings.TrimSpace(out.stdout))
		eq(t, rec["worktree"].(map[string]any)["path"], filepath.Join(s.tmp, "trees", "fix-it"))
		read := s.in(repo, "-m", "openai/test-model", "read it")
		if _, has := s.record(strings.TrimSpace(read.stdout))["worktree"]; has {
			t.Fatal("a read run must not get a worktree")
		}
	})
	t.Run("a later turn works in the session's worktree", func(t *testing.T) {
		s := fresh(t)
		repo, _ := s.repo()
		id := strings.TrimSpace(s.in(repo, "-m", "openai/test-model", "--worktree", "start work").stdout)
		s.ask("wait", id)
		tree := s.record(id).s("dir")
		s.ask("continue", id, "--wait", `call write {"path":"later.txt","content":"x"}`+"\nmore")
		if !exists(filepath.Join(tree, "later.txt")) {
			t.Fatal("the later turn did not work in the worktree")
		}
		eq(t, s.record(id).s("dir"), tree)
		eq(t, s.record(id)["changes"].([]any)[0].(map[string]any)["path"], "later.txt")
	})
	t.Run("clean removes worktrees that changed nothing and keeps the rest", func(t *testing.T) {
		s := fresh(t)
		repo, _ := s.repo()
		idle := strings.TrimSpace(s.in(repo, "-m", "openai/test-model", "--worktree", "nothing to do").stdout)
		busy := strings.TrimSpace(s.in(repo, "-m", "openai/test-model", "--worktree", "write something\n"+`call write {"path":"w.txt","content":"w"}`).stdout)
		s.ask("wait", idle)
		s.ask("wait", busy)
		out := s.ask("clean", "--dry-run")
		match(t, out.stdout, "remove  ~/home/agent/worktrees/nothing-to-do  ask/nothing-to-do · no changes\n")
		match(t, out.stdout, "keep    .*write-something\\S*  ask/write-something\\S* · uncommitted: 0 tracked, 1 untracked\n")
		out = s.ask("clean", "--yes")
		eq(t, out.code, 0)
		if exists(s.record(idle)["worktree"].(map[string]any)["path"].(string)) {
			t.Fatal("the idle worktree remains")
		}
		if !exists(s.record(busy)["worktree"].(map[string]any)["path"].(string)) {
			t.Fatal("the busy worktree was removed")
		}
		eq(t, s.ask("clean", "--days", "0", "--yes").code, 0)
		if s.hasSession(idle) {
			t.Fatal("the idle run was kept")
		}
		if !s.hasSession(busy) {
			t.Fatal("a run with a kept worktree was removed")
		}
	})
	t.Run("clean keeps work another branch contains unless --contained, then keeps its branch", func(t *testing.T) {
		s := fresh(t)
		repo, git := s.repo()
		id := strings.TrimSpace(s.in(repo, "-m", "openai/test-model", "--worktree", "change readme\n"+`call write {"path":"b.txt","content":"new"}`).stdout)
		s.ask("wait", id)
		w := s.record(id)["worktree"].(map[string]any)
		path, branch := w["path"].(string), w["branch"].(string)
		gitAt := s.gitAt(path)
		gitAt("add", ".")
		gitAt("commit", "-qm", "change")
		git("branch", "feature/keep", branch)

		out := s.ask("clean", "--dry-run")
		match(t, out.stdout, "keep    .*  "+branch+" · contained in feature/keep; use --contained\n")

		out = s.ask("clean", "--contained", "--dry-run")
		match(t, out.stdout, "remove  .*  "+branch+" · contained in feature/keep \\(branch kept\\)\n")
		if !exists(path) {
			t.Fatal("the dry run removed the worktree")
		}

		out = s.ask("clean", "--contained", "--yes")
		eq(t, out.code, 0)
		match(t, out.stderr, "removed .*; kept "+branch+" for review")
		if exists(path) {
			t.Fatal("the contained worktree remains")
		}
		match(t, git("branch", "--list", branch), branch)
	})
	t.Run("clean keeps a worktree while its session is running", func(t *testing.T) {
		s := fresh(t)
		repo, _ := s.repo()
		hang := s.start([]string{"-m", "fake:small", "-C", repo, "--worktree", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		path := filepath.Join(s.home, "agent", "worktrees", "hang")
		until(t, func() bool {
			entries, _ := os.ReadDir(filepath.Join(s.home, "agent", "sessions"))
			return exists(path) && len(entries) > 0
		})
		out := s.ask("clean", "--dry-run")
		match(t, out.stdout, "keep    ~/home/agent/worktrees/hang  ask/hang · session running\n")
		if !exists(path) {
			t.Fatal("the running session's worktree is gone")
		}
		_ = hang.cmd.Process.Kill()
		hang.wait(t)
	})
}
