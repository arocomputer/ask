package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/runs"
	"github.com/arocomputer/ask/src/status"
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
		if task.State == "succeeded" || task.State == "failed" {
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
	if out.State != "succeeded" {
		return 1, nil
	}
	return 0, nil
}
