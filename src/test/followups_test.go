package test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestFollowups pins -c: which session, model and access a follow-up gets, and what it refuses.
func TestFollowups(t *testing.T) {
	t.Run("a batch refuses two aliases for the same agent session before starting either", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "remember")
		ref := filepath.Join(s.home, "runs", s.latest())
		input, _ := json.Marshal([]object{{"continue": runID(t, first.stderr), "prompt": "one"}, {"continue": ref, "prompt": "two"}})
		r := s.run([]string{"batch", "--wait", "-j", "2", "-"}, string(input), nil)
		eq(t, r.code, 2)
		match(t, r.stderr, `agent session is already in use`)
		eq(t, len(s.calls()), 1)
		eq(t, len(s.dirs()), 1)
	})
	t.Run("separate processes cannot follow the same session and release it when stopped", func(t *testing.T) {
		s := fresh(t)
		s.ask("--wait", "-m", "fake:small", "remember")
		ref := filepath.Join(s.home, "runs", s.latest())
		run := s.start([]string{"--wait", "-c", ref, "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 2 })
		second := s.ask("--wait", "-c", ref, "more")
		eq(t, second.code, 2)
		match(t, second.stderr, `agent session is already in use`)
		eq(t, len(s.calls()), 2)
		eq(t, len(s.dirs()), 2)
		if e := run.cmd.Process.Signal(syscall.SIGTERM); e != nil {
			t.Fatal(e)
		}
		eq(t, run.wait(t).code, 130)
		eq(t, s.ask("--wait", "-c", ref, "finish").code, 0)
	})
	t.Run("different sessions cannot share a kept worktree while result hooks are running", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		trees, alias := filepath.Join(s.tmp, "trees"), filepath.Join(s.tmp, "alias")
		s.mkdir(trees)
		if err := os.Symlink(trees, alias); err != nil {
			t.Fatal(err)
		}
		s.json(filepath.Join(s.home, "settings.json"), object{"worktrees": filepath.Join(alias, "{name}")})
		s.localAgent("turn", `cat >/dev/null
echo changed > a.txt
printf '{"session":"%s"}\n' "$ASK_MODEL" > "$ASK_REPORT"
echo done`)
		eq(t, s.ask("--wait", "-m", "turn:small", "-w", "--worktree", "-C", dir, "edit").code, 0)
		first := filepath.Join(s.home, "runs", s.latest())
		eq(t, s.ask("--wait", "-c", first, "-m", "turn:big", "another turn").code, 0)
		second := filepath.Join(s.home, "runs", s.latest())
		// The lock key must stay the same before and after recreating a path through a symlink.
		git("worktree", "remove", "--force", filepath.Join(alias, "edit"))
		s.hook("hold", []string{"result"}, `touch "$HOME/in-hook"
while [ -e "$HOME/hold" ]; do sleep 0.05; done`)
		s.write(filepath.Join(s.tmp, "hold"), "")
		t.Cleanup(func() { _ = os.Remove(filepath.Join(s.tmp, "hold")) })
		run := s.start([]string{"--wait", "-c", first, "more"}, "", nil)
		until(t, func() bool { return exists(filepath.Join(s.tmp, "in-hook")) })
		blocked := s.ask("--wait", "-c", second, "--no-hooks", "more")
		eq(t, blocked.code, 2)
		match(t, blocked.stderr, `worktree is already in use`)
		if err := os.Remove(filepath.Join(s.tmp, "hold")); err != nil {
			t.Fatal(err)
		}
		eq(t, run.wait(t).code, 0)
		// A failed reservation must also release the session lock it acquired first.
		eq(t, s.ask("--wait", "-c", second, "finish").code, 0)
	})
	t.Run("follow-ups keep a role's recorded model and cost after edits, and explicit roles must keep the agent", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "settings.json"), `{"model":"review","max_cost":2,"roles":{"review":"fake:SMALL#low"}}`)
		first := s.ask("--wait", "remember")
		eq(t, first.code, 0)
		ref := filepath.Join(s.home, "runs", s.latest())
		s.write(filepath.Join(s.home, "settings.json"), `{"model":"review","max_cost":9,"roles":{"review":"fake:big#high","other":"other:x"}}`)
		s.script("agents", "other", "echo hi")
		eq(t, s.ask("continue", "--wait", ref, "keep model").code, 0)
		eq(t, s.ask("continue", "--wait", ref, "-m", "review", "change model").code, 0)
		eq(t, objects(t, s.read(filepath.Join(s.home, "runs", s.latest(), "results.json")))[0].s("model"), "fake:big#high")
		eq(t, fields(s.calls(), "model", "effort", "max_cost"), [][]any{{"small", "low", "2"}, {"small", "low", "2"}, {"big", "high", "2"}})
		switched := s.ask("continue", "--wait", ref, "-m", "other", "no")
		eq(t, switched.code, 2)
		match(t, switched.stderr, `must use the same agent`)
		eq(t, len(s.calls()), 3)
		s.write(filepath.Join(s.home, "settings.json"), `{}`)
		eq(t, s.ask("continue", "--wait", ref, "role removed").code, 0)
		eq(t, s.calls()[3].s("model"), "small")
		eq(t, s.calls()[3].s("effort"), "low")
	})
	t.Run("rerunning a failed role task retains its saved model after the role is removed", func(t *testing.T) {
		s := fresh(t)
		s.write(filepath.Join(s.home, "settings.json"), `{"roles":{"fast":"fake:small#low"}}`)
		first := s.run([]string{"--wait", "-m", "fast", "bad"}, "", map[string]string{"FAKE_FAIL": "bad"})
		eq(t, first.code, 1)
		s.write(filepath.Join(s.home, "settings.json"), `{}`)
		eq(t, s.ask("continue", "--wait", runID(t, first.stderr)).code, 0)
		eq(t, fields(s.calls(), "model", "effort"), [][]any{{"small", "low"}, {"small", "low"}})
	})
	t.Run("-c continues the agent session where it ran, with the same model", func(t *testing.T) {
		s := fresh(t)
		work := filepath.Join(s.tmp, "work")
		s.mkdir(work)
		first := s.ask("--wait", "-m", "fake:big#high", "-C", work, "remember PELICAN")
		second := s.ask("--wait", "-c", runID(t, first.stderr), "what word?")
		eq(t, second.code, 0)
		a, b := s.calls()[0], s.calls()[1]
		eq(t, b.s("session"), fmt.Sprintf("s-%.0f", a.n("pid")))
		eq(t, b.s("cwd"), work)
		eq(t, b.s("model"), "big")
		eq(t, b.s("effort"), "high")
		eq(t, b.s("stdin"), "what word?")
		match(t, second.stderr, `follow-up `+runID(t, first.stderr))
	})
	t.Run("a batch follow-up inherits access and cost but keeps its directory", func(t *testing.T) {
		s := fresh(t)
		work := filepath.Join(s.tmp, "work")
		other := filepath.Join(s.tmp, "other")
		s.mkdir(work)
		s.mkdir(other)
		first := s.ask("--wait", "-m", "fake:small", "-w", "-C", work, "--max-cost", "2", "change it")
		eq(t, first.code, 0)
		tasks, _ := json.Marshal([]object{{"continue": runID(t, first.stderr), "prompt": "more", "dir": other}})
		second := s.run([]string{"batch", "--wait", "-C", other, "-"}, string(tasks), nil)
		eq(t, second.code, 0)
		call := s.calls()[1]
		eq(t, call.s("access"), "write")
		eq(t, call.s("max_cost"), "2")
		eq(t, call.s("cwd"), work)
	})
	t.Run("a follow-up keeps write access unless it says -r, and may change the model within the agent", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:big", "-w", "change it")
		id := runID(t, first.stderr)
		s.ask("--wait", "-c", id, "more")
		s.ask("--wait", "-c", id, "-r", "-m", "fake:small", "look")
		eq(t, fields(s.calls(), "access", "model"), [][]any{{"write", "big"}, {"write", "big"}, {"read", "small"}})
	})
	t.Run("a follow-up to another agent, or to a run with no session, is refused", func(t *testing.T) {
		s := fresh(t)
		s.script("agents", "other", "echo hi")
		fake := s.ask("--wait", "-m", "fake:small", "hi")
		other := s.ask("--wait", "-m", "other:x", "hi")
		switched := s.ask("--wait", "-c", runID(t, fake.stderr), "-m", "other:x", "more")
		eq(t, switched.code, 2)
		match(t, switched.stderr, `must use the same agent`)
		sessionless := s.ask("--wait", "-c", runID(t, other.stderr), "more")
		eq(t, sessionless.code, 2)
		match(t, sessionless.stderr, `reported no session`)
	})
	t.Run("a run that timed out can still be continued", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"--wait", "-m", "fake:small", "-t", "0.5", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		match(t, first.stderr, `timed out`)
		second := s.ask("--wait", "-c", runID(t, first.stderr), "finish")
		eq(t, second.code, 0)
		eq(t, s.calls()[1].s("session"), fmt.Sprintf("s-%.0f", s.calls()[0].n("pid")))
	})
	t.Run("a batch task is continued as RUN/TASK, from a follow-up or another batch", func(t *testing.T) {
		s := fresh(t)
		batch := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"a","prompt":"x"},{"id":"b","prompt":"y"}]`, nil)
		id := runID(t, batch.stderr)
		bare := s.ask("--wait", "-c", id, "more")
		eq(t, bare.code, 2)
		match(t, bare.stderr, `continue one of them, like `+id+`/a`)
		s.ask("--wait", "-c", id+"/b", "more")
		input, _ := json.Marshal([]object{{"continue": id + "/a", "prompt": "again"}})
		s.run([]string{"batch", "--wait", "-"}, string(input), nil)
		by := func(prompt string) object {
			for _, c := range s.calls() {
				if strings.HasSuffix(c.s("stdin"), prompt) {
					return c
				}
			}
			t.Fatalf("no call ending %q", prompt)
			return nil
		}
		eq(t, by("more").s("session"), fmt.Sprintf("s-%.0f", by("y").n("pid")))
		eq(t, by("again").s("session"), fmt.Sprintf("s-%.0f", by("x").n("pid")))
	})
	t.Run("a follow-up of a task whose worktree was removed never runs in a folder another run holds", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		r := s.run([]string{"batch", "--wait", "-m", "fake:small", "-w", "--worktree", "-C", dir, "-"}, `[{"id":"a","prompt":"look"}]`, nil)
		id := runID(t, r.stderr)
		taken := filepath.Join(s.home, "worktrees", id+"-1-a")
		git("worktree", "add", "-q", "-b", "other", taken)
		s.ask("--wait", "-c", id+"/a", "now change it")
		if cwd := s.calls()[1].s("cwd"); cwd == taken || !strings.HasPrefix(cwd, filepath.Join(s.home, "worktrees")) {
			t.Fatalf("follow-up ran in %s", cwd)
		}
	})
	t.Run("-c accepts a single-task run's folder", func(t *testing.T) {
		s := fresh(t)
		s.ask("--wait", "-m", "fake:small", "hello")
		eq(t, s.ask("--wait", "-c", filepath.Join(s.home, "runs", s.latest()), "more").code, 0)
	})
	t.Run("-c of a run with no result says it has not finished", func(t *testing.T) {
		s := fresh(t)
		s.json(filepath.Join(s.home, "runs", "20260101T000000000-abc123-hung", "tasks.json"), []object{{"id": "1", "prompt": "x", "model": "fake:small", "write": false, "json": false, "dir": s.tmp, "timeout": 900}})
		r := s.ask("--wait", "-c", "hung", "more")
		eq(t, r.code, 2)
		match(t, r.stderr, `hung cannot be continued: it has not finished`)
	})
}

func TestContinueCommand(t *testing.T) {
	t.Run("a prompt continues the saved session and can enable writing", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "investigate")
		id := runID(t, first.stderr)
		got := s.ask("continue", "--wait", id, "--write", "fix it")
		eq(t, got.code, 0)
		eq(t, got.stdout, "fake: fix it\n")
		eq(t, s.calls()[1].s("session"), s.runFile("results.json")[0].s("session"))
		eq(t, s.calls()[1].s("access"), "write")
	})
	t.Run("a follow-up rejects a directory it cannot use", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "investigate")
		got := s.ask("continue", "--wait", runID(t, first.stderr), "--directory", s.tmp, "fix it")
		eq(t, got.code, 2)
		match(t, got.stderr, `uses its original directory`)
		eq(t, len(s.calls()), 1)
	})
	t.Run("piped input is a follow-up prompt", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "investigate")
		without := s.run([]string{"continue", "--wait", runID(t, first.stderr)}, "fix it", nil)
		eq(t, without.code, 2)
		eq(t, len(s.calls()), 1)
		got := s.run([]string{"continue", "--wait", runID(t, first.stderr), "-"}, "fix it", nil)
		eq(t, got.code, 0)
		eq(t, got.stdout, "fake: fix it\n")
		got = s.run([]string{"continue", "--wait", runID(t, first.stderr), "-"}, "another fix", nil)
		eq(t, got.code, 0)
		eq(t, got.stdout, "fake: another fix\n")
		got = s.run([]string{"continue", "--wait", runID(t, first.stderr), "-"}, "", nil)
		eq(t, got.code, 2)
		match(t, got.stderr, `no prompt on stdin`)
	})
	t.Run("a stopped run continues its reported session", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		id := strings.Split(s.latest(), "-")[1]
		eq(t, s.ask("stop", id).code, 0)
		run.wait(t)
		got := s.ask("continue", "--wait", id)
		eq(t, got.code, 0)
		eq(t, got.stdout, "fake: hang\n")
		match(t, got.stderr, `continuing saved conversation to finish the original task`)
		eq(t, s.calls()[1].s("session"), fmt.Sprintf("s-%.0f", s.calls()[0].n("pid")))
		match(t, s.calls()[1].s("stdin"), `finish the original task`)
	})
	t.Run("a rerun retains saved JSON output and rejects changed settings", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"--wait", "-m", "fake:small", "--json", "fail"}, "", map[string]string{"FAKE_FAIL": "fail"})
		eq(t, first.code, 1)
		id := runID(t, first.stderr)
		got := s.ask("continue", "--wait", id, "--write")
		eq(t, got.code, 2)
		match(t, got.stderr, `keeps its original options`)
		eq(t, len(s.calls()), 1)
		got = s.run([]string{"continue", "--wait", id}, "", map[string]string{"FAKE_ANSWER": `{"fixed":true}`})
		eq(t, got.code, 0)
		jsonEqual(t, obj(t, got.stdout), object{"fixed": true})
	})
	t.Run("a batch continues only failed tasks", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"prompt":"ok"},{"prompt":"bad"}]`, map[string]string{"FAKE_FAIL": "bad"})
		eq(t, first.code, 1)
		got := s.ask("continue", "--wait", runID(t, first.stderr))
		eq(t, got.code, 0)
		eq(t, len(s.calls()), 3)
		match(t, got.stderr, `continuing saved conversation to finish the original task`)
	})
	t.Run("a selected batch task reruns alone", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"ok","prompt":"ok"},{"id":"one","prompt":"bad one"},{"id":"two","prompt":"bad two"}]`, map[string]string{"FAKE_FAIL": "bad"})
		eq(t, first.code, 1)
		id := runID(t, first.stderr)
		got := s.ask("continue", "--wait", id+"/one")
		eq(t, got.code, 0)
		eq(t, got.stdout, "fake: bad one\n")
		eq(t, len(s.calls()), 4)
		eq(t, s.ask("show", id+"/two").code, 1)
	})
	t.Run("live reports preserve an interrupted write worktree and its session", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		run := s.start([]string{"--wait", "-m", "fake:small", "-w", "--worktree", "-C", dir, "hang"}, "", map[string]string{"FAKE_HANG": "hang", "FAKE_WRITE": "kept.txt=unfinished"})
		until(t, func() bool { return len(s.calls()) == 1 })
		runDir := filepath.Join(s.home, "runs", s.latest())
		live := filepath.Join(runDir, "recovery-0.json")
		until(t, func() bool {
			data, _ := os.ReadFile(live)
			var record object
			return json.Unmarshal(data, &record) == nil && record.s("session") != ""
		})
		info, err := os.Stat(live)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, info.Mode().Perm(), os.FileMode(0600))
		eq(t, s.ask("stop", filepath.Base(runDir)).code, 0)
		run.wait(t)
		clean := s.ask("clean", "--dry-run", "--days", "0.000001")
		eq(t, clean.code, 0)
		match(t, clean.stdout, `uncommitted changes`)
		if strings.Contains(clean.stdout, "Runs") {
			t.Fatal("cleanup would discard interrupted worktree identity")
		}
		s.json(filepath.Join(s.home, "settings.json"), object{"worktrees": filepath.Join(s.tmp, "different", "{name}")})
		got := s.ask("continue", "--wait", runDir)
		eq(t, got.code, 0)
		eq(t, s.calls()[1].s("cwd"), s.calls()[0].s("cwd"))
		eq(t, s.calls()[1].s("session"), fmt.Sprintf("s-%.0f", s.calls()[0].n("pid")))
		eq(t, s.read(filepath.Join(s.calls()[1].s("cwd"), "kept.txt")), "unfinished")
	})
	t.Run("a live reported session survives a missing final report", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("reported", `cat >/dev/null
