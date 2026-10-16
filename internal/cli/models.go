package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// models lists the models that are on, or with --all every model and whether it is on, and
// reports listing failures without failing the command. Given models, it turns them on or off
// or sets their cost limit in models.json instead.
func models(a *agent.Registry, opts home.Object, words []string) (int, error) {
	config, e := a.Paths.ReadModels()
	if e != nil {
		return 0, e
	}
	if len(words) > 0 {
		return changeModels(a, config, opts, words)
	}
	if opts.B("--enable") || opts.B("--disable") || opts.Has("--max-cost") {
		return 0, home.Usage("say which models, like ask models codex:gpt-5.6-sol --disable")
	}
	entries, errors := a.Catalog(config)
	for _, e := range errors {
		fmt.Fprintln(os.Stderr, "ask: could not list the models of "+e)
	}
	shown := []agent.Entry{}
	for _, x := range entries {
		if !x.Off || opts.B("--all") {
			shown = append(shown, x)
		}
	}
	if len(entries) == 0 {
		fmt.Fprintln(os.Stderr, "ask: no models; run ask setup to connect your coding agents")
	}
	terminal, color := status.IsTerminal(os.Stdout), status.CanStyle(os.Stdout)
	dim := func(s string) string {
		if color && s != "" {
			return "\x1b[2m" + s + "\x1b[0m"
		}
		return s
	}
	previous := ""
	for _, x := range shown {
		owner, model, _ := strings.Cut(x.ID, ":")
		m, _ := agent.Parse(a.Paths, x.ID)
		state, limit := "on", ""
		if x.Off {
			state = "off"
		}
		if c, _ := config.Get(owner, model); c.MaxCost > 0 {
			limit = "max $" + home.Dollars(c.MaxCost)
		}
		switch {
		case opts.B("--names"):
			fmt.Fprintf(os.Stdout, "%s\t%s\n", x.ID, a.Name(m, ""))
		case terminal:
			if owner != previous {
				if previous != "" {
					fmt.Fprintln(os.Stdout)
				}
				if color {
					fmt.Fprintf(os.Stdout, "\x1b[1m%s\x1b[0m\n", owner)
				} else {
					fmt.Fprintln(os.Stdout, owner)
				}
				previous = owner
			}
			notes := strings.TrimSpace(a.Name(m, "") + "  " + limit)
			if x.Off {
				notes = "off  " + notes
			}
			fmt.Fprintf(os.Stdout, "  %-24s %s\n", model, dim(notes))
		case opts.B("--all"):
			fmt.Fprintf(os.Stdout, "%s\t%s\n", x.ID, state)
		default:
			fmt.Fprintln(os.Stdout, x.ID)
		}
	}
	return 0, nil
}

// keep records a model's entry in models.json only when it says something: off, a cost limit, or
// on for a model its agent doesn't list. Everything else is the default, so the file holds only
// your choices and never keeps a model its agent stopped offering.
func keep(config home.Models, agentName, id string, x home.Model, listed bool) {
	if !x.Off && x.MaxCost == 0 && listed {
		config.Delete(agentName, id)
	} else {
		config.Set(agentName, id, x)
	}
}

// changeModels turns models on or off, or sets or clears (0) their cost limit, in models.json.
func changeModels(a *agent.Registry, config home.Models, opts home.Object, words []string) (int, error) {
	if opts.B("--enable") && opts.B("--disable") {
		return 0, home.Usage("ask models takes --enable or --disable, not both")
	}
	if !opts.B("--enable") && !opts.B("--disable") && !opts.Has("--max-cost") {
		return 0, home.Usage("say what to change: --enable, --disable or --max-cost DOLLARS")
	}
	limit := -1.0
	if opts.Has("--max-cost") {
		n, e := strconv.ParseFloat(strings.TrimPrefix(opts.S("--max-cost"), "$"), 64)
		if e != nil || n < 0 {
			return 0, home.Usage("--max-cost takes dollars, like 10 (0 for none), not %q", opts.S("--max-cost"))
		}
		limit = n
	}
	listed := map[string]bool{}
	entries, _ := a.Catalog(config)
	for _, x := range entries {
		listed[x.ID] = x.Listed
	}
	for _, id := range words {
		m, e := agent.Parse(a.Paths, id)
		if e != nil {
			return 0, e
		}
		x, _ := config.Get(m.Agent, m.ID)
		if opts.B("--enable") {
			x.Off = false
		}
		if opts.B("--disable") {
			x.Off = true
		}
		if limit >= 0 {
			x.MaxCost = limit
		}
		keep(config, m.Agent, m.ID, x, listed[m.Agent+":"+m.ID])
		state := "on"
		if x.Off {
			state = "off"
		}
		if x.MaxCost > 0 {
			state += ", at most $" + home.Dollars(x.MaxCost) + " a run"
		}
		fmt.Fprintf(os.Stderr, "ask: %s:%s is %s\n", m.Agent, m.ID, state)
	}
	path := filepath.Join(a.Paths.Home, "models.json")
	if before, after := read(path), home.ModelsText(config); before != after {
		fmt.Fprintln(os.Stderr)
		tui.Review(os.Stderr, []tui.Change{{Path: home.Tilde(path), Before: before, After: after}}, status.CanStyle(os.Stderr), termWidth())
	}
	return 0, a.Paths.WriteModels(config)
}
