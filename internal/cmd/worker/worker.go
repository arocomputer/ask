// Package worker is the detached side of a turn: the launcher starts ask __worker FOLDER in
// its own session, the worker locks the session, admits the turn over a pipe, executes it
// with ask's harness or an external one, and records the outcome. Launch is the launcher side.
package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/extension"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/harness"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/provider"
	"github.com/arocomputer/ask/internal/sessions"
	"github.com/arocomputer/ask/internal/term"
)

// Launch starts a worker for the session's latest turn and prints the session ID, or with
// wait the answer. undo removes what the caller created when the worker cannot start. On a
// terminal, stderr also says how to collect it.
func Launch(p config.Paths, s *sessions.Session, wait, asJSON bool, undo func()) (int, error) {
	if err := Start(p, s); err != nil {
		undo()
		return 0, err
	}
	if wait {
		return cmdutil.Wait([]*sessions.Session{s}, asJSON)
	}
	if asJSON {
		fmt.Fprintln(os.Stdout, config.JSON(map[string]any{"session_id": s.ID, "turn": len(s.Turns), "state": "running"}, false))
		return 0, nil
	}
	fmt.Fprintln(os.Stdout, s.ID)
	if st := term.Styled(os.Stderr); st.On {
		fmt.Fprintf(os.Stderr, "%s %s started · %s%s\n", st.Yellow("!"), st.Bold(s.ID), term.ModelName(s.Turn().Model), st.Dim(" · ask wait "+s.ID))
	}
	return 0, nil
}

// Start detaches a worker for the session and returns once it holds the session's lock, so
// the ID the caller prints names work that is really under way. The worker gets a reply pipe
// as descriptor 3 and lives in its own session, beyond the caller's terminal.
func Start(p config.Paths, s *sessions.Session) error {
	replyR, replyW, err := os.Pipe()
	if err != nil {
		return err
	}
	defer replyR.Close()
	cmd := exec.Command(p.Bin, "__worker", s.Folder)
	cmd.Env = os.Environ()
	cmd.ExtraFiles = []*os.File{replyW}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	log, err := os.OpenFile(filepath.Join(s.Folder, "worker.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		replyW.Close()
		return err
	}
	cmd.Stderr = log
	err = cmd.Start()
	replyW.Close()
	log.Close()
	if err != nil {
		return fmt.Errorf("cannot start the worker: %w", err)
	}
	line := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(replyR)
		if sc.Scan() {
			line <- sc.Text()
		} else {
			line <- ""
		}
	}()
	select {
	case reply := <-line:
		if reply == "ok" {
			_ = cmd.Process.Release()
			return nil
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if reply == "" {
			return errors.New("the worker exited before admitting the turn")
		}
		if strings.HasPrefix(reply, "usage: ") {
			return config.Usage("%s", strings.TrimPrefix(reply, "usage: "))
		}
		return errors.New(strings.TrimPrefix(reply, "error: "))
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return errors.New("the worker did not admit the turn within 30 seconds")
	}
}

// Main is the detached side: it locks the session, admits the latest turn over descriptor 3,
// executes it and records the outcome. SIGTERM (ask stop) ends the turn as stopped.
func Main(args []string) int {
	reply := os.NewFile(3, "reply")
	fail := func(prefix, msg string) int {
		if reply != nil {
			fmt.Fprintln(reply, prefix+msg)
			reply.Close()
		}
		fmt.Fprintln(os.Stderr, msg)
		return 1
	}
	if len(args) != 1 || reply == nil {
		return fail("error: ", "the worker is started by ask itself")
	}
	p := config.New()
	s, err := sessions.Load(args[0])
	if err != nil {
		return fail("error: ", err.Error())
	}
	lock, err := sessions.Lock(s)
	if err != nil {
		return fail("usage: ", err.Error())
	}
	defer lock.Close()
	t := s.Turn()
	t.Started, t.State = sessions.Now(), "running"
	if err := s.Save(); err != nil {
		return fail("error: ", err.Error())
	}
	process.Listen()
	// A stop before the turn's own handler is in place still records the turn as stopped.
	process.OnStop(func() {
		t.State, t.Finished = "stopped", sessions.Now()
		_ = s.Save()
	})
	signal.Ignore(syscall.SIGHUP)
	fmt.Fprintln(reply, "ok")
	reply.Close()
	execute(p, s)
	if t.State == "succeeded" {
		return 0
	}
	return 1
}

// execute runs the latest turn with ask's harness or an external harness, saving progress as
// it goes and the outcome at the end. A stop signal cancels the work, waits for the record to
// be saved as stopped, then exits.
func execute(p config.Paths, s *sessions.Session) {
	t := s.Turn()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(t.Timeout*float64(time.Second)))
	defer cancel()
	saved := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(saved) }) }
	process.OnStop(func() { cancel(); <-saved })
	defer process.OnStop(nil)
	start := time.Now()
	var snapshot *git.Snapshot
	if t.Write {
		snapshot = git.Take(s.Dir)
	}
	sessions.Append(s, sessions.Event{Type: "status", Text: fmt.Sprintf("turn %d running", len(s.Turns))})
	isNative, _, _ := cmdutil.Split(t.Model)
	var mu sync.Mutex
	save := func() {
		mu.Lock()
		defer mu.Unlock()
		t.Seconds = time.Since(start).Seconds()
		_ = s.Save()
	}
	auth, err := p.ReadAuth()
	switch {
	case err != nil:
		t.Error = err.Error()
	case isNative:
		native(ctx, p, auth, s, save)
	default:
		external(ctx, p, s, save)
	}
	switch {
	case ctx.Err() != nil && t.Error != "" && errors.Is(ctx.Err(), context.DeadlineExceeded):
		t.State, t.Error = "failed", "timed out"
	case ctx.Err() != nil && t.Error != "":
		t.State, t.Error = "stopped", ""
	case t.Error != "":
		t.State = "failed"
	default:
		t.State = "succeeded"
	}
	if snapshot != nil {
		changes, commits := git.Changes(snapshot)
		for _, c := range changes {
			t.Changes = append(t.Changes, sessions.Change{Path: c.Path, Change: c.Change})
		}
		t.Commits = commits
	}
	t.Finished = sessions.Now()
	save()
	sessions.Append(s, sessions.Event{Type: "status", Text: t.State})
	fmt.Fprintln(os.Stderr, term.Line(s, term.Styled(os.Stderr)))
	finish()
}

