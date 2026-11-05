package root

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

const learnMore = `Use ask help <command> for a command's options.
A session works in the background: a launch prints only its ID, wait prints the answer, and
status goes to stderr. Exit 0 means admitted (launch) or succeeded (wait), 1 a failed or
stopped turn, 2 a usage error. Add --json for JSON instead.`

// overview is the root page, built from the commands' summaries and the extensions' commands.
func overview(p config.Paths) cmdutil.Page {
	line := func(name, summary string) string { return fmt.Sprintf("%-12s %s", name+":", summary) }
	list := func(cs []command) string {
		lines := []string{}
		for _, c := range cs {
			lines = append(lines, line(c.name, c.help.Summary))
		}
		return strings.Join(lines, "\n")
	}
	sections := []cmdutil.Section{
		{Title: "USAGE", Body: "ask [flags] <prompt>\nask <command> [flags]"},
		{Title: "CORE COMMANDS", Body: list(commands[:core])},
		{Title: "MORE COMMANDS", Body: list(commands[core:])},
	}
	ext := []string{}
	for _, e := range extension.Working(p) {
		for name := range e.Commands {
			ext = append(ext, line(name, "from the "+e.Name+" extension"))
		}
	}
	if len(ext) > 0 {
		sort.Strings(ext)
		sections = append(sections, cmdutil.Section{Title: "EXTENSION COMMANDS", Body: strings.Join(ext, "\n")})
	}
	return cmdutil.Page{Summary: "Hand a task to a subagent.", Sections: append(sections,
		cmdutil.Section{Title: "FLAGS", Body: `-m, --model <model>         provider/model, or harness:model for an external harness
-w, --write                 Allow editing files and running commands
    --wait                  Print the answer instead of the ID
    --json                  JSON output`},
		cmdutil.Section{Title: "EXAMPLES", Body: `$ ask "Why does the login test fail?"
k3f9a2
$ ask wait k3f9a2
$ ask continue k3f9a2 -w "Fix it, then run the test."
$ git diff | ask --wait --stdin "Review this diff; give file, line and impact."`},
		cmdutil.Section{Title: "LEARN MORE", Body: learnMore},
	)}
}

// help prints the overview or one command's page.
func help(p config.Paths, args []string) (int, error) {
	s := term.Styled(os.Stdout)
	if len(args) == 0 {
		fmt.Fprint(os.Stdout, render(overview(p), s))
		return 0, nil
	}
	for _, c := range commands {
		if c.name == args[0] {
			fmt.Fprint(os.Stdout, render(c.help, s))
			return 0, nil
		}
	}
	return 0, config.Usage("no help for %q; see ask help", args[0])
}

// render lays a page out: the summary, then bold uppercase titles with bodies
// indented two spaces.
func render(pg cmdutil.Page, s term.Style) string {
	var b strings.Builder
	b.WriteString(pg.Summary + "\n\n")
	for _, sec := range pg.Sections {
		b.WriteString(s.Bold(sec.Title) + "\n")
		for _, line := range strings.Split(sec.Body, "\n") {
			b.WriteString("  " + line + "\n")
		}
		b.WriteString("\n")
	}
	return b.String()
}
