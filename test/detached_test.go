package test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
)

// TestDetached exercises default detached handoff through the real binary, without a shell background job.
func TestDetached(t *testing.T) {
	launch := func(t *testing.T, s *setup, args []string, env map[string]string) string {
		t.Helper()
		out := s.run(append([]string{"run", "-m", "fake:small"}, args...), "", env)
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		id := strings.TrimSpace(out.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		return id
	}
	open := func(t *testing.T, s *setup, id string) *runs.Run {
		t.Helper()
		r, _, err := runs.Open(home.Paths{Runs: filepath.Join(s.home, "runs")}, id)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	t.Run("SIGTERM before admission removes only the fresh unadmitted record", func(t *testing.T) {
		s := fresh(t)
		// A legacy reused worktree reads settings while reserving its location, after
		// creation and the run lock but before admission. The FIFO holds that boundary.
		if err := syscall.Mkfifo(filepath.Join(s.home, "settings.json"), 0600); err != nil {
			t.Fatal(err)
		}
		requestR, requestW, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer requestR.Close()
		defer requestW.Close()
		replyR, replyW, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer replyR.Close()
		defer replyW.Close()
		cmd := exec.Command(askBin, "__ask_worker")
		cmd.Dir = s.tmp
		for k, v := range s.env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.ExtraFiles = []*os.File{requestR, replyW}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill() })
		requestR.Close()
		replyW.Close()
		request := home.O("Jobs", 1, "Tasks", []any{home.O("id", "1", "model", "fake:small", "prompt", "fresh", "dir", s.tmp, "timeout", 5, "reuse", true, "worktree", "legacy", "continues", "earlier")})
		if _, err := requestW.Write([]byte(home.JSON(request, false))); err != nil {
			t.Fatal(err)
		}
		requestW.Close()
		until(t, func() bool {
			entries, _ := os.ReadDir(filepath.Join(s.home, "runs"))
			return len(entries) == 1 && runs.Owner(&runs.Run{Dir: filepath.Join(s.home, "runs", entries[0].Name())}) == cmd.Process.Pid
		})
		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("worker did not stop during admission")
		}
		eq(t, cmd.ProcessState.ExitCode(), 130)
		eq(t, len(s.dirs()), 0)
		eq(t, len(s.calls()), 0)
	})
	t.Run("relative home supports snapshots waits and recovery", func(t *testing.T) {
		s := fresh(t)
		s.env["ASK_HOME"] = "home"
		id := launch(t, s, []string{"hang"}, map[string]string{"FAKE_HANG": "hang"})
		shown := s.ask("show", "--json", id)
		eq(t, shown.code, 1)
		eq(t, obj(t, shown.stdout).s("state"), "running")
		listed := s.ask("runs", "--json")
		eq(t, listed.code, 0)
		eq(t, objects(t, listed.stdout)[0].s("run_id"), id)
		eq(t, s.ask("stop", id).code, 0)
		eq(t, s.ask("continue", filepath.Join("home", "runs", s.latest())).stdout, id+"\n")
		waited := s.ask("wait", "--json", id)
		eq(t, waited.code, 0)
		eq(t, obj(t, waited.stdout).s("run_id"), id)
		eq(t, s.ask("show", "--json", id).code, 0)
		eq(t, len(s.dirs()), 1)
	})
	t.Run("name hook notes reach detached callers safely on stderr", func(t *testing.T) {
		s := fresh(t)
		s.hook("namer", []string{"name"}, `printf 'bad\033[31m note\n' >&2; exit 3`)
		out := s.ask("-m", "fake:small", "inspect notes")
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		match(t, out.stderr, `note · hook namer · failed`)
		noMatch(t, out.stderr, "\x1b")
		eq(t, s.ask("wait", strings.TrimSpace(out.stdout)).stdout, "fake: inspect notes\n")
	})
	t.Run("missing worktree recovery tells the detached caller it will restart", func(t *testing.T) {
		s := fresh(t)
		dir, git := s.repo()
		id := launch(t, s, []string{"-w", "--worktree", "-C", dir, "hang"}, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 1 })
		eq(t, s.ask("stop", id).code, 0)
		git("worktree", "remove", "--force", s.calls()[0].s("cwd"))
		out := s.ask("continue", id)
		eq(t, out.code, 0)
		eq(t, out.stdout, id+"\n")
		match(t, out.stderr, `saved worktree is missing or changed; rerunning`)
		eq(t, s.ask("wait", id).stdout, "fake: hang\n")
		eq(t, s.calls()[1].s("session"), "")
		eq(t, len(s.dirs()), 1)
	})
	t.Run("partial recovery explains blockers before returning the batch ID", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"blocked","prompt":"bad"},{"id":"retry","prompt":"bad"}]`, map[string]string{"FAKE_FAIL": "bad"})
		eq(t, first.code, 1)
		id := strings.SplitN(s.latest(), "-", 3)[1]
		r := open(t, s, id)
		results := s.runFile("results.json")
		results[0]["error"] = "authentication required"
		s.json(filepath.Join(r.Dir, "results.json"), results)
		out := s.ask("continue", id)
		eq(t, out.code, 0)
		eq(t, out.stdout, id+"\n")
		match(t, out.stderr, `blocked: authentication required`)
		match(t, out.stderr, `continuing saved conversation`)
		eq(t, s.ask("wait", "--json", id).code, 1)
		jsonEqual(t, s.runFile("results.json")[0], results[0])
		eq(t, len(s.calls()), 3)
	})
	t.Run("acknowledges a locked worker detached from the launcher and stops its agent", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"hang"}, map[string]string{"FAKE_HANG": "hang"})
		r := open(t, s, id)
		owner := runs.Owner(r)
		if owner <= 0 {
			t.Fatal("launch returned without a live owner")
		}
		if err := runs.DiscardUnadmitted(r); err == nil {
			t.Fatal("cleanup deleted another worker's active run")
		}
		group, err := syscall.Getpgid(owner)
		if err != nil || group != owner {
			t.Fatalf("worker did not detach into its own session/group: %d %v", group, err)
		}
		if _, known := runs.Pending(r, owner); !known {
			t.Fatal("launch returned before recording pending tasks")
		}
		until(t, func() bool { return len(s.calls()) == 1 })
		if err := syscall.Kill(owner, syscall.SIGHUP); err != nil {
			t.Fatal(err)
		}
		eq(t, s.ask("stop", id).code, 0)
		until(t, func() bool { return !alive(int(s.calls()[0].n("pid"))) })
		out := s.ask("wait", "--id", id)
		eq(t, out.code, 1)
		eq(t, out.stdout, id+"\n")
		match(t, out.stderr, `stopped`)
		eq(t, len(s.calls()), 1)
	})
	t.Run("keeps normal task options and stdin while returning only an ID", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		out := s.run([]string{"run", "-m", "fake:small", "-w", "--worktree", "-C", dir, "--json", "--title", "inspect", "-"}, "the", map[string]string{"FAKE_ANSWER": `{"key":true}`, "FAKE_WRITE": "new.txt=hello"})
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		id := strings.TrimSpace(out.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		waited := s.ask("wait", id)
		eq(t, waited.code, 0)
		eq(t, waited.stdout, "{\"key\":true}\n")
		eq(t, s.calls()[0].s("access"), "write")
		match(t, s.calls()[0].s("title"), `Inspect`)
		result := obj(t, s.ask("show", id, "--json").stdout)
		worktree, ok := result["worktree"].(map[string]any)
		if !ok || filepath.Base(worktree["path"].(string)) != id {
			t.Fatalf("unnamed detached worktree must use the worker ID: %v", result["worktree"])
		}
		eq(t, len(s.calls()), 1)
	})
	t.Run("concurrent identical prompts get matching unique run and worktree names", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		// Both launchers choose their name before either worker can claim it.
		s.hook("barrier", []string{"name"}, `touch "$HOME/ready-$PPID"
