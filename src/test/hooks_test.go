package test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestHooks pins task and result hooks: their order, what they may change, and failing open.
func TestHooks(t *testing.T) {
	t.Run("task hooks run in name order, each changing the task the next one sees", func(t *testing.T) {
		s := fresh(t)
		s.hook("a-route", []string{"task"}, `echo '{"task":{"model":"fake:big","prompt":"fix it (routed)"}}'`)
		s.hook("b-context", []string{"task"}, `echo '{"task":{"prompt":"Context first. fix it (routed)"}}'`)
		r := s.ask("-m", "fake:small", "-w", "fix it")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("model"), "big")
		eq(t, s.calls()[0].s("stdin"), "Context first. fix it (routed)")
		input := s.hookCalls()[1]["input"].(map[string]any)
		task := input["task"].(map[string]any)
		eq(t, task["prompt"], "fix it (routed)")
	})
	t.Run("a task hook can refuse a task, which then never runs", func(t *testing.T) {
		s := fresh(t)
		s.hook("guard", []string{"task"}, `case "$input" in *'"write":true'*) echo '{"refuse":"no writes here"}';; esac`)
		r := s.ask("-m", "fake:small", "-w", "delete everything")
		eq(t, r.code, 1)
		eq(t, len(s.calls()), 0)
		match(t, r.stderr, `(?m) · failed · .* · refused by hook guard: no writes here$`)
	})
	t.Run("a hook that crashes or prints nonsense changes nothing and leaves a note", func(t *testing.T) {
		s := fresh(t)
		s.hook("broken", []string{"task"}, "echo 'Error: boom' >&2; echo 'runtime banner' >&2; exit 1")
		s.hook("chatty", []string{"task"}, "echo 'not json'")
		s.hook("typo", []string{"task"}, `echo '{"task":{"write":"yes","dir":"/"}}'`)
		s.hook("vague", []string{"task"}, `echo '{"refuse":true}'`)
		r := s.ask("-m", "fake:small", "look")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("access"), "read")
		match(t, r.stderr, `(?m)^ask [\w-]+ · note · hook broken · failed: .*boom`)
		match(t, r.stderr, `(?m)^ask [\w-]+ · note · hook chatty · failed: printed something other than JSON$`)
		match(t, r.stderr, `(?m)^ask [\w-]+ · note · hook typo · ignored a change to "write"$`)
		match(t, r.stderr, `(?m)^ask [\w-]+ · note · hook typo · ignored a change to "dir"$`)
		match(t, r.stderr, `(?m)^ask [\w-]+ · note · hook vague · ignored "refuse": expected a string$`)
	})
	t.Run("a result hook can ask the same agent for a follow-up, and the rounds make one result", func(t *testing.T) {
		s := fresh(t)
		s.hook("verify", []string{"result"}, `case "$input" in *'"answer":"fake: try again"'*) ;; *) echo '{"followup":"try again","note":"tests fail"}';; esac`)
		r := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt":"fix the bug"}]`, nil)
		result := objects(t, r.stdout)[0]
		first, second := s.calls()[0], s.calls()[1]
		eq(t, second.s("session"), fmt.Sprintf("s-%.0f", first.n("pid")))
		eq(t, second.s("stdin"), "try again")
		eq(t, result.s("answer"), "fake: try again")
		eq(t, result.n("followups"), 1.0)
		jsonEqual(t, result["usage"], object{"input": 20, "output": 10, "cached": 4, "cost": 0.02})
		match(t, r.stderr, `(?m)^ask [\w-]+ · note · hook verify · tests fail$`)
		match(t, r.stderr, `(?m)^ask [\w-]+ · follow-up · hook verify · try again$`)
	})
	t.Run("follow-ups stop after three, so a hook that is never satisfied cannot loop forever", func(t *testing.T) {
		s := fresh(t)
		s.hook("never", []string{"result"}, `echo '{"followup":"again"}'`)
		r := s.ask("-m", "fake:small", "go")
		eq(t, len(s.calls()), 4)
		match(t, r.stderr, `hook never · asked for a follow-up after 3; stopping`)
	})
	t.Run("a result hook can fail a result", func(t *testing.T) {
		s := fresh(t)
		s.hook("strict", []string{"result"}, `echo '{"fail":"no tests were run"}'`)
		r := s.ask("-m", "fake:small", "go")
		eq(t, r.code, 1)
		eq(t, r.stdout, "")
		match(t, r.stderr, `(?m) · failed · .* · failed by hook strict: no tests were run$`)
	})
	t.Run("a hook gets only the events it declares, and --no-hooks skips them all", func(t *testing.T) {
		s := fresh(t)
		s.hook("after", []string{"result"}, ":")
		s.ask("-m", "fake:small", "go")
		eq(t, stringsField(s.hookCalls(), "event"), []string{"result"})
		match(t, s.hookCalls()[0].s("run"), `^go$`)
		s.ask("-m", "fake:small", "--no-hooks", "go")
		eq(t, len(s.hookCalls()), 1)
	})
	t.Run("a follow-up of a hook-routed run keeps the agent and access that ran it", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("other", `cat >/dev/null; echo '{"session":"other-session"}' > "$ASK_REPORT"; echo fine`)
		s.hook("route", []string{"task"}, `if [ ! -e "$HOME/routed" ]; then touch "$HOME/routed"; echo '{"task":{"model":"other:small","write":true}}'; fi`)
		r := s.ask("-m", "fake:small", "go")
		eq(t, r.code, 0)
		follow := s.ask("-c", runID(t, r.stderr), "again")
		eq(t, follow.code, 0)
		result := obj(t, s.ask("show", runID(t, follow.stderr), "--json").stdout)
		eq(t, result.s("model"), "other:small")
		eq(t, s.calls(), []object(nil))
	})
	t.Run("a large hook timeout is clamped, not expired at once", func(t *testing.T) {
		s := fresh(t)
		s.hook("long", []string{"task"}, `echo '{"task":{"timeout":3000000}}'`)
		s.localAgent("slow", `cat >/dev/null; sleep 0.05; echo done`)
		r := s.ask("-m", "slow:small", "go")
		eq(t, r.code, 0)
		noMatch(t, r.stderr, `timed out`)
	})
	t.Run("read access a hook chose carries forward to follow-ups", func(t *testing.T) {
		s := fresh(t)
		s.hook("route", []string{"task"}, `if [ ! -e "$HOME/routed" ]; then touch "$HOME/routed"; echo '{"task":{"write":false}}'; fi`)
		first := s.ask("-m", "fake:small", "-w", "go")
		eq(t, first.code, 0)
		follow := s.ask("-c", runID(t, first.stderr), "again")
		eq(t, follow.code, 0)
		eq(t, s.calls()[1].s("access"), "read")
	})
	t.Run("a hook that cannot start changes nothing", func(t *testing.T) {
		s := fresh(t)
		path := filepath.Join(s.home, "hooks", "broken")
		s.write(path, "not an executable format\n")
		if err := os.Chmod(path, 0755); err != nil {
			t.Fatal(err)
		}
		s.hook("vanish", []string{"task"}, `echo '{"task":{"write":true}}'`)
		// The declaration succeeds but the event's interpreter cannot start.
		s.script("hooks", "vanish", `if [ "$1" = events ]; then echo task; printf '#!/no/such/interpreter\n' > "$0"; exit 0; fi`)
		r := s.ask("-m", "fake:small", "go")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("access"), "read")
		match(t, r.stderr, `hook broken · failed:`)
		match(t, r.stderr, `hook vanish · failed:`)
	})
	t.Run("the status line describes the task as hooks routed it", func(t *testing.T) {
		s := fresh(t)
		s.hook("route", []string{"task"}, `echo '{"task":{"model":"fake:big","write":true}}'`)
		r := s.ask("-m", "fake:small", "go")
		match(t, r.stderr, ` · started · Big · write · `)
	})
}
