package test

import (
	"regexp"
	"strings"
	"testing"
)

// TestDocs pins ask docs: the built-in pages list, print as markdown when piped, match by prefix
// and search; and every help footer names a page that exists.
func TestDocs(t *testing.T) {
	s := fresh(t)
	list := s.ask("docs")
	eq(t, list.code, 0)
	match(t, list.stdout, `(?m)^settings +Agents, defaults, cost limits`)
	match(t, list.stdout, `(?m)^claude +The official ask agent for Claude Code\.$`)
	page := s.ask("docs", "settings")
	eq(t, strings.HasPrefix(page.stdout, "# Settings\n"), true)
	eq(t, s.ask("docs", "batch").stdout, s.ask("docs", "batches").stdout)
	ambiguous := s.ask("docs", "set")
	eq(t, ambiguous.code, 2)
	match(t, ambiguous.stderr, `"set" could be settings or setup`)
	match(t, s.ask("docs", "--search", "ASK_MAX_COST").stdout, `(?m)^agents:\d+ `)
	eq(t, s.ask("docs", "claude", "--url").stdout, "https://github.com/arocomputer/ask/blob/main/packages/claude/README.md\n")
	footer := regexp.MustCompile(`docs  ask docs ([a-z]+)\n$`)
	for _, topic := range []string{"run", "batch", "bench", "show", "runs", "stop", "wait", "clean", "models", "title", "install", "packages", "remove", "hooks", "agents", "setup", "settings", "docs", "update"} {
		m := footer.FindStringSubmatch(s.ask("help", topic).stdout)
		if m == nil {
			t.Fatalf("help %s has no docs footer", topic)
		}
		eq(t, s.ask("docs", m[1]).code, 0)
	}
}