while [ "$(find "$HOME" -name 'ready-*' | wc -l | tr -d ' ')" -lt 2 ]; do sleep 0.01; done`)
		prompts := []string{"review login security race", "review login security race"}
		started := make([]*running, len(prompts))
		for i, prompt := range prompts {
			started[i] = s.start([]string{"run", "-m", "fake:small", "-w", "--worktree", "-C", dir, prompt}, "", map[string]string{"FAKE_SLOW": "review", "FAKE_WRITE": "kept.txt=change"})
		}
		names := map[string]bool{}
		for i, process := range started {
			out := process.wait(t)
			eq(t, out.code, 0)
			match(t, out.stdout, `^[a-z0-9]{6}\n$`)
			id := strings.TrimSpace(out.stdout)
			t.Cleanup(func() { s.ask("stop", id) })
			eq(t, open(t, s, id).Tasks[0].S("prompt"), prompts[i])
			eq(t, s.ask("wait", id).stdout, "fake: "+prompts[i]+"\n")
			r := open(t, s, id)
			names[r.Name] = true
			worktree := obj(t, s.ask("show", "--json", id).stdout)["worktree"].(map[string]any)
			eq(t, filepath.Base(worktree["path"].(string)), r.Name)
			eq(t, worktree["branch"], "ask/"+r.Name)
		}
		eq(t, names, map[string]bool{"review-login-security-race": true, "review-login-security-race-2": true})
		eq(t, len(s.calls()), 2)
		eq(t, len(s.dirs()), 2)
	})
	t.Run("private lifecycle logs never copy prompts credentials answers or diagnostics", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("private", `cat >/dev/null
