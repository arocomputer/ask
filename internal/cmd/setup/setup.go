// Package setup is ask setup: connect a provider, pick a default model, teach your agents ask.
package setup

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/extension"
	"github.com/arocomputer/ask/internal/provider"
	"github.com/arocomputer/ask/internal/term"
)

// Help is the command's page.
var Help = cmdutil.Page{Summary: "Connect a provider, pick a default model, teach your agents ask.", Sections: []cmdutil.Section{
	{Title: "USAGE", Body: "ask setup"},
	{Title: "ARGUMENTS", Body: `Asks before each change and reads answers from stdin: a credential for each provider (offering
the key OpenCode already has), the model listing, a default model, external harnesses for coding
agents found on this machine, and the ask skill for Claude Code, Codex, OpenCode, Cursor and pi.`},
}}

// harnesses are the built-in external harnesses, the CLI each one runs and its name for people.
var harnesses = []struct{ Name, CLI, Title string }{{"claude", "claude", "Claude Code"}, {"codex", "codex", "Codex"}}

// host is an app that reads skills from a folder, present when its config folder exists.
type host struct{ Name, Config, SkillDir string }

func hosts() []host {
	h, _ := os.UserHomeDir()
	at := func(parts ...string) string { return filepath.Join(append([]string{h}, parts...)...) }
	return []host{
		{"Claude Code", at(".claude"), at(".claude", "skills", "ask")},
		{"Codex", at(".codex"), at(".codex", "skills", "ask")},
		{"OpenCode", at(".config", "opencode"), at(".config", "opencode", "skills", "ask")},
		{"Cursor", at(".cursor"), at(".cursor", "skills", "ask")},
		{"pi", at(".pi", "agent"), at(".pi", "agent", "skills", "ask")},
	}
}

// mark is the line that says ask setup wrote a skill and may update it.
const mark = "<!-- Written by ask setup, which keeps it up to date. Delete this line to keep your own edits. -->"

// Skill is the ask skill, in the SKILL.md format the hosts share.
const Skill = `---
name: ask
description: Delegate a focused question, review or bounded implementation task to a subagent through ask, including several in parallel or a second model's opinion.
---
` + mark + `

Use ask for an independent investigation, review or bounded implementation. Give the goal,
the relevant files or context, the constraints and the evidence you want back. Review what
comes back before relying on it.

A session works in the background. A launch prints only its ID; exit 0 means admitted.

    id=$(ask "Find why the login test fails; report the cause with file and line.") || exit $?
    ask wait "$id"                 # block for the answer; exit 1 if it failed
    ask show "$id"                 # current state and recent activity, at once
    ask wait "$id" --json          # the result record, including failures

Options: ` + "`-w`" + ` allows edits and commands (sessions are read-only by default; tests and builds
need it); ` + "`--worktree`" + ` gives a write session its own branch and checkout; ` + "`-m MODEL`" + ` picks a
model from ` + "`ask models`" + ` (` + "`opencode-go/glm-5.3`" + ` for ask's own harness, ` + "`claude:sonnet-5.5`" + ` for an
external one; omit it to use the default); ` + "`--wait`" + ` prints the answer instead of the ID;
` + "`--stdin`" + ` appends piped context to the prompt: ` + "`git diff | ask --stdin \"Review this diff\"`" + `.

Several at once: launch each, then ` + "`ask wait A B C`" + ` returns the first to finish and says
which on stderr; wait again for the rest. Give parallel write sessions separate worktrees.
Worktrees start from HEAD, so pass uncommitted context in the prompt.

` + "`ask continue ID \"next\"`" + ` adds a turn to the same session, which remembers everything it read,
said and did; it keeps the ID, directory and model, and ` + "`-w`" + ` adds write access. ` + "`ask continue ID`" + `
without a prompt resumes an interrupted turn. ` + "`ask stop ID`" + ` stops a turn. ` + "`ask sessions`" + ` lists
your sessions.

Status and errors go to stderr; wait exits 1 for a failed or stopped turn and 2 for a usage
error. Check the exit status even with ` + "`--json`" + `. ` + "`ask help COMMAND`" + ` lists options.
`

