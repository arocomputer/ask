// Package cmdutil holds what the commands share: option parsing, model resolution, prompt and
// limit handling, the result record, run scoping, waiting and printing, and help pages.
package cmdutil

import (
	"strings"

	"github.com/arocomputer/ask/internal/config"
)

// Version is the running ask's version, set by the root command.
var Version = "dev"

// Flag describes one option: its long name, optional short letter and whether it takes a value.
type Flag struct {
	Long, Short string
	Value       bool
}

// Parse reads options in any order among words. Words after -- are never options. Options
// are returned by long name; a repeated option keeps its last value. A dash word after the
// first prompt word is prompt text, so "-v means verbose" survives.
func Parse(args []string, flags []Flag) (config.Object, []string, error) {
	opts := config.Object{}
	words := []string{}
	find := func(name string) *Flag {
		for i := range flags {
			if "--"+flags[i].Long == name || flags[i].Short != "" && "-"+flags[i].Short == name {
				return &flags[i]
			}
		}
		return nil
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			words = append(words, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			words = append(words, a)
			continue
		}
		name, inline, has := strings.Cut(a, "=")
		f := find(name)
		if f == nil {
			if len(words) > 0 && !strings.HasPrefix(a, "--") {
				words = append(words, a)
				continue
			}
			return nil, nil, config.Usage("unknown option %s; see ask help", name)
		}
		if !f.Value {
			if has {
				return nil, nil, config.Usage("%s takes no value", name)
			}
			opts[f.Long] = true
			continue
		}
		if has {
			opts[f.Long] = inline
			continue
		}
		if i+1 >= len(args) {
			return nil, nil, config.Usage("%s needs a value", name)
		}
		i++
		opts[f.Long] = args[i]
	}
	return opts, words, nil
}

// Number reads a numeric option, failing with the option's expected meaning.
func Number(opts config.Object, name, meaning string) (float64, error) {
	if !opts.Has(name) {
		return 0, nil
	}
	n := config.Number(opts.Get(name))
	if n != n || n < 0 {
		return 0, config.Usage("--%s must be %s", name, meaning)
	}
	return n, nil
}

// Page is a command's help: a one-line summary and titled sections, rendered like gh's help.
type Page struct {
	Summary  string
	Sections []Section
}

// Section is one titled block of a help page.
type Section struct{ Title, Body string }