if [ -z "$ASK_SESSION" ]; then
  echo '{"session":"saved-live"}' > "$ASK_REPORT"
  sleep 1
  rm "$ASK_REPORT"
  echo transient >&2
  exit 1
fi
printf '%s\n' "$ASK_SESSION"`)
		first := s.ask("--wait", "-m", "reported:small", "finish")
		eq(t, first.code, 1)
		got := s.ask("continue", "--wait", runID(t, first.stderr))
		eq(t, got.code, 0)
		eq(t, got.stdout, "saved-live\n")
	})

	t.Run("a missing interrupted worktree restarts without claiming resumption", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		run := s.start([]string{"--wait", "-m", "fake:small", "-w", "--worktree", "-C", dir, "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		ref := filepath.Join(s.home, "runs", s.latest())
		eq(t, s.ask("stop", ref).code, 0)
		run.wait(t)
		git("worktree", "remove", "--force", s.calls()[0].s("cwd"))
		got := s.ask("continue", "--wait", ref)
		eq(t, got.code, 0)
		match(t, got.stderr, `saved worktree is missing or changed; rerunning`)
		eq(t, s.calls()[1].s("session"), "")
		eq(t, s.calls()[1].s("stdin"), "hang")
	})
	t.Run("an interrupted rerun never falls back to the immutable task session", func(t *testing.T) {
		s := fresh(t)
		ref := filepath.Join(s.home, "runs", "20260101T000000000-abc123-stopped")
		s.json(filepath.Join(ref, "tasks.json"), []object{{"id": "1", "prompt": "unfinished", "model": "fake:small", "session": "stale-before-rerun", "dir": s.tmp, "timeout": 900}})
		got := s.ask("continue", "--wait", ref)
		eq(t, got.code, 0)
		match(t, got.stderr, `no usable saved session; rerunning`)
		eq(t, s.calls()[0].s("session"), "")
		eq(t, s.calls()[0].s("stdin"), "unfinished")
	})
	t.Run("a rerun saves its new session instead of exposing its previous failed result", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("turn", `cat >/dev/null
