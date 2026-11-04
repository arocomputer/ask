package test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestRun pins option validation, prompt/answer formatting and process shutdown.
func TestRun(t *testing.T) {
	t.Run("no arguments print the help", func(t *testing.T) {
		s := fresh(t)
		r := s.ask()
		eq(t, r.code, 0)
		match(t, r.stdout, `ask \[options\] PROMPT`)
	})
	t.Run("a missing -m is a usage error that lists the models", func(t *testing.T) {
		s := fresh(t)
		s.json(filepath.Join(s.home, "models.json"), object{"fake": []string{"extra"}})
		r := s.ask("hello")
		eq(t, r.code, 2)
		match(t, r.stderr, `needs a model`)
		match(t, r.stderr, `fake +small  +big`)
		match(t, r.stderr, `fake +small  +big  +extra`)
		eq(t, len(s.calls()), 0)
	})
	t.Run("a malformed model or an unknown agent is a usage error", func(t *testing.T) {
		s := fresh(t)
		bad := s.ask("-m", "opus", "hello")
		eq(t, bad.code, 2)
		match(t, bad.stderr, `expected agent:id`)
		unknown := s.ask("-m", "gemini:x", "hello")
		eq(t, unknown.code, 2)
		match(t, unknown.stderr, `no agent "gemini" in .*; installed: fake;`)
	})
	t.Run("-r and -w together are refused", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("-m", "fake:small", "-r", "-w", "hello")
		eq(t, r.code, 2)
		match(t, r.stderr, `choose one of -r`)
		eq(t, len(s.calls()), 0)
	})
	t.Run("a models.json that does not parse is a usage error", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "models.json"), "{")
		r := s.ask("models")
		eq(t, r.code, 2)
		match(t, r.stderr, `cannot parse`)
	})
	t.Run("a JSON string answer is printed as JSON", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:big", "--json", "go"}, "", map[string]string{"FAKE_ANSWER": `"hello"`})
		eq(t, r.stdout, "\"hello\"\n")
		_, raw := s.runFile("results.json")[0]["raw_answer"]
		eq(t, raw, false)
	})
	t.Run("--json strips a code fence around the answer", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:big", "--json", "go"}, "", map[string]string{"FAKE_ANSWER": "```json\n{\"a\": 1}\n```"})
		jsonEqual(t, obj(t, r.stdout), object{"a": 1})
		match(t, s.calls()[0].s("stdin"), `Answer ONLY with JSON`)
	})
	t.Run("an answer that is not valid JSON fails under --json", func(t *testing.T) {
		s := fresh(t)
		s.hook("capture", []string{"result"}, `printf '%s' "$input" > "$HOME/result-hook.json"`)
		answer := " \n```json\n{\"private\": \"recovery-only\",}\n```\n "
		r := s.run([]string{"-m", "fake:big", "--json", "go"}, "", map[string]string{"FAKE_ANSWER": answer})
		eq(t, r.code, 1)
		match(t, r.stderr, `not valid JSON`)
		eq(t, r.stdout, "")
		noMatch(t, r.stderr, `recovery-only`)
		saved := s.runFile("results.json")[0]
		eq(t, saved.b("ok"), false)
		eq(t, saved.s("raw_answer"), answer+"\n") // The fake appends a newline.
		_, hasAnswer := saved["answer"]
		eq(t, hasAnswer, false)
		hooked := obj(t, s.read(filepath.Join(s.tmp, "result-hook.json")))["result"].(map[string]any)
		eq(t, hooked["raw_answer"], answer+"\n")
		shown := s.ask("show", runID(t, r.stderr), "--json")
		eq(t, shown.code, 1)
		eq(t, obj(t, shown.stdout).s("raw_answer"), answer+"\n")
		noMatch(t, shown.stderr, `recovery-only`)
		plain := s.ask("show", runID(t, r.stderr))
		eq(t, plain.code, 1)
		eq(t, plain.stdout, "")
	})
	t.Run("-C sets the directory the model works in", func(t *testing.T) {
		s := fresh(t)
		s.mkdir(filepath.Join(s.tmp, "work"))
		s.ask("-m", "fake:small", "-C", filepath.Join(s.tmp, "work"), "hi")
		eq(t, s.calls()[0].s("cwd"), filepath.Join(s.tmp, "work"))
	})
	t.Run("long model, directory and timeout options are accepted together", func(t *testing.T) {
		s := fresh(t)
		s.mkdir(filepath.Join(s.tmp, "work"))
		r := s.ask("--model", "fake:small", "--directory", filepath.Join(s.tmp, "work"), "--timeout", "30", "hello")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("cwd"), filepath.Join(s.tmp, "work"))
	})
	t.Run("the prompt is read from stdin when none is given", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:small"}, "from stdin\n", nil)
		eq(t, r.stdout, "fake: from stdin\n")
	})
	t.Run("a hung model times out and its process is killed", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:small", "-t", "0.5", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		eq(t, r.code, 1)
		match(t, r.stderr, `timed out`)
		eq(t, alive(int(s.calls()[0].n("pid"))), false)
	})
	t.Run("stopping ask with SIGINT stops the models it started", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"-m", "fake:big", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		pid := int(s.calls()[0].n("pid"))
		if e := run.cmd.Process.Signal(syscall.SIGINT); e != nil {
			t.Fatal(e)
		}
		eq(t, run.wait(t).code, 130)
		until(t, func() bool { return !alive(pid) })
	})
	t.Run("a failing model exits 1 with its message", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:big", "break"}, "", map[string]string{"FAKE_FAIL": "break"})
		eq(t, r.code, 1)
		match(t, r.stderr, `(?m) · failed · .*fake boom$`)
		eq(t, r.stdout, "")
	})
	t.Run("stopping ask kills a model that ignores SIGTERM before exiting", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"-m", "fake:big", "hang"}, "", map[string]string{"FAKE_HANG": "hang", "FAKE_IGNORE_TERM": "1"})
		until(t, func() bool { return len(s.calls()) == 1 })
		pid := int(s.calls()[0].n("pid"))
		if e := run.cmd.Process.Signal(syscall.SIGINT); e != nil {
			t.Fatal(e)
		}
		eq(t, run.wait(t).code, 130)
		eq(t, alive(pid), false)
	})
	t.Run("agents get the prompt as given, with the access in ASK_ACCESS", func(t *testing.T) {
		s := fresh(t)
		s.ask("-m", "fake:small", "where is main?")
		s.ask("-m", "fake:small", "-w", "fix it")
		calls := s.calls()
		eq(t, calls[0].s("stdin")+","+calls[1].s("stdin"), "where is main?,fix it")
		eq(t, calls[0].s("access")+","+calls[1].s("access"), "read,write")
	})
	t.Run("the answer goes to stdout and a status line with usage to stderr", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("-m", "fake:small", "hi")
		eq(t, r.stdout, "fake: hi\n")
		match(t, r.stderr, `started.* · id `+strings.SplitN(s.latest(), "-", 3)[1]+`\n`)
		id := runID(t, r.stderr)
		match(t, r.stderr, fmt.Sprintf(`^ask %s · started · Small One · read · .+\nask %s · ok · Fake 1\.0 · [\d.]+s · 10 in · 5 out · 2 cache read · \$0\.01\n$`, id, id))
	})
	t.Run("a run that reports no usage prints no usage", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:small", "hi"}, "", map[string]string{"FAKE_NO_USAGE": "1"})
		eq(t, r.code, 0)
		noMatch(t, r.stderr, ` in .* out`)
	})
	t.Run("an answer from an agent that exited nonzero fails", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"-m", "fake:small", "hi"}, "", map[string]string{"FAKE_EXIT": "1"})
		eq(t, r.code, 1)
		match(t, r.stderr, `(?m) · failed · .*exit 1$`)
		eq(t, r.stdout, "")
		_, raw := s.runFile("results.json")[0]["raw_answer"]
		eq(t, raw, false)
	})
	t.Run("--schema answers are checked, then printed as JSON", func(t *testing.T) {
		s := fresh(t)
		path := filepath.Join(s.tmp, "s.json")
		s.json(path, object{"type": "object", "properties": object{"a": object{"type": "number"}}, "required": []string{"a"}})
		good := s.run([]string{"-m", "fake:small", "--schema", path, "go"}, "", map[string]string{"FAKE_ANSWER": `{"a": 1}`})
		jsonEqual(t, obj(t, good.stdout), object{"a": 1})
		match(t, s.calls()[0].s("stdin"), `Answer ONLY with JSON matching this JSON Schema`)
		answer := " \n```json\n{\"a\": \"one\", \"private\": \"schema-only\"}\n```\n "
		bad := s.run([]string{"-m", "fake:small", "--schema", path, "go"}, "", map[string]string{"FAKE_ANSWER": answer})
		eq(t, bad.code, 1)
		match(t, bad.stderr, `does not match the schema: \$\.a: expected number, got string`)
		eq(t, bad.stdout, "")
		noMatch(t, bad.stderr, `schema-only`)
		shown := s.ask("show", runID(t, bad.stderr), "--json")
		eq(t, shown.code, 1)
		record := obj(t, shown.stdout)
		eq(t, record.b("ok"), false)
		eq(t, record.s("raw_answer"), answer+"\n")
		_, hasAnswer := record["answer"]
		eq(t, hasAnswer, false)
	})
	t.Run("a relative -C is resolved once, against where ask runs", func(t *testing.T) {
		s := fresh(t)
		s.mkdir(filepath.Join(s.tmp, "work"))
		r := s.ask("-m", "fake:small", "-C", "work", "hi")
		eq(t, r.code, 0)
		eq(t, s.calls()[0].s("cwd"), filepath.Join(s.tmp, "work"))
	})
	t.Run("numbers are checked: -t, -j and a task timeout must be above 0, and -t at most 2000000", func(t *testing.T) {
		s := fresh(t)
		for _, args := range [][]string{{"-m", "fake:small", "-t", "abc", "hi"}, {"batch", "-j", "0", "-m", "fake:small", "-"}} {
			r := s.run(args, `[{"prompt": "a"}]`, nil)
			eq(t, r.code, 2)
			match(t, r.stderr, `needs a (whole )?number above 0`)
		}
		long := s.ask("-m", "fake:small", "-t", "inf", "hi")
		eq(t, long.code, 2)
		match(t, long.stderr, `-t needs at most 2000000 seconds, not "inf"`)
		task := s.run([]string{"batch", "-m", "fake:small", "-"}, `[{"prompt": "a", "timeout": "soon"}]`, nil)
		match(t, task.stderr, `task 1: timeout must be a number of seconds above 0, at most 2000000`)
		eq(t, len(s.calls()), 0)
	})
	t.Run("words after -- are the prompt, even ones that look like options", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("-m", "fake:small", "--", "-w", "is a flag")
		eq(t, r.stdout, "fake: -w is a flag\n")
		eq(t, s.calls()[0].s("access"), "read")
	})
	t.Run("schema checks use own properties and compare enums by value", func(t *testing.T) {
		s := fresh(t)
		req := filepath.Join(s.tmp, "req.json")
		s.json(req, object{"type": "object", "required": []string{"constructor"}})
		missing := s.run([]string{"-m", "fake:small", "--schema", req, "go"}, "", map[string]string{"FAKE_ANSWER": "{}"})
		match(t, missing.stderr, `missing "constructor"`)
		enum := filepath.Join(s.tmp, "enum.json")
		s.json(enum, object{"enum": []object{{"a": 1, "b": 2}}})
		reordered := s.run([]string{"-m", "fake:small", "--schema", enum, "go"}, "", map[string]string{"FAKE_ANSWER": `{"b": 2, "a": 1}`})
		eq(t, reordered.code, 0)
	})
	t.Run("a report that is not an object is ignored, not fatal", func(t *testing.T) {
		s := fresh(t)
		s.script("agents", "odd", `echo null > "$ASK_REPORT"; echo fine`)
		r := s.ask("-m", "odd:x", "go")
		eq(t, r.code, 0)
		eq(t, r.stdout, "fine\n")
	})
	t.Run("a prompt given as arguments leaves the caller's stdin unread", func(t *testing.T) {
		s := fresh(t)
		cmd := exec.Command("sh", "-c", `printf 'a\nb\n' | while read -r p; do "$ASK_TEST_BIN" -m fake:small "$p"; done`)
		cmd.Env = append(os.Environ(), "ASK_TEST_BIN="+askBin, "ASK_HOME="+s.home, "HOME="+s.tmp, "FAKE_LOG="+s.log)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err, string(out))
		}
		eq(t, string(out), "fake: a\nfake: b\n")
	})
	t.Run("an agent killed by a signal fails naming the signal", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("killed", `kill -TERM $$`)
		r := s.ask("-m", "killed:small", "go")
		eq(t, r.code, 1)
		match(t, r.stderr, `killed by SIGTERM`)
		noMatch(t, r.stderr, `exit null`)
	})
	t.Run("status lines in a pipe carry no control characters from agents or hooks", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("noisy", `printf '{"name":"Bad\\u001b[31mName"}' > "$ASK_REPORT"; echo done`)
		s.hook("note", []string{"task"}, `printf '{"note":"hello\\u001b[31mred"}'`)
		r := s.ask("-m", "noisy:small", "go")
		eq(t, r.code, 0)
		noMatch(t, r.stderr, `\x1b`)
	})
	t.Run("a run finishes when its agent exits, even if a child still holds stdout", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("fork", `cat >/dev/null; sleep 30 & echo fine`)
		start := time.Now()
		r := s.ask("-m", "fork:small", "-t", "2", "go")
		eq(t, r.code, 0)
		eq(t, r.stdout, "fine\n")
		if time.Since(start) >= 2*time.Second {
			t.Fatal("waited for descendant pipes")
		}
	})
	t.Run("built-in commands refuse extra arguments before doing anything", func(t *testing.T) {
		for _, command := range []string{"models", "runs", "packages", "show", "stop", "remove"} {
			s := fresh(t)
			args := []string{command, "extra"}
			if !strings.Contains("models runs packages", command) {
				args = append(args, "another")
			}
			eq(t, s.ask(args...).code, 2)
		}
	})
	t.Run("a false schema, for a task or an array's items, is honored", func(t *testing.T) {
		for _, schema := range []any{false, object{"items": false}} {
			s := fresh(t)
			path := filepath.Join(s.tmp, "schema.json")
			s.json(path, schema)
			r := s.run([]string{"-m", "fake:small", "--schema", path, "go"}, "", map[string]string{"FAKE_ANSWER": "[1]"})
			eq(t, r.code, 1)
			match(t, r.stderr, `no value is allowed here`)
			jsonEqual(t, s.calls()[0]["schema"], schema)
		}
	})
	t.Run("a JSON answer keeps the agent's key order and spelling, through runs and hooks", func(t *testing.T) {
		s := fresh(t)
		answer := `{"z":"<>&🐧","a":"\ud800","2":2,"1":1}`
		s.hook("seen", []string{"result"}, ":")
		r := s.run([]string{"-m", "fake:small", "--json", "go"}, "", map[string]string{"FAKE_ANSWER": answer})
		eq(t, r.code, 0)
		eq(t, r.stdout, answer+"\n")
		eq(t, s.ask("show", runID(t, r.stderr)).stdout, answer+"\n")
		stored := s.read(filepath.Join(s.home, "runs", s.latest(), "results.json"))
		if strings.Index(stored, `"z"`) > strings.Index(stored, `"1"`+":") {
			t.Fatal("reordered raw answer")
		}
	})
	t.Run("on Linux, a killed ask never leaves its agent running", func(t *testing.T) {
		if runtime.GOOS != "linux" {
			t.Skip("Linux Pdeathsig contract")
		}
		s := fresh(t)
		run := s.start([]string{"-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang", "FAKE_IGNORE_TERM": "1"})
		until(t, func() bool { return len(s.calls()) == 1 })
		pid := int(s.calls()[0].n("pid"))
		if e := run.cmd.Process.Signal(syscall.SIGKILL); e != nil {
			t.Fatal(e)
		}
		eq(t, run.wait(t).code, -1)
		until(t, func() bool {
			b, e := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
			// The process can vanish while its stat is read; either way it is gone.
			if os.IsNotExist(e) || errors.Is(e, syscall.ESRCH) {
				return true
			}
			if e != nil {
				t.Fatal(e)
			}
			_, state, _ := strings.Cut(string(b), ") ")
			return strings.HasPrefix(state, "Z ")
		})
	})
}

