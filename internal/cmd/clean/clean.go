// Package clean is ask clean: remove old sessions and worktrees whose branch changed nothing or landed.
package clean

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/sessions"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Remove old sessions and worktrees whose branch changed nothing or landed.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask clean [flags]"},
	{Title: "ARGUMENTS", Body: "Shows the plan, then asks. A worktree with uncommitted or unmerged work stays, and so does its session."},
	{Title: "FLAGS", Body: `    --days <n>              Remove sessions inactive for longer than this (default 30)
    --dry-run               Only show the plan
-y, --yes                   Do not ask`},
}}

// Run removes old finished sessions and landed worktrees. A session whose worktree stays is kept.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "days", Value: true}, {Long: "dry-run"}, {Long: "yes", Short: "y"}})
	if err != nil {
		return 0, err
	}
	if len(words) != 0 {
		return 0, config.Usage("ask clean takes no arguments; see ask help clean")
	}
	days, err := cmdutil.Number(opts, "days", "a number of days")
	if err != nil {
		return 0, err
	}
	if !opts.Has("days") {
		days = 30
	}
	cutoff := time.Now().Add(-time.Duration(days * 24 * float64(time.Hour)))
	type plan struct {
		s    *sessions.Session
		keep string // why its worktree stays; "" when it goes or there is none
		tree bool   // it has a worktree that still exists
	}
	plans := []plan{}
	for _, s := range sessions.All(p) {
		if s.State() == "running" {
			continue
		}
		pl := plan{s: s}
		if w := s.Worktree; w != nil {
			if _, err := os.Stat(w.Path); err == nil {
				pl.tree = true
				if landed, why := git.Landed(w.Path, w.Branch); !landed {
					pl.keep = why
				}
			}
		}
		plans = append(plans, pl)
	}
	old := func(s *sessions.Session) bool {
		updated, _ := time.Parse(time.RFC3339, s.Updated())
		return updated.Before(cutoff)
	}
	trees, stale := 0, 0
	for _, pl := range plans {
		if !pl.tree {
			continue
		}
		w := pl.s.Worktree
		if pl.keep != "" {
			fmt.Fprintf(os.Stdout, "keep    %s  %s · %s\n", config.Tilde(w.Path), w.Branch, pl.keep)
			continue
		}
		fmt.Fprintf(os.Stdout, "remove  %s  %s\n", config.Tilde(w.Path), w.Branch)
		trees++
	}
	for _, pl := range plans {
		if pl.keep == "" && old(pl.s) {
			stale++
		}
	}
	if stale > 0 {
		fmt.Fprintf(os.Stdout, "remove  %d sessions inactive for more than %s days\n", stale, config.Fixed(days, 0))
	}
	if trees == 0 && stale == 0 {
		fmt.Fprintln(os.Stdout, "nothing to remove")
		return 0, nil
	}
	if opts.B("dry-run") {
		return 0, nil
	}
	if !opts.B("yes") {
		fmt.Fprint(os.Stderr, "remove? [y/N] ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if a := strings.ToLower(config.Trim(line)); a != "y" && a != "yes" {
			return 1, nil
		}
	}
	for _, pl := range plans {
		if pl.keep != "" {
			continue
		}
		if pl.tree && !git.Remove(pl.s.Worktree.Path, pl.s.Worktree.Branch) {
			fmt.Fprintf(os.Stderr, "ask: could not remove %s\n", pl.s.Worktree.Path)
			continue
		}
		if old(pl.s) {
			_ = os.RemoveAll(pl.s.Folder)
		}
	}
	return 0, nil
}
