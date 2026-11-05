package test

import (
	"path/filepath"
	"testing"
)

// TestBatch pins position-based recording, defaults, parallel results and resumption.
func TestBatch(t *testing.T) {
	t.Run("batch keeps task order and records tasks.json and results.json", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-j", "2", "-"}, `[{"id":"slow","prompt":"one slow","model":"fake:small"},{"id":"fast","prompt":"two","model":"fake:big"}]`, map[string]string{"FAKE_SLOW": "slow"})
		eq(t, r.code, 0)
		eq(t, fields(objects(t, r.stdout), "id", "ok", "answer"), [][]any{{"slow", true, "fake: one slow"}, {"fast", true, "fake: two"}})
		eq(t, len(s.dirs()), 1)
		eq(t, stringsField(s.runFile("tasks.json"), "id"), []string{"slow", "fast"})
		eq(t, stringsField(s.runFile("results.json"), "id"), []string{"slow", "fast"})
	})
	t.Run("batch accepts JSON lines, with -m as the default model and a task model winning", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-m", "fake:small"}, "{\"prompt\": \"a\"}\n{\"prompt\": \"b\", \"model\": \"fake:big\"}", nil)
		eq(t, fields(objects(t, r.stdout), "id", "model"), [][]any{{"1", "fake:small"}, {"2", "fake:big"}})
	})
	t.Run("a JSON line that does not parse is reported by its line in the input", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-m", "fake:small"}, "\n\n{bad", nil)
		eq(t, r.code, 2)
		match(t, r.stderr, `cannot parse line 3:`)
	})
	t.Run("a batch task whose write is not a boolean is a usage error", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-m", "fake:small"}, `[{"prompt":"a","write":"false"}]`, nil)
		eq(t, r.code, 2)
		match(t, r.stderr, `"write" must be true or false`)
		eq(t, len(s.calls()), 0)
	})
	t.Run("batch -w is the default write access, and a task may override it", func(t *testing.T) {
		s := fresh(t)
		s.run([]string{"batch", "-w", "-m", "fake:small"}, `[{"prompt":"a"},{"prompt":"b","write":false}]`, nil)
		eq(t, sorted(stringsField(s.calls(), "access")), []string{"read", "write"})
		eq(t, fields(s.runFile("tasks.json"), "write"), [][]any{{true}, {false}})
	})
	t.Run("an explicit -r is a ceiling: a task asking for write is refused, not run with it", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-r", "-m", "fake:small"}, `[{"prompt":"a"},{"prompt":"b","write":true}]`, nil)
		eq(t, r.code, 2)
		match(t, r.stderr, `asks for "write": true, but -r makes every task read-only`)
		eq(t, len(s.calls()), 0)
	})
	t.Run("a batch task without a model is a usage error that lists the models", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch"}, `[{"prompt":"a"}]`, nil)
		eq(t, r.code, 2)
		match(t, r.stderr, `task 1 needs a model`)
		match(t, r.stderr, `fake +small  +big`)
	})
	t.Run("an empty batch is a usage error", func(t *testing.T) {
		s := fresh(t)
		for _, input := range []string{"", "[]"} {
			r := s.run([]string{"batch", "-m", "fake:small"}, input, nil)
			eq(t, r.code, 2)
			match(t, r.stderr, `no tasks`)
		}
	})
	t.Run("a failed batch task is reported and the batch exits 1", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "-m", "fake:small"}, `[{"prompt":"fine"},{"prompt":"break"}]`, map[string]string{"FAKE_FAIL": "break"})
		eq(t, r.code, 1)
		result := objects(t, r.stdout)
		eq(t, result[0].b("ok"), true)
		eq(t, result[1].b("ok"), false)
		eq(t, result[1].s("error"), "fake boom")
	})
	t.Run("batch --resume reruns only the tasks that did not finish", func(t *testing.T) {
		s := fresh(t)
		s.run([]string{"batch", "-m", "fake:small"}, `[{"prompt":"fine"},{"prompt":"break"}]`, map[string]string{"FAKE_FAIL": "break"})
		eq(t, len(s.calls()), 2)
		r := s.ask("batch", "--resume", filepath.Join(s.home, "runs", s.dirs()[0]))
		eq(t, r.code, 0)
		eq(t, len(s.calls()), 3)
		match(t, s.calls()[2].s("stdin"), `break$`)
		eq(t, fields(objects(t, r.stdout), "ok"), [][]any{{true}, {true}})
	})
	t.Run("batch --resume reruns a failed task even when a finished one shares its id", func(t *testing.T) {
		s := fresh(t)
		s.run([]string{"batch", "-m", "fake:small"}, `[{"id":"x","prompt":"fine"},{"id":"x","prompt":"break"}]`, map[string]string{"FAKE_FAIL": "break"})
		r := s.ask("batch", "--resume", filepath.Join(s.home, "runs", s.dirs()[0]))
		eq(t, len(s.calls()), 3)
		match(t, s.calls()[2].s("stdin"), `break$`)
		eq(t, stringsField(objects(t, r.stdout), "answer"), []string{"fake: fine", "fake: break"})
	})
	t.Run("batch --resume of an unknown run is a usage error", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("batch", "--resume", filepath.Join(s.tmp, "nope"))
		eq(t, r.code, 2)
		match(t, r.stderr, `no run at`)
	})
}
