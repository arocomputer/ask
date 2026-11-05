// Package wait is ask wait: wait for a session's latest turn and print its answer.
package wait

import (
	"fmt"
	"os"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/sessions"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Wait for a session's latest turn and print its answer.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask wait [<id>...] [flags]"},
	{Title: "ARGUMENTS", Body: `With several IDs the first to finish wins and stderr says which; already finished sessions return
at once. Without IDs it waits for the first of your active sessions. Exit 1 when the turn failed or
was stopped.`},
	{Title: "FLAGS", Body: "    --json                  The result record instead of the answer"},
	{Title: "EXAMPLES", Body: "$ ask wait k3f9a2\n$ ask wait k3f9a2 b7x01q\n$ ask wait k3f9a2 --json | jq .answer"},
}}

// Run waits for the first of the given sessions, or of the caller's active ones, to finish.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "json"}})
	if err != nil {
		return 0, err
	}
	selected := []*sessions.Session{}
	for _, id := range words {
		r, err := sessions.Open(p, id)
		if err != nil {
			return 0, err
		}
		selected = append(selected, r)
	}
	if len(words) == 0 {
		for _, r := range cmdutil.Scope(p, false) {
			if r.State() == "running" {
				selected = append(selected, r)
			}
		}
		if len(selected) == 0 {
			if opts.B("json") {
				fmt.Fprintln(os.Stdout, "null")
			}
			fmt.Fprintln(os.Stderr, "ask: no sessions are running")
			return 0, nil
		}
	}
	return cmdutil.Wait(selected, opts.B("json"))
}
