package test

import (
	"testing"
)

// TestSetup pins ask setup for machines: its report, its exit status and its flags.
func TestSetup(t *testing.T) {
	t.Run("--check reports every agent and setting, and exits 1 while an installed agent cannot run", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("setup", "--check")
		eq(t, r.code, 0)
		match(t, r.stdout, `(?m)^  ✔ fake +ready · \d+ models?$`)
		match(t, r.stdout, `(?m)^  timeout +900 \(default\)$`)
		s.script("agents", "claude", `echo "Claude Code not found: install it" >&2; exit 1`)
		r = s.ask("setup", "--check", "--json")
		eq(t, r.code, 1)
		match(t, r.stdout, `"reason": "Claude Code not found: install it"`)
	})
	t.Run("without a terminal or flags it reports and says how to change things", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("setup")
		eq(t, r.code, 0)
		match(t, r.stdout, `(?m)^Agents$`)
		match(t, r.stderr, `run ask setup in a terminal`)
	})
}
