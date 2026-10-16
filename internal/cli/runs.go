package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// wait waits for the first active run to finish and prints its result like ask show.
func wait(p home.Paths, words []string) (int, error) {
	if len(words) != 0 {
		return 0, home.Usage("ask wait takes no arguments")
	}
	return waitAny(p)
}

// waitAny returns the first run that was active when waiting began and then finishes.
func waitAny(p home.Paths) (int, error) {
	active := map[string]bool{}
	for _, r := range runs.All(p) {
		if runs.Owner(r) != 0 {
			active[r.ID] = true
		}
	}
	if len(active) == 0 {
		fmt.Fprintln(os.Stderr, "ask: no runs are running")
		return 0, nil
	}
	for {
		for _, r := range runs.All(p) {
			if !active[r.ID] || runs.Owner(r) != 0 {
				continue
			}
			for i, result := range r.Results {
				if result != nil {
					continue
				}
				ref := runs.Ref(r, i)
				resume := "ask -c " + ref
				if len(r.Tasks) > 1 {
					resume = "ask batch --resume " + r.Label()
				}
				fmt.Fprintf(os.Stderr, "ask %s · stopped · resume: %s\n", ref, resume)
				return 1, nil
			}
			return show(p, home.Object{}, []string{r.ID})
		}
		time.Sleep(250 * time.Millisecond)
	}
}

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
		for _, x := range r.Results {
			w, ok := x.Get("worktree").(home.Object)
			if !ok {
				continue
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

// show prints a saved answer or complete result without running its agent again.
func show(p home.Paths, opts home.Object, words []string) (int, error) {
	if len(words) != 1 {
		return 0, home.Usage("ask show takes one run, like ask show login-checked")
	}
	r, i, e := runs.Open(p, words[0])
	if e != nil {
		return 0, e
	}
	if b, e := os.ReadFile(filepath.Join(r.Dir, "bench.json")); e == nil && !strings.Contains(words[0], "/") {
		report, e := home.ParsePayload(string(b))
		if e != nil {
			return 0, fmt.Errorf("%s: bench.json is damaged: %v", r.Label(), e)
		}
		fmt.Fprintln(os.Stderr, status.StyledLine(status.BatchSaved(r), os.Stderr))
		if opts.B("--json") {
			fmt.Fprintln(os.Stdout, home.JSON(report, true))
		} else {
			fmt.Fprint(os.Stdout, benchTable(report))
		}
		return 0, nil
	}
	if i < 0 {
		fmt.Fprintln(os.Stderr, status.StyledLine(status.BatchSaved(r), os.Stderr))
		fmt.Fprintln(os.Stdout, home.JSON(home.ResultRecords(r.Results), true))
		for _, result := range r.Results {
			if !result.B("ok") {
				return 1, nil
			}
		}
		return 0, nil
	}
	result := r.Results[i]
	if result == nil {
		return 0, home.Usage("%s has not finished; see `ask runs`", words[0])
	}
	fmt.Fprintln(os.Stderr, status.StyledLine(status.Done(result), os.Stderr))
	if opts.B("--json") {
		fmt.Fprintln(os.Stdout, home.JSON(home.ResultRecords([]home.Object{result})[0], true))
	} else if result.B("ok") {
		fmt.Fprintln(os.Stdout, answerText(r.Tasks[i], result))
	}
	if !result.B("ok") {
		return 1, nil
	}
	return 0, nil
}

// stop resolves a run and reports whether its owner was stopped.
func stop(p home.Paths, words []string) (int, error) {
	if len(words) != 1 {
		return 0, home.Usage("ask stop takes one run, like ask stop login-checked")
	}
	r, _, e := runs.Open(p, words[0])
	if e != nil {
		return 0, e
	}
	stopped, e := runs.Stop(r)
	if e != nil {
		return 0, e
	}
	if stopped {
		fmt.Fprintf(os.Stderr, "ask %s · stopped\n", r.Label())
		return 0, nil
	}
	fmt.Fprintf(os.Stderr, "ask %s · not running\n", r.Label())
	return 1, nil
}

// listRuns prints the newest readable records as a status table: in a git repository only
// runs that worked in one of its checkouts, unless --all.
func listRuns(p home.Paths, opts home.Object) (int, error) {
	limit := 20
	if opts.B("-n") {
		n, e := number("-n", opts.S("-n"), true)
		if e != nil {
			return 0, e
		}
		limit = integer(n)
	}
	var keep func(*runs.Run) bool
	dir, _ := os.Getwd()
	if checkouts := git.Checkouts(dir); checkouts != nil && !opts.B("--all") {
		keep = func(r *runs.Run) bool { return runs.In(r, checkouts) }
	}
	list := runs.Recent(p, limit, keep)
	if len(list) == 0 && keep != nil {
		fmt.Fprintln(os.Stderr, "ask: no runs in this repository yet; ask runs --all lists every run")
	} else if len(list) == 0 {
		fmt.Fprintln(os.Stderr, "ask: no runs yet")
	} else {
		fmt.Fprintln(os.Stdout, status.Table(list, time.Now(), status.CanStyle(os.Stdout)))
	}
	return 0, nil
}
