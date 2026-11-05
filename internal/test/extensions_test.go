package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestExtensions covers extensions: the harness contract, tools, commands, and installing.
func TestExtensions(t *testing.T) {
	t.Run("a harness gets the contract and its answer, usage and session are recorded", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "fake:small#high", "say hi")
		out := s.ask("wait", id)
		eq(t, out.code, 0)
		eq(t, out.stdout, "fake: say hi\n")
		match(t, out.stderr, `^ask `+id+` · succeeded · Fake 1.0 · [\d.]+s · 10 in · 5 out · 2 cached · \$0.01\n$`)
		call := s.calls()[0]
		eq(t, call.s("model"), "small")
		eq(t, call.s("effort"), "high")
		eq(t, call.s("access"), "read")
		eq(t, call.s("contract"), "4")
		eq(t, call.s("cwd"), s.tmp)
		match(t, call.s("title"), "^Small · say hi$")
		rec := s.record(id)
		match(t, rec.s("harness_session"), `^s-\d+$`)
		eq(t, rec.s("name"), "Fake 1.0")
	})
	t.Run("a later turn resumes the harness's own session", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "fake:small", "one")
		s.ask("wait", id)
		eq(t, strings.TrimSpace(s.ask("continue", id, "-w", "two").stdout), id)
		s.ask("wait", id)
		calls := s.calls()
		eq(t, calls[1].s("session"), s.record(id).s("harness_session"))
		eq(t, calls[1].s("access"), "write")
		eq(t, calls[1].s("stdin"), "two")
		eq(t, s.record(id).b("write"), true)
	})
	t.Run("a harness failure reports its last stderr line", func(t *testing.T) {
		s := fresh(t)
		id := strings.TrimSpace(s.run([]string{"-m", "fake:small", "break it"}, "", map[string]string{"FAKE_FAIL": "break"}).stdout)
		out := s.ask("wait", id)
		eq(t, out.code, 1)
		match(t, out.stderr, "· failed · .*fake boom")
	})
	t.Run("the cost limit stops a harness that reports spending", func(t *testing.T) {
		s := fresh(t)
		id := strings.TrimSpace(s.run([]string{"-m", "fake:small", "--max-cost", "1", "spend"}, "", map[string]string{"FAKE_SPEND": "spend"}).stdout)
		out := s.ask("wait", id)
		eq(t, out.code, 1)
		match(t, out.stderr, `stopped at the \$1.00 cost limit`)
	})
	t.Run("models lists harness models and an unknown harness is a usage error", func(t *testing.T) {
		s := fresh(t)
		out := s.ask("models")
		match(t, out.stdout, "fake:small\tSmall One\nfake:big\n")
		out = s.ask("-m", "ghost:x", "hi")
		eq(t, out.code, 2)
		match(t, out.stderr, `"ghost" is not an installed harness \(installed: fake\)`)
	})
	t.Run("a schema answer that is not JSON fails", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.tmp, "schema.json"), `{"type":"object"}`)
		id := strings.TrimSpace(s.run([]string{"-m", "fake:small", "--schema", filepath.Join(s.tmp, "schema.json"), "q"}, "", map[string]string{"FAKE_ANSWER": "not json"}).stdout)
		out := s.ask("wait", id)
		eq(t, out.code, 1)
		match(t, out.stderr, "not valid JSON")
		eq(t, s.calls()[0]["schema"].(map[string]any)["type"], "object")
	})
	t.Run("an extension's tools and notes reach the native harness", func(t *testing.T) {
		s := fresh(t)
		ext := filepath.Join(s.home, "agent", "extensions", "docs")
		s.write(filepath.Join(ext, "extension.json"), `{"tools": [
			{"name": "search_docs", "description": "Search the docs", "command": "search", "access": "read",
			 "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}},
			{"name": "publish", "description": "Publish the docs", "command": "search"}],
			"instructions": "NOTES.md"}`)
		s.write(filepath.Join(ext, "NOTES.md"), "Use search_docs before answering about the docs.\n")
		s.write(filepath.Join(ext, "search"), "#!/bin/sh\nprintf 'found: '; cat; [ -z \"$OPENAI_API_KEY\" ] && printf ' (no key)'\n")
		if e := os.Chmod(filepath.Join(ext, "search"), 0755); e != nil {
			t.Fatal(e)
		}
		out := s.ask("-m", "openai/test-model", "--wait", `call search_docs {"q":"retries"}`+"\nlook")
		eq(t, out.code, 0)
		eq(t, out.stdout, "echo: look | found: {\"q\":\"retries\"} (no key)\n")
		req := s.provider.requests()[0]
		names := []string{}
		for _, tool := range req["tools"].([]any) {
			names = append(names, tool.(map[string]any)["name"].(string))
		}
		eq(t, names, []string{"read", "list", "grep", "search_docs"})
		match(t, req.s("instructions"), "# Tool notes\n\nUse search_docs before answering about the docs.")
		s.ask("-m", "openai/test-model", "-w", "--wait", "write now")
		last := s.provider.requests()[2]
		names = []string{}
		for _, tool := range last["tools"].([]any) {
			names = append(names, tool.(map[string]any)["name"].(string))
		}
		eq(t, names, []string{"read", "list", "grep", "write", "edit", "shell", "search_docs", "publish"})
	})
	t.Run("an extension's command runs as ask NAME, after the built-ins", func(t *testing.T) {
		s := fresh(t)
		ext := filepath.Join(s.home, "agent", "extensions", "workflows")
		s.write(filepath.Join(ext, "extension.json"), `{"commands": {"review": "bin/review", "sessions": "bin/review"}}`)
		s.write(filepath.Join(ext, "bin", "review"), "#!/bin/sh\necho \"review $* via $(basename \"$ASK_BIN\")\"\nexit 3\n")
		if e := os.Chmod(filepath.Join(ext, "bin", "review"), 0755); e != nil {
			t.Fatal(e)
		}
		out := s.ask("review", "HEAD~1")
		eq(t, out.code, 3)
		eq(t, out.stdout, "review HEAD~1 via ask\n")
		match(t, s.ask("help").stdout, "EXTENSION COMMANDS\n  review:      from the workflows extension")
		eq(t, s.ask("sessions").code, 0)
		eq(t, s.ask("sessions").stdout, "")
	})
	t.Run("a broken manifest is listed with its error and provides nothing", func(t *testing.T) {
		s := fresh(t)
		ext := filepath.Join(s.home, "agent", "extensions", "broken")
		s.write(filepath.Join(ext, "extension.json"), `{"harness": {"prefix": "x", "command": "missing"}, "colour": 1}`)
		list := objects(t, s.ask("extensions", "--json").stdout)
		eq(t, len(list), 2)
		eq(t, list[0].s("name"), "broken")
		match(t, list[0].s("error"), `unknown field "colour"`)
		eq(t, list[1].s("harness"), "fake")
		out := s.ask("extensions")
		match(t, out.stdout, "broken\terror: extension.json")
		match(t, out.stdout, "fake\tharness fake:\tyours\n")
	})
	t.Run("install adds built-in, folder and git extensions, and remove deletes them", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("install", "codex").code, 0)
		launcher := filepath.Join(s.home, "agent", "extensions", "codex", "codex")
		info, err := os.Stat(launcher)
		if err != nil || info.Mode()&0111 == 0 {
			t.Fatal("the built-in harness was not installed executable")
		}
		if exists(filepath.Join(s.home, "agent", "extensions", "codex", "test")) {
			t.Fatal("tests were installed")
		}
		src := filepath.Join(s.tmp, "mine")
		s.write(filepath.Join(src, "extension.json"), `{"commands": {"hello": "hello"}}`)
		s.write(filepath.Join(src, "hello"), "#!/bin/sh\necho hello from mine\n")
		if e := os.Chmod(filepath.Join(src, "hello"), 0755); e != nil {
			t.Fatal(e)
		}
		out := s.ask("install", src)
		eq(t, out.code, 0)
		eq(t, out.stderr, "installed mine: ask hello\n")
		eq(t, s.ask("hello").stdout, "hello from mine\n")
		repo := filepath.Join(s.tmp, "remote")
		s.write(filepath.Join(repo, "extension.json"), `{"instructions": "NOTES.md"}`)
		s.write(filepath.Join(repo, "NOTES.md"), "Be careful.\n")
		git := s.gitAt(repo)
		git("init", "-q", "-b", "main")
		git("add", ".")
		git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "first")
		eq(t, s.ask("install", "file://"+repo).code, 0)
		list := objects(t, s.ask("extensions", "--json").stdout)
		sources := map[string]string{}
		for _, e := range list {
			sources[e.s("name")] = e.s("source")
		}
		eq(t, sources["codex"], "builtin")
		eq(t, sources["mine"], src)
		eq(t, sources["remote"], "file://"+repo)
		eq(t, sources["fake"], "")
		out = s.ask("install", filepath.Join(s.home, "agent", "extensions", "fake"))
		eq(t, out.code, 2)
		match(t, out.stderr, "is your own extension")
		eq(t, s.ask("remove", "mine").code, 0)
		eq(t, s.ask("hello").code, 2)
		eq(t, s.ask("remove", "mine").code, 2)
		eq(t, s.ask("install", "pi-nonexistent-folder").code, 2)
	})
}