// native runs the turn with ask's harness against the provider's endpoint, continuing the
// session's transcript. Gateways get ask's user agent and the session ID, which they use to
// route and cache a conversation. Extensions add their tools and their notes on them.
func native(ctx context.Context, p config.Paths, auth config.Object, s *sessions.Session, save func()) {
	t := s.Turn()
	_, name, id := cmdutil.Split(t.Model)
	spec, ok := cmdutil.Provider(auth, name)
	if !ok {
		t.Error = "no provider " + name
		return
	}
	key := config.Credential(auth, name)
	if key == "" {
		t.Error = "no credential for " + name + ": set " + config.KeyVar(name) + " or run ask setup"
		return
	}
	prov := &provider.OpenAI{Key: key, BaseURL: spec.BaseURL, Reasoning: spec.Reasoning, UserAgent: "ask/" + cmdutil.Version, Session: s.ID}
	catalog, err := cmdutil.Catalog(p)
	if err != nil {
		t.Error = err.Error()
		return
	}
	if m, ok := catalog.Find(name, id); ok && m.Name != "" {
		t.Name = m.Name
	}
	extra, notes := tools(p, t.Write)
	result := harness.Run(ctx, harness.Options{
		Provider: prov, Model: id, Effort: t.Effort, Write: t.Write, Dir: s.Dir,
		Instructions: harness.Instructions(s.Dir, t.Write, len(t.Schema) > 0, notes),
		Transcript:   s.Transcript(), Prompt: t.Prompt, Schema: t.Schema, MaxCost: t.MaxCost, Extra: extra,
		Cost:  func(u provider.Usage) *float64 { return catalog.Cost(name, id, u) },
		Event: func(e sessions.Event) { sessions.Append(s, e) },
		Progress: func(u provider.Usage, cost *float64) {
			t.Usage = &sessions.Usage{Input: u.Input, Output: u.Output, Cached: u.Cached, Cost: cost}
			save()
		},
	})
	_ = s.SaveTranscript(result.Transcript)
	if result.Usage.Input > 0 || result.Usage.Output > 0 {
		t.Usage = &sessions.Usage{Input: result.Usage.Input, Output: result.Usage.Output, Cached: result.Usage.Cached, Cost: result.Cost}
	}
	t.Answer, t.Error = result.Answer, result.Error
}

