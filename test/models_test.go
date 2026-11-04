package test

import (
	"path/filepath"
	"testing"
	"time"
)

// TestModels pins models.json, role resolution and discovery, and cost limits.
func TestModels(t *testing.T) {
	t.Run("roles are explicit choices recorded as exact models in runs and batches", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "settings.json"), `{"model":"fast","roles":{"fast":"fake:SMALL#low","deep":"fake:big#high"}}`)
		first := s.ask("hello")
		eq(t, first.code, 0)
		eq(t, s.calls()[0].s("model"), "small")
		eq(t, s.calls()[0].s("effort"), "low")
		for _, file := range []string{"tasks.json", "results.json"} {
			eq(t, s.runFile(file)[0].s("model"), "fake:small#low")
		}
		r := s.run([]string{"batch", "-m", "deep", "-j", "1", "-"}, `[{"prompt":"one"},{"model":"fast","prompt":"two"},{"model":"fake:big","prompt":"three"}]`, nil)
		eq(t, r.code, 0)
		eq(t, fields(objects(t, s.read(filepath.Join(s.home, "runs", s.latest(), "tasks.json"))), "model"), [][]any{{"fake:big#high"}, {"fake:small#low"}, {"fake:big"}})
		eq(t, fields(objects(t, s.read(filepath.Join(s.home, "runs", s.latest(), "results.json"))), "model"), [][]any{{"fake:big#high"}, {"fake:small#low"}, {"fake:big"}})
		unknown := s.ask("-m", "missing", "no")
		eq(t, unknown.code, 2)
		match(t, unknown.stderr, `unknown model role "missing"; expected agent:id.*ask models --roles`)
		eq(t, len(s.calls()), 4)
	})
	t.Run("role discovery is sorted and keeps existing model list formats intact without calling agents", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("models", "--roles").stdout, "")
		s.write(filepath.Join(s.home, "settings.json"), `{"roles":{"review":"missing:Exact#high","fast":"fake:SMALL"}}`)
		s.script("agents", "broken", `touch "$HOME/model-list-ran"; exit 1`)
		r := s.ask("models", "--roles")
		eq(t, r.code, 0)
		eq(t, r.stdout, "fast\tfake:small\nreview\tmissing:exact#high\n")
		eq(t, exists(filepath.Join(s.tmp, "model-list-ran")), false)
		eq(t, s.ask("models").stdout, "fake:small\nfake:big\n")
		eq(t, s.ask("models", "--names").stdout, "fake:small\tSmall One\nfake:big\tBig\n")
		eq(t, s.ask("models", "--all").stdout, "fake:small\ton\nfake:big\ton\n")
		for _, extra := range []string{"--all", "--names", "--enable", "fake:small"} {
			eq(t, s.ask("models", "--roles", extra).code, 2)
		}
		missing := s.ask("-m", "review", "no")
		eq(t, missing.code, 2)
		match(t, missing.stderr, `no agent "missing"`)
	})
	t.Run("roles use the resolved model's enabled state and cost limits with explicit overrides", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "settings.json"), `{"max_cost":2,"roles":{"fast":"fake:SMALL#low"}}`)
		eq(t, s.ask("models", "fake:small", "--disable").code, 0)
		r := s.ask("-m", "fast", "no")
		eq(t, r.code, 2)
		match(t, r.stderr, `fake:small is off in models.json`)
		eq(t, len(s.calls()), 0)
		eq(t, s.ask("models", "fake:small", "--enable", "--max-cost", "5").code, 0)
		eq(t, s.ask("-m", "fast", "model limit").code, 0)
		eq(t, s.ask("-m", "fast", "--max-cost", "1", "explicit limit").code, 0)
		eq(t, s.ask("-m", "fast", "--max-cost", "0", "no limit").code, 0)
		eq(t, s.ask("models", "fake:small", "--max-cost", "0").code, 0)
		eq(t, s.ask("-m", "fast", "setting limit").code, 0)
		eq(t, fields(s.calls(), "max_cost"), [][]any{{"5"}, {"1"}, {nil}, {"2"}})
	})
	t.Run("models.json turns models off and on; off ones are hidden and refused, and the older list form still adds models", func(t *testing.T) {
		s := fresh(t)
		all := s.ask("models").stdout
		match(t, all, `(?m)^fake:small$`)
		eq(t, s.ask("models", "fake:small", "--disable").code, 0)
		noMatch(t, s.ask("models").stdout, `(?m)^fake:small$`)
		match(t, s.ask("models", "--all").stdout, `(?m)^fake:small\toff$`)
		r := s.ask("-m", "fake:small", "hi")
		eq(t, r.code, 2)
		match(t, r.stderr, `fake:small is off in models.json; turn it on with ask models fake:small --enable`)
		s.ask("models", "fake:small", "--enable")
		eq(t, s.ask("-m", "fake:small", "hi").code, 0)
		eq(t, exists(filepath.Join(s.home, "models.json")), false)
		s.write(filepath.Join(s.home, "models.json"), `{"fake": ["extra"]}`)
		match(t, s.ask("models").stdout, `(?m)^fake:extra$`)
	})
	t.Run("model ids ignore case, so a model turned off can't be reached by spelling it differently", func(t *testing.T) {
		s := fresh(t)
		s.ask("models", "fake:small", "--disable")
		r := s.ask("-m", "fake:SMALL", "hi")
		eq(t, r.code, 2)
		match(t, r.stderr, `fake:small is off in models.json`)
		s.write(filepath.Join(s.home, "models.json"), `{"fake": {"big": true, "BIG": false}}`)
		match(t, s.ask("models").stderr, `fake:(big|BIG) is named twice; model ids ignore case`)
	})
	t.Run("a cost limit is the run's, else its model's, else the setting; past it ask stops the agent and says how to continue", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "settings.json"), `{"max_cost": 2}`)
		start := time.Now()
		r := s.run([]string{"-m", "fake:small", "spend it"}, "", map[string]string{"FAKE_SPEND": "spend"})
		eq(t, r.code, 1)
		match(t, r.stderr, `· failed · .* · stopped at the \$2\.00 cost limit; follow up with ask continue spend PROMPT`)
		if time.Since(start) > 10*time.Second {
			t.Fatal("the agent was not stopped at its limit")
		}
		s.ask("models", "fake:small", "--max-cost", "5")
		s.ask("-m", "fake:small", "a")
		s.ask("-m", "fake:small", "--max-cost", "1", "b")
		s.ask("-m", "fake:big", "c")
		calls := s.calls()
		eq(t, []string{calls[1].s("max_cost"), calls[2].s("max_cost"), calls[3].s("max_cost")}, []string{"5", "1", "2"})
	})
}
