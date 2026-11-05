package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/runs"
	"github.com/arocomputer/ask/src/status"
)

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