// Run connects providers, picks a default model, installs harnesses and writes skills, asking
// before each change. It reads answers from stdin, so a pipe can drive it.
func Run(p config.Paths, args []string) (int, error) {
	if _, words, err := cmdutil.Parse(args, nil); err != nil || len(words) != 0 {
		if err != nil {
			return 0, err
		}
		return 0, config.Usage("ask setup takes no arguments")
	}
	in := bufio.NewReader(os.Stdin)
	ask := func(prompt string) string {
		fmt.Fprint(os.Stderr, prompt)
		line, _ := in.ReadString('\n')
		return config.Trim(line)
	}
	yes := func(prompt string) bool {
		a := strings.ToLower(ask(prompt + " [Y/n] "))
		return a == "" || a == "y" || a == "yes"
	}
	st := term.Styled(os.Stderr)
	done := func(text string) {
		if st.On {
			text = st.Success(text)
		}
		fmt.Fprintln(os.Stderr, text)
	}
	auth, err := p.ReadAuth()
	if err != nil {
		return 0, err
	}
	known := opencodeKeys()
	for _, spec := range provider.Known {
		if config.Credential(auth, spec.Name) != "" {
			done(spec.Name + ": credential present")
			continue
		}
		key := known[spec.Name]
		if key != "" && !yes("OpenCode has a key for "+spec.Name+"; use it for ask too?") {
			key = ""
		}
		if key == "" {
			key = ask(spec.Name + " API key (enter to skip): ")
		}
		if key == "" {
			continue
		}
		auth.Set(spec.Name, config.Object{"api_key": key})
		if err := p.WriteAuth(auth); err != nil {
			return 0, err
		}
		done(spec.Name + ": saved to " + config.Tilde(filepath.Join(p.Home, "auth.json")))
	}
	catalog := cmdutil.CachePath(p)
	if _, err := os.Stat(catalog); err != nil {
		if yes("Download the model list from models.dev?") {
			if err := provider.FetchCatalog(context.Background(), catalog, cmdutil.Providers(auth)); err != nil {
				fmt.Fprintln(os.Stderr, "ask: "+err.Error())
			}
		}
	}
	cfg, err := p.ReadConfig()
	if err != nil {
		return 0, err
	}
	if cfg.S("model") == "" {
		if m := ask("Default model, like opencode-go/glm-5.3 (enter to skip): "); m != "" {
			if _, err := cmdutil.Resolve(p, cfg, m); err != nil {
				fmt.Fprintln(os.Stderr, "ask: "+err.Error())
			} else {
				cfg.Set("model", m)
				if err := p.WriteConfig(cfg); err != nil {
					return 0, err
				}
				done("default model: " + m)
			}
		}
	} else {
		done("default model: " + cfg.S("model"))
	}
	for _, h := range harnesses {
		if _, err := exec.LookPath(h.CLI); err != nil {
			continue
		}
		if extension.Path(p, h.Name) != "" {
			extension.Refresh(p, cmdutil.Version)
			continue
		}
		if yes(h.Title + " is installed; add it as a harness, so " + h.Name + ":MODEL runs it?") {
			if _, err := extension.Install(p, h.Name, cmdutil.Version); err != nil {
				return 0, err
			}
		}
	}
	for _, h := range hosts() {
		if info, err := os.Stat(h.Config); err != nil || !info.IsDir() {
			continue
		}
		current, _ := os.ReadFile(filepath.Join(h.SkillDir, "SKILL.md"))
		switch {
		case string(current) == Skill:
			done(h.Name + ": skill current")
			continue
		case len(current) > 0 && !strings.Contains(string(current), mark):
			fmt.Fprintln(os.Stderr, h.Name+": skill is your own; left alone")
			continue
		}
		if yes("Write the ask skill for " + h.Name + "?") {
			if err := os.MkdirAll(h.SkillDir, 0755); err != nil {
				return 0, err
			}
			if err := os.WriteFile(filepath.Join(h.SkillDir, "SKILL.md"), []byte(Skill), 0644); err != nil {
				return 0, err
			}
			done(h.Name + ": skill written")
		}
	}
	return 0, nil
}

// opencodeKeys reads the API keys OpenCode itself holds, by provider name, so setup can offer
// the ones ask shares (opencode, opencode-go) instead of asking for them again.
func opencodeKeys() map[string]string {
	keys := map[string]string{}
	h, _ := os.UserHomeDir()
	dir := os.Getenv("XDG_DATA_HOME")
	if dir == "" {
		dir = filepath.Join(h, ".local", "share")
	}
	b, err := os.ReadFile(filepath.Join(dir, "opencode", "auth.json"))
	if err != nil {
		return keys
	}
	v, err := config.ParseJSON(config.UTF8(b))
	entries, _ := v.(config.Object)
	if err != nil {
		return keys
	}
	for name, entry := range entries {
		if e, _ := entry.(config.Object); e.S("type") == "api" && e.S("key") != "" {
			keys[name] = e.S("key")
		}
	}
	return keys
}
