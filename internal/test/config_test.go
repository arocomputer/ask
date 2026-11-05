package test

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// TestConfig covers config, the home layout, declared models, setup and help.
func TestConfig(t *testing.T) {
	t.Run("config keys are printed, set and removed", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("config").stdout, "{}\n")
		eq(t, s.ask("config", "model", "openai/x").code, 0)
		eq(t, s.ask("config", "timeout", "30").code, 0)
		eq(t, s.ask("config", "worktree", "on").code, 0)
		eq(t, s.ask("config", "model").stdout, `"openai/x"`+"\n")
		eq(t, s.ask("config").stdout, "{\n  \"model\": \"openai/x\",\n  \"timeout\": 30,\n  \"worktree\": true\n}\n")
		eq(t, s.ask("config", "model", "").code, 0)
		eq(t, s.ask("config", "model").code, 1)
		out := s.ask("config", "colour", "blue")
		eq(t, out.code, 2)
		match(t, out.stderr, `unknown key "colour"`)
		eq(t, s.ask("config", "timeout", "soon").code, 2)
		out = s.ask("config", "model", "no-provider")
		eq(t, out.code, 2)
		match(t, out.stderr, "models are named provider/model")
		s.write(filepath.Join(s.home, "config.json"), `{"nope": 1}`)
		out = s.ask("-m", "openai/test-model", "hi")
		eq(t, out.code, 2)
		match(t, out.stderr, `unknown key "nope"`)
	})
	t.Run("nothing is created in the home folder until it is used", func(t *testing.T) {
		s := fresh(t)
		home := filepath.Join(s.tmp, "empty-home")
		env := map[string]string{"ASK_HOME": home}
		for _, args := range [][]string{{"help"}, {"sessions"}, {"models"}, {"config"}, {"extensions"}, {"wait"}} {
			s.run(args, "", env)
		}
		if exists(home) {
			t.Fatal("reading commands created the home folder")
		}
		s.run([]string{"-m", "openai/test-model", "--wait", "hi"}, "", env)
		entries, _ := os.ReadDir(home)
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		eq(t, names, []string{"agent"})
		entries, _ = os.ReadDir(filepath.Join(home, "agent"))
		names = []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		eq(t, names, []string{"sessions"})
	})
	t.Run("declared models name and price models and list harness models", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "models.json"), `{"openai": {"test-model": {"name": "Declared", "input": 10, "output": 30, "cached": 1}, "other": "Other One"}, "fake": {"declared-only": "Declared Only"}}`)
		s.write(filepath.Join(s.home, "cache", "models.json"), `{"openai":[{"id":"test-model","name":"Fetched"},{"id":"cached-only","name":"Cached Only"}]}`)
		out := s.ask("models")
		eq(t, out.stdout, "openai/cached-only\tCached Only\nopenai/other\tOther One\nopenai/test-model\tDeclared\nfake:declared-only\tDeclared Only\nfake:small\tSmall One\nfake:big\n")
		out = s.ask("-m", "openai/test-model", "--wait", "hi")
		match(t, out.stderr, `· succeeded · Declared · .* · \$0.0011\n`)
		s.write(filepath.Join(s.home, "models.json"), `{"openai": {"x": 3}}`)
		out = s.ask("models")
		eq(t, out.code, 2)
		match(t, out.stderr, "openai/x must be a name or")
	})
	t.Run("setup saves a key, a default model and the skill", func(t *testing.T) {
		s := fresh(t)
		delete(s.env, "OPENAI_API_KEY")
		s.mkdir(filepath.Join(s.tmp, ".claude"))
		out := s.run([]string{"setup"}, "sk-test\n\n\nn\nopenai/test-model\ny\n", nil)
		eq(t, out.code, 0)
		eq(t, obj(t, s.read(filepath.Join(s.home, "auth.json")))["openai"].(map[string]any)["api_key"], "sk-test")
		info, _ := os.Stat(filepath.Join(s.home, "auth.json"))
		eq(t, info.Mode().Perm(), os.FileMode(0600))
		eq(t, s.ask("config", "model").stdout, `"openai/test-model"`+"\n")
		skill := s.read(filepath.Join(s.tmp, ".claude", "skills", "ask", "SKILL.md"))
		match(t, skill, "(?s)^---\nname: ask\n.*ask wait.*ask sessions")
		s.write(filepath.Join(s.tmp, ".claude", "skills", "ask", "SKILL.md"), "mine")
		s.run([]string{"setup"}, "y\n", nil)
		eq(t, s.read(filepath.Join(s.tmp, ".claude", "skills", "ask", "SKILL.md")), "mine")
	})
	t.Run("setup offers the keys OpenCode already holds", func(t *testing.T) {
		s := fresh(t)
		delete(s.env, "OPENAI_API_KEY")
		s.write(filepath.Join(s.tmp, ".local", "share", "opencode", "auth.json"), `{"opencode-go":{"type":"api","key":"go-key"},"openai":{"type":"oauth","access":"x"}}`)
		out := s.run([]string{"setup"}, "\n\ny\nn\n\n", nil)
		eq(t, out.code, 0)
		match(t, out.stderr, `OpenCode has a key for opencode-go; use it for ask too\?`)
		auth := obj(t, s.read(filepath.Join(s.home, "auth.json")))
		eq(t, auth["opencode-go"].(map[string]any)["api_key"], "go-key")
		if _, has := auth["openai"]; has {
			t.Fatal("an OAuth entry is not an API key")
		}
	})
	t.Run("help and version", func(t *testing.T) {
		s := fresh(t)
		out := s.ask("help")
		eq(t, out.code, 0)
		match(t, out.stdout, "(?s)^Hand a task to a subagent.\n\nUSAGE\n  ask \\[flags\\] <prompt>.*CORE COMMANDS\n  run:.*  sessions:.*MORE COMMANDS\n  models:.*  extensions:.*LEARN MORE\n")
		match(t, s.ask("help", "continue").stdout, "(?s)^Add a turn to a session.*USAGE\n  ask continue <id>")
		eq(t, s.ask("help", "nope").code, 2)
		eq(t, s.ask("--version").stdout, "dev\n")
	})
}
