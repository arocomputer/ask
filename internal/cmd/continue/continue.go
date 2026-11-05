// Package cont is ask continue: add a turn to a session, or resume an interrupted one.
package cont

import (
	"os"
	"strings"

	"github.com/arocomputer/ask/internal/cmd/worker"
	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/sessions"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Add a turn to a session, or resume an interrupted one.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask continue <id> [<prompt>] [flags]"},
	{Title: "ARGUMENTS", Body: `With a prompt, the model gets it as the next turn and sees everything the session read, said and
did. Without one, it is asked to finish the task, which is how an interrupted turn resumes. The
session keeps its ID, directory and worktree; -m may change the model within the same provider.`},
	{Title: "FLAGS", Body: `-m, --model <model>         Another model from the same provider or harness
-w, --write                 Add write access
    --wait                  Wait and print the answer
    --json                  JSON output`},
	{Title: "ADVANCED FLAGS", Body: `-t, --timeout <seconds>     As for run
    --max-cost <usd>        As for run
    --schema <file>         As for run
    --stdin                 Append stdin to the prompt`},
	{Title: "EXAMPLES", Body: `$ ask continue k3f9a2 "Now add a test for the expired-token case."
$ ask continue k3f9a2 --wait -w "Fix it."
$ ask continue k3f9a2`},
}}

// finishPrompt is what an interrupted turn is followed by when no prompt is given.
const finishPrompt = "Continue the task where you left off and finish it. If you already completed it, give the final answer."

// Run adds a turn to a session and launches it.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, cmdutil.LaunchFlags)
	if err != nil {
		return 0, err
	}
	if len(words) == 0 {
		return 0, config.Usage("ask continue needs a session ID, like ask continue k3f9a2 \"Add a test too\"")
	}
	s, err := sessions.Open(p, words[0])
	if err != nil {
		return 0, err
	}
	state := s.State()
	if state == "running" {
		return 0, config.Usage("%s is still running; ask wait %s first", s.ID, s.ID)
	}
	cfg, err := p.ReadConfig()
	if err != nil {
		return 0, err
	}
	last := s.Turn()
	spec := opts.S("model")
	if spec == "" {
		spec = last.Model
	}
	lastNative, lastProvider, _ := cmdutil.Split(last.Model)
	m, err := cmdutil.Resolve(p, cfg, spec)
	if err != nil {
		return 0, err
	}
	if m.Native != lastNative || m.Provider != lastProvider {
		return 0, config.Usage("a session keeps its provider: %s continues on %s, not %s", s.ID, lastProvider, m.Provider)
	}
	prompt := config.Trim(strings.Join(words[1:], " "))
	if prompt == "" && !opts.B("stdin") && len(words) == 1 {
		if state == "succeeded" {
			return 0, config.Usage("%s finished; give the next turn's prompt, like ask continue %s \"Now add a test\"", s.ID, s.ID)
		}
		prompt = finishPrompt
	} else if prompt, err = cmdutil.ReadPrompt(words[1:], opts.B("stdin")); err != nil {
		return 0, err
	}
	if !m.Native && s.HarnessSession == "" {
		return 0, config.Usage("%s reported no session of its own, so %s cannot continue it; start a new session", s.ID, lastProvider)
	}
	t := sessions.Turn{Prompt: prompt, Model: m.Spec, Name: m.Name, Effort: m.Effort, Write: last.Write || opts.B("write"), Schema: last.Schema}
	if err := cmdutil.Limits(&t, opts, cfg); err != nil {
		return 0, err
	}
	if !opts.Has("timeout") {
		t.Timeout = last.Timeout
	}
	if !opts.Has("max-cost") {
		t.MaxCost = last.MaxCost
	}
	if opts.Has("schema") {
		if t.Schema, err = cmdutil.ReadSchema(opts.S("schema")); err != nil {
			return 0, err
		}
	}
	if s.Worktree != nil {
		if err := git.Check(s.Origin, &git.Worktree{Path: s.Worktree.Path, Branch: s.Worktree.Branch}); err != nil {
			return 0, err
		}
	} else if t.Write && !last.Write && cfg.B("worktree") {
		return 0, config.Usage("the worktree key in config requires write sessions to work in a worktree, and %s works in %s; start a new session with --worktree", s.ID, s.Dir)
	}
	if info, err := os.Stat(s.Dir); err != nil || !info.IsDir() {
		return 0, config.Usage("%s worked in %s, which no longer exists", s.ID, s.Dir)
	}
	if err := s.AddTurn(t); err != nil {
		return 0, err
	}
	return worker.Launch(p, s, opts.B("wait"), opts.B("json"), func() { _ = s.DropTurn() })
}
