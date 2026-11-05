package test

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestNames pins run names: made from the prompt, kept apart, taken over by follow-ups, and hookable.
func TestNames(t *testing.T) {
	t.Run("a run is named after its prompt, and a later run with the same name gets a number", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "Please add rate limiting to the login route.")
		eq(t, runID(t, first.stderr), "add-rate-limiting-login")
		second := s.ask("--wait", "-m", "fake:small", "Add rate limiting to login")
		eq(t, runID(t, second.stderr), "add-rate-limiting-login-2")
	})
	t.Run("a follow-up takes over the name, so -c NAME reaches the latest turn and the ID an earlier one", func(t *testing.T) {
		s := fresh(t)
		s.ask("--wait", "-m", "fake:small", "remember PELICAN")
		id := strings.Fields(strings.Split(s.ask("runs").stdout, "\n")[1])[1]
		second := s.ask("--wait", "-c", "remember-pelican", "and FALCON")
		eq(t, runID(t, second.stderr), "remember-pelican")
		s.ask("--wait", "-c", "remember-pelican", "what words?")
		calls := s.calls()
		eq(t, calls[2].s("session"), calls[1].s("session"))
		eq(t, s.ask("show", "remember-pelican").stdout, "fake: what words?\n")
		eq(t, s.ask("show", id).stdout, "fake: remember PELICAN\n")
		eq(t, len(s.dirs()), 3)
	})
	t.Run("a batch task's follow-up never takes the batch's name, even when the task id has no usable words", func(t *testing.T) {
		s := fresh(t)
		s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"ü","prompt":"fix bug"},{"prompt":"fix bug two"}]`, nil)
		eq(t, runID(t, s.ask("--wait", "-c", "fix-bug/1", "more").stderr), "fix-bug-2")
		eq(t, s.ask("show", "fix-bug/2").stdout, "fake: fix bug two\n")
	})
	t.Run("a name hook can rename a run from its prompts; a failing one keeps the prompt's name", func(t *testing.T) {
		s := fresh(t)
		s.hook("namer", []string{"name"}, `echo '{"name":"Login Throttle"}'`)
		r := s.ask("--wait", "-m", "fake:small", "Add rate limiting to login")
		eq(t, runID(t, r.stderr), "login-throttle")
		eq(t, s.hookCalls()[0].s("event"), "name")
		s.hook("namer", []string{"name"}, `exit 3`)
		r = s.ask("--wait", "-m", "fake:small", "Add rate limiting to login")
		eq(t, runID(t, r.stderr), "add-rate-limiting-login")
		match(t, r.stderr, `(?m)^ask add-rate-limiting-login · note · hook namer · failed`)
	})
	t.Run("a name hook is told whether the run works in a worktree, whose name its answer also sets", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		s.hook("namer", []string{"name"}, `echo '{"name":"bright running fox"}'`)
		s.ask("--wait", "-m", "fake:small", "look around")
		r := s.run([]string{"--wait", "-m", "fake:small", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		s.run([]string{"batch", "--wait", "-m", "fake:small", "-C", dir, "-"}, `[{"prompt":"go","write":true,"worktree":true}]`, map[string]string{"FAKE_WRITE": "c.txt=new"})
		calls := s.hookCalls()
		eq(t, object(calls[0]["input"].(map[string]any)).b("worktree"), false)
		eq(t, object(calls[1]["input"].(map[string]any)).b("worktree"), true)
		eq(t, object(calls[2]["input"].(map[string]any)).b("worktree"), true)
		s.write(filepath.Join(s.home, "settings.json"), `{"worktree":true}`)
		s.run([]string{"--wait", "-m", "fake:small", "-w", "-C", dir, "another"}, "", map[string]string{"FAKE_WRITE": "d.txt=new"})
		eq(t, object(s.hookCalls()[3]["input"].(map[string]any)).b("worktree"), true)
		eq(t, runID(t, r.stderr), "bright-running-fox-2")
		match(t, git("branch", "--list", "ask/bright-running-fox-2"), `ask/bright-running-fox-2`)
	})
}
