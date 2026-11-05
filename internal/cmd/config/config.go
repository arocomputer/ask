// Package config is ask config: print or change config.json.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/cmdutil"
	cfg "github.com/arocomputer/ask/internal/config"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Print or change config.json.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask config [<key> [<value>]]"},
	{Title: "ARGUMENTS", Body: `model      the default -m, like opencode-go/glm-5.3
timeout    seconds a turn may take (default 900)
max_cost   dollars a turn may spend (0 for no limit)
worktree   true to give every write session its own worktree
worktrees  where worktrees go: a path whose last part holds {name}
branches   their branch names, holding {name} (default ask/{name})

An empty value removes a key. Credentials live in auth.json, written by ask setup; models you
declare live in models.json, all three in ~/.ask (or $ASK_HOME).`},
	{Title: "EXAMPLES", Body: "$ ask config\n$ ask config model opencode-go/glm-5.3\n$ ask config worktree true\n$ ask config max_cost \"\""},
}}

// Run prints or changes config.json.
func Run(p cfg.Paths, args []string) (int, error) {
	_, words, err := cmdutil.Parse(args, nil)
	if err != nil {
		return 0, err
	}
	current, err := p.ReadConfig()
	if err != nil {
		return 0, err
	}
	switch len(words) {
	case 0:
		fmt.Fprintln(os.Stdout, cfg.JSON(current, true))
		return 0, nil
	case 1:
		if !current.Has(words[0]) {
			return 1, nil
		}
		fmt.Fprintln(os.Stdout, cfg.JSON(current.Get(words[0]), false))
		return 0, nil
	case 2:
	default:
		return 0, cfg.Usage("ask config [KEY [VALUE]]; see ask help config")
	}
	key, value := words[0], cfg.Trim(words[1])
	known := false
	for _, k := range cfg.Keys {
		known = known || k == key
	}
	if !known {
		return 0, cfg.Usage("unknown key %q; keys: %s", key, strings.Join(cfg.Keys, ", "))
	}
	if value == "" {
		delete(current, key)
		return 0, p.WriteConfig(current)
	}
	switch key {
	case "timeout", "max_cost":
		n, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0, cfg.Usage("%s must be a number", key)
		}
		current[key] = n
	case "worktree":
		switch strings.ToLower(value) {
		case "true", "on", "yes":
			current[key] = true
		case "false", "off", "no":
			delete(current, key)
		default:
			return 0, cfg.Usage("worktree must be true or false")
		}
	case "model":
		if _, err := cmdutil.Resolve(p, cfg.Object{}, value); err != nil {
			return 0, err
		}
		current[key] = value
	default:
		current[key] = value
	}
	return 0, p.WriteConfig(current)
}