// tools collects the extensions' tools this turn may use (read tools always, the rest only in
// write turns) and the notes of every extension that contributes one, or that has notes and
// no tools at all. A name already taken is skipped with a line in the worker log.
func tools(p config.Paths, write bool) ([]harness.Tool, []string) {
	out, notes := []harness.Tool{}, []string{}
	taken := map[string]bool{}
	for _, t := range harness.Tools(true) {
		taken[t.Name] = true
	}
	for _, e := range extension.Working(p) {
		used := false
		for _, t := range e.Tools {
			if t.Access != "read" && !write {
				continue
			}
			if taken[t.Name] {
				fmt.Fprintf(os.Stderr, "extension %s: tool %s is already taken; skipped\n", e.Name, t.Name)
				continue
			}
			path, err := e.Path(t.Command)
			if err != nil {
				continue
			}
			taken[t.Name], used = true, true
			out = append(out, harness.External(t.Name, t.Description, t.Parameters, path))
		}
		if text := e.Text(); text != "" && (used || len(e.Tools) == 0) {
			notes = append(notes, text)
		}
	}
	return out, notes
}

// external runs the turn through an installed harness under the executable contract,
// resuming the harness's own session on a later turn.
func external(ctx context.Context, p config.Paths, s *sessions.Session, save func()) {
	t := s.Turn()
	_, name, id := cmdutil.Split(t.Model)
	extension.Refresh(p, cmdutil.Version)
	stop := make(chan struct{})
	go func() { <-ctx.Done(); close(stop) }()
	title := strings.SplitN(s.Turns[0].Prompt, "\n", 2)[0]
	if n := []rune(title); len(n) > 60 {
		title = string(n[:60]) + "…"
	}
	result := extension.Run(p, extension.Options{
		Harness: name, Model: id, Effort: t.Effort, Write: t.Write, Dir: s.Dir, Prompt: t.Prompt, Schema: t.Schema,
		Session: s.HarnessSession, Events: sessions.EventsPath(s), Title: term.ModelName(t.Model) + " · " + title, MaxCost: t.MaxCost,
		Timeout: time.Duration(t.Timeout * float64(time.Second)), Stop: stop,
		Progress: func(rep extension.Report) {
			changed := false
			if rep.Session != "" && rep.Session != s.HarnessSession {
				s.HarnessSession, changed = rep.Session, true
			}
			if u := usage(rep); u != nil {
				t.Usage, changed = u, true
			}
			if changed {
				save()
			}
		},
	})
	if result.Report.Session != "" {
		s.HarnessSession = result.Report.Session
	}
	if result.Report.Name != "" {
		t.Name = result.Report.Name
	}
	if u := usage(result.Report); u != nil {
		t.Usage = u
	}
	if result.OK {
		t.Answer = result.Answer
		if len(t.Schema) > 0 {
			var v any
			if json.Unmarshal([]byte(result.Answer), &v) != nil {
				t.Error = "the answer is not valid JSON"
			}
		}
	} else {
		t.Error = result.Error
	}
}

func usage(rep extension.Report) *sessions.Usage {
	if rep.Input == nil && rep.Output == nil && rep.Cost == nil {
		return nil
	}
	u := &sessions.Usage{Cost: rep.Cost}
	if rep.Input != nil {
		u.Input = int(*rep.Input)
	}
	if rep.Output != nil {
		u.Output = int(*rep.Output)
	}
	if rep.Cached != nil {
		u.Cached = int(*rep.Cached)
	}
	return u
}
