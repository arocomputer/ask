package test

import (
	"path/filepath"
	"testing"
	"time"
)

// TestModels pins models.json and cost limits.
func TestModels(t *testing.T) {
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
		match(t, r.stderr, `· failed · .* · stopped at the \$2\.00 cost limit; ask -c spend continues it`)
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
