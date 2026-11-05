// Package models is ask models: the models you can use.
package models

import (
	"context"
	"fmt"
	"os"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/extension"
	"github.com/arocomputer/ask/internal/provider"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "The models you can use, with a display name.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask models [flags]"},
	{Title: "ARGUMENTS", Body: `Models you declare in ~/.ask/models.json come first, then the cached models.dev listing for each
provider you have a credential for, as provider/model; any model a provider accepts also works
without being listed. Installed harnesses add their own, as harness:model.`},
	{Title: "FLAGS", Body: "    --refresh               Download the models.dev listing again\n    --json                  JSON output"},
}}

// listed is one model ask can run, as printed by ask models.
type listed struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// Run lists declared and cached native models for providers with a credential, and each
// harness's models: declared ones, then what the harness lists itself.
func Run(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "refresh"}, {Long: "json"}})
	if err != nil {
		return 0, err
	}
	if len(words) != 0 {
		return 0, config.Usage("ask models takes no arguments; see ask help models")
	}
	auth, err := p.ReadAuth()
	if err != nil {
		return 0, err
	}
	if opts.B("refresh") {
		if err := provider.FetchCatalog(context.Background(), cmdutil.CachePath(p), cmdutil.Providers(auth)); err != nil {
			return 0, err
		}
	}
	catalog, err := cmdutil.Catalog(p)
	if err != nil {
		return 0, err
	}
	out := []listed{}
	seen := map[string]bool{}
	add := func(id, name string) {
		if !seen[id] {
			seen[id] = true
			out = append(out, listed{id, name})
		}
	}
	configured := 0
	for _, name := range cmdutil.Providers(auth) {
		if config.Credential(auth, name) == "" {
			continue
		}
		configured++
		for _, m := range catalog[name] {
			add(name+"/"+m.ID, m.Name)
		}
	}
	if configured == 0 {
		fmt.Fprintln(os.Stderr, "ask: no provider credential yet; run ask setup")
	} else if _, err := os.Stat(cmdutil.CachePath(p)); err != nil {
		fmt.Fprintln(os.Stderr, "ask: no models.dev listing yet; ask models --refresh downloads one (any model id works regardless)")
	}
	for _, prefix := range extension.Harnesses(p) {
		for _, m := range catalog[prefix] {
			add(prefix+":"+m.ID, m.Name)
		}
		list, err := extension.Models(p, prefix)
		if err != nil {
			fmt.Fprintln(os.Stderr, "ask: "+err.Error())
			continue
		}
		for _, m := range list {
			add(prefix+":"+m.ID, m.Name)
		}
	}
	if opts.B("json") {
		fmt.Fprintln(os.Stdout, config.JSON(out, true))
		return 0, nil
	}
	for _, m := range out {
		if m.Name != "" {
			fmt.Fprintf(os.Stdout, "%s\t%s\n", m.ID, m.Name)
		} else {
			fmt.Fprintln(os.Stdout, m.ID)
		}
	}
	return 0, nil
}
