package test

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// TestHarness covers the native loop: its tools, access, events, cost and transcript.
func TestHarness(t *testing.T) {
	t.Run("read tools return file content and are confined to the directory", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.tmp, "a.txt"), "alpha\nbeta\n")
		s.write(filepath.Join(s.tmp, "secret.txt"), "x")
		out := s.ask("-m", "openai/test-model", "--wait", `call read {"path":"a.txt","line":2}`+"\n"+`call read {"path":"../../etc/passwd"}`+"\nread")
		eq(t, out.code, 0)
		match(t, out.stdout, `echo: read \| beta\n \| error: ../../etc/passwd is outside the working directory`)
	})
	t.Run("a read run offers no write tools and refuses writes", func(t *testing.T) {
		s := fresh(t)
		out := s.ask("-m", "openai/test-model", "--wait", `call write {"path":"new.txt","content":"x"}`+"\nhi")
		eq(t, out.code, 0)
		match(t, out.stdout, "error: no tool named write")
		if exists(filepath.Join(s.tmp, "new.txt")) {
			t.Fatal("a read run wrote a file")
		}
		names := []string{}
		for _, tool := range s.provider.requests()[0]["tools"].([]any) {
			names = append(names, tool.(map[string]any)["name"].(string))
		}
		eq(t, names, []string{"read", "list", "grep"})
		match(t, s.provider.requests()[0].s("instructions"), "read-only task")
	})
	t.Run("a write run can write, edit and run commands, and its changes are recorded", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		prompt := `call write {"path":"b.txt","content":"hello world\n"}` + "\n" +
			`call edit {"path":"a.txt","old":"one","new":"uno"}` + "\n" +
			`call shell {"command":"cat b.txt && echo done >&2; exit 3"}` + "\nchange"
		out := s.in(dir, "-m", "openai/test-model", "--wait", "-w", prompt)
		eq(t, out.code, 0)
		match(t, out.stdout, `wrote b.txt \| edited a.txt \| exit 3\nhello world\nstderr:\ndone`)
		eq(t, s.read(filepath.Join(dir, "a.txt")), "uno\n")
		match(t, out.stderr, "· write · .* · 2 files changed · ")
		rec := s.record(strings.Fields(out.stderr)[1])
		eq(t, rec.b("write"), true)
		changes := rec["changes"].([]any)
		eq(t, changes[0].(map[string]any)["path"], "a.txt")
		eq(t, changes[1].(map[string]any)["change"], "added")
	})
	t.Run("edit requires exactly one occurrence", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.tmp, "c.txt"), "x x\n")
		out := s.ask("-m", "openai/test-model", "--wait", "-w", `call edit {"path":"c.txt","old":"x","new":"y"}`+"\n"+`call edit {"path":"c.txt","old":"z","new":"y"}`+"\nedit")
		match(t, out.stdout, "occurs more than once")
		match(t, out.stdout, "old text not found")
		eq(t, s.read(filepath.Join(s.tmp, "c.txt")), "x x\n")
	})
	t.Run("list and grep find files", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.tmp, "src", "x.go"), "package x\n// needle here\n")
		s.write(filepath.Join(s.tmp, "src", "y.txt"), "needle too\n")
		out := s.ask("-m", "openai/test-model", "--wait", `call list {"path":"src"}`+"\n"+`call grep {"pattern":"needle","path":"src","glob":"*.go"}`+"\n"+`call grep {"pattern":"nothing[-]here"}`+"\nfind")
		eq(t, out.code, 0)
		match(t, out.stdout, `x.go\ny.txt`)
		match(t, out.stdout, `src/x.go:2:// needle here`)
		noMatch(t, out.stdout, "y.txt:1")
		match(t, out.stdout, `\(no matches\)`)
	})
	t.Run("a shell command is stopped at its timeout", func(t *testing.T) {
		s := fresh(t)
		out := s.ask("-m", "openai/test-model", "--wait", "-w", `call shell {"command":"sleep 5","timeout":1}`+"\nslow shell")
		eq(t, out.code, 0)
		match(t, out.stdout, "timed out after 1 seconds")
	})
	t.Run("activity is recorded and paged", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.tmp, "a.txt"), "alpha\n")
		id := s.launch("-m", "openai/test-model", `call read {"path":"a.txt"}`+"\nanswer the final word")
		s.ask("wait", id)
		page := obj(t, s.ask("show", id, "--after", "0").stdout)
		eq(t, page.s("state"), "succeeded")
		events := page["events"].([]any)
		types := []string{}
		for _, e := range events {
			types = append(types, e.(map[string]any)["type"].(string))
		}
		eq(t, types, []string{"status", "tool", "tool_result", "message", "status"})
		eq(t, events[1].(map[string]any)["text"], "a.txt")
		eq(t, events[2].(map[string]any)["text"], "alpha\n")
		eq(t, events[3].(map[string]any)["text"], "the final word")
		eq(t, page.b("has_more"), false)
		next := int(page.n("next_cursor"))
		later := obj(t, s.ask("show", id, "--after", fmt.Sprint(next)).stdout)
		eq(t, len(later["events"].([]any)), 0)
		eq(t, s.ask("show", id, "--after", "3").code, 2)
		out := s.ask("show", id)
		match(t, out.stderr, "tool read: a.txt\ntool_result read: alpha")
		eq(t, out.stdout, "the final word\n")
	})
	t.Run("cost is priced from the catalog and limited", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "cache", "models.json"), `{"openai":[{"id":"test-model","name":"Test One","input":10,"output":30,"cached":1}]}`)
		out := s.ask("-m", "openai/test-model", "--wait", "hi")
		// 80 fresh input at $10/M + 20 cached at $1/M + 10 output at $30/M.
		match(t, out.stderr, `· succeeded · Test One · .* · \$0.0011\n`)
		id := s.launch("-m", "openai/test-model", "--max-cost", "0.001", `call read {"path":"a.txt"}`+"\nhi")
		out = s.ask("wait", id)
		eq(t, out.code, 1)
		match(t, out.stderr, `failed · .*stopped at the \$0.001 cost limit`)
	})
	t.Run("a turn continues the session's transcript", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "openai/test-model", "answer the answer is 4\nfirst question")
		s.ask("wait", id)
		out := s.ask("continue", id, "second question")
		eq(t, out.code, 0)
		eq(t, strings.TrimSpace(out.stdout), id)
		eq(t, strings.TrimSpace(s.ask("wait", id).stdout), "echo: second question")
		req := s.provider.requests()
		input := req[len(req)-1]["input"].([]any)
		eq(t, len(input), 3)
		eq(t, input[1].(map[string]any)["role"], "assistant")
		out = s.ask("continue", id)
		eq(t, out.code, 2)
		match(t, out.stderr, "give the next turn's prompt")
	})
	t.Run("continuing a failed run asks the model to finish", func(t *testing.T) {
		s := fresh(t)
		id := s.launch("-m", "openai/test-model", "fail boom it broke\nwork")
		s.ask("wait", id)
		out := s.ask("continue", id, "--wait")
		eq(t, out.code, 0)
		match(t, out.stdout, "echo: Continue the task where you left off")
	})
	t.Run("the project's instructions reach the model", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		s.write(filepath.Join(dir, "AGENTS.md"), "Always run make test.\n")
		sub := filepath.Join(dir, "sub")
		s.mkdir(sub)
		s.in(sub, "-m", "openai/test-model", "--wait", "hi")
		instructions := s.provider.requests()[0].s("instructions")
		match(t, instructions, "^You are a subagent")
		match(t, instructions, "Work in the directory "+sub)
		match(t, instructions, "# Project instructions\n\nAlways run make test.")
	})
	t.Run("the request keeps the conversation local and asks for encrypted reasoning", func(t *testing.T) {
		s := fresh(t)
		s.ask("-m", "openai/test-model#high", "--wait", "hi")
		req := s.provider.requests()[0]
		eq(t, req["store"], false)
		eq(t, req["stream"], true)
		eq(t, req["model"], "test-model")
		eq(t, req["reasoning"].(map[string]any)["effort"], "high")
		eq(t, req["include"].([]any)[0], "reasoning.encrypted_content")
		id := s.launch("-m", "openai/test-model", "reason\nhi")
		s.ask("wait", id)
		s.ask("continue", id, "--wait", "more")
		input := s.provider.requests()[2]["input"].([]any)
		eq(t, input[1].(map[string]any)["type"], "reasoning")
	})
	t.Run("gateways get a user agent and a conversation header, and no reasoning replay", func(t *testing.T) {
		s := fresh(t)
		delete(s.env, "OPENAI_API_KEY")
		s.write(filepath.Join(s.home, "auth.json"), `{"opencode-go":{"api_key":"test-key","base_url":"`+s.provider.URL()+`"},"mine":{"api_key":"test-key","base_url":"`+s.provider.URL()+`"}}`)
		id := s.launch("-m", "opencode-go/glm-5.3", "reason\nhi")
		s.ask("wait", id)
		s.ask("continue", id, "more")
		s.ask("wait", id)
		req := s.provider.requests()
		eq(t, len(req), 2)
		headers := req[1]["_headers"].(map[string]any)
		eq(t, headers["user-agent"], "ask/dev")
		eq(t, headers["session"], id)
		if _, has := req[1]["include"]; has {
			t.Fatal("a gateway must not be asked for encrypted reasoning")
		}
		for _, item := range req[1]["input"].([]any) {
			if item.(map[string]any)["type"] == "reasoning" {
				t.Fatal("a gateway's reasoning item was replayed")
			}
		}
		out := s.ask("-m", "mine/any-model", "--wait", "custom")
		eq(t, out.code, 0)
		eq(t, out.stdout, "echo: custom\n")
		out = s.ask("-m", "openai/test-model", "--wait", "hi")
		eq(t, out.code, 2)
		match(t, out.stderr, "no credential for openai: set OPENAI_API_KEY or run ask setup")
	})
	t.Run("a missing credential fails the run clearly", func(t *testing.T) {
		s := fresh(t)
		delete(s.env, "OPENAI_API_KEY")
		out := s.ask("-m", "openai/test-model", "hi")
		eq(t, out.code, 2)
		match(t, out.stderr, "no credential for openai: set OPENAI_API_KEY or run ask setup")
		s.write(filepath.Join(s.home, "auth.json"), `{"openai":{"api_key":"test-key"}}`)
		eq(t, s.ask("-m", "openai/test-model", "--wait", "hi").code, 0)
	})
}
