package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSettings pins settings.json and ask settings: what each setting changes, the review before a save, and bad values.
func TestSettings(t *testing.T) {
	t.Run("settings choose the default model, worktree folders and branch names", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		s.write(filepath.Join(s.home, "settings.json"), `{"model": "fake:big", "worktrees": "`+s.tmp+`/wt/ask-{name}", "branches": "agents/{name}"}`)
		r := s.run([]string{"--wait", "-w", "--worktree", "-C", dir, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		eq(t, r.code, 0)
		match(t, r.stderr, ` · started · Big · write · worktree ~/wt/ask-go\n`)
		match(t, r.stderr, ` · branch agents/go · `)
		git("rev-parse", "--verify", "-q", "refs/heads/agents/go")
		s.write(filepath.Join(s.home, "settings.json"), `{"jobs": 0}`)
		bad := s.ask("--wait", "-m", "fake:small", "hi")
		eq(t, bad.code, 2)
		match(t, bad.stderr, `"jobs" must be a whole number of tasks, 1 or more`)
	})
	t.Run("a relative worktrees setting puts worktrees in the repository's main checkout", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		s.write(filepath.Join(s.home, "settings.json"), `{"model": "fake:big", "worktrees": ".ask/worktrees/{name}"}`)
		linked := filepath.Join(s.tmp, "linked")
		git("worktree", "add", "-q", "-b", "side", linked)
		for _, from := range []string{dir, linked} {
			r := s.run([]string{"--wait", "-w", "--worktree", "-C", from, "go"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
			eq(t, r.code, 0)
		}
		for _, name := range []string{"go", "go-2"} {
			if _, e := os.Stat(filepath.Join(dir, ".ask", "worktrees", name, "b.txt")); e != nil {
				t.Fatalf("no worktree %s in the main checkout: %v", name, e)
			}
		}
	})
	t.Run("ask settings set shows what it changes, then saves; get and unset read and undo", func(t *testing.T) {
		s := fresh(t)
		s.mkdir(filepath.Join(s.tmp, ".claude"))
		r := s.ask("settings", "set", "model", "fake:small")
		eq(t, r.code, 0)
		match(t, r.stderr, `(?m)^~/home/settings.json new  \+\d+$`)
		match(t, r.stderr, `(?m)^\+ +"model": "fake:small"$`)
		match(t, r.stderr, `1 file changed, \d+ insertions?\(\+\)`)
		dry := s.ask("settings", "set", "timeout", "1800", "--dry-run")
		match(t, dry.stderr, `(?m)^- +"model": "fake:small"$`)
		match(t, dry.stderr, `(?m)^\+ +"timeout": 1800$`)
		eq(t, strings.Contains(s.read(filepath.Join(s.home, "settings.json")), "timeout"), false)
		s.ask("settings", "set", "jobs", "6")
		s.ask("settings", "set", "worktrees", "~/wt/ask-{name}")
		s.ask("settings", "set", "skills", "claude-code")
		s.ask("settings", "set", "hook", "on")
		eq(t, s.ask("settings", "get", "jobs").stdout, "6\n")
		eq(t, s.ask("settings", "get", "hook").stdout, "on\n")
		match(t, s.read(filepath.Join(s.tmp, ".claude", "skills", "ask", "SKILL.md")), `(?m)^name: ask$`)
		match(t, s.read(filepath.Join(s.tmp, ".claude", "settings.json")), `"command": "ask title --hook"`)
		eq(t, s.ask("--wait", "-C", s.tmp, "hi").stdout, "fake: hi\n")
		s.ask("settings", "unset", "model")
		eq(t, strings.Contains(s.read(filepath.Join(s.home, "settings.json")), "model"), false)
		match(t, s.ask("settings", "get").stdout, `(?m)^timeout +900 \(default\)$`)
	})
	t.Run("roles can be reviewed, saved, read as JSON and removed without changing other settings", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("settings", "get", "roles", "--json").stdout, "{}\n")
		eq(t, s.ask("settings", "set", "timeout", "1800").code, 0)
		roles := `{"fast":"fake:small#low","deep":"fake:big#high"}`
		dry := s.ask("settings", "set", "roles", roles, "--dry-run")
		eq(t, dry.code, 0)
		match(t, dry.stderr, `"fast": "fake:small#low"`)
		noMatch(t, s.read(filepath.Join(s.home, "settings.json")), `roles`)
		eq(t, s.ask("settings", "set", "roles", roles).code, 0)
		jsonEqual(t, obj(t, s.ask("settings", "get", "roles", "--json").stdout), obj(t, roles))
		jsonEqual(t, obj(t, s.ask("settings", "get", "roles").stdout), obj(t, roles))
		eq(t, s.ask("settings", "set", "model", "fast").code, 0)
		eq(t, s.ask("settings", "get", "timeout").stdout, "1800\n")
		eq(t, s.ask("settings", "set", "model", "unknown").code, 2)
		eq(t, s.ask("settings", "unset", "model").code, 0)
		eq(t, s.ask("settings", "unset", "roles").code, 0)
		eq(t, s.ask("settings", "get", "roles").stdout, "{}\n")
		eq(t, s.ask("settings", "get", "timeout").stdout, "1800\n")
		match(t, s.ask("help").stdout, `ask models --roles`)
		match(t, s.ask("help", "settings").stdout, `ask settings set roles`)
	})
	t.Run("invalid, ambiguous and cyclic role maps fail on read and save before any agent starts", func(t *testing.T) {
		for _, tc := range []struct{ roles, message string }{
			{`null`, `"roles" must be an object`},
			{`[]`, `"roles" must be an object`},
			{`{"fast":false}`, `role "fast" must target`},
			{`{"fast":null}`, `role "fast" must target`},
			{`{"Fast":"fake:small"}`, `names must match`},
			{`{"fast":"fake:small","FAST":"fake:big"}`, `names must match`},
			{`{"fake:small":"fake:big"}`, `names must match`},
			{`{"fast#high":"fake:big"}`, `names must match`},
			{`{"":"fake:small"}`, `names must match`},
			{`{"fast":""}`, `expected agent:id`},
			{`{"fast":"fake:"}`, `expected agent:id`},
			{`{"fast":"fake:small#"}`, `expected agent:id`},
			{`{"fast":"fake:small#low#high"}`, `expected agent:id`},
			{`{"fast":"fake:small high"}`, `expected agent:id`},
			{`{"fast":"fake:small\u00a0"}`, `expected agent:id`},
			{`{"fast":"deep","deep":"fake:big"}`, `roles cannot reference roles`},
			{`{"fast":"fast"}`, `including cycles`},
			{`{"fast":"deep","deep":"fast"}`, `including cycles`},
			{`{"fast":"fake:small","fast":"fake:big"}`, `role "fast" is defined twice`},
		} {
			s := fresh(t)
			bad := s.ask("settings", "set", "roles", tc.roles)
			eq(t, bad.code, 2)
			match(t, bad.stderr, tc.message)
			eq(t, exists(filepath.Join(s.home, "settings.json")), false)
			s.write(filepath.Join(s.home, "settings.json"), `{"roles":`+tc.roles+`}`)
			bad = s.ask("--wait", "-m", "fake:small", "no")
			eq(t, bad.code, 2)
			match(t, bad.stderr, tc.message)
			eq(t, len(s.calls()), 0)
		}
		s := fresh(t)
		s.write(filepath.Join(s.home, "settings.json"), `{"roles":{},"roles":{"fast":"fake:small"}}`)
		match(t, s.ask("settings", "get").stderr, `"roles" is defined twice`)
		s.write(filepath.Join(s.home, "settings.json"), `{"roles":{},"typo":true}`)
		match(t, s.ask("settings", "get").stderr, `unknown setting "typo"`)
	})
	t.Run("bad values and arguments are usage errors", func(t *testing.T) {
		s := fresh(t)
		for _, args := range [][]string{{"settings", "set", "jobs", "0"}, {"settings", "set", "worktrees", "../wt/{name}"}, {"settings", "set", "colour", "red"}, {"settings", "set", "skills", "emacs"}, {"settings", "set", "hook", "maybe"}, {"setup", "--json"}, {"setup", "extra"}, {"settings", "nobody"}} {
			eq(t, s.ask(args...).code, 2)
		}
	})
}
