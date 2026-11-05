// Package install is ask install, ask remove and ask extensions: add, remove and list extensions.
package install

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/extension"
	"github.com/arocomputer/ask/internal/term"
)

// Help is ask install's page.
var Help = cmdutil.Page{Summary: "Add an extension: a built-in one, a folder or a git repository.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask install {claude | codex | <folder> | <owner/repo> | <git-url>}"},
	{Title: "ARGUMENTS", Body: `Copies the extension to ~/.ask/agent/extensions/NAME, named for the folder or repository.
claude and codex are built in: they add Claude Code and Codex as external harnesses, so
claude:MODEL and codex:MODEL run those CLIs with their own login. A folder you made yourself
in the extensions folder is never replaced.`},
	{Title: "EXAMPLES", Body: "$ ask install claude\n$ ask install ./my-tools\n$ ask install acme/ask-docs"},
}}

// RemoveHelp is ask remove's page.
var RemoveHelp = cmdutil.Page{Summary: "Remove an extension.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask remove <name>"},
	{Title: "ARGUMENTS", Body: "Deletes ~/.ask/agent/extensions/NAME, whether ask installed it or you made it."},
}}

// ListHelp is ask extensions' page.
var ListHelp = cmdutil.Page{Summary: "List extensions and what they provide.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask extensions [--json]"},
	{Title: "ARGUMENTS", Body: `An extension is a folder in ~/.ask/agent/extensions with an extension.json. It can serve a
harness (harness:model), add tools to ask's own harness, add commands (ask NAME), and tell
the model how to use its tools. A broken manifest is listed with its error and provides nothing.`},
}}

// Run installs an extension.
func Run(p config.Paths, args []string) (int, error) {
	_, words, err := cmdutil.Parse(args, nil)
	if err != nil {
		return 0, err
	}
	if len(words) != 1 {
		return 0, config.Usage("ask install takes one source: %s, a folder, owner/repo or a git URL", strings.Join(extension.Builtin(), ", "))
	}
	name, err := extension.Install(p, words[0], cmdutil.Version)
	if err != nil {
		return 0, err
	}
	e := extension.Load(p.Extensions + "/" + name)
	fmt.Fprintf(os.Stderr, "installed %s: %s\n", name, provides(e))
	return 0, nil
}

// Remove removes an extension.
func Remove(p config.Paths, args []string) (int, error) {
	_, words, err := cmdutil.Parse(args, nil)
	if err != nil {
		return 0, err
	}
	if len(words) != 1 {
		return 0, config.Usage("ask remove takes one extension's name; see ask extensions")
	}
	if err := extension.Remove(p, words[0]); err != nil {
		return 0, err
	}
	fmt.Fprintf(os.Stderr, "removed %s\n", words[0])
	return 0, nil
}

// entry is one extension as ask extensions --json prints it.
type entry struct {
	Name     string   `json:"name"`
	Source   string   `json:"source,omitempty"`
	Harness  string   `json:"harness,omitempty"`
	Tools    []string `json:"tools,omitempty"`
	Commands []string `json:"commands,omitempty"`
	Error    string   `json:"error,omitempty"`
}

// List prints the installed extensions.
func List(p config.Paths, args []string) (int, error) {
	opts, words, err := cmdutil.Parse(args, []cmdutil.Flag{{Long: "json"}})
	if err != nil {
		return 0, err
	}
	if len(words) != 0 {
		return 0, config.Usage("ask extensions takes no arguments")
	}
	all := extension.All(p)
	entries := []entry{}
	for _, e := range all {
		en := entry{Name: e.Name, Source: extension.Source(e)}
		if e.Err != nil {
			en.Error = e.Err.Error()
		} else {
			if e.Harness != nil {
				en.Harness = e.Harness.Prefix
			}
			for _, t := range e.Tools {
				en.Tools = append(en.Tools, t.Name)
			}
			for c := range e.Commands {
				en.Commands = append(en.Commands, c)
			}
			sort.Strings(en.Commands)
		}
		entries = append(entries, en)
	}
	if opts.B("json") {
		fmt.Fprintln(os.Stdout, config.JSON(entries, true))
		return 0, nil
	}
	st := term.Styled(os.Stdout)
	if len(all) == 0 {
		if st.On {
			fmt.Fprintf(os.Stderr, "No extensions yet. ask install %s adds one.\n", strings.Join(extension.Builtin(), " or "))
		}
		return 0, nil
	}
	rows := [][]string{}
	for i, e := range all {
		source := entries[i].Source
		if source == "" {
			source = "yours"
		}
		rows = append(rows, []string{e.Name, provides(e), source})
	}
	fmt.Fprint(os.Stdout, term.Table(st, []string{"name", "provides", "source"}, rows, func(column int, text string) string {
		switch column {
		case 0:
			return st.Bold(text)
		case 2:
			return st.Dim(text)
		}
		if strings.HasPrefix(text, "error: ") {
			return st.Red(text)
		}
		return text
	}))
	return 0, nil
}

// provides describes what an extension adds, in a few words.
func provides(e extension.Extension) string {
	if e.Err != nil {
		return "error: " + e.Err.Error()
	}
	parts := []string{}
	if e.Harness != nil {
		parts = append(parts, "harness "+e.Harness.Prefix+":")
	}
	if n := len(e.Tools); n > 0 {
		names := []string{}
		for _, t := range e.Tools {
			names = append(names, t.Name)
		}
		parts = append(parts, "tools "+strings.Join(names, ", "))
	}
	if len(e.Commands) > 0 {
		names := []string{}
		for c := range e.Commands {
			names = append(names, "ask "+c)
		}
		sort.Strings(names)
		parts = append(parts, strings.Join(names, ", "))
	}
	if e.Instructions != "" {
		parts = append(parts, "instructions")
	}
	if len(parts) == 0 {
		return "nothing"
	}
	return strings.Join(parts, " · ")
}
