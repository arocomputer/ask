package test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// TestRuns pins saved runs: show, stop, locks, damaged records and --resume.
func TestRuns(t *testing.T) {
	t.Run("show prints a run again: its answer, or with --json its whole result", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("-m", "fake:small", "hello")
		id := runID(t, first.stderr)
		shown := s.ask("show", id)
		eq(t, shown.stdout, "fake: hello\n")
		match(t, shown.stderr, `^ask `+id+` · ok · Fake 1\.0`)
		full := obj(t, s.ask("show", id, "--json").stdout)
		eq(t, full.s("run"), id)
		eq(t, full.s("session"), fmt.Sprintf("s-%.0f", s.calls()[0].n("pid")))
		batch := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"a"},{"prompt":"b"}]`, nil)
		batchID := runID(t, batch.stderr)
		shownBatch := s.ask("show", batchID)
		eq(t, shownBatch.stderr, "ask "+batchID+" · 2/2 ok\n")
	})
	t.Run("stop stops a run that is going, and its agents", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		parts := strings.Split(s.latest(), "-")
		id := parts[len(parts)-1]
		stopped := s.ask("stop", id)
		match(t, stopped.stderr, `^ask `+id+` · stopped`)
		eq(t, run.wait(t).code, 130)
		eq(t, s.ask("stop", id).code, 1)
	})
	t.Run("a run another ask is running cannot be resumed at the same time", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"hang"}]`, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		parts := strings.Split(s.latest(), "-")
		id := parts[len(parts)-1]
		second := s.ask("batch", "--resume", id)
		eq(t, second.code, 2)
		match(t, second.stderr, `run `+id+` is running`)
		if e := run.cmd.Process.Signal(syscall.SIGTERM); e != nil {
			t.Fatal(e)
		}
		run.wait(t)
	})
	t.Run("a damaged results.json is reported, never taken as no results", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"a"}]`, nil)
		id := runID(t, first.stderr)
		s.write(filepath.Join(s.home, "runs", s.latest(), "results.json"), `[{"ok": tr`)
		r := s.ask("batch", "--resume", id)
		eq(t, r.code, 2)
		match(t, r.stderr, `results\.json is damaged`)
		eq(t, len(s.calls()), 1)
	})
	t.Run("--resume reruns a batch as recorded, refusing options that would change it", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"a"}]`, nil)
		r := s.ask("batch", "--resume", runID(t, first.stderr), "-r")
		eq(t, r.code, 2)
		match(t, r.stderr, `takes only -j and --no-hooks, not -r`)
	})
	t.Run("run records and folders are private to you", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("-m", "fake:small", "go")
		eq(t, r.code, 0)
		dir := filepath.Join(s.home, "runs", s.latest())
		for _, p := range []string{filepath.Join(s.home, "runs"), dir, filepath.Join(dir, "tasks.json"), filepath.Join(dir, "results.json")} {
			info, e := os.Stat(p)
			if e != nil {
				t.Fatal(e)
			}
			if info.Mode().Perm()&0077 != 0 {
				t.Errorf("%s mode %o", p, info.Mode().Perm())
			}
		}
	})
	t.Run("a stopped task resumes without a failure result, result hook or printed results", func(t *testing.T) {
		s := fresh(t)
		s.hook("observe", []string{"result"}, `echo '{}'`)
		run := s.start([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"hang"}]`, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		id := strings.TrimPrefix(s.latest()[strings.LastIndex(s.latest(), "-"):], "-")
		eq(t, s.ask("stop", id).code, 0)
		out := run.wait(t)
		eq(t, out.code, 130)
		eq(t, out.stdout, "")
		path := filepath.Join(s.home, "runs", s.latest(), "results.json")
		if exists(path) && strings.Contains(s.read(path), `"ok": false`) {
			t.Fatal("stopped task saved as failed")
		}
		if len(s.hookCalls()) != 0 {
			t.Fatalf("result hook called: %v", s.hookCalls())
		}
		match(t, s.ask("runs").stdout, `stopped.*resume: ask batch --resume `+id)
	})
	t.Run("show exits 1 when any saved task failed", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"pass"},{"prompt":"fail"}]`, map[string]string{"FAKE_FAIL": "fail"})
		eq(t, r.code, 1)
		eq(t, s.ask("show", runID(t, r.stderr)).code, 1)
	})
	t.Run("an empty task record is skipped in recent runs", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "runs", "20260101T000000000-zzzzzz", "tasks.json"), `[]`)
		r := s.ask("runs")
		eq(t, r.code, 0)
		noMatch(t, r.stdout, `zzzzzz`)
	})
	t.Run("stop never signals a process named by a record nobody holds", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("-m", "fake:small", "go")
		eq(t, first.code, 0)
		cmd := exec.Command("sleep", "30")
		if e := cmd.Start(); e != nil {
			t.Fatal(e)
		}
		defer func() { cmd.Process.Kill(); cmd.Wait() }()
		lock := filepath.Join(s.home, "runs", s.latest(), "lock")
		s.write(lock, strconv.Itoa(cmd.Process.Pid))
		r := s.ask("stop", runID(t, first.stderr))
		eq(t, r.code, 1)
		if !alive(cmd.Process.Pid) {
			t.Fatal("unrelated process was signaled")
		}
	})
	t.Run("a run's lock is the one the kernel holds, not what the lock file says", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"fail"}]`, map[string]string{"FAKE_FAIL": "fail"})
		eq(t, first.code, 1)
		path := filepath.Join(s.home, "runs", s.latest(), "lock")
		f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		if e := f.Truncate(0); e != nil {
			t.Fatal(e)
		}
		if e := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &syscall.Flock_t{Type: syscall.F_WRLCK}); e != nil {
			t.Fatal(e)
		}
		r := s.ask("batch", "--resume", runID(t, first.stderr))
		eq(t, r.code, 2)
		match(t, r.stderr, `is running \(pid `+strconv.Itoa(os.Getpid())+`\)`)
	})
	t.Run("wait", func(t *testing.T) {
		t.Run("waits for a running run, then prints its answer", func(t *testing.T) {
			s := fresh(t)
			slow := s.start([]string{"-m", "fake:small", "slow one"}, "", map[string]string{"FAKE_SLOW": "slow"})
			until(t, func() bool { return exists(filepath.Join(s.home, "runs")) && len(s.dirs()) == 1 })
			r := s.ask("wait")
			eq(t, r.code, 0)
			eq(t, r.stdout, "fake: slow one\n")
			slow.wait(t)
		})
		t.Run("reports idle normally and rejects args and options", func(t *testing.T) {
			s := fresh(t)
			idle := s.ask("wait")
			eq(t, idle.code, 0)
			eq(t, idle.stderr, "ask: no runs are running\n")
			r := s.ask("wait", "named")
			eq(t, r.code, 2)
			r = s.ask("wait", "-t", "3")
			eq(t, r.code, 2)
		})
		t.Run("without names returns the first of several active runs to finish", func(t *testing.T) {
			s := fresh(t)
			slow := s.start([]string{"-m", "fake:small", "slow reply"}, "", map[string]string{"FAKE_SLOW": "slow"})
			hang := s.start([]string{"-m", "fake:small", "hang around"}, "", map[string]string{"FAKE_HANG": "hang"})
			until(t, func() bool { return len(s.calls()) == 2 })
			r := s.ask("wait")
			eq(t, r.code, 0)
			eq(t, r.stdout, "fake: slow reply\n")
			if e := hang.cmd.Process.Signal(syscall.SIGTERM); e != nil {
				t.Fatal(e)
			}
			hang.wait(t)
			slow.wait(t)
		})
	})
	t.Run("setup with an agent name points to settings", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("setup", "opencode")
		eq(t, r.code, 2)
		match(t, r.stderr, `did you mean ask settings opencode\?`)
	})
	t.Run("clean removes landed worktrees and old runs, and nothing else", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		s.run([]string{"-m", "fake:small", "-w", "--worktree", "-C", dir, "change readme"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		path := filepath.Join(s.home, "worktrees", "change-readme")
		gitAt := s.gitAt(path)
		gitAt("add", ".")
		gitAt("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "change")
		plan := s.ask("clean", "--dry-run")
		match(t, plan.stdout, `keep +~/home/worktrees/change-readme +ask/change-readme · not merged into main`)
		git("-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--squash", "ask/change-readme")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "squashed")
		old := filepath.Join(s.home, "runs", "20200101T000000000-abc123-old")
		s.mkdir(old)
		s.write(filepath.Join(old, "tasks.json"), `[{"id":"1","prompt":"x","model":"fake:small","write":false,"json":false,"dir":"/","timeout":900}]`)
		r := s.ask("clean", "--yes")
		eq(t, r.code, 0)
		match(t, r.stderr, `removed ~/home/worktrees/change-readme and ask/change-readme`)
		match(t, r.stderr, `removed 1 run\n`)
		eq(t, exists(path), false)
		eq(t, exists(old), false)
		eq(t, strings.TrimSpace(git("branch", "--list", "ask/change-readme")), "")
		eq(t, len(s.dirs()), 1)
		if _, e := os.Stat(filepath.Join(dir, "b.txt")); e != nil {
			t.Fatal("the merged change is gone from the checkout")
		}
	})
	t.Run("runs lists recorded runs, newest first, with their outcome and model", func(t *testing.T) {
		s := fresh(t)
		s.ask("-m", "fake:small", "first question")
		s.run([]string{"batch", "-m", "fake:small"}, `[{"prompt":"fine"},{"prompt":"break"}]`, map[string]string{"FAKE_FAIL": "break"})
		rows := strings.Split(strings.TrimSpace(s.ask("runs").stdout), "\n")
		eq(t, len(rows), 3)
		match(t, rows[0], `^RUN +ID +STARTED +STATUS +MODEL +TIME +TASK$`)
		match(t, rows[1], `^fine +\w{6} .* 1/2 ok +2 tasks +fine$`)
		match(t, rows[2], `^first-question +\w{6} .* ok +Fake 1\.0 +[\d.]+s +first question$`)
	})
	t.Run("runs shows an unfinished run whose ask is gone as stopped, with how to resume", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000-zzzzzz")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "1", "model": "fake:small", "prompt": "p"}, {"id": "2", "model": "fake:small", "prompt": "p"}})
		s.json(filepath.Join(dir, "results.json"), []any{object{"id": "1", "ok": true}, nil})
		match(t, s.ask("runs").stdout, `(?m)^zzzzzz .* stopped .* resume: ask batch --resume zzzzzz$`)
	})
	t.Run("ask runs in a repository lists its runs, from any of its checkouts; --all lists every run", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		other := filepath.Join(s.tmp, "other")
		s.mkdir(other)
		s.ask("-m", "fake:small", "-C", dir, "in repo")
		s.ask("-m", "fake:small", "-C", other, "elsewhere")
		linked := filepath.Join(s.tmp, "linked")
		git("worktree", "add", "-q", "--detach", linked)
		here := s.runIn(linked, "runs")
		match(t, here.stdout, `in repo`)
		eq(t, strings.Contains(here.stdout, "elsewhere"), false)
		match(t, s.runIn(linked, "runs", "--all").stdout, `elsewhere`)
	})
}
