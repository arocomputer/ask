package test

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestSessions covers listing, scoping to the calling conversation, waiting without IDs,
// inspecting, stopping and turns.
func TestSessions(t *testing.T) {
	t.Run("each parent sees its own sessions and all sees everyone's", func(t *testing.T) {
		s := fresh(t)
		one := map[string]string{"CLAUDE_CODE_SESSION_ID": "one"}
		two := map[string]string{"CODEX_THREAD_ID": "two"}
		a := strings.TrimSpace(s.run([]string{"-m", "openai/test-model", "task a"}, "", one).stdout)
		b := strings.TrimSpace(s.run([]string{"-m", "openai/test-model", "task b"}, "", two).stdout)
		s.ask("wait", a)
		s.ask("wait", b)
		eq(t, s.record(a).s("parent"), "claude-code:one")
		eq(t, s.record(b).s("parent"), "codex:two")
		out := s.run([]string{"sessions"}, "", one)
		match(t, out.stdout, "^"+a+"\t20[0-9-]+T[0-9:.]+Z\tsucceeded\t1\tread\tTest Model\t[\\d.]+s\ttask a\n$")
		noMatch(t, out.stdout, b)
		out = s.run([]string{"sessions", "--all"}, "", one)
		match(t, out.stdout, a)
		match(t, out.stdout, b)
		out = s.run([]string{"sessions", "--json"}, "", map[string]string{"ASK_PARENT": "codex:two"})
		list := objects(t, out.stdout)
		eq(t, len(list), 1)
		eq(t, list[0].s("session_id"), b)
		eq(t, list[0].s("parent"), "codex:two")
	})
	t.Run("without a parent, sessions are scoped to the repository", func(t *testing.T) {
		s := fresh(t)
		repo, _ := s.repo()
		inRepo := strings.TrimSpace(s.in(repo, "-m", "openai/test-model", "in repo").stdout)
		outside := strings.TrimSpace(s.ask("-m", "openai/test-model", "outside").stdout)
		s.ask("wait", inRepo)
		s.ask("wait", outside)
		out := s.in(repo, "sessions")
		match(t, out.stdout, inRepo)
		noMatch(t, out.stdout, outside)
		other := filepath.Join(s.tmp, "other")
		s.mkdir(other)
		out = s.in(other, "sessions")
		eq(t, out.stdout, "")
		eq(t, out.stderr, "")
		out = s.ask("sessions", "-n", "1")
		noMatch(t, out.stdout, inRepo)
		match(t, out.stdout, outside)
	})
	t.Run("a session started here but working elsewhere is listed here", func(t *testing.T) {
		s := fresh(t)
		repo, _ := s.repo()
		elsewhere := filepath.Join(s.tmp, "elsewhere")
		s.mkdir(elsewhere)
		id := strings.TrimSpace(s.in(repo, "-m", "openai/test-model", "-C", elsewhere, "look there").stdout)
		s.ask("wait", id)
		eq(t, s.record(id).s("dir"), elsewhere)
		eq(t, s.record(id).s("origin"), repo)
		match(t, s.in(repo, "sessions").stdout, id)
	})
	t.Run("a session keeps one ID across turns and lists its latest", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "openai/test-model", "answer first\nfirst question")
		s.ask("wait", id)
		eq(t, strings.TrimSpace(s.ask("continue", id, "second question").stdout), id)
		out := s.ask("wait", id)
		eq(t, out.stdout, "echo: second question\n")
		match(t, out.stderr, "^ask "+id+" · succeeded · Test Model · turn 2 · ")
		rec := s.record(id)
		eq(t, rec.n("turns"), 2.0)
		eq(t, rec.s("prompt"), "second question")
		list := objects(t, s.ask("sessions", "--json").stdout)
		eq(t, len(list), 1)
		eq(t, list[0].n("turn"), 2.0)
		eq(t, list[0].s("task"), "answer first")
		eq(t, list[0].s("answer"), "echo: second question")
		out = s.ask("continue", id, "--wait", "--json", "third")
		eq(t, obj(t, out.stdout).n("turn"), 3.0)
	})
	t.Run("wait without IDs returns the first active session in scope", func(t *testing.T) {
		s := fresh(t)
		env := map[string]string{"ASK_PARENT": "p"}
		out := s.run([]string{"wait"}, "", env)
		eq(t, out.code, 0)
		eq(t, out.stderr, "ask: no sessions are running\n")
		eq(t, s.run([]string{"wait", "--json"}, "", env).stdout, "null\n")
		quick := strings.TrimSpace(s.run([]string{"-m", "openai/test-model", "answer quick one"}, "", env).stdout)
		until(t, func() bool { return s.record(quick).s("state") == "succeeded" })
		slow := strings.TrimSpace(s.run([]string{"-m", "openai/test-model", "slow\nslow one"}, "", env).stdout)
		// Only active runs are waited for: the finished quick run is not returned again.
		out = s.run([]string{"wait"}, "", env)
		eq(t, out.stdout, "echo: slow one\n")
		out = s.ask("wait", slow, quick)
		match(t, out.stderr, "^ask: completed "+slow+"\nask "+slow+" · succeeded · Test Model · [\\d.]+s · ")
	})
	t.Run("show reports a running session without waiting and follow ends with it", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "openai/test-model", "slow\nhi")
		out := s.ask("show", id)
		eq(t, out.code, 0)
		match(t, out.stderr, "^ask "+id+" · running · Test Model · [\\d.]+s\n$")
		eq(t, out.stdout, "")
		out = s.ask("show", id, "--json")
		eq(t, out.code, 1)
		eq(t, obj(t, out.stdout).s("state"), "running")
		out = s.ask("show", id, "--follow")
		eq(t, out.code, 0)
		match(t, out.stderr, "message: echo: hi\nask "+id+" · succeeded")
		eq(t, out.stdout, "echo: hi\n")
	})
	t.Run("stop ends a turn and wait reports it stopped", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "openai/test-model", "slow\nhi")
		out := s.ask("stop", id)
		eq(t, out.code, 0)
		match(t, out.stderr, "^ask "+id+" · stopped · Test Model · [\\d.]+s\n$")
		out = s.ask("wait", id)
		eq(t, out.code, 1)
		match(t, out.stderr, "^ask "+id+" · stopped · Test Model · [\\d.]+s\n$")
		eq(t, s.record(id).s("state"), "stopped")
		eq(t, s.ask("stop", id).code, 1)
	})
	t.Run("a session whose worker died is reported stopped", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "openai/test-model", "slow\nhi")
		pid, err := exec.Command("pgrep", "-f", "__worker "+s.sessionDir(id)).Output()
		if err != nil {
			t.Fatal("no worker process", err)
		}
		if err := exec.Command("kill", "-9", strings.TrimSpace(string(pid))).Run(); err != nil {
			t.Fatal(err)
		}
		until(t, func() bool { return obj(t, s.ask("show", id, "--json").stdout).s("state") == "stopped" })
		out := s.ask("wait", id)
		eq(t, out.code, 1)
		match(t, out.stderr, "· stopped ·")
	})
	t.Run("unknown sessions and IDs are usage errors", func(t *testing.T) {
		s := fresh(t)
		for _, args := range [][]string{{"wait", "zzzzzz"}, {"show", "nope"}, {"stop", "x"}, {"continue", "zzzzzz", "hi"}} {
			out := s.ask(args...)
			eq(t, out.code, 2)
			match(t, out.stderr, "ask: ")
		}
	})
}
