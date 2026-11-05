// Package show is ask show: the current state and recent activity of a session, without waiting.
package show

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/sessions"
	"github.com/arocomputer/ask/internal/term"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "The current state and recent activity of a session, without waiting.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask show <id> [flags]"},
	{Title: "ARGUMENTS", Body: "The status line and recent activity go to stderr; the answer, once finished, to stdout."},
	{Title: "FLAGS", Body: `    --follow                Keep printing activity until the turn ends (interrupting leaves the session going)
    --after <cursor>        One JSON page of events from a byte cursor; 0 first, then next_cursor
    --json                  The result record`},
	{Title: "EXAMPLES", Body: "$ ask show k3f9a2\n$ ask show k3f9a2 --follow\n$ ask show k3f9a2 --after 0"},
}}

// Run inspects a session now: readable activity, a result record, a page of events after a
// cursor, or a live follow until the turn ends.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "json"}, {Long: "after", Value: true}, {Long: "follow"}})
	if err != nil {
		return 0, err
	}
	if len(words) != 1 {
		return 0, config.Usage("ask show takes one session ID, like ask show k3f9a2")
	}
	r, err := sessions.Open(p, words[0])
	if err != nil {
		return 0, err
	}
	modes := 0
	for _, m := range []string{"json", "after", "follow"} {
		if opts.Has(m) {
			modes++
		}
	}
	if modes > 1 {
		return 0, config.Usage("choose one of --json, --after or --follow")
	}
	if opts.Has("after") {
		cursor, err := strconv.ParseInt(opts.S("after"), 10, 64)
		if err != nil || cursor < 0 {
			return 0, config.Usage("--after needs a byte cursor: 0 first, then next_cursor")
		}
		page, err := sessions.Events(r, cursor, false)
		if err != nil {
			return 0, err
		}
		page.State = r.State()
		fmt.Fprintln(os.Stdout, config.JSON(page, false))
		return 0, nil
	}
	if opts.B("json") {
		return cmdutil.Print(r, true)
	}
	s := term.Styled(os.Stderr)
	cursor := int64(0)
	first := true
	for {
		if err := r.Reload(); err != nil {
			return 0, err
		}
		page, err := sessions.Events(r, cursor, first)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ask: activity unavailable: "+err.Error())
		} else {
			for _, e := range page.Events {
				printEvent(s, e)
			}
			cursor = page.NextCursor
			if page.HasMore {
				continue
			}
		}
		first = false
		if r.State() != "running" {
			return cmdutil.Print(r, false)
		}
		if !opts.B("follow") {
			fmt.Fprintln(os.Stderr, term.Line(r, s))
			return 0, nil
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// printEvent renders one event for a person: a dimmed label, then the text, indented.
func printEvent(s term.Style, e sessions.Event) {
	label := e.Type
	if e.Tool != "" {
		label += " " + e.Tool
	}
	text := term.Safe(strings.ReplaceAll(e.Text, "\n", "\n  "))
	if n := []rune(text); len(n) > 1000 {
		text = string(n[:1000]) + "…"
	}
	fmt.Fprintf(os.Stderr, "%s: %s\n", s.Dim(label), text)
}
