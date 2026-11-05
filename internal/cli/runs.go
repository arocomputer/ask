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

// wait pins all references before polling. Explicit sets include saved completions; without
// references it snapshots active runs in this repository (or current directory outside git).
// JSON emits null for an empty scope, or one runResult; failed/stopped selections exit 1.
func wait(p home.Paths, opts home.Object, words []string) (int, error) {
	if opts.B("--id") && opts.B("--json") {
		return 0, home.Usage("choose one of --id or --json")
	}
	type selection struct {
		r   *runs.Run
		i   int
		ref string
	}
	selected := []selection{}
	for _, ref := range words {
		r, i, err := runs.Open(p, ref)
		if err != nil {
			return 0, err
		}
		selected = append(selected, selection{r, i, ref})
	}
	if len(words) == 0 {
		dir, err := os.Getwd()
		if err != nil {
			return 0, err
		}
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			dir = real
		}
		checkouts := git.Checkouts(dir)
		if checkouts == nil {
			checkouts = []string{dir}
		}
		for _, r := range runs.All(p) {
			if runs.In(r, checkouts) && runs.Owner(r) != 0 {
				i := -1
				if len(r.Tasks) == 1 {
					i = 0
				}
				selected = append(selected, selection{r, i, r.ID})
			}
		}
		if len(selected) == 0 {
			if opts.B("--json") {
				fmt.Fprintln(os.Stdout, "null")
			}
			fmt.Fprintln(os.Stderr, "ask: no runs are running")
			return 0, nil
		}
	}
	for {
		for at := range selected {
			s := &selected[at]
			// Read pending state before results so an attempt cannot return its earlier failure.
			owner := runs.Owner(s.r)
			pending, known := runs.Pending(s.r, owner)
			r, _, err := runs.Open(p, s.r.Dir)
			if err != nil {
				return 0, err
			}
			if runs.Owner(r) != owner {
				continue
			}
			s.r = r
			unfinished := -1
			for i, result := range r.Results {
				if (s.i < 0 || i == s.i) && (result == nil || known && pending[i]) {
					unfinished = i
					break
				}
			}
			if unfinished < 0 && (owner == 0 || s.i >= 0 && known && !pending[s.i]) {
				if opts.B("--json") {
					return printRunResult(r, status.Record(r, owner, pending, known), s.i)
				}
				if opts.B("--id") {
					fmt.Fprintln(os.Stdout, waitID(r, s.i))
					if s.i < 0 {
						fmt.Fprintln(os.Stderr, status.StyledLine(status.BatchSaved(r), os.Stderr))
					} else {
						fmt.Fprintln(os.Stderr, status.StyledLine(status.Done(r.Results[s.i]), os.Stderr))
					}
					for i, result := range r.Results {
						if (s.i < 0 || i == s.i) && !result.B("ok") {
							return 1, nil
						}
					}
					return 0, nil
				}
				if len(selected) > 1 {
					fmt.Fprintln(os.Stderr, "ask: completed "+waitID(r, s.i))
				}
				return showRun(r, home.Object{}, s.ref, s.i)
			}
			if owner == 0 {
				if opts.B("--json") {
					return printRunResult(r, status.Record(r, owner, pending, known), s.i)
				}
				if len(selected) > 1 && !opts.B("--id") {
					fmt.Fprintln(os.Stderr, "ask: completed "+waitID(r, s.i))
				}
				if opts.B("--id") {
					fmt.Fprintln(os.Stdout, waitID(r, s.i))
				}
				ref := runs.Ref(r, unfinished)
				rerun := r.Label()
				if s.i >= 0 && len(r.Tasks) > 1 {
					rerun = ref
				}
				fmt.Fprintf(os.Stderr, "ask %s · stopped · continue: ask continue %s\n", ref, rerun)
				if _, err := os.Stat(filepath.Join(r.Dir, "worker.log")); err == nil {
					fmt.Fprintln(os.Stderr, "ask: worker lifecycle log: "+filepath.Join(r.Dir, "worker.log"))
				}
				return 1, nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// A separate numeric position avoids pretending ID/POSITION is an unambiguous task reference:
// saved numeric task IDs take precedence over positional references.
func waitID(r *runs.Run, i int) string {
	if i >= 0 && len(r.Tasks) > 1 {
		return fmt.Sprintf("%s\t%d", r.ID, i+1)
	}
	return r.ID
}

// runSnapshot samples pending before reloading results, then checks ownership again.
// This prevents a retry's saved failure from masquerading as its current completion.
func runSnapshot(p home.Paths, r *runs.Run) (*runs.Run, status.RunRecord, error) {
	for {
		owner := runs.Owner(r)
		pending, known := runs.Pending(r, owner)
		fresh, _, err := runs.Open(p, r.Dir)
		if err != nil {
			return nil, status.RunRecord{}, err
		}
		if runs.Owner(fresh) == owner {
			return fresh, status.Record(fresh, owner, pending, known), nil
		}
	}
}

// runResult wraps wait output without changing show's existing full-result contract.
// A batch's results retain their positions, with null for unfinished or stale attempts.
type runResult struct {
	RunID    string               `json:"run_id"`
	Name     string               `json:"name,omitempty"`
	State    string               `json:"state"`
	Position int                  `json:"position,omitempty"`
	TaskID   string               `json:"task_id,omitempty"`
	Result   *home.ResultRecord   `json:"result,omitempty"`
	Results  []*home.ResultRecord `json:"results,omitempty"`
}

func printRunResult(r *runs.Run, record status.RunRecord, i int) (int, error) {
	out := runResult{RunID: r.ID, Name: r.Name, State: record.State}
	results := make([]home.Object, len(r.Tasks))
	for at, task := range record.Tasks {
		if task.State == "success" || task.State == "failed" {
			results[at] = r.Results[at]
		}
	}
	saved := home.ResultRecords(results)
	if i >= 0 {
		task := record.Tasks[i]
		out.State, out.Position, out.TaskID, out.Result = task.State, task.Position, task.TaskID, saved[i]
	} else {
		out.Results = saved
	}
	fmt.Fprintln(os.Stdout, home.JSON(out, true))
	if out.State != "success" {
		return 1, nil
	}
	return 0, nil
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

// show inspects activity or a saved result without running its agent again.
// Existing --json results retain their format and exit status; --after returns an activity page.
func show(p home.Paths, opts home.Object, words []string) (int, error) {
	if len(words) != 1 {
		return 0, home.Usage("ask show takes one run, like ask show login-checked")
	}
	if opts.B("--follow") && (opts.B("--json") || opts.Has("--after")) {
		return 0, home.Usage("--follow supports readable output only; choose --after for cursor JSON")
	}
	r, i, e := runs.Open(p, words[0])
	if e != nil {
		return 0, e
	}
	if opts.Has("--after") {
		return showAfter(p, r, i, opts.S("--after"))
	}
	if !opts.B("--json") {
		return showActivity(p, r, i, words[0], opts.B("--follow"))
	}
	if opts.B("--json") {
		fresh, record, err := runSnapshot(p, r)
		if err != nil {
			return 0, err
		}
		r = fresh
		state := record.State
		if i >= 0 {
			state = record.Tasks[i].State
		}
		if state == "running" || state == "stopped" {
			return printRunResult(r, record, i)
		}
	}
	return showRun(r, opts, words[0], i)
}

// showRun keeps saved answer and status output identical for show and targeted wait.
func showRun(r *runs.Run, opts home.Object, ref string, i int) (int, error) {
	if b, e := os.ReadFile(filepath.Join(r.Dir, "bench.json")); e == nil && !strings.Contains(ref, "/") {
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
		return 0, home.Usage("%s has not finished; see `ask runs`", ref)
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

// listRuns prints the newest readable records as a status table or machine metadata: in a
// git repository only runs that worked in one of its checkouts, unless --all.
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
	if opts.B("--json") {
		records := make([]status.RunRecord, 0, len(list))
		for _, r := range list {
			_, record, err := runSnapshot(p, r)
			if err != nil {
				return 0, err
			}
			records = append(records, record)
		}
		fmt.Fprintln(os.Stdout, home.JSON(records, true))
		return 0, nil
	}
	if len(list) == 0 && keep != nil {
		fmt.Fprintln(os.Stderr, "ask: no runs in this repository yet; ask runs --all lists every run")
	} else if len(list) == 0 {
		fmt.Fprintln(os.Stderr, "ask: no runs yet")
	} else {
		fmt.Fprintln(os.Stdout, status.Table(list, time.Now(), status.CanStyle(os.Stdout)))
	}
	return 0, nil
}
