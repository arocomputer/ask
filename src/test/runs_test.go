package test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestRuns pins saved runs: show, wait, stop, locks, damaged records and --resume.
func TestRuns(t *testing.T) {
	t.Run("show prints a run again: its answer, or with --json its whole result", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "hello")
		id := runID(t, first.stderr)
		shown := s.ask("show", id)
		eq(t, shown.stdout, "fake: hello\n")
		match(t, shown.stderr, `^ask `+id+` · succeeded · Fake 1\.0`)
		full := obj(t, s.ask("show", id, "--json").stdout)
		eq(t, full.s("run"), id)
		eq(t, full.s("session"), fmt.Sprintf("s-%.0f", s.calls()[0].n("pid")))
		batch := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"a"},{"prompt":"b"}]`, nil)
		batchID := runID(t, batch.stderr)
		shownBatch := s.ask("show", batchID)
		eq(t, shownBatch.stderr, "ask "+batchID+" · 2 succeeded · 0 failed\n")
	})
	t.Run("activity snapshots are bounded and preserve completed answer and JSON contracts", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view01-view")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "one", "prompt": "p", "model": "fake:small"}})
		s.json(filepath.Join(dir, "results.json"), []object{{"ok": true, "answer": "final answer"}})
		var events strings.Builder
		for i := range 300 {
			fmt.Fprintf(&events, "{\"type\":\"message\",\"text\":\"event-%03d %s\"}\n", i, strings.Repeat("x", 1000))
		}
		events.WriteString(`{"type":"tool","tool":"shell\u001b]52;c;bad\u0007","text":"API_KEY=secret-value Authorization: Bearer abc123 password=\"two words\"\u001b[2J","hidden_reasoning":"private-content"}` + "\n")
		s.write(filepath.Join(dir, "events-0.jsonl"), events.String())
		out := s.ask("show", "view")
		eq(t, out.code, 0)
		eq(t, out.stdout, "final answer\n")
		match(t, out.stderr, `event-299`)
		match(t, out.stderr, `\[redacted\]`)
		noMatch(t, out.stderr, "event-000|secret-value|abc123|two words|private-content|\x1b|\x07")
		if len(out.stderr) > 66*1024 {
			t.Fatalf("unbounded snapshot: %d bytes", len(out.stderr))
		}
		full := s.ask("show", "view", "--json")
		eq(t, full.code, 0)
		eq(t, obj(t, full.stdout).s("answer"), "final answer")
		noMatch(t, full.stdout+full.stderr, `event-299|hidden_reasoning`)
		waited := obj(t, s.ask("wait", "view", "--json").stdout)
		eq(t, waited.s("state"), "succeeded")
		eq(t, waited["result"].(map[string]any)["answer"], "final answer")
		eq(t, s.read(filepath.Join(dir, "events-0.jsonl")), events.String())
	})
	t.Run("activity snapshot keeps a record at the exact window boundary", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view00-boundary")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "one", "prompt": "p", "model": "fake:small"}})
		s.json(filepath.Join(dir, "results.json"), []object{{"ok": true, "answer": "done"}})
		first := `{"type":"message","text":"at-boundary"}` + "\n"
		line := `{"type":"message","text":"` + strings.Repeat("x", 16000) + "\"}\n"
		prefix := `{"type":"message","text":"` + strings.Repeat("y", 32*1024-len(first)-2*len(line)-29) + "\"}\n"
		window := first + line + line + prefix
		if len(window) != 32*1024 {
			t.Fatalf("window length: %d", len(window))
		}
		s.write(filepath.Join(dir, "events-0.jsonl"), "{}\n"+window)
		match(t, s.ask("show", "boundary").stderr, `at-boundary`)
	})
	t.Run("activity cursors paginate complete records and leave partial UTF-8 tails for every reader", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view02-cursor")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "one", "prompt": "p", "model": "fake:small"}})
		var events strings.Builder
		for i := range 105 {
			fmt.Fprintf(&events, "{\"type\":\"message\",\"text\":\"event-%d 🌱\"}\n", i)
		}
		complete := events.String()
		partial := `{"type":"tool_result","tool":"shell","text":"` + string([]byte("🌱")[:2])
		path := filepath.Join(dir, "events-0.jsonl")
		s.write(path, complete+partial)
		first := s.ask("show", "cursor", "--after", "0")
		eq(t, first.code, 0)
		eq(t, first, s.ask("show", "view02", "--after", "0"))
		page := obj(t, first.stdout)
		eq(t, page.s("run_id"), "view02")
		eq(t, page.s("state"), "stopped")
		eq(t, len(page["events"].([]any)), 100)
		eq(t, page.b("has_more"), true)
		cursor := strconv.Itoa(int(page.n("next_cursor")))
		second := obj(t, s.ask("show", "cursor", "--after", cursor).stdout)
		eq(t, len(second["events"].([]any)), 5)
		eq(t, second.n("next_cursor"), float64(len(complete)))
		eq(t, second.b("has_more"), false)
		cursor = strconv.Itoa(len(complete))
		tail := obj(t, s.ask("show", "cursor", "--after", cursor).stdout)
		eq(t, len(tail["events"].([]any)), 0)
		eq(t, tail.n("next_cursor"), float64(len(complete)))
		eq(t, tail.b("has_more"), false)
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(string([]byte("🌱")[2:]) + `"}` + "\n")
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		resumed := s.ask("show", "cursor", "--after", cursor)
		eq(t, resumed, s.ask("show", "cursor", "--after", cursor))
		last := obj(t, resumed.stdout)
		eq(t, len(last["events"].([]any)), 1)
		eq(t, last["events"].([]any)[0].(map[string]any)["text"], "🌱")
		eq(t, last.n("next_cursor"), float64(len(complete+partial)+len([]byte("🌱")[2:])+3))
	})
	t.Run("activity rejects invalid cursors including partial tail offsets", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view03-invalid")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "one", "prompt": "p", "model": "fake:small"}})
		data := "{\"type\":\"message\",\"text\":\"ok\"}\npartial"
		s.write(filepath.Join(dir, "events-0.jsonl"), data)
		for _, cursor := range []string{"", "-1", "+1", "1.0", "one", "9223372036854775808", "1", strconv.Itoa(len(data)), strconv.Itoa(len(data) + 1)} {
			out := s.ask("show", "invalid", "--after", cursor)
			eq(t, out.code, 2)
			eq(t, out.stdout, "")
		}
	})
	t.Run("activity skips invalid records without forwarding metadata or malformed JSON", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view04-parse")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "one", "prompt": "p", "model": "fake:small"}})
		data := strings.Join([]string{
			`{"type":"message","text":"public","hidden_reasoning":"private-reasoning"}`,
			`{"type":"reasoning","text":"public summary"}`,
			`{"type":"tool","tool":"shell","text":"command"}`,
			`{"type":"tool_result","text":"ok"}`,
			`{"type":"unknown","text":"invalid-kind"}`,
			`{"type":"message","text":42}`,
			`{"type":"message","text":null}`,
			`{"type":"message"}`,
			`{"type":"message","text":"null-tool","tool":null}`,
			`{"type":"message","text":"numeric-tool","tool":42}`,
			`{"type":"message","text":"` + strings.Repeat("🌱", 5000) + `"}`,
			"{\"type\":\"message\",\"text\":\"\xff\"}",
			`[]`, `null`, `not-json`,
			`{"type":"message","text":"last"}`,
		}, "\n") + "\n"
		s.write(filepath.Join(dir, "events-0.jsonl"), data)
		out := s.ask("show", "parse", "--after", "0")
		eq(t, out.code, 0)
		page := obj(t, out.stdout)
		eq(t, len(page["events"].([]any)), 5)
		eq(t, page.n("next_cursor"), float64(len(data)))
		eq(t, page.b("has_more"), false)
		noMatch(t, out.stdout, `private-reasoning|invalid-kind|null-tool|numeric-tool|hidden_reasoning|🌱`)
	})
	t.Run("activity byte limits allow draining large streams in bounded pages", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view05-bytes")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "one", "prompt": "p", "model": "fake:small"}})
		line := `{"type":"message","text":"` + strings.Repeat("x", 16000) + "\"}\n"
		data := strings.Repeat(line, 40)
		s.write(filepath.Join(dir, "events-0.jsonl"), data)
		cursor, count := 0, 0
		for range 20 {
			page := obj(t, s.ask("show", "bytes", "--after", strconv.Itoa(cursor)).stdout)
			count += len(page["events"].([]any))
			next := int(page.n("next_cursor"))
			if next-cursor > 64*1024 || next <= cursor {
				t.Fatalf("bad page: %v", page)
			}
			cursor = next
			if !page.b("has_more") {
				break
			}
		}
		eq(t, count, 40)
		eq(t, cursor, len(data))
		// A legal partial tail straddling the read window must not advertise
		// another page once the last complete line has been returned.
		data = strings.Repeat(line, 16)
		s.write(filepath.Join(dir, "events-0.jsonl"), data+`{"type":"message","text":"`+strings.Repeat("x", 6000))
		first := obj(t, s.ask("show", "bytes", "--after", "0").stdout)
		eq(t, first.b("has_more"), true)
		last := first
		for last.b("has_more") {
			last = obj(t, s.ask("show", "bytes", "--after", strconv.Itoa(int(last.n("next_cursor")))).stdout)
		}
		eq(t, last.b("has_more"), false)
		eq(t, last.n("next_cursor"), float64(len(data)))
	})
	t.Run("activity handles legacy agents and batch task selectors without inventing streams", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000000-view06-batch-view")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "custom", "prompt": "a", "model": "fake:small"}, {"id": "1", "prompt": "b", "model": "fake:small"}})
		s.json(filepath.Join(dir, "results.json"), []any{object{"ok": true, "answer": "done"}, nil})
		s.write(filepath.Join(dir, "events-1.jsonl"), "{\"type\":\"message\",\"text\":\"second task\"}\n")
		out := s.ask("show", "batch-view")
		eq(t, out.code, 1)
		eq(t, out.stdout, "")
		match(t, out.stderr, `custom · succeeded`)
		match(t, out.stderr, `1 · stopped`)
		eq(t, s.ask("show", "batch-view", "--after", "0").code, 2)
		page := obj(t, s.ask("show", "batch-view/1", "--after", "0").stdout)
		eq(t, page["events"].([]any)[0].(map[string]any)["text"], "second task")
		eq(t, s.ask("show", "batch-view/custom").stdout, "done\n")
		empty := obj(t, s.ask("show", "batch-view/custom", "--after", "0").stdout)
		eq(t, len(empty["events"].([]any)), 0)
		eq(t, empty.n("next_cursor"), float64(0))
		eq(t, empty.s("state"), "succeeded")
		for _, args := range [][]string{{"--json", "--follow"}, {"--after", "0", "--follow"}} {
			eq(t, s.ask(append([]string{"show", "batch-view/1"}, args...)...).code, 2)
		}
	})
	t.Run("follow readers stream independently and interruption leaves the detached worker running", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("gate", `cat >/dev/null
printf '{"activity":"running commands"}' > "$ASK_REPORT"
printf '%s\n%s' '{"type":"message","text":"existing-event"}' '{"type":"tool_result","text":"new-' >> "$ASK_EVENTS"
touch "$HOME/ready"
while [ ! -e "$HOME/release" ]; do sleep 0.05; done
echo final-answer`)
		launch := s.ask("run", "-m", "gate:small", "follow-view")
		eq(t, launch.code, 0)
		id := strings.TrimSpace(launch.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		until(t, func() bool { return exists(filepath.Join(s.tmp, "ready")) })
		until(t, func() bool { return strings.Contains(s.ask("show", id).stderr, "running commands") })
		fallback := s.ask("show", id)
		eq(t, fallback.code, 0)
		match(t, fallback.stderr, `running · running commands`)
		path := filepath.Join(s.home, "runs", s.latest(), "events-0.jsonl")
		interrupted := s.start([]string{"show", id, "--follow"}, "", nil)
		reader := s.start([]string{"show", id, "--follow"}, "", nil)
		time.Sleep(350 * time.Millisecond)
		if err := interrupted.cmd.Process.Signal(syscall.SIGINT); err != nil {
			t.Fatal(err)
		}
		stopped := interrupted.wait(t)
		eq(t, stopped.code, 130)
		match(t, stopped.stderr, `existing-event`)
		active := obj(t, s.ask("show", id, "--after", "0").stdout)
		eq(t, active.s("state"), "running")
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString("event\"}\n"); err != nil {
			t.Fatal(err)
		}
		f.Close()
		s.write(filepath.Join(s.tmp, "release"), "")
		out := reader.wait(t)
		eq(t, out.code, 0)
		eq(t, out.stdout, "final-answer\n")
		match(t, out.stderr, `(?s)existing-event.*new-event`)
		eq(t, strings.Count(out.stderr, "existing-event"), 1)
		eq(t, strings.Count(out.stderr, "new-event"), 1)
		eq(t, obj(t, s.ask("show", id, "--after", "0").stdout).s("state"), "succeeded")
	})
	t.Run("follow ends when a selected batch task finishes or its worker stops", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("gate", `prompt=$(cat)
touch "$HOME/$prompt-ready"
while [ ! -e "$HOME/$prompt-release" ]; do sleep 0.05; done
echo "answer: $prompt"`)
		launch := s.run([]string{"batch", "-m", "gate:small", "-j", "2", "-"}, `[{"id":"a","prompt":"alpha"},{"id":"b","prompt":"beta"}]`, nil)
		eq(t, launch.code, 0)
		id := strings.TrimSpace(launch.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		until(t, func() bool {
			return exists(filepath.Join(s.tmp, "alpha-ready")) && exists(filepath.Join(s.tmp, "beta-ready"))
		})
		chosen := s.start([]string{"show", id + "/a", "--follow"}, "", nil)
		other := s.start([]string{"show", id + "/b", "--follow"}, "", nil)
		s.write(filepath.Join(s.tmp, "alpha-release"), "")
		out := chosen.wait(t)
		eq(t, out.code, 0)
		eq(t, out.stdout, "answer: alpha\n")
		eq(t, obj(t, s.ask("show", id+"/b", "--after", "0").stdout).s("state"), "running")
		eq(t, s.ask("stop", id).code, 0)
		out = other.wait(t)
		eq(t, out.code, 1)
		eq(t, out.stdout, "")
		match(t, out.stderr, `stopped · continue:`)
	})
	t.Run("runs JSON lists states and execution metadata without incidental contents", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("runs", "--json").stdout, "[]\n")
		for i, state := range []string{"succeeded", "failed", "stopped"} {
			dir := filepath.Join(s.home, "runs", fmt.Sprintf("2026010%dT000000000-id%d-%s", i+1, i, state))
			s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "custom", "model": "fake:small", "dir": s.tmp, "write": true, "prompt": "private-prompt", "session": "private-session", "schema": object{"private-schema": true}}})
			if state != "stopped" {
				s.json(filepath.Join(dir, "results.json"), []object{{"ok": state == "succeeded", "answer": "private-answer", "error": "private-error", "note": "private-note", "session": "private-session", "seconds": 2, "usage": object{"cost": 0.01}, "worktree": object{"path": "/worktree", "branch": "ask/work"}}})
			}
		}
		out := s.ask("runs", "--json")
		eq(t, out.code, 0)
		noMatch(t, out.stdout, `private-|"(prompt|answer|error|note|session|schema)"`)
		rows := objects(t, out.stdout)
		eq(t, len(rows), 3)
		for i, state := range []string{"stopped", "failed", "succeeded"} {
			eq(t, rows[i].s("state"), state)
			eq(t, rows[i].s("run_id"), fmt.Sprintf("id%d", 2-i))
			task := rows[i]["tasks"].([]any)[0].(map[string]any)
			eq(t, task["state"], state)
			eq(t, task["model"], "fake:small")
			eq(t, task["dir"], s.tmp)
			eq(t, task["write"], true)
			if state != "stopped" {
				eq(t, task["seconds"], float64(2))
				eq(t, task["worktree"].(map[string]any)["branch"], "ask/work")
			}
		}
		eq(t, len(objects(t, s.ask("runs", "--json", "-n", "1").stdout)), 1)
		eq(t, s.ask("runs", "--json", "-n", "0").code, 2)
	})
	t.Run("stop stops a run that is going, and its agents", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		parts := strings.Split(s.latest(), "-")
		id := parts[len(parts)-1]
		stopped := s.ask("stop", id)
		match(t, stopped.stderr, `^ask `+id+` · stopped`)
		eq(t, run.wait(t).code, 130)
		eq(t, s.ask("stop", id).code, 1)
	})
	t.Run("wait suggests rerunning a stopped single task", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		parts := strings.Split(s.latest(), "-")
		id := parts[len(parts)-1]
		waiter := s.start([]string{"wait"}, "", nil)
		time.Sleep(400 * time.Millisecond)
		eq(t, s.ask("stop", id).code, 0)
		got := waiter.wait(t)
		eq(t, got.code, 1)
		match(t, got.stderr, `stopped · continue: ask continue `+id)
		run.wait(t)
	})
	t.Run("a run another ask is running cannot be resumed at the same time", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"hang"}]`, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		parts := strings.Split(s.latest(), "-")
		id := parts[len(parts)-1]
		second := s.ask("batch", "--wait", "--resume", id)
		eq(t, second.code, 2)
		match(t, second.stderr, `run `+id+` is running`)
		if e := run.cmd.Process.Signal(syscall.SIGTERM); e != nil {
			t.Fatal(e)
		}
		run.wait(t)
	})
	t.Run("a damaged results.json is reported, never taken as no results", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"a"}]`, nil)
		id := runID(t, first.stderr)
		s.write(filepath.Join(s.home, "runs", s.latest(), "results.json"), `[{"ok": tr`)
		r := s.ask("batch", "--wait", "--resume", id)
		eq(t, r.code, 2)
		match(t, r.stderr, `results\.json is damaged`)
		eq(t, len(s.calls()), 1)
	})
	t.Run("--resume reruns a batch as recorded, refusing options that would change it", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"a"}]`, nil)
		r := s.ask("batch", "--wait", "--resume", runID(t, first.stderr), "-r")
		eq(t, r.code, 2)
		match(t, r.stderr, `takes only -j, --no-hooks and --wait, not -r`)
	})
	t.Run("run records and folders are private to you", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("--wait", "-m", "fake:small", "go")
		eq(t, r.code, 0)
		dir := filepath.Join(s.home, "runs", s.latest())
		for _, p := range []string{filepath.Join(s.home, "runs"), dir, filepath.Join(dir, "tasks.json"), filepath.Join(dir, "results.json")} {
			info, e := os.Stat(p)
			if e != nil {
				t.Fatal(e)
			}
			if info.Mode().Perm()&0077 != 0 {
				t.Errorf("%s mode %o", p, info.Mode().Perm())
			}
		}
	})
	t.Run("a stopped task resumes without a failure result, result hook or printed results", func(t *testing.T) {
		s := fresh(t)
		s.hook("observe", []string{"result"}, `echo '{}'`)
		run := s.start([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"hang"}]`, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		id := strings.TrimPrefix(s.latest()[strings.LastIndex(s.latest(), "-"):], "-")
		eq(t, s.ask("stop", id).code, 0)
		out := run.wait(t)
		eq(t, out.code, 130)
		eq(t, out.stdout, "")
		path := filepath.Join(s.home, "runs", s.latest(), "results.json")
		if exists(path) && strings.Contains(s.read(path), `"ok": false`) {
			t.Fatal("stopped task saved as failed")
		}
		if len(s.hookCalls()) != 0 {
			t.Fatalf("result hook called: %v", s.hookCalls())
		}
		match(t, s.ask("runs").stdout, `stopped.*continue: ask continue `+id)
	})
	t.Run("show exits 1 when any saved task failed", func(t *testing.T) {
		s := fresh(t)
		r := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"pass"},{"prompt":"fail"}]`, map[string]string{"FAKE_FAIL": "fail"})
		eq(t, r.code, 1)
		eq(t, s.ask("show", runID(t, r.stderr)).code, 1)
	})
	t.Run("an empty task record is skipped in recent runs", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "runs", "20260101T000000000-zzzzzz", "tasks.json"), `[]`)
		r := s.ask("runs")
		eq(t, r.code, 0)
		noMatch(t, r.stdout, `zzzzzz`)
	})
	t.Run("stop never signals a process named by a record nobody holds", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "go")
		eq(t, first.code, 0)
		cmd := exec.Command("sleep", "30")
		if e := cmd.Start(); e != nil {
			t.Fatal(e)
		}
		defer func() { cmd.Process.Kill(); cmd.Wait() }()
		lock := filepath.Join(s.home, "runs", s.latest(), "lock")
		s.write(lock, strconv.Itoa(cmd.Process.Pid))
		r := s.ask("stop", runID(t, first.stderr))
		eq(t, r.code, 1)
		if !alive(cmd.Process.Pid) {
			t.Fatal("unrelated process was signaled")
		}
	})
	t.Run("a run's lock is the one the kernel holds, not what the lock file says", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"fail"}]`, map[string]string{"FAKE_FAIL": "fail"})
		eq(t, first.code, 1)
		path := filepath.Join(s.home, "runs", s.latest(), "lock")
		f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		if e := f.Truncate(0); e != nil {
			t.Fatal(e)
		}
		if e := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &syscall.Flock_t{Type: syscall.F_WRLCK}); e != nil {
			t.Fatal(e)
		}
		r := s.ask("batch", "--wait", "--resume", runID(t, first.stderr))
		eq(t, r.code, 2)
		match(t, r.stderr, `is running \(pid `+strconv.Itoa(os.Getpid())+`\)`)
	})
	t.Run("wait", func(t *testing.T) {
		t.Run("waits for a running run, then prints its answer", func(t *testing.T) {
			s := fresh(t)
			slow := s.start([]string{"--wait", "-m", "fake:small", "slow one"}, "", map[string]string{"FAKE_SLOW": "slow"})
			until(t, func() bool { return exists(filepath.Join(s.home, "runs")) && len(s.dirs()) == 1 })
			r := s.ask("wait")
			eq(t, r.code, 0)
			eq(t, r.stdout, "fake: slow one\n")
			slow.wait(t)
		})
		t.Run("reports idle normally and validates every reference and option", func(t *testing.T) {
			s := fresh(t)
			idle := s.ask("wait")
			eq(t, idle.code, 0)
			eq(t, idle.stderr, "ask: no runs are running\n")
			eq(t, s.ask("wait", "--json").stdout, "null\n")
			eq(t, s.ask("wait", "--json", "--id").code, 2)
			r := s.ask("wait", "one", "two")
			eq(t, r.code, 2)
			match(t, r.stderr, `no run one`)
			r = s.ask("wait", "-t", "3")
			eq(t, r.code, 2)
		})
		t.Run("without names returns the first of several active runs to finish", func(t *testing.T) {
			s := fresh(t)
			slow := s.start([]string{"--wait", "-m", "fake:small", "slow reply"}, "", map[string]string{"FAKE_SLOW": "slow"})
			hang := s.start([]string{"--wait", "-m", "fake:small", "hang around"}, "", map[string]string{"FAKE_HANG": "hang"})
			until(t, func() bool { return len(s.calls()) == 2 })
			r := s.ask("wait")
			eq(t, r.code, 0)
			eq(t, r.stdout, "fake: slow reply\n")
			if e := hang.cmd.Process.Signal(syscall.SIGTERM); e != nil {
				t.Fatal(e)
			}
			hang.wait(t)
			slow.wait(t)
		})
		t.Run("returns an already completed run by name or ID exactly like show", func(t *testing.T) {
			s := fresh(t)
			first := s.ask("--wait", "-m", "fake:small", "saved answer")
			eq(t, first.code, 0)
			for _, ref := range []string{"saved-answer", runID(t, first.stderr)} {
				eq(t, s.ask("wait", ref), s.ask("show", ref))
			}
			eq(t, len(s.calls()), 1)
		})
		t.Run("preserves a saved JSON answer without a result wrapper", func(t *testing.T) {
			s := fresh(t)
			first := s.run([]string{"--wait", "-m", "fake:small", "--json", "structured answer"}, "", map[string]string{"FAKE_ANSWER": `{"answer":[1,true,"ok"]}`})
			eq(t, first.code, 0)
			ref := runID(t, first.stderr)
			waited := s.ask("wait", ref)
			eq(t, waited, s.ask("show", ref))
			eq(t, waited.stdout, first.stdout)
			machine := s.ask("wait", "--json", ref)
			eq(t, machine.code, 0)
			full := obj(t, machine.stdout)
			result := full["result"].(map[string]any)
			jsonEqual(t, result["answer"], object{"answer": []any{1, true, "ok"}})
			eq(t, len(s.calls()), 1)
		})
		gated := func(t *testing.T) *setup {
			s := fresh(t)
			s.localAgent("gate", `prompt=$(cat)
: > "$HOME/$prompt-ready"
while [ ! -f "$HOME/$prompt-release" ]; do sleep 0.05; done
printf 'answer: %s\n' "$prompt"`)
			return s
		}
		t.Run("an explicit set ignores unrelated completions and returns stable identity", func(t *testing.T) {
			s := gated(t)
			launch := func(prompt string) string {
				out := s.ask("run", "-m", "gate:small", prompt)
				eq(t, out.code, 0)
				id := strings.TrimSpace(out.stdout)
				t.Cleanup(func() { s.ask("stop", id) })
				return id
			}
			a, b, other := launch("alpha"), launch("bravo"), launch("other")
			waiter := s.start([]string{"wait", "--id", a, b}, "", nil)
			machine := s.start([]string{"wait", "--json", a, b}, "", nil)
			shown := s.ask("show", a, "--json")
			eq(t, shown.code, 1)
			eq(t, obj(t, shown.stdout).s("state"), "running")
			eq(t, obj(t, shown.stdout).s("run_id"), a)
			eq(t, objects(t, s.ask("runs", "--json", "-n", "1").stdout)[0].s("state"), "running")
			s.write(filepath.Join(s.tmp, "other-release"), "")
			eq(t, s.ask("wait", other).code, 0)
			select {
			case out := <-waiter.done:
				t.Fatalf("returned an unrelated completion: %+v", out)
			case <-time.After(350 * time.Millisecond):
			}
			select {
			case out := <-machine.done:
				t.Fatalf("JSON returned an unrelated completion: %+v", out)
			default:
			}
			s.write(filepath.Join(s.tmp, "bravo-release"), "")
			out := waiter.wait(t)
			eq(t, out.code, 0)
			eq(t, out.stdout, b+"\n")
			jsonOut := machine.wait(t)
			eq(t, jsonOut.code, 0)
			full := obj(t, jsonOut.stdout)
			eq(t, full.s("run_id"), b)
			eq(t, full.s("state"), "succeeded")
			eq(t, full["result"].(map[string]any)["answer"], "answer: bravo")
			eq(t, s.ask("wait", "--json", b), jsonOut)
			eq(t, s.ask("wait", "--json", b, "missing").stdout, "")
			// The saved completion is eligible, even while the first selection is active.
			eq(t, s.ask("wait", "--id", a, b).stdout, b+"\n")
			answer := s.ask("wait", a, b)
			eq(t, answer.stdout, "answer: bravo\n")
			match(t, answer.stderr, `ask: completed `+b)
			eq(t, s.ask("wait", "--id", b, "missing").code, 2)
			eq(t, s.ask("wait", "--id", b, "missing").stdout, "")
			s.write(filepath.Join(s.tmp, "alpha-release"), "")
			eq(t, s.ask("wait", a).code, 0)
			eq(t, s.ask("wait", "--id", a, b).stdout, a+"\n")
		})
		t.Run("no argument wait scopes active work to the repository or current directory", func(t *testing.T) {
			s := gated(t)
			repo, _ := s.repo()
			other := s.ask("run", "-m", "gate:small", "outside")
			eq(t, other.code, 0)
			id := strings.TrimSpace(other.stdout)
			t.Cleanup(func() { s.ask("stop", id) })
			s.cwd = filepath.Join(s.tmp, "empty")
			s.mkdir(s.cwd)
			eq(t, s.ask("wait", "--id").stdout, "")
			s.cwd = repo
			eq(t, s.ask("wait", "--id").stdout, "")
			eq(t, s.ask("wait").stderr, "ask: no runs are running\n")
			inside := s.ask("run", "-m", "gate:small", "inside")
			eq(t, inside.code, 0)
			innerID := strings.TrimSpace(inside.stdout)
			t.Cleanup(func() { s.ask("stop", innerID) })
			waiter := s.start([]string{"wait", "--id"}, "", nil)
			s.write(filepath.Join(s.tmp, "outside-release"), "")
			eq(t, s.ask("wait", id).code, 0)
			select {
			case out := <-waiter.done:
				t.Fatalf("repository wait collected outside work: %+v", out)
			case <-time.After(350 * time.Millisecond):
			}
			s.write(filepath.Join(s.tmp, "inside-release"), "")
			eq(t, waiter.wait(t).stdout, innerID+"\n")
		})
		t.Run("machine identity separates the run ID and position from numeric task names", func(t *testing.T) {
			s := fresh(t)
			s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"custom","prompt":"a"},{"id":"1","prompt":"b"}]`, nil)
			id := strings.SplitN(s.latest(), "-", 3)[1]
			out := s.ask("wait", "--id", id+"/custom")
			eq(t, out.code, 0)
			eq(t, out.stdout, id+"\t1\n")
			eq(t, s.ask("show", id+"/1").stdout, "fake: b\n")
			full := obj(t, s.ask("wait", "--json", id+"/1").stdout)
			eq(t, full.n("position"), float64(2))
			eq(t, full.s("task_id"), "1")
		})
		t.Run("an explicit run ignores simultaneous runs that finish before or after it", func(t *testing.T) {
			s := gated(t)
			other := s.start([]string{"--wait", "-m", "gate:small", "other"}, "", nil)
			target := s.start([]string{"--wait", "-m", "gate:small", "target"}, "", nil)
			pending := s.start([]string{"--wait", "-m", "gate:small", "pending"}, "", nil)
			until(t, func() bool {
				return exists(filepath.Join(s.tmp, "other-ready")) && exists(filepath.Join(s.tmp, "target-ready")) && exists(filepath.Join(s.tmp, "pending-ready"))
			})
			waiter := s.start([]string{"wait", "target"}, "", nil)
			s.write(filepath.Join(s.tmp, "other-release"), "")
			eq(t, other.wait(t).code, 0)
			select {
			case out := <-waiter.done:
				t.Fatalf("wait returned before the selected run finished: %+v", out)
			case <-time.After(350 * time.Millisecond):
			}
			s.write(filepath.Join(s.tmp, "target-release"), "")
			waited := waiter.wait(t)
			eq(t, target.wait(t).code, 0)
			eq(t, waited, s.ask("show", "target"))
			eq(t, waited.stdout, "answer: target\n")
			s.write(filepath.Join(s.tmp, "pending-release"), "")
			eq(t, pending.wait(t).code, 0)
		})
		t.Run("a task returns while its batch keeps running and the whole run waits for all tasks", func(t *testing.T) {
			s := gated(t)
			batch := s.start([]string{"batch", "--wait", "-m", "gate:small", "-j", "2", "-"}, `[{"id":"chosen","prompt":"selected"},{"id":"other","prompt":"pending"}]`, nil)
			until(t, func() bool {
				return exists(filepath.Join(s.tmp, "selected-ready")) && exists(filepath.Join(s.tmp, "pending-ready"))
			})
			taskWaiter := s.start([]string{"wait", "selected/chosen"}, "", nil)
			runWaiter := s.start([]string{"wait", "selected"}, "", nil)
			jsonTask := s.start([]string{"wait", "--json", "selected/chosen"}, "", nil)
			jsonRun := s.start([]string{"wait", "--json", "selected"}, "", nil)
			shown := s.ask("show", "selected", "--json")
			eq(t, shown.code, 1)
			eq(t, obj(t, shown.stdout).s("state"), "running")
			s.write(filepath.Join(s.tmp, "selected-release"), "")
			waited := taskWaiter.wait(t)
			eq(t, waited, s.ask("show", "selected/chosen"))
			eq(t, waited.stdout, "answer: selected\n")
			jsonOut := jsonTask.wait(t)
			eq(t, jsonOut.code, 0)
			full := obj(t, jsonOut.stdout)
			eq(t, full.n("position"), float64(1))
			eq(t, full.s("task_id"), "chosen")
			eq(t, full.s("run_id"), strings.SplitN(s.latest(), "-", 3)[1])
			select {
			case out := <-jsonRun.done:
				t.Fatalf("JSON returned a partial batch: %+v", out)
			default:
			}
			eq(t, s.ask("wait", "selected/1"), waited)
			select {
			case out := <-runWaiter.done:
				t.Fatalf("wait returned before the whole batch finished: %+v", out)
			case <-time.After(350 * time.Millisecond):
			}
			s.write(filepath.Join(s.tmp, "pending-release"), "")
			eq(t, batch.wait(t).code, 0)
			waited = runWaiter.wait(t)
			eq(t, waited, s.ask("show", "selected"))
			eq(t, len(objects(t, waited.stdout)), 2)
			full = obj(t, jsonRun.wait(t).stdout)
			eq(t, full.s("state"), "succeeded")
			eq(t, len(full["results"].([]any)), 2)
		})
		t.Run("a failed task can be waited on while another task runs", func(t *testing.T) {
			s := fresh(t)
			s.localAgent("gate", `prompt=$(cat)
if [ "$prompt" = failed ]; then echo failed >&2; exit 1; fi
touch "$HOME/pending-ready"
while [ ! -e "$HOME/release" ]; do sleep 0.05; done
echo done`)
			batch := s.start([]string{"batch", "--wait", "-m", "gate:small", "-j", "2", "-"}, `[{"id":"bad","prompt":"failed"},{"id":"slow","prompt":"pending"}]`, nil)
			until(t, func() bool { return exists(filepath.Join(s.tmp, "pending-ready")) })
			waited := s.ask("wait", "failed/bad")
			eq(t, waited.code, 1)
			match(t, waited.stderr, `failed`)
			machine := s.ask("wait", "--json", "failed/bad")
			eq(t, machine.code, 1)
			full := obj(t, machine.stdout)
			eq(t, full.s("state"), "failed")
			eq(t, full.n("position"), float64(1))
			eq(t, full["result"].(map[string]any)["ok"], false)
			s.write(filepath.Join(s.tmp, "release"), "")
			eq(t, batch.wait(t).code, 1)
		})
		t.Run("waiting for a rerun does not return its earlier failure", func(t *testing.T) {
			s := fresh(t)
			s.localAgent("retry", `cat >/dev/null
if [ ! -e "$HOME/first" ]; then touch "$HOME/first"; echo failed >&2; exit 1; fi
touch "$HOME/retry-started"
while [ ! -e "$HOME/release" ]; do sleep 0.05; done
echo success`)
			first := s.ask("--wait", "-m", "retry:small", "retry")
			eq(t, first.code, 1)
			id := runID(t, first.stderr)
			rerun := s.start([]string{"continue", "--wait", id}, "", nil)
			until(t, func() bool { return exists(filepath.Join(s.tmp, "retry-started")) })
			waiter := s.start([]string{"wait", "--json", id}, "", nil)
			plain := s.start([]string{"wait", id}, "", nil)
			select {
			case out := <-waiter.done:
				t.Fatalf("wait returned the old result: %+v", out)
			case <-time.After(350 * time.Millisecond):
			}
			s.write(filepath.Join(s.tmp, "release"), "")
			eq(t, rerun.wait(t).code, 0)
			got := waiter.wait(t)
			eq(t, got.code, 0)
			eq(t, obj(t, got.stdout).s("state"), "succeeded")
			eq(t, obj(t, got.stdout)["result"].(map[string]any)["answer"], "success")
			eq(t, plain.wait(t).stdout, "success\n")
		})
		t.Run("an interrupted rerun is reported as stopped, not as its old failure", func(t *testing.T) {
			s := fresh(t)
			s.localAgent("retry", `cat >/dev/null
if [ ! -e "$HOME/first" ]; then touch "$HOME/first"; echo old-failure >&2; exit 1; fi
touch "$HOME/retry-started"
sleep 10`)
			first := s.ask("--wait", "-m", "retry:small", "retry")
			id := runID(t, first.stderr)
			rerun := s.start([]string{"continue", "--wait", id}, "", nil)
			until(t, func() bool { return exists(filepath.Join(s.tmp, "retry-started")) })
			waiter := s.start([]string{"wait", "--json", id}, "", nil)
			plain := s.start([]string{"wait", id}, "", nil)
			time.Sleep(350 * time.Millisecond)
			eq(t, s.ask("stop", id).code, 0)
			rerun.wait(t)
			got := waiter.wait(t)
			eq(t, got.code, 1)
			eq(t, obj(t, got.stdout).s("state"), "stopped")
			eq(t, obj(t, got.stdout).s("run_id"), strings.SplitN(s.latest(), "-", 3)[1])
			noMatch(t, got.stdout, `old-failure|"result"`)
			eq(t, s.ask("show", id, "--json").code, 1)
			eq(t, obj(t, s.ask("show", id, "--json").stdout).s("state"), "stopped")
			noMatch(t, got.stderr, `old-failure`)
			plainOut := plain.wait(t)
			eq(t, plainOut.code, 1)
			match(t, plainOut.stderr, `stopped · continue: ask continue `+id)
			match(t, s.ask("runs").stdout, `stopped .* continue: ask continue `+id)
		})
		t.Run("saved failures return the same output and exit status as show", func(t *testing.T) {
			s := fresh(t)
			single := s.run([]string{"--wait", "-m", "fake:small", "fail"}, "", map[string]string{"FAKE_FAIL": "fail"})
			batch := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"pass"},{"prompt":"fail"}]`, map[string]string{"FAKE_FAIL": "fail"})
			for _, ref := range []string{runID(t, single.stderr), runID(t, batch.stderr), runID(t, batch.stderr) + "/2"} {
				waited := s.ask("wait", ref)
				eq(t, waited.code, 1)
				eq(t, waited, s.ask("show", ref))
				machine := s.ask("wait", "--json", ref)
				eq(t, machine.code, 1)
				eq(t, obj(t, machine.stdout).s("state"), "failed")
			}
		})
		t.Run("reports a run stopped during or before waiting without printing an answer", func(t *testing.T) {
			s := fresh(t)
			run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
			until(t, func() bool { return len(s.calls()) == 1 })
			waiter := s.start([]string{"wait", "hang"}, "", nil)
			eq(t, s.ask("stop", "hang").code, 0)
			eq(t, run.wait(t).code, 130)
			waited := waiter.wait(t)
			eq(t, waited.code, 1)
			eq(t, waited.stdout, "")
			eq(t, waited.stderr, "ask hang · stopped · continue: ask continue hang\n")
			eq(t, s.ask("wait", "hang"), waited)
		})
		t.Run("a stopped batch reports unfinished tasks while completed tasks remain available", func(t *testing.T) {
			s := fresh(t)
			batch := s.start([]string{"batch", "--wait", "-m", "fake:small", "-j", "1", "-"}, `[{"prompt":"finished"},{"prompt":"hang"}]`, map[string]string{"FAKE_HANG": "hang"})
			until(t, func() bool { return len(s.calls()) == 2 })
			eq(t, s.ask("stop", "finished").code, 0)
			eq(t, batch.wait(t).code, 130)
			for _, ref := range []string{"finished", "finished/2"} {
				waited := s.ask("wait", ref)
				eq(t, waited.code, 1)
				eq(t, waited.stdout, "")
				eq(t, waited.stderr, "ask finished/2 · stopped · continue: ask continue "+ref+"\n")
			}
			eq(t, s.ask("wait", "finished/1"), s.ask("show", "finished/1"))
		})
		t.Run("reports missing runs and tasks without waiting for unrelated runs", func(t *testing.T) {
			s := fresh(t)
			run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
			until(t, func() bool { return len(s.calls()) == 1 })
			for _, ref := range []string{"missing", "hang/missing"} {
				waited := s.ask("wait", ref)
				eq(t, waited.code, 2)
				eq(t, waited.stdout, "")
				match(t, waited.stderr, `no (run|task) missing`)
			}
			eq(t, s.ask("stop", "hang").code, 0)
			eq(t, run.wait(t).code, 130)
		})
	})
	t.Run("setup with an agent name points to settings", func(t *testing.T) {
		s := fresh(t)
		r := s.ask("setup", "opencode")
		eq(t, r.code, 2)
		match(t, r.stderr, `did you mean ask settings opencode\?`)
	})
	t.Run("clean removes landed worktrees and old runs, and nothing else", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		s.run([]string{"--wait", "-m", "fake:small", "-w", "--worktree", "-C", dir, "change readme"}, "", map[string]string{"FAKE_WRITE": "b.txt=new"})
		path := filepath.Join(s.home, "worktrees", "change-readme")
		gitAt := s.gitAt(path)
		gitAt("add", ".")
		gitAt("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "change")
		plan := s.ask("clean", "--dry-run")
		match(t, plan.stdout, `keep +~/home/worktrees/change-readme +ask/change-readme · not merged into main`)
		git("-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--squash", "ask/change-readme")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "squashed")
		old := filepath.Join(s.home, "runs", "20200101T000000000-abc123-old")
		s.mkdir(old)
		s.write(filepath.Join(old, "tasks.json"), `[{"id":"1","prompt":"x","model":"fake:small","write":false,"json":false,"dir":"/","timeout":900}]`)
		r := s.ask("clean", "--yes")
		eq(t, r.code, 0)
		match(t, r.stderr, `removed ~/home/worktrees/change-readme and ask/change-readme`)
		match(t, r.stderr, `removed 1 run\n`)
		eq(t, exists(path), false)
		eq(t, exists(old), false)
		eq(t, strings.TrimSpace(git("branch", "--list", "ask/change-readme")), "")
		eq(t, len(s.dirs()), 1)
		if _, e := os.Stat(filepath.Join(dir, "b.txt")); e != nil {
			t.Fatal("the merged change is gone from the checkout")
		}
	})
	t.Run("runs shows live activity without exposing agent text", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("progress", `cat >/dev/null
printf '{"activity":"running commands"}' > "$ASK_REPORT"
sleep 10`)
		run := s.start([]string{"--wait", "-m", "progress:small", "check"}, "", nil)
		until(t, func() bool { return strings.Contains(s.ask("runs").stdout, "running commands") })
		id := strings.Split(s.latest(), "-")[1]
		path := filepath.Join(s.home, "runs", s.latest(), "progress-0.json")
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm()&0077 != 0 {
			t.Fatalf("progress snapshot is not private: %v %v", info, err)
		}
		eq(t, s.ask("stop", id).code, 0)
		run.wait(t)
		// A stopped owner can leave a stale snapshot if it exits before cleanup.
		s.write(path, `{"pid":1,"activity":"running commands"}`)
		noMatch(t, s.ask("runs").stdout, `running commands`)
	})
	t.Run("runs shows activity for parallel batch tasks", func(t *testing.T) {
		s := fresh(t)
		s.env["COLUMNS"] = "200"
		s.localAgent("progress", `prompt=$(cat)
case "$prompt" in
  alpha) echo '{"activity":"searching"}' > "$ASK_REPORT" ;;
  beta) echo '{"activity":"editing files"}' > "$ASK_REPORT" ;;
esac
sleep 10`)
		run := s.start([]string{"batch", "--wait", "-m", "progress:small", "-j", "2", "-"}, `[{"id":"a","prompt":"alpha"},{"id":"b","prompt":"beta"}]`, nil)
		until(t, func() bool {
			out := s.ask("runs").stdout
			return strings.Contains(out, "a: searching") && strings.Contains(out, "b: editing files")
		})
		id := strings.Split(s.latest(), "-")[1]
		eq(t, s.ask("stop", id).code, 0)
		run.wait(t)
	})
	t.Run("runs shows elapsed time for an active run", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		id := strings.Split(s.latest(), "-")[1]
		match(t, s.ask("runs").stdout, `running +fake:small +0:[0-9]{2}`)
		eq(t, s.ask("stop", id).code, 0)
		run.wait(t)
	})
	t.Run("runs lists recorded runs, newest first, with their outcome and model", func(t *testing.T) {
		s := fresh(t)
		s.ask("--wait", "-m", "fake:small", "first question")
		s.run([]string{"batch", "--wait", "-m", "fake:small"}, `[{"prompt":"fine"},{"prompt":"break"}]`, map[string]string{"FAKE_FAIL": "break"})
		rows := strings.Split(strings.TrimSpace(s.ask("runs").stdout), "\n")
		eq(t, len(rows), 3)
		match(t, rows[0], `^RUN +ID +STARTED +STATUS +MODEL +TIME +TASK$`)
		match(t, rows[1], `^fine +\w{6} .* failed · 1 succeeded · 1 failed +2 tasks +fine$`)
		match(t, rows[2], `^first-question +\w{6} .* succeeded +Fake 1\.0 +[\d.]+s +first question$`)
	})
	t.Run("runs shows an unfinished run whose ask is gone as stopped, with how to resume", func(t *testing.T) {
		s := fresh(t)
		dir := filepath.Join(s.home, "runs", "20260101T000000-zzzzzz")
		s.json(filepath.Join(dir, "tasks.json"), []object{{"id": "1", "model": "fake:small", "prompt": "p"}, {"id": "2", "model": "fake:small", "prompt": "p"}})
		s.json(filepath.Join(dir, "results.json"), []any{object{"id": "1", "ok": true}, nil})
		match(t, s.ask("runs").stdout, `(?m)^zzzzzz .* stopped .* continue: ask continue zzzzzz$`)
	})
	t.Run("ask runs in a repository lists its runs, from any of its checkouts; --all lists every run", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		other := filepath.Join(s.tmp, "other")
		s.mkdir(other)
		s.ask("--wait", "-m", "fake:small", "-C", dir, "in repo")
		s.ask("--wait", "-m", "fake:small", "-C", other, "elsewhere")
		linked := filepath.Join(s.tmp, "linked")
		git("worktree", "add", "-q", "--detach", linked)
		here := s.runIn(linked, "runs")
		match(t, here.stdout, `in repo`)
		eq(t, strings.Contains(here.stdout, "elsewhere"), false)
		match(t, s.runIn(linked, "runs", "--all").stdout, `elsewhere`)
		rows := objects(t, s.runIn(linked, "runs", "--json", "-n", "1").stdout)
		eq(t, len(rows), 1)
		eq(t, rows[0]["tasks"].([]any)[0].(map[string]any)["dir"], dir)
		rows = objects(t, s.runIn(linked, "runs", "--json", "--all", "-n", "1").stdout)
		eq(t, rows[0]["tasks"].([]any)[0].(map[string]any)["dir"], other)
	})
}
