package test

import (
	"path/filepath"
	"testing"
)

// TestCompat keeps released records readable, listed and continuable without rewriting fixtures.
func TestCompat(t *testing.T) {
	t.Run("a version 1 run record can be shown, listed and continued", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20261001T120000000-abc123")
		for _, name := range []string{"tasks.json", "results.json"} {
			s.write(filepath.Join(dir, name), s.read(filepath.Join(root, "src", "test", "fixtures", "run-v1", name)))
		}
		shown := s.ask("show", "abc123")
		eq(t, shown.stdout, "The token expiry is compared in seconds against milliseconds.\n")
		match(t, shown.stderr, `(?m)^ask abc123 · ok · Fake 1\.0 · 41\.2s · 1 file changed · 52\.1k in · 2\.0k out · \$0\.31$`)
		match(t, s.ask("runs").stdout, `(?m)^abc123 .* ok +Fake 1\.0 +41\.2s +Why does the login test fail\?$`)
		followup := s.ask("-c", "abc123", "Fix it.")
		eq(t, followup.code, 0)
		eq(t, s.calls()[0].s("session"), "s-fixture")
		eq(t, s.calls()[0].s("access"), "write")
	})
	t.Run("a v0.1.0 run record, named and stopped at its cost limit, can be shown, listed and continued", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20261002T120000000-k3f9a2-port-parser-rust")
		for _, name := range []string{"tasks.json", "results.json"} {
			s.write(filepath.Join(dir, name), s.read(filepath.Join(root, "src", "test", "fixtures", "run-v0.1.0", name)))
		}
		shown := s.ask("show", "port-parser-rust")
		eq(t, shown.code, 1)
		match(t, shown.stderr, `(?m)^ask port-parser-rust · failed · Fake 1\.0 · 6:12 · 412\.0k in · 9\.1k out · \$25\.31 · stopped at the \$25 cost limit; ask -c port-parser-rust continues it$`)
		eq(t, s.ask("show", "k3f9a2").stderr, shown.stderr)
		match(t, s.ask("runs", "--all").stdout, `(?m)^port-parser-rust +k3f9a2 .* failed +Fake 1\.0 +6:12 +Port the parser to Rust\.$`)
		followup := s.ask("-c", "port-parser-rust", "Go on.")
		eq(t, followup.code, 0)
		eq(t, s.calls()[0].s("session"), "s-fixture-2")
		eq(t, s.calls()[0].s("max_cost"), "25")
	})
	t.Run("every agent, hook and command gets the contract version as ASK_CONTRACT", func(t *testing.T) {
		s := fresh(t)
		s.hook("seen", []string{"task"}, `printf '{"note":"contract %s"}\n' "$ASK_CONTRACT"`)
		r := s.ask("-m", "fake:small", "go")
		eq(t, s.calls()[0].s("contract"), "1")
		match(t, r.stderr, `hook seen · contract 1`)
	})
}