func TestRunCommandAndStdin(t *testing.T) {
	t.Run("--stdin appends piped context after the explicit prompt", func(t *testing.T) {
		s := fresh(t)
		input := "diff --git a/file b/file\n-old\n+new\n"
		got := s.run([]string{"run", "-m", "fake:small", "--stdin", "Review this diff"}, input, nil)
		eq(t, got.code, 0)
		eq(t, s.calls()[0].s("stdin"), "Review this diff\n\n"+input)
		eq(t, s.runFile("tasks.json")[0].s("prompt"), "Review this diff\n\n"+input)
	})
	t.Run("--stdin with an empty stream keeps the argument prompt", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("-m", "fake:small", "--stdin", "Review this diff").code, 0)
		eq(t, s.calls()[0].s("stdin"), "Review this diff")
	})
	t.Run("--stdin accepts large redirected context without putting it in arguments", func(t *testing.T) {
		s := fresh(t)
		input := strings.Repeat("context line\n", 50000)
		s.write(filepath.Join(s.tmp, "context.txt"), input)
		cmd := exec.Command("sh", "-c", `"$ASK_TEST_BIN" -m fake:small --stdin "Review" < context.txt`)
		cmd.Dir = s.tmp
		for k, v := range s.env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Env = append(cmd.Env, "ASK_TEST_BIN="+askBin)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatal(err, string(out))
		}
		eq(t, s.calls()[0].s("stdin"), "Review\n\n"+input)
	})
	t.Run("--stdin without an instruction reads only stdin", func(t *testing.T) {
		s := fresh(t)
		got := s.run([]string{"-m", "fake:small", "--stdin", "-"}, "literal input\n", nil)
		eq(t, got.code, 0)
		eq(t, s.calls()[0].s("stdin"), "literal input\n")
	})
	t.Run("stdin cannot supply both schema and prompt", func(t *testing.T) {
		s := fresh(t)
		got := s.run([]string{"-m", "fake:small", "--stdin", "--schema", "-", "Review"}, "{}", nil)
		eq(t, got.code, 2)
		match(t, got.stderr, `stdin cannot supply both`)
		eq(t, len(s.calls()), 0)
	})
	t.Run("an argument prompt completes with inherited stdin held open", func(t *testing.T) {
		s := fresh(t)
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		defer writer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, askBin, "-m", "fake:small", "Review")
		cmd.Dir, cmd.Stdin = s.tmp, reader
		for k, v := range s.env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		out, err := cmd.Output()
		if err != nil {
			t.Fatal("argument prompt blocked on inherited stdin or failed:", err)
		}
		eq(t, string(out), "fake: Review\n")
	})
	t.Run("explicit run does not become part of the prompt", func(t *testing.T) {
		s := fresh(t)
		got := s.ask("run", "-m", "fake:small", "inspect")
		eq(t, got.code, 0)
		eq(t, s.calls()[0].s("stdin"), "inspect")
	})
	t.Run("a command word can be a literal prompt after double dash", func(t *testing.T) {
		s := fresh(t)
		got := s.ask("-m", "fake:small", "--", "continue", "please")
		eq(t, got.code, 0)
		eq(t, s.calls()[0].s("stdin"), "continue please")
	})
	t.Run("a bare invocation accepts piped input", func(t *testing.T) {
		s := fresh(t)
		s.json(filepath.Join(s.home, "settings.json"), object{"model": "fake:small"})
		got := s.run(nil, "-literal prompt\n", nil)
		eq(t, got.code, 0)
		eq(t, s.calls()[0].s("stdin"), "-literal prompt\n")
	})
}