if [ ! -e "$HOME/again" ]; then
  echo '{"session":"old"}' > "$ASK_REPORT"
  echo boom >&2
  exit 1
fi
echo '{"session":"new"}' > "$ASK_REPORT"
while [ -e "$HOME/hold" ]; do sleep 0.05; done
printf '%s\n' "$ASK_SESSION"`)
		first := s.ask("--wait", "-m", "turn:small", "finish")
		eq(t, first.code, 1)
		ref := filepath.Join(s.home, "runs", s.latest())
		s.write(filepath.Join(s.tmp, "again"), "")
		s.write(filepath.Join(s.tmp, "hold"), "")
		run := s.start([]string{"continue", "--wait", ref}, "", nil)
		until(t, func() bool {
			data, _ := os.ReadFile(filepath.Join(ref, "recovery-0.json"))
			var record object
			return json.Unmarshal(data, &record) == nil && record.s("session") == "new"
		})
		if s.runFile("results.json")[0] != nil {
			t.Fatal("rerun exposed the previous result")
		}
		eq(t, s.ask("stop", ref).code, 0)
		run.wait(t)
		if err := os.Remove(filepath.Join(s.tmp, "hold")); err != nil {
			t.Fatal(err)
		}
		got := s.ask("continue", "--wait", ref)
		eq(t, got.code, 0)
		eq(t, got.stdout, "new\n")
	})
	t.Run("automatic recovery explains blockers while leaving them and successes untouched", func(t *testing.T) {
		for _, reason := range []string{"authentication required", "refused by hook policy", "stopped at the $1 cost limit"} {
			t.Run(reason, func(t *testing.T) {
				s := fresh(t)
				first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"ok","prompt":"ok"},{"id":"blocked","prompt":"bad"},{"id":"retry","prompt":"retry"}]`, map[string]string{"FAKE_FAIL": "bad"})
				ref := filepath.Join(s.home, "runs", s.latest())
				results := s.runFile("results.json")
				results[1]["error"] = reason
				results[2]["ok"] = false
				results[2]["error"] = "transient failure"
				s.json(filepath.Join(ref, "results.json"), results)
				got := s.ask("continue", "--wait", runID(t, first.stderr))
				eq(t, got.code, 1)
				match(t, got.stderr, `blocked: .*resolve it and give an explicit follow-up prompt`)
				eq(t, len(s.calls()), 4)
				match(t, s.calls()[3].s("stdin"), `retry$`)
				after := s.runFile("results.json")
				jsonEqual(t, after[0], results[0])
				jsonEqual(t, after[1], results[1])
				eq(t, s.ask("continue", "--wait", runID(t, first.stderr)+"/blocked", "I resolved the blocker; finish").code, 0)
			})
		}
	})
	t.Run("an active run and a completed run do not wait on an open empty pipe", func(t *testing.T) {
		s := fresh(t)
		run := s.start([]string{"--wait", "-m", "fake:small", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		active := filepath.Join(s.home, "runs", s.latest())
		finished := s.ask("--wait", "-m", "fake:small", "done")
		for _, c := range []struct{ ref, want string }{{active, "still running; use ask wait"}, {runID(t, finished.stderr), "is complete; give a prompt"}} {
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(askBin, "continue", c.ref)
			cmd.Dir, cmd.Stdin = s.tmp, reader
			for k, v := range s.env {
				cmd.Env = append(cmd.Env, k+"="+v)
			}
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-done:
				match(t, stderr.String(), c.want)
			case <-time.After(2 * time.Second):
				_ = cmd.Process.Kill()
				t.Error("continue waited on empty stdin")
			}
			reader.Close()
			writer.Close()
		}
		eq(t, s.ask("stop", active).code, 0)
		run.wait(t)
	})

	t.Run("a completed run needs a prompt", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "done")
		got := s.ask("continue", "--wait", runID(t, first.stderr))
		eq(t, got.code, 2)
		match(t, got.stderr, `is complete; give a prompt`)
		eq(t, len(s.calls()), 1)
	})
}
