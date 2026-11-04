package test

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
)

// TestStart exercises detached handoff through the real binary, without a shell background job.
func TestStart(t *testing.T) {
	launch := func(t *testing.T, s *setup, args []string, env map[string]string) string {
		t.Helper()
		out := s.run(append([]string{"start", "-m", "fake:small"}, args...), "", env)
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		id := strings.TrimSpace(out.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		return id
	}
	open := func(t *testing.T, s *setup, id string) *runs.Run {
		t.Helper()
		r, _, err := runs.Open(home.Paths{Runs: filepath.Join(s.home, "runs")}, id)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	t.Run("acknowledges a locked worker detached from the launcher and stops its agent", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"hang"}, map[string]string{"FAKE_HANG": "hang"})
		r := open(t, s, id)
		owner := runs.Owner(r)
		if owner <= 0 {
			t.Fatal("start returned without a live owner")
		}
		group, err := syscall.Getpgid(owner)
		if err != nil || group != owner {
			t.Fatalf("worker did not detach into its own session/group: %d %v", group, err)
		}
		if _, known := runs.Pending(r, owner); !known {
			t.Fatal("start returned before recording pending tasks")
		}
		until(t, func() bool { return len(s.calls()) == 1 })
		if err := syscall.Kill(owner, syscall.SIGHUP); err != nil {
			t.Fatal(err)
		}
		eq(t, s.ask("stop", id).code, 0)
		until(t, func() bool { return !alive(int(s.calls()[0].n("pid"))) })
		out := s.ask("wait", "--id", id)
		eq(t, out.code, 1)
		eq(t, out.stdout, id+"\n")
		match(t, out.stderr, `stopped`)
		eq(t, len(s.calls()), 1)
	})
	t.Run("keeps normal task options and stdin while returning only an ID", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		out := s.run([]string{"start", "-m", "fake:small", "-w", "--worktree", "-C", dir, "--json", "--title", "inspect", "-"}, "the", map[string]string{"FAKE_ANSWER": `{"key":true}`, "FAKE_WRITE": "new.txt=hello"})
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		id := strings.TrimSpace(out.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		waited := s.ask("wait", id)
		eq(t, waited.code, 0)
		eq(t, waited.stdout, "{\"key\":true}\n")
		eq(t, s.calls()[0].s("access"), "write")
		match(t, s.calls()[0].s("title"), `Inspect`)
		result := obj(t, s.ask("show", id, "--json").stdout)
		worktree, ok := result["worktree"].(map[string]any)
		if !ok || filepath.Base(worktree["path"].(string)) != id {
			t.Fatalf("unnamed detached worktree must use the worker ID: %v", result["worktree"])
		}
		eq(t, len(s.calls()), 1)
	})
	t.Run("concurrent prompts with the same readable name cannot execute each other's work", func(t *testing.T) {
		s := fresh(t)
		prompts := []string{"review login security race alpha", "review login security race bravo"}
		started := make([]*running, len(prompts))
		for i, prompt := range prompts {
			started[i] = s.start([]string{"start", "-m", "fake:small", prompt}, "", map[string]string{"FAKE_SLOW": "review"})
		}
		successes := 0
		for i, process := range started {
			out := process.wait(t)
			if out.code != 0 {
				eq(t, out.code, 1)
				eq(t, out.stdout, "")
				match(t, out.stderr, `claimed concurrently`)
				continue
			}
			successes++
			match(t, out.stdout, `^[a-z0-9]{6}\n$`)
			id := strings.TrimSpace(out.stdout)
			t.Cleanup(func() { s.ask("stop", id) })
			eq(t, open(t, s, id).Tasks[0].S("prompt"), prompts[i])
			eq(t, s.ask("wait", id).stdout, "fake: "+prompts[i]+"\n")
		}
		if successes == 0 {
			t.Fatal("neither concurrent launch was admitted")
		}
		eq(t, len(s.calls()), successes)
	})
	t.Run("private lifecycle logs never copy prompts credentials answers or diagnostics", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("private", `cat >/dev/null
printf '%s\n' "$CREDENTIAL" >&2
printf 'private answer\n'`)
		id := launch(t, s, []string{"-m", "private:small", "private prompt"}, map[string]string{"CREDENTIAL": "private credential"})
		eq(t, s.ask("wait", id).stdout, "private answer\n")
		r := open(t, s, id)
		log := filepath.Join(r.Dir, "worker.log")
		until(t, func() bool { return strings.Contains(s.read(log), "finished") })
		eq(t, s.read(log), "started\nfinished\n")
		for _, path := range []string{r.Dir, log, filepath.Join(r.Dir, "tasks.json"), filepath.Join(r.Dir, "results.json")} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm()&0077 != 0 {
				t.Fatalf("not private: %s: %v %v", path, info, err)
			}
		}
	})
	t.Run("agent failures remain visible after a successful launch", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"fail"}, map[string]string{"FAKE_FAIL": "fail"})
		out := s.ask("wait", id)
		eq(t, out.code, 1)
		eq(t, out.stdout, "")
		match(t, out.stderr, `failed`)
		eq(t, s.ask("wait", "--id", id).stdout, id+"\n")
		eq(t, s.ask("wait", "--id", id).code, 1)
		eq(t, len(s.calls()), 1)
	})
	t.Run("detached tasks retain the configured timeout and its failure report", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"-t", "0.2", "hang"}, map[string]string{"FAKE_HANG": "hang"})
		out := s.ask("wait", "--id", id)
		eq(t, out.code, 1)
		eq(t, out.stdout, id+"\n")
		match(t, out.stderr, `timed out|timeout`)
		eq(t, len(s.calls()), 1)
		until(t, func() bool { return !alive(int(s.calls()[0].n("pid"))) })
	})
	t.Run("conflicting continuations fail admission without a returned ID or duplicate execution", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("-m", "fake:small", "remember")
		eq(t, first.code, 0)
		prior := strings.SplitN(s.latest(), "-", 3)[1]
		id := launch(t, s, []string{"-c", prior, "hang"}, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 2 })
		out := s.ask("start", "-c", prior, "other")
		eq(t, out.code, 1)
		eq(t, out.stdout, "")
		match(t, out.stderr, `already in use`)
		eq(t, len(s.calls()), 2)
		eq(t, len(s.dirs()), 2)
		eq(t, runs.Owner(open(t, s, id)) > 0, true)
	})
	t.Run("validation and private worker entry cannot choose an existing run identity", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"original"}, nil)
		eq(t, s.ask("wait", id).code, 0)
		other := launch(t, s, []string{"new task"}, map[string]string{"ASK_RUN": id, "ASK_RUN_ID": id})
		if other == id {
			t.Fatal("inherited identity reused an existing run")
		}
		eq(t, s.ask("wait", other).code, 0)
		for _, args := range [][]string{{"start", "--run-id", id, "bad"}, {"start", "-m", "missing:x", "bad"}, {"__ask_worker"}, {"__ask_worker", id}} {
			out := s.ask(args...)
			eq(t, out.code, 2)
			eq(t, out.stdout, "")
		}
		eq(t, len(s.calls()), 2)
		eq(t, s.ask("show", id).stdout, "fake: original\n")
	})
}
