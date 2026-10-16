package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/packages"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/setup"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// agentState is one official agent here: its CLI, whether an agent of its name is installed,
// and whether that agent can run.
type agentState struct {
	setup.Agent
	CLI, Path, Why string
	Installed      bool
	Ready          bool
	Models         string
}

// machine is everything ask setup reports and changes.
type machine struct {
	Agents   []agentState
	Settings home.Object
	Hosts    []setup.Host
	Skills   map[string]string
	Hook     bool
}

// survey reads the machine's state: the official agents, then any other agent installed; checking
// agents runs each installed one's models command.
func survey(p home.Paths) (*machine, error) {
	s, e := p.ReadSettings()
	if e != nil {
		return nil, e
	}
	m := &machine{Settings: s, Skills: map[string]string{}, Hook: setup.HookOn()}
	all := append([]setup.Agent{}, setup.Agents...)
	for _, x := range find.Sorted(p, "agents") {
		official := false
		for _, a := range setup.Agents {
			official = official || a.Name == x.Name
		}
		if !official {
			all = append(all, setup.Agent{Name: x.Name, Title: x.Name})
		}
	}
	for _, a := range all {
		x := agentState{Agent: a, Path: find.Path(p, "agents", a.Name)}
		if a.CLI != "" {
			x.CLI = setup.FindCLI(a.CLI)
		}
		x.Installed = x.Path != ""
		if x.Installed {
			x.Ready, x.Why = readiness(p, a.Name, x.Path)
			if x.Ready {
				x.Models, x.Why = strings.TrimPrefix(strings.TrimSuffix(x.Why, ", see ask models"), ": "), ""
				if strings.HasPrefix(x.Models, ";") {
					x.Models = "names models as you use them"
				}
			}
		}
		m.Agents = append(m.Agents, x)
	}
	for _, h := range setup.Hosts() {
		if h.Present() {
			m.Hosts = append(m.Hosts, h)
			m.Skills[h.Name] = setup.SkillState(h)
		}
	}
	return m, nil
}

// settingText shows a setting's value with unit, or its built-in default marked as such.
func settingText(s home.Object, key string, unit ...string) string {
	defaults := map[string]string{"model": "none: give -m", "timeout": "900", "jobs": "4", "max_cost": "none", "worktrees": "~/.ask/worktrees/{name}", "branches": "ask/{name}"}
	text, suffix := defaults[key], " (default)"
	if key == "max_cost" && s.N(key) > 0 {
		return "$" + home.Dollars(s.N(key)) + " a task"
	}
	if s.Has(key) && !(key == "max_cost" && s.N(key) == 0) {
		text, suffix = home.String(s.Get(key)), ""
	}
	if len(unit) > 0 && !(key == "model" && !s.Has(key)) {
		text += " " + unit[0]
	}
	return text + suffix
}

// report prints the machine's state for people, or as JSON with asJSON.
func report(w io.Writer, p home.Paths, m *machine, asJSON bool) {
	if asJSON {
		agents := []any{}
		for _, a := range m.Agents {
			agents = append(agents, home.O("name", a.Name, "cli", a.CLI, "installed", a.Installed, "ready", a.Ready, "models", a.Models, "reason", a.Why))
		}
		skills := home.Object{}
		for k, v := range m.Skills {
			skills[k] = v
		}
		fmt.Fprintln(w, home.JSON(home.O("agents", agents, "settings", m.Settings, "skills", skills, "hook", m.Hook), true))
		return
	}
	color := status.CanStyle(os.Stdout)
	dim := func(s string) string {
		if color {
			return "\x1b[2m" + s + "\x1b[0m"
		}
		return s
	}
	mark := func(ok bool) string {
		switch {
		case ok && color:
			return "\x1b[1m✔\x1b[0m"
		case ok:
			return "✔"
		case color:
			return "\x1b[2m•\x1b[0m"
		}
		return "•"
	}
	fmt.Fprintln(w, "Agents")
	for _, a := range m.Agents {
		text := ""
		switch {
		case a.Ready:
			text = "ready · " + a.Models
		case a.Installed:
			text = "not ready: " + a.Why
		case a.CLI != "":
			text = dim(a.Title + " is installed; ask install " + a.Name + " connects it")
		default:
			text = dim("not installed")
		}
		fmt.Fprintf(w, "  %s %-9s %s\n", mark(a.Ready), a.Name, text)
	}
	fmt.Fprintf(w, "\nSettings %s\n", dim(home.Tilde(filepath.Join(p.Home, "settings.json"))))
	for _, k := range home.Settings {
		fmt.Fprintf(w, "  %-10s %s\n", k, settingText(m.Settings, k))
	}
	fmt.Fprintln(w, "\nThe ask skill")
	if len(m.Hosts) == 0 {
		fmt.Fprintln(w, dim("  no app that reads skills is installed"))
	}
	for _, h := range m.Hosts {
		state := map[string]string{"current": "added", "outdated": "added, an older version", "yours": "yours, left as it is", "missing": "not added"}[m.Skills[h.Name]]
		fmt.Fprintf(w, "  %s %-12s %s\n", mark(m.Skills[h.Name] != "missing"), h.Title, state)
	}
	if hasHost(m, "claude-code") {
		on := "off"
		if m.Hook {
			on = "on"
		}
		fmt.Fprintf(w, "\nTask titles in Claude Code  %s\n", on)
	}
}

