// Package sessions is ask sessions: list sessions, most recently active first.
package sessions

import (
	"fmt"
	"os"
	"strconv"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/term"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "List sessions, most recently active first.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask sessions [flags]"},
	{Title: "ARGUMENTS", Body: `Without --all: the sessions started by this conversation when the host identifies it
(ASK_PARENT, Claude Code or Codex), otherwise those started in or working in this repository.
On a terminal the list is a table; piped, it is tab-separated without a header.`},
	{Title: "FLAGS", Body: `    --all                   Every session
-n, --limit <n>             How many (default 20)
    --json                  Result records`},
}}

// Run prints sessions: the caller's own, or everyone's with --all.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "all"}, {Long: "json"}, {Long: "limit", Short: "n", Value: true}})
	if err != nil {
		return 0, err
	}
	if len(words) != 0 {
		return 0, config.Usage("ask sessions takes no arguments; see ask help sessions")
	}
	limit, err := cmdutil.Number(opts, "limit", "a number of sessions")
	if err != nil {
		return 0, err
	}
	if limit == 0 {
		limit = 20
	}
	list := cmdutil.Scope(p, opts.B("all"))
	if len(list) > int(limit) {
		list = list[:int(limit)]
	}
	if opts.B("json") {
		out := []cmdutil.Result{}
		for _, s := range list {
			out = append(out, cmdutil.ToResult(s))
		}
		fmt.Fprintln(os.Stdout, config.JSON(out, true))
		return 0, nil
	}
	st := term.Styled(os.Stdout)
	if len(list) == 0 {
		if st.On {
			fmt.Fprintln(os.Stderr, "No sessions yet. ask sessions --all lists every session; ask \"task\" starts one.")
		}
		return 0, nil
	}
	rows := [][]string{}
	for _, s := range list {
		t := s.Turn()
		state := s.State()
		elapsed := ""
		if state != "running" && t.Seconds > 0 {
			elapsed = term.Duration(t.Seconds)
		}
		access := "read"
		if t.Write {
			access = "write"
		}
		updated := term.Ago(s.Updated())
		if !st.On {
			updated = s.Updated()
		}
		rows = append(rows, []string{s.ID, updated, state, strconv.Itoa(len(s.Turns)), access, term.TurnModel(t), elapsed, term.Safe(cmdutil.FirstLine(s.Turns[0].Prompt))})
	}
	fmt.Fprint(os.Stdout, term.Table(st, []string{"id", "updated", "state", "turns", "access", "model", "time", "task"}, rows, func(column int, text string) string {
		switch column {
		case 0:
			return st.Bold(text)
		case 2:
			return st.State(text)
		case 1, 3, 6:
			return st.Dim(text)
		}
		return text
	}))
	return 0, nil
}
