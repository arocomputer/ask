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
	{Title: "ARGUMENTS", Body: `Walks through choosing a provider (OpenCode Go, OpenCode Zen, OpenAI or another
OpenAI-compatible endpoint) and its key, offering the key OpenCode already holds; the model
listing; a default model from that provider; external harnesses for coding agents found on this
machine; and the ask skill for Claude Code, Codex, OpenCode, Cursor and pi. Answers are read from
stdin, so a pipe can drive it. Run it again to switch provider or default model.`},
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
	// secret reads a key without echoing it, when stdin is a terminal.
	secret := func(prompt string) string {
		if !term.Styled(os.Stdin).On {
			return ask(prompt)
		}
		quiet := exec.Command("stty", "-echo")
		quiet.Stdin = os.Stdin
		if quiet.Run() != nil {
			return ask(prompt)
		}
		defer func() {
			loud := exec.Command("stty", "echo")
			loud.Stdin = os.Stdin
			_ = loud.Run()
			fmt.Fprintln(os.Stderr)
		}()
		return ask(prompt)
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
	name, err := chooseProvider(p, auth, ask, secret, yes, done, st)
	if err != nil {
		return 0, err
	}
	if name == "" {
		fmt.Fprintln(os.Stderr, "No provider connected; run ask setup again when you have a key.")
	}
	catalog := cmdutil.CachePath(p)
	if _, err := os.Stat(catalog); err != nil && name != "" {
		if yes("Download model names and prices from models.dev?") {
			if err := provider.FetchCatalog(context.Background(), catalog, cmdutil.Providers(auth)); err != nil {
				fmt.Fprintln(os.Stderr, "ask: "+err.Error())
			}
		}
	}
	cfg, err := p.ReadConfig()
	if err != nil {
		return 0, err
	}
	if m := chooseModel(p, cfg, name, ask, st); name != "" && m != "" {
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

// titles are the known providers' names for people, in the order setup offers them.
var titles = []struct{ Name, Title string }{
	{"opencode-go", "OpenCode Go"}, {"opencode", "OpenCode Zen"}, {"openai", "OpenAI"},
}

// chooseProvider asks which provider ask should use and makes sure it has a key: one already
// saved or set in the environment, the one OpenCode holds, or one typed in. Another
// OpenAI-compatible endpoint is added by name and base URL. It returns the provider's name, or
// "" when none was connected.
func chooseProvider(p config.Paths, auth config.Object, ask, secret func(string) string, yes func(string) bool, done func(string), st term.Style) (string, error) {
	known := opencodeKeys()
	choice := 0
	fmt.Fprintln(os.Stderr, "Which provider should ask use?")
	for i, t := range titles {
		note := ""
		switch {
		case config.Credential(auth, t.Name) != "":
			note = "connected"
		case known[t.Name] != "":
			note = "key found in OpenCode"
		}
		if note != "" && choice == 0 {
			choice = i + 1
		}
		if note != "" {
			note = st.Dim("  " + note)
		}
		fmt.Fprintf(os.Stderr, "  %d. %s%s\n", i+1, t.Title, note)
	}
	fmt.Fprintf(os.Stderr, "  %d. Another OpenAI-compatible endpoint\n", len(titles)+1)
	if choice == 0 {
		choice = 1
	}
	answer := ask(fmt.Sprintf("Choose [%d]: ", choice))
	if answer != "" {
		n := 0
		if _, err := fmt.Sscan(answer, &n); err != nil || n < 1 || n > len(titles)+1 {
			return "", config.Usage("choose a number from 1 to %d", len(titles)+1)
		}
		choice = n
	}
	save := func(name string, entry config.Object) error {
		auth.Set(name, entry)
		if err := p.WriteAuth(auth); err != nil {
			return err
		}
		done(name + ": saved to " + config.Tilde(filepath.Join(p.Home, "auth.json")))
		return nil
	}
	if choice == len(titles)+1 {
		name := strings.ToLower(ask("Name for it, like my-proxy: "))
		base := ask("Base URL, like https://example.com/v1: ")
		key := secret("API key: ")
		if name == "" || base == "" || key == "" {
			return "", nil
		}
		return name, save(name, config.Object{"api_key": key, "base_url": base})
	}
	t := titles[choice-1]
	if config.Credential(auth, t.Name) != "" {
		done(t.Title + " is connected")
		return t.Name, nil
	}
	if key := known[t.Name]; key != "" && yes("OpenCode already has a key for "+t.Title+"; use it?") {
		return t.Name, save(t.Name, config.Object{"api_key": key})
	}
	key := secret(t.Title + " API key: ")
	if key == "" {
		return "", nil
	}
	return t.Name, save(t.Name, config.Object{"api_key": key})
}

// chooseModel asks for the default model from the provider's listed models, offering the
// current default when it is on that provider, else the provider's own. It returns
// provider/model, or "" to keep the current one.
func chooseModel(p config.Paths, cfg config.Object, name string, ask func(string) string, st term.Style) string {
	suggest := ""
	if spec, ok := provider.For(name, ""); ok {
		suggest = spec.Default
	}
	if current := cfg.S("model"); strings.HasPrefix(current, name+"/") {
		suggest = strings.TrimPrefix(current, name+"/")
	}
	if name == "" {
		return ""
	}
	catalog, _ := cmdutil.Catalog(p)
	listed := catalog[name]
	if len(listed) > 0 {
		fmt.Fprintln(os.Stderr, "Default model:")
		for i, m := range listed {
			fmt.Fprintf(os.Stderr, "  %2d. %s%s\n", i+1, m.ID, st.Dim("  "+m.Name))
		}
	}
	prompt := "Default model, a number or an id"
	if suggest != "" {
		prompt += " [" + suggest + "]"
	}
	answer := ask(prompt + ": ")
	n := 0
	if _, err := fmt.Sscan(answer, &n); err == nil && n >= 1 && n <= len(listed) && fmt.Sprint(n) == answer {
		answer = listed[n-1].ID
	}
	if answer == "" {
		if suggest == "" || cfg.S("model") == name+"/"+suggest {
			return ""
		}
		answer = suggest
	}
	if !strings.Contains(answer, "/") {
		answer = name + "/" + answer
	}
	return answer
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