// hasHost reports whether the named host is installed.
func hasHost(m *machine, name string) bool {
	for _, h := range m.Hosts {
		if h.Name == name {
			return true
		}
	}
	return false
}

// healthy is --check's verdict: some agent is ready and no installed agent is broken.
func healthy(m *machine) bool {
	ready := false
	for _, a := range m.Agents {
		if a.Installed && !a.Ready {
			return false
		}
		ready = ready || a.Ready
	}
	return ready
}

// installAgent installs an official agent and says how it went, in the TUI when there is one.
func installAgent(p home.Paths, say func(string, string), name string) bool {
	line, e := packages.Install(p, name)
	if e != nil {
		say("✗", name+": "+e.Error())
		return false
	}
	_, dir, _ := packages.Locate(p, name)
	path := filepath.Join(dir, "agents", name)
	if used := find.Path(p, "agents", name); used != path {
		say("•", fmt.Sprintf("%s: %s, but your %s is used instead", name, line, home.Tilde(used)))
		return true
	}
	ok, text := readiness(p, name, path)
	if ok {
		say("✓", name+" is ready"+text)
	} else {
		say("!", name+" is installed but not ready: "+text)
	}
	return ok
}

// recommended applies --yes: agents for the CLIs found, the skill where it is missing or old,
// and Claude Code's title hook, showing what it changes.
func recommended(p home.Paths) (int, error) {
	m, e := survey(p)
	if e != nil {
		return 0, e
	}
	d, e := newDraft(p)
	if e != nil {
		return 0, e
	}
	for _, a := range m.Agents {
		if a.Agent.CLI != "" && a.CLI != "" && !a.Installed {
			d.install[a.Name] = true
		}
	}
	for _, h := range m.Hosts {
		if st := m.Skills[h.Name]; st == "missing" || st == "outdated" {
			d.skills[h.Name] = true
		}
	}
	if hasHost(m, "claude-code") {
		d.hook = true
	}
	changes, e := d.changes()
	if e != nil {
		return 0, e
	}
	if len(changes) == 0 {
		fmt.Fprintln(os.Stderr, "ask: nothing to do; ask is set up")
		return 0, nil
	}
	tui.Review(os.Stderr, changes, status.CanStyle(os.Stderr), termWidth())
	if !d.apply(func(mark, text string) { fmt.Fprintln(os.Stderr, mark+" "+text) }) {
		return 1, nil
	}
	return 0, nil
}

// setupCommand runs ask setup: the walkthrough in a terminal the first time, your settings after;
// --yes applies the recommended setup; --check reports, and so does a run without a terminal.
func setupCommand(p home.Paths, opts home.Object) (int, error) {
	if opts.B("--json") && !opts.B("--check") {
		return 0, home.Usage("--json goes with --check")
	}
	switch {
	case opts.B("--yes"):
		return recommended(p)
	case !opts.B("--check") && status.IsTerminal(os.Stdin) && status.IsTerminal(os.Stdout):
		return interactive(p, "", true)
	}
	m, e := survey(p)
	if e != nil {
		return 0, e
	}
	report(os.Stdout, p, m, opts.B("--json"))
	if opts.B("--check") {
		if !healthy(m) {
			return 1, nil
		}
		return 0, nil
	}
	fmt.Fprintln(os.Stderr, "\nask: run ask setup in a terminal, or ask setup --yes to connect detected CLIs without prompts; see ask help setup")
	return 0, nil
}

