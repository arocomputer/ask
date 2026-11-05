// Package stop is ask stop: stop a session's turn and everything it started.
package stop

import (
	"fmt"
	"os"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/sessions"
	"github.com/arocomputer/ask/internal/term"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Stop a session's turn and everything it started.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask stop <id>"},
	{Title: "ARGUMENTS", Body: "Exit 1 when it was not running."},
}}

// Run stops a session's turn and reports whether it was running.
func Run(p config.Paths, args []string) (int, error) {
	_, words, err := cmdutil.Parse(args, nil)
	if err != nil {
		return 0, err
	}
	if len(words) != 1 {
		return 0, config.Usage("ask stop takes one session ID, like ask stop k3f9a2")
	}
	r, err := sessions.Open(p, words[0])
	if err != nil {
		return 0, err
	}
	stopped, err := sessions.Stop(r)
	if err != nil {
		return 0, err
	}
	if stopped {
		_ = r.Reload()
		fmt.Fprintln(os.Stderr, term.Line(r, term.Styled(os.Stderr)))
		return 0, nil
	}
	if st := term.Styled(os.Stderr); st.On {
		fmt.Fprintf(os.Stderr, "%s %s is not running\n", st.Dim("-"), st.Bold(r.ID))
	} else {
		fmt.Fprintf(os.Stderr, "ask %s · not running\n", r.ID)
	}
	return 1, nil
}
