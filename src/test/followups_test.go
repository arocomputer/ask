package test

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// TestFollowups pins -c: which session, model and access a follow-up gets, and what it refuses.
func TestFollowups(t *testing.T) {
	t.Run("-c continues the agent session where it ran, with the same model", func(t *testing.T) {
		s := fresh(t)
		work := filepath.Join(s.tmp, "work")
		s.mkdir(work)
		first := s.ask("-m", "fake:big#high", "-C", work, "remember PELICAN")
		second := s.ask("-c", runID(t, first.stderr), "what word?")
		eq(t, second.code, 0)
		a, b := s.calls()[0], s.calls()[1]
		eq(t, b.s("session"), fmt.Sprintf("s-%.0f", a.n("pid")))
		eq(t, b.s("cwd"), work)
		eq(t, b.s("model"), "big")
		eq(t, b.s("effort"), "high")
		eq(t, b.s("stdin"), "what word?")
		match(t, second.stderr, `follow-up `+runID(t, first.stderr))
	})
	t.Run("a batch follow-up inherits access and cost but keeps its directory", func(t *testing.T) {
		s := fresh(t)
		work := filepath.Join(s.tmp, "work")
		other := filepath.Join(s.tmp, "other")
		s.mkdir(work)
		s.mkdir(other)
		first := s.ask("-m", "fake:small", "-w", "-C", work, "--max-cost", "2", "change it")
		eq(t, first.code, 0)
		tasks, _ := json.Marshal([]object{{"continue": runID(t, first.stderr), "prompt": "more", "dir": other}})
		second := s.run([]string{"batch", "-C", other, "-"}, string(tasks), nil)
		eq(t, second.code, 0)
		call := s.calls()[1]
		eq(t, call.s("access"), "write")
		eq(t, call.s("max_cost"), "2")
		eq(t, call.s("cwd"), work)
	})
	t.Run("a follow-up keeps write access unless it says -r, and may change the model within the agent", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("-m", "fake:big", "-w", "change it")
		id := runID(t, first.stderr)
		s.ask("-c", id, "more")
		s.ask("-c", id, "-r", "-m", "fake:small", "look")
		eq(t, fields(s.calls(), "access", "model"), [][]any{{"write", "big"}, {"write", "big"}, {"read", "small"}})
	})
	t.Run("a follow-up to another agent, or to a run with no session, is refused", func(t *testing.T) {
		s := fresh(t)
		s.script("agents", "other", "echo hi")
		fake := s.ask("-m", "fake:small", "hi")
		other := s.ask("-m", "other:x", "hi")
		switched := s.ask("-c", runID(t, fake.stderr), "-m", "other:x", "more")
		eq(t, switched.code, 2)
		match(t, switched.stderr, `must use the same agent`)
		sessionless := s.ask("-c", runID(t, other.stderr), "more")
		eq(t, sessionless.code, 2)
		match(t, sessionless.stderr, `reported no session`)
	})
	t.Run("a run that timed out can still be continued", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"-m", "fake:small", "-t", "0.5", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		match(t, first.stderr, `timed out`)
		second := s.ask("-c", runID(t, first.stderr), "finish")
		eq(t, second.code, 0)
		eq(t, s.calls()[1].s("session"), fmt.Sprintf("s-%.0f", s.calls()[0].n("pid")))
	})
	t.Run("a batch task is continued as RUN/TASK, from a follow-up or another batch", func(t *testing.T) {
		s := fresh(t)
		batch := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"id":"a","prompt":"x"},{"id":"b","prompt":"y"}]`, nil)
		id := runID(t, batch.stderr)
		bare := s.ask("-c", id, "more")
		eq(t, bare.code, 2)
		match(t, bare.stderr, `continue one of them, like `+id+`/a`)
		s.ask("-c", id+"/b", "more")
		input, _ := json.Marshal([]object{{"continue": id + "/a", "prompt": "again"}})
		s.run([]string{"batch", "-"}, string(input), nil)
		by := func(prompt string) object {
			for _, c := range s.calls() {
				if strings.HasSuffix(c.s("stdin"), prompt) {
					return c
				}
			}
			t.Fatalf("no call ending %q", prompt)
			return nil
		}
		eq(t, by("more").s("session"), fmt.Sprintf("s-%.0f", by("y").n("pid")))
		eq(t, by("again").s("session"), fmt.Sprintf("s-%.0f", by("x").n("pid")))
	})
	t.Run("a follow-up of a task whose worktree was removed never runs in a folder another run holds", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		r := s.run([]string{"batch", "-m", "fake:small", "-w", "--worktree", "-C", dir, "-"}, `[{"id":"a","prompt":"look"}]`, nil)
		id := runID(t, r.stderr)
		taken := filepath.Join(s.home, "worktrees", id+"-1-a")
		git("worktree", "add", "-q", "-b", "other", taken)
		s.ask("-c", id+"/a", "now change it")
		if cwd := s.calls()[1].s("cwd"); cwd == taken || !strings.HasPrefix(cwd, filepath.Join(s.home, "worktrees")) {
			t.Fatalf("follow-up ran in %s", cwd)
		}
	})
	t.Run("-c accepts a single-task run's folder", func(t *testing.T) {
		s := fresh(t)
		s.ask("-m", "fake:small", "hello")
		eq(t, s.ask("-c", filepath.Join(s.home, "runs", s.latest()), "more").code, 0)
	})
	t.Run("-c of a run with no result says it has not finished", func(t *testing.T) {
		s := fresh(t)
		s.json(filepath.Join(s.home, "runs", "20260101T000000000-abc123-hung", "tasks.json"), []object{{"id": "1", "prompt": "x", "model": "fake:small", "write": false, "json": false, "dir": s.tmp, "timeout": 900}})
		r := s.ask("-c", "hung", "more")
		eq(t, r.code, 2)
		match(t, r.stderr, `hung cannot be continued: it has not finished`)
	})
}
