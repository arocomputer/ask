package cli

import (
	"fmt"
	"os"

	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/runs"
)

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
