// Package clean is ask clean: remove old sessions and worktrees whose branch changed nothing or
// landed. Worktrees that a live session, a lock, a nested worktree, or uncommitted or unlanded
// work may still need are kept.
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
	{Title: "ARGUMENTS", Body: `Shows the plan, then asks. A worktree with a live session, a git lock, a nested worktree, or
uncommitted or unlanded work stays, and so does its session.`},
	{Title: "FLAGS", Body: `    --days <n>              Remove sessions inactive for longer than this (default 30)
    --dry-run               Only show the plan
-y, --yes                   Do not ask
    --contained             Also remove work whose commits another branch still holds;
                            the worktree goes and its branch stays
    --superseded            Also remove work a main branch already matches after a rework`},
}}

// plan is what clean will do with one session: whether its worktree stays, goes, or has no
// worktree anymore, and why.
type plan struct {
	s          *sessions.Session
	why        string // why the worktree stays or goes
	tree       bool   // it has a worktree that still exists
	running    bool   // its session still holds its lock
	keep       bool   // the worktree stays
	remove     bool   // the worktree goes
	branchOnly bool   // the worktree goes, its branch stays
	removed    bool   // its worktree was removed
}

// Run removes old finished sessions and landed worktrees. A session whose worktree stays is kept.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "days", Value: true}, {Long: "dry-run"}, {Long: "yes", Short: "y"}, {Long: "contained"}, {Long: "superseded"}})
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
	plans := []plan{}
	for _, s := range sessions.All(p) {
		pl := plan{s: s, running: sessions.Owner(s) != 0 || starting(s)}
		if w := s.Worktree; w != nil {
			if _, err := os.Stat(w.Path); err == nil {
				pl.tree = true
				classify(&pl, w, opts.B("contained"), opts.B("superseded"))
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
		if pl.tree {
			w := pl.s.Worktree
			switch {
			case pl.keep:
				fmt.Fprintf(os.Stdout, "keep    %s  %s · %s\n", config.Tilde(w.Path), w.Branch, pl.why)
			case pl.branchOnly:
				fmt.Fprintf(os.Stdout, "remove  %s  %s · %s (branch kept)\n", config.Tilde(w.Path), w.Branch, pl.why)
				trees++
			default:
				fmt.Fprintf(os.Stdout, "remove  %s  %s · %s\n", config.Tilde(w.Path), w.Branch, pl.why)
				trees++
			}
		}
		if !pl.keep && !pl.running && old(pl.s) {
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
	code := 0
	for i := range plans {
		pl := &plans[i]
		if !pl.remove {
			continue
		}
		w := pl.s.Worktree
		// A session may have started since the plan; never remove a worktree under it.
		if live(pl.s.Folder) {
			fmt.Fprintf(os.Stderr, "ask: kept %s; its session is running\n", config.Tilde(w.Path))
			continue
		}
		if pl.branchOnly {
			if !git.RemoveWorktreeOnly(w.Path) {
				fmt.Fprintf(os.Stderr, "ask: could not remove %s\n", config.Tilde(w.Path))
				code = 1
				continue
			}
			fmt.Fprintf(os.Stderr, "ask: removed %s; kept %s for review\n", config.Tilde(w.Path), w.Branch)
		} else {
			if !git.Remove(w.Path, w.Branch) {
				fmt.Fprintf(os.Stderr, "ask: could not remove %s\n", config.Tilde(w.Path))
				code = 1
				continue
			}
			fmt.Fprintf(os.Stderr, "ask: removed %s and %s\n", config.Tilde(w.Path), w.Branch)
		}
		pl.removed = true
	}
	gone := 0
	for _, pl := range plans {
		if pl.keep || pl.running || !old(pl.s) || (pl.tree && !pl.removed) {
			continue
		}
		// A session may have started a turn since the plan; keep its record then.
		if live(pl.s.Folder) {
			continue
		}
		if os.RemoveAll(pl.s.Folder) == nil {
			gone++
		} else {
			code = 1
		}
	}
	if gone > 0 {
		fmt.Fprintf(os.Stderr, "ask: removed %s\n", count(gone, "session"))
	}
	return code, nil
}

// starting reports whether a session's latest turn still claims to run but has not taken its
// lock yet. ask creates the session before its worker locks it, and clean must not race that
// short window; an interrupted turn is past the grace after two minutes.
func starting(s *sessions.Session) bool {
	if s.Turn().State != "running" || sessions.Owner(s) != 0 {
		return false
	}
	started, err := time.Parse(time.RFC3339, s.Updated())
	return err == nil && time.Since(started) < 2*time.Minute
}

// live reports whether a session still holds its lock or is still starting. It loads the record
// again, so a turn added since the plan is seen. Unreadable records count as live.
func live(folder string) bool {
	s, err := sessions.Load(folder)
	if err != nil {
		return true
	}
	return sessions.Owner(s) != 0 || starting(s)
}

// classify decides whether a session's worktree stays or goes. A live session, a lock, a nested
// worktree, and dirty work always stay; landed work goes, and the opt-in flags allow the two
// cases where commits or reworked files may still matter.
func classify(pl *plan, w *sessions.Worktree, contained, superseded bool) {
	if pl.running {
		pl.keep, pl.why = true, "session running"
		return
	}
	if locked, reason := git.Locked(w.Path); locked {
		pl.keep, pl.why = true, "in use ("+reason+")"
		return
	}
	if git.Nested(w.Path) {
		pl.keep, pl.why = true, "contains a nested worktree"
		return
	}
	tracked, untracked, readable := git.DirtyCounts(w.Path)
	if !readable {
		pl.keep, pl.why = true, "git cannot read it"
		return
	}
	if tracked+untracked > 0 {
		pl.keep, pl.why = true, fmt.Sprintf("uncommitted: %d tracked, %d untracked", tracked, untracked)
		return
	}
	landed, why := git.Landed(w.Path, w.Branch)
	if landed {
		pl.remove, pl.why = true, why
		return
	}
	if container, ok := git.Contained(w.Path, w.Branch); ok {
		if contained {
			pl.remove, pl.branchOnly, pl.why = true, true, "contained in "+container
		} else {
			pl.keep, pl.why = true, "contained in "+container+"; use --contained"
		}
		return
	}
	if likely, why := git.LikelyLanded(w.Path, w.Branch); likely {
		if superseded {
			pl.remove, pl.why = true, why
		} else {
			pl.keep, pl.why = true, why+"; use --superseded"
		}
		return
	}
	pl.keep, pl.why = true, why
}

// count formats a number of things with a plural s when needed.
func count(n int, thing string) string {
	if n == 1 {
		return "1 " + thing
	}
	return fmt.Sprintf("%d %ss", n, thing)
}