printf '%s\n' "$CREDENTIAL" >&2
printf 'private answer\n'`)
		id := launch(t, s, []string{"-m", "private:small", "private prompt"}, map[string]string{"CREDENTIAL": "private credential"})
		eq(t, s.ask("wait", id).stdout, "private answer\n")
		r := open(t, s, id)
		log := filepath.Join(r.Dir, "worker.log")
		until(t, func() bool { return strings.Contains(s.read(log), "finished") })
		eq(t, s.read(log), "started\nfinished\n")
		for _, path := range []string{r.Dir, log, filepath.Join(r.Dir, "tasks.json"), filepath.Join(r.Dir, "results.json")} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm()&0077 != 0 {
				t.Fatalf("not private: %s: %v %v", path, info, err)
			}
		}
	})
	t.Run("agent failures remain visible after a successful launch", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"fail"}, map[string]string{"FAKE_FAIL": "fail"})
		out := s.ask("wait", id)
		eq(t, out.code, 1)
		eq(t, out.stdout, "")
		match(t, out.stderr, `failed`)
		eq(t, s.ask("wait", "--id", id).stdout, id+"\n")
		eq(t, s.ask("wait", "--id", id).code, 1)
		eq(t, len(s.calls()), 1)
	})
	t.Run("detached tasks retain the configured timeout and its failure report", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"-t", "0.2", "hang"}, map[string]string{"FAKE_HANG": "hang"})
		out := s.ask("wait", "--id", id)
		eq(t, out.code, 1)
		eq(t, out.stdout, id+"\n")
		match(t, out.stderr, `timed out|timeout`)
		eq(t, len(s.calls()), 1)
		until(t, func() bool { return !alive(int(s.calls()[0].n("pid"))) })
	})
	t.Run("conflicting continuations fail admission without a returned ID or duplicate execution", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "remember")
		eq(t, first.code, 0)
		prior := strings.SplitN(s.latest(), "-", 3)[1]
		id := launch(t, s, []string{"-c", prior, "hang"}, map[string]string{"FAKE_HANG": "hang"})
		until(t, func() bool { return len(s.calls()) == 2 })
		out := s.ask("run", "-c", prior, "other")
		eq(t, out.code, 2)
		eq(t, out.stdout, "")
		match(t, out.stderr, `already in use`)
		eq(t, len(s.calls()), 2)
		eq(t, len(s.dirs()), 2)
		eq(t, runs.Owner(open(t, s, id)) > 0, true)
	})
	t.Run("validation and private worker entry cannot choose an existing run identity", func(t *testing.T) {
		s := fresh(t)
		id := launch(t, s, []string{"original"}, nil)
		eq(t, s.ask("wait", id).code, 0)
		other := launch(t, s, []string{"new task"}, map[string]string{"ASK_RUN": id, "ASK_RUN_ID": id})
		if other == id {
			t.Fatal("inherited identity reused an existing run")
		}
		eq(t, s.ask("wait", other).code, 0)
		for _, args := range [][]string{{"run", "--run-id", id, "bad"}, {"run", "-m", "missing:x", "bad"}, {"__ask_worker"}, {"__ask_worker", id}} {
			out := s.ask(args...)
			eq(t, out.code, 2)
			eq(t, out.stdout, "")
		}
		eq(t, len(s.calls()), 2)
		eq(t, s.ask("show", id).stdout, "fake: original\n")
	})
	t.Run("implicit prompts and bare piped input detach by default", func(t *testing.T) {
		for _, args := range [][]string{{"-m", "fake:small", "hang"}, nil} {
			s := fresh(t)
			s.json(filepath.Join(s.home, "settings.json"), object{"model": "fake:small"})
			out := s.run(args, "hang", map[string]string{"FAKE_HANG": "hang"})
			eq(t, out.code, 0)
			match(t, out.stdout, `^[a-z0-9]{6}\n$`)
			id := strings.TrimSpace(out.stdout)
			t.Cleanup(func() { s.ask("stop", id) })
			r := open(t, s, id)
			if runs.Owner(r) <= 0 {
				t.Fatal("prompt returned before locking detached work")
			}
			eq(t, s.ask("stop", id).code, 0)
		}
	})
	t.Run("continue with a prompt detaches and keeps session model and write options", func(t *testing.T) {
		s := fresh(t)
		first := s.ask("--wait", "-m", "fake:small", "remember")
		eq(t, first.stdout, "fake: remember\n")
		prior := open(t, s, strings.SplitN(s.latest(), "-", 3)[1])
		out := s.run([]string{"continue", prior.ID, "-m", "fake:big", "-w", "hang"}, "", map[string]string{"FAKE_HANG": "hang"})
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		id := strings.TrimSpace(out.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		if id == prior.ID {
			t.Fatal("explicit follow-up reused the original execution identity")
		}
		until(t, func() bool { return len(s.calls()) == 2 })
		eq(t, s.calls()[1].s("session"), prior.Results[0].S("session"))
		eq(t, s.calls()[1].s("model"), "big")
		eq(t, s.calls()[1].s("access"), "write")
		eq(t, s.ask("stop", id).code, 0)
	})
	t.Run("competing recovery launchers acknowledge one locked owner and preserve its worktree", func(t *testing.T) {
		s := fresh(t)
		dir, _ := s.repo()
		id := launch(t, s, []string{"-w", "--worktree", "-C", dir, "hang"}, map[string]string{"FAKE_HANG": "hang", "FAKE_WRITE": "kept.txt=unfinished"})
		r := open(t, s, id)
		until(t, func() bool {
			b, _ := os.ReadFile(filepath.Join(r.Dir, "recovery-0.json"))
			return strings.Contains(string(b), `"session": "s-`)
		})
		eq(t, s.ask("stop", id).code, 0)
		launchers := []*running{
			s.start([]string{"continue", id}, "", map[string]string{"FAKE_HANG": "hang"}),
			s.start([]string{"continue", id}, "", map[string]string{"FAKE_HANG": "hang"}),
		}
		accepted := 0
		for _, caller := range launchers {
			out := caller.wait(t)
			if out.code == 0 {
				accepted++
				eq(t, out.stdout, id+"\n")
				owner := runs.Owner(r)
				pending, known := runs.Pending(r, owner)
				if owner <= 0 || !known || !pending[0] {
					t.Fatal("recovery returned before lock and pending state were ready")
				}
			} else {
				eq(t, out.stdout, "")
				match(t, out.stderr, `is (still )?running`)
			}
		}
		eq(t, accepted, 1)
		until(t, func() bool { return len(s.calls()) == 2 })
		eq(t, s.calls()[1].s("cwd"), s.calls()[0].s("cwd"))
		eq(t, s.calls()[1].s("session"), "s-"+home.String(s.calls()[0]["pid"]))
		eq(t, s.read(filepath.Join(s.calls()[1].s("cwd"), "kept.txt")), "unfinished")
		eq(t, len(s.dirs()), 1)
		eq(t, s.ask("stop", id).code, 0)
	})
	t.Run("batch detaches with bounded concurrency and cancellation never starts queued work", func(t *testing.T) {
		s := fresh(t)
		out := s.run([]string{"batch", "-m", "fake:small", "-j", "2", "-"}, `[{"prompt":"hang a"},{"prompt":"hang b"},{"prompt":"hang c"}]`, map[string]string{"FAKE_HANG": "hang"})
		eq(t, out.code, 0)
		match(t, out.stdout, `^[a-z0-9]{6}\n$`)
		id := strings.TrimSpace(out.stdout)
		t.Cleanup(func() { s.ask("stop", id) })
		r := open(t, s, id)
		pending, known := runs.Pending(r, runs.Owner(r))
		eq(t, known, true)
		eq(t, len(pending), 3)
		until(t, func() bool { return len(s.calls()) == 2 })
		eq(t, s.ask("stop", id).code, 0)
		for _, call := range s.calls() {
			until(t, func() bool { return !alive(int(call.n("pid"))) })
		}
		eq(t, len(s.calls()), 2)
		resumed := s.ask("batch", "--resume", id, "-j", "1")
		eq(t, resumed.code, 0)
		eq(t, resumed.stdout, id+"\n")
		waited := s.ask("wait", id)
		eq(t, waited.code, 0)
		eq(t, len(objects(t, waited.stdout)), 3)
		eq(t, len(s.calls()), 5)
	})
	t.Run("selected recovery uses the recorded position even with numeric task names", func(t *testing.T) {
		s := fresh(t)
		first := s.run([]string{"batch", "--wait", "-m", "fake:small", "-"}, `[{"id":"chosen","prompt":"bad a"},{"id":"1","prompt":"bad b"}]`, map[string]string{"FAKE_FAIL": "bad"})
		eq(t, first.code, 1)
		id := strings.SplitN(s.latest(), "-", 3)[1]
		out := s.ask("continue", id+"/chosen")
		eq(t, out.code, 0)
		eq(t, out.stdout, id+"\n")
		eq(t, s.ask("wait", id+"/chosen").stdout, "fake: bad a\n")
		eq(t, s.ask("show", id+"/1").code, 1)
		eq(t, len(s.calls()), 3)
		match(t, s.calls()[2].s("stdin"), `bad a$`)
	})
	t.Run("blocked recovery and failed pending state return no ID and preserve saved results", func(t *testing.T) {
		for _, failure := range []string{"blocked", "pending state"} {
			s := fresh(t)
			first := s.run([]string{"--wait", "-m", "fake:small", "bad"}, "", map[string]string{"FAKE_FAIL": "bad"})
			eq(t, first.code, 1)
			id := strings.SplitN(s.latest(), "-", 3)[1]
			r := open(t, s, id)
			if failure == "blocked" {
				results := s.runFile("results.json")
				results[0]["error"] = "authentication required"
				s.json(filepath.Join(r.Dir, "results.json"), results)
			} else {
				s.mkdir(filepath.Join(r.Dir, "pending.json"))
			}
			before := s.read(filepath.Join(r.Dir, "results.json"))
			out := s.ask("continue", id)
			if failure == "blocked" {
				eq(t, out.code, 2)
			} else {
				eq(t, out.code, 1)
			}
			eq(t, out.stdout, "")
			if failure == "blocked" {
				match(t, out.stderr, `blocked: authentication required`)
			}
			eq(t, s.read(filepath.Join(r.Dir, "results.json")), before)
			eq(t, len(s.calls()), 1)
			eq(t, len(s.dirs()), 1)
		}
	})
	t.Run("start is removed rather than accepted as an alias or a new prompt", func(t *testing.T) {
		s := fresh(t)
		out := s.ask("start", "-m", "fake:small", "bad")
		eq(t, out.code, 2)
		eq(t, out.stdout, "")
		match(t, out.stderr, `ask start was removed`)
		eq(t, len(s.calls()), 0)
	})

	t.Run("completed recovery and missing batch input never prompt on a terminal", func(t *testing.T) {
		if _, err := exec.LookPath("script"); err != nil {
			t.Skip("a pseudo-terminal requires script")
		}
		s := fresh(t)
		// This pseudo-terminal has no emulator to answer the UI library's color probes.
		s.env["TERM"] = "dumb"
		eq(t, s.ask("--wait", "-m", "fake:small", "done").code, 0)
		id := strings.SplitN(s.latest(), "-", 3)[1]
		for _, args := range [][]string{{"continue", id}, {"continue", "--wait", id}, {"batch"}} {
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			scriptArgs := append([]string{"-q", "/dev/null", askBin}, args...)
			if runtime.GOOS != "darwin" {
				scriptArgs = []string{"-q", "-e", "-c", askBin + " " + strings.Join(args, " "), "/dev/null"}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			cmd := exec.CommandContext(ctx, "script", scriptArgs...)
			cmd.Dir, cmd.Stdin = s.tmp, reader
			for k, v := range s.env {
				cmd.Env = append(cmd.Env, k+"="+v)
			}
			out, _ := cmd.CombinedOutput()
			cancel()
			if ctx.Err() == context.DeadlineExceeded {
				t.Fatalf("ask %v blocked on terminal input: %s", args, out)
			}
			if args[0] == "continue" {
				match(t, string(out), `is complete; give a prompt`)
			} else {
				match(t, string(out), `needs a task file or piped input`)
			}
		}
		eq(t, len(s.calls()), 1)
	})

}
