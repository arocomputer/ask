// Package run is ask run: start a session and print its ID.
package run

import (
	"os"

	"github.com/arocomputer/ask/internal/cmd/worker"
	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/sessions"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Start a session and print its ID.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask [run] [flags] <prompt>"},
	{Title: "ARGUMENTS", Body: "The prompt is the words after the flags, or stdin when there are none or the prompt is -."},
	{Title: "FLAGS", Body: `-m, --model <model>         provider/model for ask's own harness, harness:model for an external
                            one, either plus #effort (ask models); default: the model in config
-w, --write                 Allow editing files and running commands (default: read-only)
    --worktree              Work in a fresh git worktree and branch (implies --write)
-C, --directory <dir>       Where to work (default: the current directory)
-t, --timeout <seconds>     Stop the turn after this long (default: 900, or timeout in config)
    --max-cost <usd>        Stop when the cost passes this (default: max_cost in config)
    --schema <file>         The answer must be JSON matching this JSON Schema (- for stdin)
    --stdin                 Append stdin to the argument prompt, after a blank line
    --wait                  Wait and print the answer instead of the ID; exit 1 if it fails
    --json                  {"session_id","turn","state"} at launch, or the result with --wait`},
	{Title: "EXAMPLES", Body: `$ ask "Where is the retry logic?"
$ ask -w --worktree "Add rate limiting to the login route."
$ ask --wait -m opencode-go/glm-5.3#high "Summarize src/."
$ ask -m claude:sonnet-5.5 "Second opinion on the design."`},
}}

var flags = append([]cmdutil.Flag{{Long: "worktree"}, {Long: "directory", Short: "C", Value: true}}, cmdutil.LaunchFlags...)

// Run creates a session from the command line and launches its first turn.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, flags)
	if err != nil {
		return 0, err
	}
	cfg, err := p.ReadConfig()
	if err != nil {
		return 0, err
	}
	m, err := cmdutil.Resolve(p, cfg, opts.S("model"))
	if err != nil {
		return 0, err
	}
	prompt, err := cmdutil.ReadPrompt(words, opts.B("stdin"))
	if err != nil {
		return 0, err
	}
	t := sessions.Turn{Prompt: prompt, Model: m.Spec, Effort: m.Effort, Write: opts.B("write") || opts.B("worktree")}
	if err := cmdutil.Limits(&t, opts, cfg); err != nil {
		return 0, err
	}
	if opts.Has("schema") {
		if t.Schema, err = cmdutil.ReadSchema(opts.S("schema")); err != nil {
			return 0, err
		}
	}
	dir, err := cmdutil.WorkDir(opts.S("directory"))
	if err != nil {
		return 0, err
	}
	origin, err := os.Getwd()
	if err != nil {
		origin = dir
	}
	rec := sessions.Record{Parent: sessions.Parent(), Dir: dir, Origin: origin, Turns: []sessions.Turn{t}}
	var fresh *git.Worktree
	if t.Write && (opts.B("worktree") || cfg.B("worktree")) {
		if fresh, err = git.Add(p, dir, cmdutil.Slug(prompt, sessions.NewID()), nil); err != nil {
			return 0, err
		}
		rec.Worktree = &sessions.Worktree{Path: fresh.Path, Branch: fresh.Branch}
		rec.Dir = fresh.Dir
	}
	undo := func() {
		if fresh != nil {
			// Nothing ran in it, so nothing is lost.
			git.Remove(fresh.Path, fresh.Branch)
		}
	}
	s, err := sessions.Create(p, rec)
	if err != nil {
		undo()
		return 0, err
	}
	return worker.Launch(p, s, opts.B("wait"), opts.B("json"), func() { _ = os.RemoveAll(s.Folder); undo() })
}
