package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/process"
	"github.com/arocomputer/ask/src/runs"
	"github.com/arocomputer/ask/src/status"
	"github.com/arocomputer/ask/src/tui"
)

// kept is a worktree a run left behind, with whether it can go and why.
type kept struct {
	Path, Branch, Why string
	Landed            bool
}

// cleanPlan finds the worktrees runs left behind and the finished runs older than days.
func cleanPlan(p home.Paths, days float64) ([]kept, []*runs.Run) {
	worktrees, old := []kept{}, []*runs.Run{}
	seen := map[string]bool{}
	cutoff := time.Now().Add(-time.Duration(days * 24 * float64(time.Hour)))
	for _, r := range runs.All(p) {
		holds := false
		for i, x := range r.Results {
			w, ok := x.Get("worktree").(home.Object)
			if !ok {
				if kept := runs.InterruptedWorktree(r, i); kept != nil {
					w = home.O("path", kept.Path, "branch", kept.Branch)
				} else {
					continue
				}
			}
			path := w.S("path")
			if info, e := os.Stat(path); e != nil || !info.IsDir() {
				continue
			}
			holds = true
			if seen[path] {
				continue
			}
			seen[path] = true
			landed, why := git.Landed(path, w.S("branch"))
			worktrees = append(worktrees, kept{path, w.S("branch"), why, landed})
		}
		created, e := time.Parse("20060102T150405", r.Created[:min(15, len(r.Created))])
		if e == nil && created.Before(cutoff) && runs.Owner(r) == 0 && !holds {
			old = append(old, r)
		}
	}
	return worktrees, old
}

// clean removes worktrees whose work has landed and old run records, after showing the plan:
// in a terminal it asks first; elsewhere it needs --yes. --dry-run only shows the plan.
func clean(p home.Paths, opts home.Object) (int, error) {
	days := 30.0
	if opts.Has("--days") {
		n, e := number("--days", opts.S("--days"), false)
		if e != nil {
			return 0, e
		}
		days = n
	}
	worktrees, old := cleanPlan(p, days)
	color := status.CanStyle(os.Stdout)
	paint := func(code, s string) string {
		if color {
			return "\x1b[" + code + "m" + s + "\x1b[0m"
		}
		return s
	}
	removing := 0
	if len(worktrees) > 0 {
		fmt.Fprintln(os.Stdout, "Worktrees")
		for _, w := range worktrees {
			action := paint("2", "keep  ")
			if w.Landed {
				action = paint("31", "remove")
				removing++
			}
			fmt.Fprintf(os.Stdout, "  %s  %s  %s\n", action, home.Tilde(w.Path), paint("2", w.Branch+" · "+w.Why))
		}
	}
	if len(old) > 0 {
		fmt.Fprintf(os.Stdout, "Runs\n  %s  %s older than %s days\n", paint("31", "remove"), status.Plural(len(old), "run"), home.String(days))
		removing += len(old)
	}
	if removing == 0 {
		fmt.Fprintln(os.Stderr, "ask: nothing to clean")
		return 0, nil
	}
	if opts.B("--dry-run") {
		return 0, nil
	}
	if !opts.B("--yes") {
		if !status.IsTerminal(os.Stdin) || !status.IsTerminal(os.Stdout) {
			fmt.Fprintln(os.Stderr, "ask: run ask clean --yes to remove these")
			return 0, nil
		}
		t := &tui.Prompter{In: os.Stdin, Out: os.Stdout, Color: color, Unicode: status.UTF8(), OnStop: process.OnStop}
		yes, e := t.Confirm("Remove them?", true)
		if e != nil || !yes {
			return 0, nil
		}
	}
	code := 0
	for _, w := range worktrees {
		if !w.Landed {
			continue
		}
		if git.Remove(&git.Worktree{Path: w.Path, Branch: w.Branch}) {
			fmt.Fprintf(os.Stderr, "ask: removed %s and %s\n", home.Tilde(w.Path), w.Branch)
		} else {
			fmt.Fprintf(os.Stderr, "ask: git would not remove %s; left it\n", home.Tilde(w.Path))
			code = 1
		}
	}
	gone := 0
	for _, r := range old {
		if runs.Delete(r) == nil {
			gone++
		}
	}
	if gone > 0 {
		fmt.Fprintf(os.Stderr, "ask: removed %s\n", status.Plural(gone, "run"))
	}
	if gone < len(old) {
		code = 1
	}
	return code, nil
}
