package test

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestTitle describes each task form without starting its agent or recording a run.
func TestTitle(t *testing.T) {
	s := fresh(t)
	for _, c := range []struct{ command, description, want string }{
		{`cd /tmp && A=value ask -m fake:small#high -w "fix login" 2>&1 | tail -20`, "", "Small One (high) · Fix login · write\n"},
		{`ask -m fake:big -w --worktree 'fix it'`, "  add a test  ", "Big · Add a test · worktree\n"},
		{`ask -m fake:small 'first line
second line'`, "", "Small One · First line\n"},
		{`ask -m fake:small '` + strings.Repeat("x", 70) + `'`, "", "Small One · X" + strings.Repeat("x", 58) + "…\n"},
		{`ask batch -m fake:small -`, "check tests", "Batch · Check tests\n"},
		{`ask batch --resume abc123`, "finish the batch", "Resume abc123 · Finish the batch\n"},
	} {
		r := s.ask("title", "--command", c.command, "--description", c.description)
		eq(t, r.code, 0)
		eq(t, r.stdout, c.want)
	}
	eq(t, len(s.calls()), 0)
	path := filepath.Join(s.tmp, "tasks.json")
	s.json(path, []object{{"prompt": "check the API"}, {"prompt": "check tests", "model": "fake:big"}, {"prompt": "review"}})
	eq(t, s.ask("title", "--command", "ask batch -m fake:small "+path).stdout, "Batch of 3 · Small One, Big · Check the API\n")
	written := "cd " + s.tmp + " && cat > new.json <<'EOF'\n[{\"prompt\": \"audit runs\"}, {\"prompt\": \"audit hooks\"}]\nEOF\nask batch -m fake:big new.json"
	eq(t, s.ask("title", "--command", written, "--description", "Run audits").stdout, "Batch of 2 · Big · Run audits\n")
	piped := "ask batch -m fake:small - <<'EOF'\n{\"prompt\": \"one\"}\nEOF"
	eq(t, s.ask("title", "--command", piped).stdout, "Batch of 1 · Small One · One\n")
	first := s.ask("-m", "fake:small#high", "-w", "remember")
	id := runID(t, first.stderr)
	eq(t, s.ask("title", "--command", "ask -c "+id+" 'go again'").stdout, "Small One (high) · Go again · write\n")
	eq(t, s.ask("title", "--command", "ask -c "+id+" -m fake:big -r 'look'").stdout, "Big · Look\n")
	t.Run("ask title --hook answers a PreToolUse event for ask commands and stays silent otherwise", func(t *testing.T) {
		s := fresh(t)
		event := `{"tool_name":"Bash","tool_input":{"command":"ask -m fake:small hi","description":"Say hi","timeout":5}}`
		eq(t, s.run([]string{"title", "--hook"}, event, nil).stdout, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"ask -m fake:small hi","description":"Small One · Say hi","run_in_background":true,"timeout":5}}}`+"\n")
		other := s.run([]string{"title", "--hook"}, `{"tool_name":"Bash","tool_input":{"command":"ls","description":"List"}}`, nil)
		eq(t, other.stdout+other.stderr, "")
		eq(t, other.code, 0)
	})
	t.Run("commands that start no task, or cannot be parsed, are left alone", func(t *testing.T) {
		s := fresh(t)
		s.script("commands", "review", "echo fine")
		for _, command := range []string{"echo ask -m fake:small hi", "ask", "ask --help", "ask -m fake:small --help hi", "ask review", `ask -m fake:small "bad`, "ask -m fake:small hi |", "ask title --command hi", "ask help batch", "ask show x", "ask runs", "ask models", "ask stop x", "ask install", "ask packages", "ask remove x"} {
			r := s.ask("title", "--command", command)
			eq(t, r.code, 0)
			eq(t, r.stdout, "")
		}
		eq(t, s.ask("title").code, 2)
		eq(t, s.ask("title", "--command", "ask", "extra").code, 2)
		eq(t, len(s.calls()), 0)
	})
	t.Run("the parsed invocation goes to hooks that declare it, unless --no-hooks", func(t *testing.T) {
		s := fresh(t)
		s.hook("host", []string{"title"}, `echo '{"title":"A better title"}'`)
		r := s.ask("title", "--command", `A=1 ask -m fake:small 'go now' 2>&1`, "--description", "do it")
		eq(t, r.stdout, "A better title\n")
		input := s.hookCalls()[0]["input"].(map[string]any)
		jsonEqual(t, input, object{"title": "Small One · Do it", "command": []string{"ask", "-m", "fake:small", "go now"}, "description": "do it"})
		eq(t, s.ask("title", "--command", "ask -m fake:small --no-hooks hi").stdout, "Small One · Hi\n")
		eq(t, len(s.hookCalls()), 1)
	})
	t.Run("a title hook can customize the shared agent-session title", func(t *testing.T) {
		s := fresh(t)
		s.hook("name-session", []string{"title"}, `echo '{"title":"My custom session"}'`)
		r := s.ask("-m", "fake:small", "fix the login")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("title"), "My custom session")
		input := s.hookCalls()[0]["input"].(map[string]any)
		eq(t, input["title"], "Small One · Fix the login")
		assertTask := input["task"].(map[string]any)
		eq(t, assertTask["prompt"], "fix the login")
		r = s.ask("-m", "fake:small", "keep default", "--no-hooks")
		eq(t, s.calls()[1].s("title"), "Small One · Keep default")
		eq(t, len(s.hookCalls()), 1)
	})
	t.Run("an explicit run word is parsed the way ask parses it", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("title", "--command", `ask run -m fake:small fix`).stdout, "Small One · Run fix\n")
	})
	t.Run("--title overrides the prompt-derived host title", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("title", "--command", `ask -m fake:small --title "Audit parser" actual task`).stdout, "Small One · Audit parser\n")
	})
	t.Run("--title names single and batch agent sessions uniformly", func(t *testing.T) {
		s := fresh(t)
		s.ask("-m", "fake:small", "--title", "Audit parser", "actual prompt")
		eq(t, s.calls()[0].s("title"), "Small One · Audit parser")
		match(t, s.read(filepath.Join(s.home, "runs", s.latest(), "tasks.json")), `"title": "Audit parser"`)

		batch := fresh(t)
		batch.run([]string{"batch", "-j", "1", "-m", "fake:small", "--title", "Shared title", "-"}, `[{"prompt":"one"},{"prompt":"two","title":"Specific title"}]`, nil)
		calls := batch.calls()
		eq(t, calls[0].s("title"), "Small One · Shared title")
		eq(t, calls[1].s("title"), "Small One · Specific title")
	})
	t.Run("a batch file is found before -C applies", func(t *testing.T) {
		s := fresh(t)
		s.mkdir(filepath.Join(s.tmp, "other"))
		s.write(filepath.Join(s.tmp, "jobs.json"), `[{"prompt":"fix","model":"fake:small"}]`)
		eq(t, s.ask("title", "--command", `ask batch -C other jobs.json`).stdout, "Batch of 1 · Small One · Fix\n")
	})
}
