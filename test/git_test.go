package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGit pins what write runs report from git, and --worktree.
func TestGit(t *testing.T) {
	t.Run("a write run reports the files it changed, not ones already changed before it", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.write(filepath.Join(dir, "a.txt"), "edited before\n")
		s.write(filepath.Join(dir, "untouched.txt"), "new before\n")
		r := s.run([]string{"batch", "-w", "-m", "fake:small", "-C", dir, "-"}, `[{"prompt":"go"}]`, map[string]string{"FAKE_WRITE": "b.txt=new"})
		result := objects(t, r.stdout)[0]
		jsonEqual(t, result["changes"], []object{{"path": "b.txt", "change": "added"}})
		eq(t, result.n("commits"), 0.0)
		match(t, r.stderr, ` · ok · Fake 1\.0 · [\d.]+s · 1 file changed · `)
	})
	t.Run("a write run that commits reports its commits and the files they changed", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.write(filepath.Join(dir, "a.txt"), "two\n")
		r := s.run([]string{"batch", "-w", "-m", "fake:small", "-C", dir, "-"}, `[{"prompt":"go"}]`, map[string]string{"FAKE_COMMIT": "1"})
		result := objects(t, r.stdout)[0]
		jsonEqual(t, result["changes"], []object{})
		eq(t, result.n("commits"), 1.0)
		edits := s.run([]string{"batch", "-w", "-m", "fake:small", "-C", dir, "-"}, `[{"prompt":"go"}]`, map[string]string{"FAKE_WRITE": "a.txt=three", "FAKE_COMMIT": "1"})
		jsonEqual(t, objects(t, edits.stdout)[0]["changes"], []object{{"path": "a.txt", "change": "modified"}})
	})
	t.Run("--worktree runs in a new worktree and branch, kept with the changes, leaving the checkout alone", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		r := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, r.code, 0)
		id := runID(t, r.stderr)
		path := filepath.Join(s.home, "worktrees", id)
		eq(t, s.calls()[0].s("cwd"), path)
		eq(t, s.read(filepath.Join(path, "b.txt")), "new")
		eq(t, exists(filepath.Join(dir, "b.txt")), false)
		match(t, git("branch", "--list", "ask/"+id), `ask/`+id)
		match(t, r.stderr, `branch ask/`+id)
	})
	t.Run("a new worktree starts at the calling worktree commit", func(t *testing.T) {
		s := fresh(t)
		_, git := s.repo()
		source := filepath.Join(s.tmp, "source-worktree")
		git("worktree", "add", "-q", "-b", "source", source)
		s.write(filepath.Join(source, "source-only.txt"), "source branch")
		sourceGit := s.gitAt(source)
		sourceGit("add", "source-only.txt")
		sourceGit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "source change")
		want := strings.TrimSpace(sourceGit("rev-parse", "HEAD"))
		got := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", source, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, got.code, 0)
		taskDir := s.calls()[0].s("cwd")
		eq(t, strings.TrimSpace(s.gitAt(taskDir)("rev-parse", "HEAD")), want)
		eq(t, s.read(filepath.Join(taskDir, "source-only.txt")), "source branch")
	})
	t.Run("a worktree run that changed nothing removes its worktree and branch, and a follow-up recreates it", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		r := s.ask("-m", "fake:small", "-w", "--worktree", "-C", dir, "look")
		id := runID(t, r.stderr)
		eq(t, exists(filepath.Join(s.home, "worktrees", id)), false)
		eq(t, strings.TrimSpace(git("branch", "--list", "ask/"+id)), "")
		s.run([]string{"-c", id, "now change it"}, "", map[string]string{"FAKE_WRITE": "c.txt=x"})
		eq(t, s.calls()[1].s("cwd"), filepath.Join(s.home, "worktrees", id))
		match(t, git("branch", "--list", "ask/"+id), `ask/`+id)
	})
	t.Run("--worktree needs -w and a git repository", func(t *testing.T) {
		s := fresh(t)
		read := s.ask("-m", "fake:small", "--worktree", "go")
		eq(t, read.code, 2)
		match(t, read.stderr, `a worktree is for write runs; add -w`)
		outside := s.ask("-m", "fake:small", "-w", "--worktree", "-C", s.tmp, "go")
		eq(t, outside.code, 1)
		match(t, outside.stderr, `--worktree needs a git repository`)
	})
	t.Run("an idle later round keeps the changes and commits of earlier rounds", func(t *testing.T) {
		for _, commit := range []bool{false, true} {
			s := fresh(t)
			dir, _ := s.repo()
			s.localAgent("edit", `cat >/dev/null
if [ -z "$ASK_SESSION" ]; then echo changed > a.txt; [ "$COMMIT" != yes ] || git commit -qam changed; fi
echo '{"session":"same"}' > "$ASK_REPORT"
echo fine`)
			s.hook("again", []string{"result"}, `case "$input" in *'"followups"'*) ;; *) echo '{"followup":"look again"}';; esac`)
			env := map[string]string{}
			if commit {
				env["COMMIT"] = "yes"
			}
			r := s.run([]string{"-m", "edit:small", "-w", "--worktree", "-C", dir, "go"}, "", env)
			eq(t, r.code, 0)
			path := filepath.Join(s.home, "worktrees", runID(t, r.stderr))
			eq(t, s.read(filepath.Join(path, "a.txt")), "changed\n")
			eq(t, s.ask("-c", runID(t, r.stderr), "look once more").code, 0)
			eq(t, exists(path), true)
		}
	})
	t.Run("a worktree keeps a mode-only change and a dangling symlink", func(t *testing.T) {
		for _, tc := range []struct{ name, body, path, change string }{{"mode", `chmod +x a.txt`, "a.txt", "modified"}, {"symlink", `ln -s missing dangling`, "dangling", "added"}} {
			t.Run(tc.name, func(t *testing.T) {
				s := fresh(t)
				dir, _ := s.repo()
				s.localAgent("edit", `cat >/dev/null; `+tc.body+`; echo done`)
				r := s.ask("-m", "edit:small", "-w", "--worktree", "-C", dir, "go")
				eq(t, r.code, 0)
				result := obj(t, s.ask("show", runID(t, r.stderr), "--json").stdout)
				if result["worktree"] == nil {
					t.Fatal("worktree removed")
				}
				found := false
				for _, v := range result["changes"].([]any) {
					x := v.(map[string]any)
					if x["path"] == tc.path && x["change"] == tc.change {
						found = true
					}
				}
				if !found {
					t.Fatalf("missing %s %s: %v", tc.path, tc.change, result["changes"])
				}
			})
		}
	})
	t.Run("from a symlinked folder, the agent works in the same subfolder of its worktree", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.write(filepath.Join(dir, "sub", "keep"), "x")
		s.gitAt(dir)("add", ".")
		s.gitAt(dir)("commit", "-qm", "sub")
		link := filepath.Join(s.tmp, "alias")
		if e := os.Symlink(dir, link); e != nil {
			t.Fatal(e)
		}
		r := s.ask("-m", "fake:small", "-w", "--worktree", "-C", filepath.Join(link, "sub"), "go")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("cwd"), filepath.Join(s.home, "worktrees", runID(t, r.stderr), "sub"))
	})
	t.Run("batch worktree names use task position, so similar ids never share a branch", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.localAgent("edit", `cat >/dev/null; echo "$ASK_MODEL" > "$ASK_MODEL.txt"; echo done`)
		batch := `[{"id":"a/b","prompt":"one"},{"id":"a_b","prompt":"two"}]`
		r := s.run([]string{"batch", "-m", "edit:small", "-w", "--worktree", "-C", dir, "-"}, batch, nil)
		eq(t, r.code, 0)
		results := objects(t, r.stdout)
		a := results[0]["worktree"].(map[string]any)
		b := results[1]["worktree"].(map[string]any)
		if a["path"] == b["path"] || a["branch"] == b["branch"] {
			t.Fatalf("shared worktree: %v %v", a, b)
		}
	})
	t.Run("a read follow-up may run in a kept worktree", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		first := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, first.code, 0)
		r := s.ask("-c", runID(t, first.stderr), "-r", "inspect")
		eq(t, r.code, 0)
		eq(t, s.calls()[1].s("access"), "read")
		eq(t, s.calls()[1].s("cwd"), filepath.Join(s.home, "worktrees", runID(t, first.stderr)))
	})
	t.Run("follow-ups keep the exact prefixed worktree and branch across settings changes", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		s.write(filepath.Join(dir, "sub", "keep"), "x")
		git("add", ".")
		git("commit", "-qm", "subfolder")
		s.json(filepath.Join(s.home, "settings.json"), object{"worktrees": ".ask/worktrees/pre-{name}-post", "branches": "task/{name}"})
		// A relative template lets allocation, rather than run naming, handle this collision.
		s.mkdir(filepath.Join(dir, ".ask", "worktrees", "pre-go-post"))
		first := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", filepath.Join(dir, "sub"), "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, first.code, 0)
		ref := filepath.Join(s.home, "runs", s.latest())
		path := filepath.Join(dir, ".ask", "worktrees", "pre-go-2-post")
		eq(t, s.calls()[0].s("cwd"), filepath.Join(path, "sub"))
		eq(t, s.ask("-c", ref, "-r", "inspect").code, 0)
		s.json(filepath.Join(s.home, "settings.json"), object{"worktrees": filepath.Join(s.tmp, "elsewhere", "new-{name}"), "branches": "new/{name}"})
		eq(t, s.ask("-c", ref, "-r", "inspect again").code, 0)
		eq(t, s.run([]string{"-c", ref, "-w", "edit"}, "", map[string]string{"FAKE_WRITE": "b.txt=changed"}).code, 0)
		for _, call := range s.calls() {
			eq(t, call.s("cwd"), filepath.Join(path, "sub"))
		}
		eq(t, s.read(filepath.Join(path, "sub", "b.txt")), "changed")
		eq(t, strings.TrimSpace(s.gitAt(path)("branch", "--show-current")), "task/go-2")
	})
	t.Run("result hook follow-ups reuse a prefixed worktree without applying the template again", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.json(filepath.Join(s.home, "settings.json"), object{"worktrees": filepath.Join(s.tmp, "trees", "pre-{name}-post"), "branches": "task/{name}"})
		s.hook("again", []string{"result"}, `case "$input" in *'"followups"'*) ;; *) echo '{"followup":"look again"}';; esac`)
		r := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, r.code, 0)
		calls := s.calls()
		eq(t, len(calls), 2)
		eq(t, calls[1].s("cwd"), calls[0].s("cwd"))
		result := obj(t, s.ask("show", runID(t, r.stderr), "--json").stdout)
		jsonEqual(t, result["worktree"], object{"path": calls[0].s("cwd"), "branch": "task/go"})
	})
	t.Run("a legacy saved follow-up with a prefixed worktree can be resumed", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.json(filepath.Join(s.home, "settings.json"), object{"worktrees": filepath.Join(s.tmp, "trees", "pre-{name}-post"), "branches": "task/{name}"})
		first := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, first.code, 0)
		failed := s.run([]string{"-c", runID(t, first.stderr), "fail"}, "", map[string]string{"FAKE_FAIL": "fail"})
		eq(t, failed.code, 1)
		ref := filepath.Join(s.home, "runs", s.latest())
		path := s.calls()[0].s("cwd")
		// Recreate the older prepared record shape only in this test's temporary home.
		tasks := objects(t, s.read(filepath.Join(ref, "tasks.json")))
		delete(tasks[0], "kept_worktree")
		tasks[0]["worktree"] = filepath.Base(path)
		s.json(filepath.Join(ref, "tasks.json"), tasks)
		eq(t, s.ask("batch", "--resume", ref).code, 0)
		eq(t, s.calls()[2].s("cwd"), path)
	})
	t.Run("a kept worktree replaced by another branch is refused", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		first := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, first.code, 0)
		ref := filepath.Join(s.home, "runs", s.latest())
		path := s.calls()[0].s("cwd")
		git("worktree", "remove", "--force", path)
		git("worktree", "add", "-q", "-b", "other", path)
		r := s.ask("-c", ref, "edit")
		eq(t, r.code, 1)
		match(t, r.stderr, `kept worktree .* is no longer on branch`)
		eq(t, len(s.calls()), 1)
	})
	t.Run("a read follow-up cannot recreate a removed worktree", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		first := s.ask("-m", "fake:small", "-w", "--worktree", "-C", dir, "go")
		eq(t, first.code, 0)
		r := s.ask("-c", runID(t, first.stderr), "-r", "inspect")
		eq(t, r.code, 2)
		match(t, r.stderr, `a worktree is for write runs`)
	})
	t.Run("a read follow-up cannot recreate a worktree removed after preparation", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		first := s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, first.code, 0)
		path := s.calls()[0].s("cwd")
		s.hook("remove", []string{"task"}, `git worktree remove --force "$TREE"`)
		r := s.run([]string{"-c", runID(t, first.stderr), "-r", "inspect"}, "", map[string]string{"TREE": path})
		eq(t, r.code, 1)
		match(t, r.stderr, `a read follow-up needs its kept worktree to exist`)
		eq(t, exists(path), false)
		eq(t, len(s.calls()), 1)
	})
	t.Run("a follow-up of a run in the checkout refuses --worktree", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		first := s.ask("-m", "fake:small", "-C", dir, "look")
		r := s.run([]string{"-c", runID(t, first.stderr), "-w", "--worktree", "edit"}, "", map[string]string{"FAKE_WRITE": "a.txt=changed\n"})
		eq(t, r.code, 2)
		match(t, r.stderr, `not a worktree; drop --worktree`)
		eq(t, s.read(filepath.Join(dir, "a.txt")), "one\n")
	})
	t.Run("task ids git refuses in branch names, like v1..v2, become valid ones", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		r := s.run([]string{"batch", "-m", "fake:small", "-w", "--worktree", "-C", dir, "-"}, `[{"id":"v1..v2","prompt":"a"},{"id":"api.lock","prompt":"b"}]`, nil)
		eq(t, r.code, 0)
	})
	t.Run("a changed file whose name has a newline is reported", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.localAgent("edit", `cat >/dev/null; printf changed > 'line
break'; echo done`)
		r := s.ask("-m", "edit:small", "-w", "--worktree", "-C", dir, "go")
		eq(t, r.code, 0)
		result := obj(t, s.ask("show", runID(t, r.stderr), "--json").stdout)
		changes := result["changes"].([]any)
		eq(t, len(changes), 1)
		eq(t, changes[0].(map[string]any)["path"], "line\nbreak")
	})
	t.Run("new worktrees go under a private folder", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		r := s.ask("-m", "fake:small", "-w", "--worktree", "-C", dir, "go")
		eq(t, r.code, 0)
		info, e := os.Stat(filepath.Join(s.home, "worktrees"))
		if e != nil {
			t.Fatal(e)
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("worktrees parent mode %o", info.Mode().Perm())
		}
	})
	t.Run("ask's own git calls never run a core.fsmonitor an agent set", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		planted := filepath.Join(s.tmp, "planted")
		s.localAgent("plant", `cat >/dev/null; git config core.fsmonitor "touch `+planted+`; false"; echo two >> a.txt; echo fine`)
		r := s.ask("-m", "plant:small", "-w", "-C", dir, "go")
		eq(t, r.code, 0)
		eq(t, exists(planted), false)
	})
}
