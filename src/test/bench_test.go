package test

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestBench pins ask bench: every task on every model, checks that decide a pass, fresh
// worktrees for write attempts, and the per-model report.
func TestBench(t *testing.T) {
	t.Run("every task runs on every model -n times, and its check, given the answer, decides a pass", func(t *testing.T) {
		s := fresh(t)
		tasks := `[{"id":"says","prompt":"hello","check":"grep -q 'fake: hello'"},{"id":"never","prompt":"x","check":"echo nope; exit 3"}]`
		r := s.run([]string{"bench", "-m", "fake:small", "-m", "fake:big", "-n", "2", "-"}, tasks, nil)
		eq(t, r.code, 0)
		eq(t, len(s.calls()), 8)
		report := obj(t, r.stdout)
		rows := []object{}
		for _, x := range report["models"].([]any) {
			rows = append(rows, object(x.(map[string]any)))
		}
		eq(t, fields(rows, "model", "attempts", "passed", "input", "cost"), [][]any{
			{"fake:small", 4.0, 2.0, 40.0, 0.04}, {"fake:big", 4.0, 2.0, 40.0, 0.04}})
		attempts := report["attempts"].([]any)
		eq(t, len(attempts), 8)
		shown := s.ask("show", runID(t, r.stderr)+"/2", "--json")
		eq(t, shown.code, 0)
		result := obj(t, shown.stdout)
		eq(t, result.s("id"), "says")
		eq(t, result.s("model"), "fake:small")
		eq(t, result.s("session"), s.runFile("results.json")[1].s("session"))
		last := object(attempts[7].(map[string]any))
		eq(t, []any{last.s("task"), last.s("model"), last.n("n"), last.b("ok"), last.b("passed"), last.s("note")},
			[]any{"never", "fake:big", 2.0, true, false, "check: nope"})
	})
	t.Run("a write attempt works and is checked in its own worktree, discarded afterward unless --keep", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		tasks := `[{"prompt":"edit","write":true,"check":"test \"$(cat b.txt)\" = new"}]`
		env := map[string]string{"FAKE_WRITE": "b.txt=new"}
		r := s.run([]string{"bench", "-m", "fake:small", "-n", "2", "-C", dir, "-"}, tasks, env)
		eq(t, r.code, 0)
		calls := s.calls()
		if calls[0].s("cwd") == dir || calls[0].s("cwd") == calls[1].s("cwd") {
			t.Fatalf("attempts shared a folder: %s, %s", calls[0].s("cwd"), calls[1].s("cwd"))
		}
		row := object(obj(t, r.stdout)["models"].([]any)[0].(map[string]any))
		eq(t, row.n("passed"), 2.0)
		eq(t, exists(filepath.Join(dir, "b.txt")), false)
		eq(t, git("branch", "--list", "ask/*"), "")
		r = s.run([]string{"bench", "-m", "fake:small", "--keep", "-C", dir, "-"}, tasks, env)
		attempt := object(obj(t, r.stdout)["attempts"].([]any)[0].(map[string]any))
		kept := attempt["worktree"].(map[string]any)["path"].(string)
		eq(t, s.read(filepath.Join(kept, "b.txt")), "new")
	})
	t.Run("ask show prints a bench's report again", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"bench", "-m", "fake:small", "-"}, `[{"prompt":"hi"}]`, nil)
		saved := s.ask("show", runID(t, r.stderr), "--json")
		eq(t, saved.code, 0)
		jsonEqual(t, obj(t, saved.stdout), obj(t, r.stdout))
		match(t, s.ask("show", runID(t, r.stderr)).stdout, `(?m)^model\s+pass\s+median\s+tokens in\s+cost\s+\$/pass\nFake 1\.0\s+1/1\s+\S+s\s+10\s+\$0\.01\s+\$0\.01`)
	})
	t.Run("a task naming a model, a bench without -m, or a check that is not a string, is a usage error", func(t *testing.T) {
		s := fresh(t)
		for _, c := range []struct{ args, tasks, want string }{
			{"-m fake:small", `[{"prompt":"a","model":"fake:big"}]`, `drop "model" and use -m`},
			{"", `[{"prompt":"a"}]`, `needs the models to compare`},
			{"-m fake:small", `[{"prompt":"a","check":true}]`, `"check" must be a shell command`},
		} {
			args := []string{"bench"}
			if c.args != "" {
				args = append(args, strings.Fields(c.args)...)
			}
			r := s.run(append(args, "-"), c.tasks, nil)
			eq(t, r.code, 2)
			match(t, r.stderr, c.want)
		}
		eq(t, len(s.calls()), 0)
	})
}
