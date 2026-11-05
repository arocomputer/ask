package cmdutil

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/provider"
	"github.com/arocomputer/ask/internal/sessions"
	"github.com/arocomputer/ask/internal/term"
)

// Result is a session as commands print it with --json: the session and its latest turn's
// outcome, without the prompts.
type Result struct {
	SessionID      string             `json:"session_id"`
	Turn           int                `json:"turn"`
	State          string             `json:"state"`
	Model          string             `json:"model"`
	Write          bool               `json:"write"`
	Dir            string             `json:"dir"`
	Parent         string             `json:"parent,omitempty"`
	Created        string             `json:"created"`
	Updated        string             `json:"updated"`
	Seconds        float64            `json:"seconds,omitempty"`
	Usage          *sessions.Usage    `json:"usage,omitempty"`
	Answer         string             `json:"answer,omitempty"`
	Error          string             `json:"error,omitempty"`
	Changes        []sessions.Change  `json:"changes,omitempty"`
	Commits        int                `json:"commits,omitempty"`
	Worktree       *sessions.Worktree `json:"worktree,omitempty"`
	Task           string             `json:"task"`
	Activity       *sessions.Event    `json:"activity,omitempty"`
	HarnessSession string             `json:"harness_session,omitempty"`
}

// ToResult builds the printable record for a session's latest turn.
func ToResult(s *sessions.Session) Result {
	t := s.Turn()
	state := s.State()
	out := Result{SessionID: s.ID, Turn: len(s.Turns), State: state, Model: t.Model, Write: t.Write, Dir: s.Dir, Parent: s.Parent,
		Created: s.Created, Updated: s.Updated(), Seconds: t.Seconds, Usage: t.Usage, Changes: t.Changes, Commits: t.Commits,
		Worktree: s.Worktree, Task: FirstLine(s.Turns[0].Prompt), HarnessSession: s.HarnessSession}
	switch state {
	case "succeeded":
		out.Answer = t.Answer
	case "stopped":
		out.Error = "stopped"
	case "failed":
		out.Error = t.Error
	case "running":
		if page, err := sessions.Events(s, 0, true); err == nil && len(page.Events) > 0 {
			last := page.Events[len(page.Events)-1]
			out.Activity = &last
		}
	}
	return out
}

// FirstLine is a prompt's first line, clipped, as listings show it.
func FirstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	if n := []rune(line); len(n) > 80 {
		return string(n[:80]) + "…"
	}
	return line
}

// Scope returns the sessions the caller sees by default, most recently active first: its own
// when the host identifies the conversation, else those started in or working in the current
// repository (or directory). all is everyone's.
func Scope(p config.Paths, all bool) []*sessions.Session {
	every := sessions.All(p)
	out := []*sessions.Session{}
	parent := sessions.Parent()
	var checkouts []string
	if !all && parent == "" {
		dir, err := os.Getwd()
		if err != nil {
			return out
		}
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			dir = real
		}
		if checkouts = git.Checkouts(dir); checkouts == nil {
			checkouts = []string{dir}
		}
	}
	for _, s := range every {
		switch {
		case all:
		case parent != "" && s.Parent != parent:
			continue
		case parent == "" && !s.In(checkouts):
			continue
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated() > out[j].Updated() })
	return out
}

// Wait polls until the latest turn of one of the sessions finishes, then prints it: the answer
// on stdout and the status line on stderr, or the result record with json. Exit 1 unless it
// succeeded.
//
// On a terminal it redraws one status line in place meanwhile, its spinner turning.
func Wait(selected []*sessions.Session, asJSON bool) (int, error) {
	st := term.Styled(os.Stderr)
	clear := func() {}
	for frame := 0; ; frame++ {
		for _, s := range selected {
			if err := s.Reload(); err != nil {
				clear()
				return 0, err
			}
			if s.State() != "running" {
				clear()
				if len(selected) > 1 && !st.On {
					fmt.Fprintln(os.Stderr, "ask: completed "+s.ID)
				}
				return Print(s, asJSON)
			}
		}
		delay := 250 * time.Millisecond
		if st.On {
			delay = 100 * time.Millisecond
			line := term.Spinning(selected[0], st, frame)
			if len(selected) > 1 {
				line = st.Symbol("running", frame) + fmt.Sprintf(" waiting for %d sessions", len(selected))
			}
			fmt.Fprint(os.Stderr, "\r"+term.Fit(line, term.Columns(os.Stderr)-1)+"\x1b[K")
			clear = func() { fmt.Fprint(os.Stderr, "\r\x1b[K") }
		}
		time.Sleep(delay)
	}
}

// Print prints a session's latest turn, finished or not.
func Print(s *sessions.Session, asJSON bool) (int, error) {
	state := s.State()
	if asJSON {
		fmt.Fprintln(os.Stdout, config.JSON(ToResult(s), true))
	} else {
		fmt.Fprintln(os.Stderr, term.Line(s, term.Styled(os.Stderr)))
		if state == "succeeded" {
			fmt.Fprintln(os.Stdout, s.Turn().Answer)
		}
	}
	if state == "succeeded" {
		return 0, nil
	}
	return 1, nil
}

// Catalog is every model ask knows about: the fetched models.dev cache, with the models you
// declare in models.json laid over it.
func Catalog(p config.Paths) (provider.Catalog, error) {
	declared, err := provider.LoadDeclared(p.Models)
	if err != nil {
		return nil, config.Usage("%s", err)
	}
	return provider.LoadCatalog(CachePath(p)).Merge(declared), nil
}

// CachePath is where the models.dev snapshot is kept.
func CachePath(p config.Paths) string { return filepath.Join(p.Cache, "models.json") }