// interactive runs on the terminal: one agent's screen when agentName is given, the walkthrough
// when setup finds nothing set up yet, and the settings menu otherwise.
func interactive(p home.Paths, agentName string, fromSetup bool) (int, error) {
	t := &tui.Prompter{In: os.Stdin, Out: os.Stdout, Color: status.CanStyle(os.Stdout), Unicode: status.UTF8(), OnStop: process.OnStop}
	m, e := survey(p)
	if e != nil {
		return 0, e
	}
	d, e := newDraft(p)
	if e != nil {
		return 0, e
	}
	_, statErr := os.Stat(filepath.Join(p.Home, "settings.json"))
	first := fromSetup && os.IsNotExist(statErr)
	for _, a := range m.Agents {
		first = first && !a.Installed
	}
	switch {
	case agentName != "":
		t.Title("ask settings", agentName)
		e = d.agentMenu(t, m, agentName)
		if e == nil {
			e = d.finish(t)
		}
	case first:
		e = walkthrough(p, t, m, d)
	default:
		t.Title("ask settings", home.Tilde(p.Home))
		e = d.mainMenu(t, m)
	}
	if errors.Is(e, tui.ErrInterrupted) {
		if n := len(d.mustChanges()); n > 0 {
			fmt.Fprint(t.Out, "\r\n"+t.Dim(fmt.Sprintf("Discarded %s; nothing was saved.", status.Plural(n, "unsaved change")))+"\r\n")
		} else {
			fmt.Fprint(t.Out, "\r\n")
		}
		return 130, nil
	}
	return 0, e
}

// walkthrough sets ask up the first time: it installs the agents you pick, gathers the rest into
// a draft, and saves it once you have seen what it changes.
func walkthrough(p home.Paths, t *tui.Prompter, m *machine, d *draft) error {
	t.Title("ask setup", "connects your coding agents; nothing else changes until you review it")
	options, chosen, official := []tui.Option{}, []bool{}, []agentState{}
	for _, a := range m.Agents {
		if a.Agent.CLI == "" {
			continue
		}
		note := a.Title + " not found"
		if a.CLI != "" {
			note = a.Title + " · " + home.Tilde(a.CLI)
		}
		official = append(official, a)
		options = append(options, tui.Option{Label: a.Name, Note: note})
		chosen = append(chosen, a.CLI != "")
	}
	picked, e := t.MultiSelect("Which coding agents should ask use?", options, chosen)
	if e != nil {
		return e
	}
	for i, a := range official {
		if picked[i] {
			installAgent(p, t.Say, a.Name)
		}
	}
	if entries, _ := agent.New(p).Catalog(d.models); len(entries) > 0 {
		count := map[string]int{}
		for _, x := range entries {
			owner, _, _ := strings.Cut(x.ID, ":")
			count[owner]++
		}
		for _, a := range setup.Agents {
			if count[a.Name] > 12 {
				t.Say("•", fmt.Sprintf("%s offers %d models; ask settings %s chooses which ask uses", a.Name, count[a.Name], a.Name))
			}
		}
	}
	if e := d.chooseModel(t); e != nil {
		return e
	}
	if e := d.chooseWorktrees(t); e != nil {
		return e
	}
	if e := d.chooseSkills(t, m); e != nil {
		return e
	}
	if hasHost(m, "claude-code") && !m.Hook {
		on, e := t.Confirm("Show ask runs by model and task in Claude Code's task list?", true)
		if e != nil {
			return e
		}
		d.hook = on
	}
	saved, e := d.review(t)
	if e != nil {
		return e
	}
	if !saved {
		fmt.Fprint(t.Out, t.Dim("The agents above stay installed; nothing else was saved. Run ask setup again whenever you like.")+"\r\n")
		return nil
	}
	example := "ask -m MODEL \"What does this project do?\""
	if d.settings.Has("model") {
		example = "ask \"What does this project do?\""
	}
	fmt.Fprint(t.Out, "\r\n"+t.Bold("ask is set up.")+" Try it in a project:\r\n\r\n  "+example+"\r\n\r\n"+t.Dim("ask settings changes any of this.")+"\r\n")
	return nil
}
