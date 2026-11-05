package test

import (
	"strings"
	"testing"
)

// TestHelp pins ask help and its aliases: one screen, command pages, errors and suggestions.
func TestHelp(t *testing.T) {
	t.Run("ask help gives commands, options and models in one screen", func(t *testing.T) {
		s := fresh(t)
		s.script("agents", "broken", "echo 'not logged in' >&2; exit 1")
		r := s.ask("help")
		eq(t, r.code, 0)
		if len(strings.Split(strings.TrimSpace(r.stdout), "\n")) > 40 {
			t.Fatal("help is too long")
		}
		match(t, r.stdout, `(?m)^  fake +small  +big$`)
		match(t, r.stdout, `(?m)^  --model MODEL`)
		match(t, r.stdout, `(?m)^  --directory DIR`)
		match(t, r.stdout, `(?m)^  --timeout SECONDS`)
		match(t, r.stdout, `Short forms: -m, -w, -c, -C, -t`)
		match(t, r.stdout, `(?m)^  broken +\(could not list: not logged in\)$`)
		eq(t, len(s.calls()), 0)
		match(t, r.stdout, `ask help run · ask help COMMAND`)
		for topic, page := range map[string]string{"batch": "batches", "hooks": "hooks", "agents": "agents"} {
			r := s.ask("help", topic)
			eq(t, r.code, 0)
			match(t, r.stdout, `(?m)^ask `+topic+` · `)
			match(t, r.stdout, `\ndocs  ask docs `+page+`\n$`)
		}
	})
	t.Run("large model catalogs point to the agent's settings", func(t *testing.T) {
		s := fresh(t)
		s.script("agents", "many", `i=1; while [ "$i" -le 13 ]; do echo "model-$i"; i=$((i + 1)); done`)
		r := s.ask("help")
		eq(t, r.code, 0)
		match(t, r.stdout, `13 models; ask models --all lists; ask settings many chooses`)
	})
	t.Run("run help keeps title long-only and timeout on -t", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("run", "--help")
		match(t, r.stdout, `--title TEXT`)
		noMatch(t, r.stdout, `-t,? --title`)
		match(t, r.stdout, `--timeout SECONDS.*alias: -t`)
	})
	t.Run("models show display names and keep ids for scripts", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("models").stdout, "fake:small\nfake:big\n")
		eq(t, s.ask("models", "--names").stdout, "fake:small\tSmall One\nfake:big\tBig\n")
	})
	t.Run("a usage error is one line that names its help topic", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("batch", "--typo")
		eq(t, r.code, 2)
		eq(t, r.stderr, "ask: unknown option --typo; see ask help batch\n")
		r = s.ask("help", "nope")
		eq(t, r.code, 2)
		eq(t, r.stderr, "ask: unknown help topic \"nope\"; see ask help\n")
		eq(t, s.ask("setup", "one", "two").stderr, "ask: ask setup takes no arguments; see ask help setup\n")
		r = s.ask("-m", "unknown:small", "hi")
		eq(t, r.code, 2)
		match(t, r.stderr, `(?m)^  fake +small  +big$`)
	})
	t.Run("a command's page and its --help print the same text", func(t *testing.T) {
		s := fresh(t)
		for _, command := range []string{"run", "batch", "bench", "show", "runs", "wait", "clean", "stop", "models", "title", "install", "packages", "remove", "setup", "settings", "docs", "update"} {
			fromTopic := s.ask("help", command)
			eq(t, fromTopic.code, 0)
			fromFlag := s.ask(command, "--help")
			eq(t, fromFlag.stdout, fromTopic.stdout)
			eq(t, s.ask(command, "-h").stdout, fromTopic.stdout)
			match(t, fromTopic.stdout, `(?m)^Usage$`)
		}
		overview := s.ask().stdout
		for _, argv := range [][]string{{"help"}, {"-h"}, {"--help"}} {
			eq(t, s.ask(argv...).stdout, overview)
		}
	})
	t.Run("a near-miss option gets a suggestion, an unrelated one does not", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("-help").stderr, "ask: unknown option -help; did you mean --help?\n")
		eq(t, s.ask("-version").stderr, "ask: unknown option -version; did you mean --version?\n")
		eq(t, s.ask("batch", "--resme").stderr, "ask: unknown option --resme; did you mean --resume?; see ask help batch\n")
		eq(t, s.ask("--version").stdout, s.ask("-V").stdout)
	})
}
