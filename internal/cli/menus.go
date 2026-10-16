package cli

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/packages"
	"github.com/arocomputer/ask/internal/setup"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// errBack returns to the menu a choice came from.
var errBack = errors.New("back")

// edited marks a menu note whose part of the draft differs from what is saved.
func edited(note string, changed bool) string {
	if changed {
		return note + " · edited"
	}
	return note
}

// mainMenu is ask settings: everything, grouped, with Save once something changed.
func (d *draft) mainMenu(t *tui.Prompter, m *machine) error {
	at := 0
	for {
		installed := []string{}
		for _, a := range m.Agents {
			if (a.Installed && !d.remove[a.Name]) || d.install[a.Name] {
				installed = append(installed, a.Name)
			}
		}
		agentsNote := strings.Join(installed, ", ")
		if agentsNote == "" {
			agentsNote = "none yet"
		}
		model := d.settings.S("model")
		if model == "" {
			model = "no default model"
		}
		defaults := model + " · " + strings.TrimSuffix(settingText(d.settings, "max_cost"), " (default)")
		if !d.settings.Has("max_cost") || d.settings.N("max_cost") == 0 {
			defaults = model + " · no cost limit"
		}
		skills, ownSkills := 0, 0
		for _, h := range m.Hosts {
			if m.Skills[h.Name] == "yours" {
				ownSkills++
			} else if m.Skills[h.Name] != "missing" || d.skills[h.Name] {
				skills++
			}
		}
		apps := fmt.Sprintf("ask skill in %d of %d apps", skills+ownSkills, len(m.Hosts))
		if hasHost(m, "claude-code") {
			apps += " · task titles " + map[bool]string{true: "on", false: "off"}[d.hook]
		}
		items := []tui.Option{
			{Label: "Agents", Note: edited(agentsNote, len(d.install)+len(d.remove) > 0)},
			{Label: "Defaults", Note: edited(defaults, d.changedSetting("model", "timeout", "jobs", "max_cost"))},
			{Label: "Worktrees", Note: edited(settingText(d.settings, "worktrees"), d.changedSetting("worktrees", "branches"))},
			{Label: "Apps", Note: edited(apps, len(d.skills) > 0 || d.hook != setup.HookOn())},
		}
		n := len(d.mustChanges())
		if n > 0 {
			items = append(items, tui.Option{Label: "Review and save", Note: status.Plural(n, "change")})
		}
		items = append(items, tui.Option{Label: "Done"})
		i, e := t.Select("What do you want to change?", items, min(at, len(items)-1))
		if e != nil {
			return e
		}
		at = i
		switch items[i].Label {
		case "Agents":
			e = d.agentsMenu(t, m)
		case "Defaults":
			e = d.defaultsMenu(t)
		case "Worktrees":
			e = d.worktreesMenu(t)
		case "Apps":
			e = d.appsMenu(t, m)
		case "Review and save":
			_, e = d.review(t)
			if e == nil {
				m, e = survey(d.p)
			}
		case "Done":
			if e = d.finish(t); e == nil {
				return nil
			}
		}
		if errors.Is(e, tui.ErrInterrupted) {
			return e
		}
		if e != nil && !errors.Is(e, errBack) {
			t.Say("✗", e.Error())
		}
	}
}

// agentsMenu lists the agents, official and yours, and opens the one you pick.
func (d *draft) agentsMenu(t *tui.Prompter, m *machine) error {
	options := []tui.Option{}
	for _, a := range m.Agents {
		note := ""
		switch {
		case d.install[a.Name]:
			note = "will be installed"
		case d.remove[a.Name]:
			note = "will be removed"
		case a.Ready:
			note = "ready · " + a.Models
		case a.Installed:
			note = "not ready: " + a.Why
		case a.CLI != "":
			note = "not installed · " + a.Title + " found"
		default:
			note = "not installed"
		}
		options = append(options, tui.Option{Label: a.Name, Note: note})
	}
	options = append(options, tui.Option{Label: "Back"})
	i, e := t.Select("Which agent?", options, 0)
	if e != nil || options[i].Label == "Back" {
		return e
	}
	return d.agentMenu(t, m, options[i].Label)
}

// agentMenu is one agent: install or remove it, which of its models are on, and their limits.
func (d *draft) agentMenu(t *tui.Prompter, m *machine, name string) error {
	var a *agentState
	for i := range m.Agents {
		if m.Agents[i].Name == name {
			a = &m.Agents[i]
		}
	}
	if a == nil {
		return home.Usage("no agent %q here", name)
	}
	official := packages.Builtin(name)
	at := 0
	for {
		items := []tui.Option{}
		if !a.Installed {
			if !official {
				return home.Usage("no %s agent is installed", name)
			}
			note := "from ask, to " + home.Tilde(packages.BuiltinDir(d.p, name))
			if d.install[name] {
				note = "will be installed · choose again to cancel"
			}
			items = append(items, tui.Option{Label: "Install", Note: note})
		} else {
			entries, failures := agent.New(d.p).Catalog(d.models)
			on, total, limited := 0, 0, 0
			for _, x := range entries {
				if owner, id, _ := strings.Cut(x.ID, ":"); owner == name {
					total++
					if !x.Off {
						on++
					}
					if c, _ := d.models.Get(name, id); c.MaxCost > 0 {
						limited++
					}
				}
			}
			for _, f := range failures {
				if strings.HasPrefix(f, name+": ") {
					t.Say("!", "could not list the models of "+f)
				}
			}
			limits := "your default for every model"
			if limited > 0 {
				limits = status.Plural(limited, "model") + " with their own"
			}
			items = append(items, tui.Option{Label: "Models", Note: fmt.Sprintf("%d of %d on", on, total)}, tui.Option{Label: "Cost limits", Note: limits})
			if official && strings.HasPrefix(a.Path, filepath.Dir(packages.BuiltinDir(d.p, name))) {
				note := "from " + home.Tilde(packages.BuiltinDir(d.p, name))
				if d.remove[name] {
					note = "will be removed · choose again to cancel"
				}
				items = append(items, tui.Option{Label: "Remove", Note: note})
			}
		}
		items = append(items, tui.Option{Label: "Back"})
		i, e := t.Select(name, items, min(at, len(items)-1))
		if e != nil {
			return e
		}
		at = i
		switch items[i].Label {
		case "Install":
			d.install[name] = !d.install[name]
			if !d.install[name] {
				delete(d.install, name)
			}
		case "Remove":
			d.remove[name] = !d.remove[name]
			if !d.remove[name] {
				delete(d.remove, name)
			}
		case "Models":
			e = d.chooseModelsOn(t, name)
		case "Cost limits":
			e = d.chooseCostLimit(t, name)
		case "Back":
			return nil
		}
		if e != nil {
			return e
		}
	}
}

// defaultsMenu edits the defaults every run starts from.
func (d *draft) defaultsMenu(t *tui.Prompter) error {
	at := 0
	for {
		model := d.settings.S("model")
		if model == "" {
			model = "none: give -m"
		}
		items := []tui.Option{
			{Label: "Model", Note: model},
			{Label: "Cost limit", Note: settingText(d.settings, "max_cost")},
			{Label: "Timeout", Note: settingText(d.settings, "timeout", "seconds")},
			{Label: "Batch jobs", Note: settingText(d.settings, "jobs", "at once")},
			{Label: "Back"},
		}
		i, e := t.Select("Defaults", items, at)
		if e != nil {
			return e
		}
		at = i
		switch items[i].Label {
		case "Model":
			e = d.chooseModel(t)
		case "Cost limit":
			e = d.askSetting(t, "max_cost", "Dollars a task may spend, 0 for no limit", "0")
		case "Timeout":
			e = d.askSetting(t, "timeout", "Seconds a task may run", "900")
		case "Batch jobs":
			e = d.askSetting(t, "jobs", "Batch tasks at once", "4")
		case "Back":
			return nil
		}
		if e != nil {
			return e
		}
	}
}

// worktreesMenu edits where --worktree runs work and their branch names.
func (d *draft) worktreesMenu(t *tui.Prompter) error {
	at := 0
	for {
		items := []tui.Option{
			{Label: "Folder", Note: settingText(d.settings, "worktrees")},
			{Label: "Branch", Note: settingText(d.settings, "branches")},
			{Label: "Back"},
		}
		i, e := t.Select("Worktrees", items, at)
		if e != nil {
			return e
		}
		at = i
		switch items[i].Label {
		case "Folder":
			e = d.chooseWorktrees(t)
		case "Branch":
			e = d.askSetting(t, "branches", "Branch name, with {name}", "ask/{name}")
		case "Back":
			return nil
		}
		if e != nil {
			return e
		}
	}
}

// appsMenu edits what the apps you work in know about ask.
func (d *draft) appsMenu(t *tui.Prompter, m *machine) error {
	at := 0
	for {
		items := []tui.Option{{Label: "The ask skill", Note: "tells their agents how to use ask"}}
		if hasHost(m, "claude-code") {
			items = append(items, tui.Option{Label: "Task titles in Claude Code", Note: map[bool]string{true: "on", false: "off"}[d.hook]})
		}
		items = append(items, tui.Option{Label: "Back"})
		i, e := t.Select("Apps", items, at)
		if e != nil {
			return e
		}
		at = i
		switch items[i].Label {
		case "The ask skill":
			e = d.chooseSkills(t, m)
		case "Task titles in Claude Code":
			on, err := t.Confirm("Show ask runs by model and task in Claude Code's task list?", !d.hook)
			d.hook, e = on, err
		case "Back":
			return nil
		}
		if e != nil {
			return e
		}
	}
}

// chooseModel picks the default model from what the agents offer.
func (d *draft) chooseModel(t *tui.Prompter) error {
	ids, _ := agent.New(d.p).List(d.models)
	if len(ids) == 0 {
		return nil
	}
	current := d.settings.S("model")
	options := []tui.Option{{Label: "None", Note: "give -m every time"}}
	at := 0
	a := agent.New(d.p)
	for i, id := range ids {
		m, _ := agent.Parse(d.p, id)
		options = append(options, tui.Option{Label: id, Note: a.Name(m, "")})
		if id == current {
			at = i + 1
		}
	}
	i, e := t.Select("Default model, when you don't give -m", options, at)
	if e != nil {
		return e
	}
	value := ""
	if i > 0 {
		value = ids[i-1]
	}
	return d.set("model", value)
}

// chooseWorktrees picks where --worktree works: ask's home, or a folder you name.
func (d *draft) chooseWorktrees(t *tui.Prompter) error {
	current := d.settings.S("worktrees")
	options := []tui.Option{{Label: "In ask's home", Note: "~/.ask/worktrees/{name}"}, {Label: "Somewhere else", Note: "like ~/code/worktrees/ask-{name}"}}
	at := 0
	if current != "" {
		at = 1
	}
	i, e := t.Select("Where should --worktree runs work?", options, at)
	if e != nil {
		return e
	}
	if i == 0 {
		return d.set("worktrees", "")
	}
	def := current
	if def == "" {
		def = "~/code/worktrees/ask-{name}"
	}
	return d.askSetting(t, "worktrees", "Folder for each worktree, with {name}", def)
}

// askSetting asks for one setting's value until it is valid; an empty answer keeps def.
func (d *draft) askSetting(t *tui.Prompter, key, question, def string) error {
	if d.settings.Has(key) {
		def = home.String(d.settings.Get(key))
	}
	for {
		v, e := t.Input(question, def)
		if e != nil {
			return e
		}
		if e := d.set(key, v); e != nil {
			t.Say("✗", e.Error())
			continue
		}
		return nil
	}
}

// chooseSkills picks the apps that get the ask skill; one you wrote yourself is never replaced.
func (d *draft) chooseSkills(t *tui.Prompter, m *machine) error {
	if len(m.Hosts) == 0 {
		return nil
	}
	options, chosen := []tui.Option{}, []bool{}
	for _, h := range m.Hosts {
		note := map[string]string{"current": "added", "outdated": "added · will update", "yours": "has your own; left as it is", "missing": ""}[m.Skills[h.Name]]
		options = append(options, tui.Option{Label: h.Title, Note: note})
		chosen = append(chosen, m.Skills[h.Name] != "missing" || d.skills[h.Name])
	}
	picked, e := t.MultiSelect("Teach these apps to use ask", options, chosen)
	if e != nil {
		return e
	}
	for i, h := range m.Hosts {
		if picked[i] && m.Skills[h.Name] != "yours" && m.Skills[h.Name] != "current" {
			d.skills[h.Name] = true
		} else {
			delete(d.skills, h.Name)
		}
	}
	return nil
}

// chooseModelsOn turns an agent's models on or off; models.json records the ones that are off.
func (d *draft) chooseModelsOn(t *tui.Prompter, name string) error {
	entries, _ := agent.New(d.p).Catalog(d.models)
	mine := []agent.Entry{}
	for _, x := range entries {
		if owner, _, _ := strings.Cut(x.ID, ":"); owner == name {
			mine = append(mine, x)
		}
	}
	if len(mine) == 0 {
		t.Say("•", name+" lists no models; add one with ask models "+name+":MODEL --enable")
		return nil
	}
	options, chosen := []tui.Option{}, []bool{}
	for _, x := range mine {
		_, id, _ := strings.Cut(x.ID, ":")
		options = append(options, tui.Option{Label: id, Note: x.Name})
		chosen = append(chosen, !x.Off)
	}
	picked, e := t.MultiSelect("Which "+name+" models should ask use?", options, chosen)
	if e != nil {
		return e
	}
	for i, x := range mine {
		_, id, _ := strings.Cut(x.ID, ":")
		c, _ := d.models.Get(name, id)
		c.Off = !picked[i]
		keep(d.models, name, id, c, x.Listed)
	}
	return nil
}

// chooseCostLimit sets one model's cost limit, which replaces your default for its runs.
func (d *draft) chooseCostLimit(t *tui.Prompter, name string) error {
	entries, _ := agent.New(d.p).Catalog(d.models)
	options, listed := []tui.Option{}, map[string]bool{}
	for _, x := range entries {
		owner, id, _ := strings.Cut(x.ID, ":")
		if owner != name || x.Off {
			continue
		}
		listed[id] = x.Listed
		note := "your default: " + settingText(d.settings, "max_cost")
		if c, _ := d.models.Get(name, id); c.MaxCost > 0 {
			note = "$" + home.Dollars(c.MaxCost) + " a task"
		}
		options = append(options, tui.Option{Label: id, Note: note})
	}
	if len(options) == 0 {
		return nil
	}
	i, e := t.Select("Which model's limit?", options, 0)
	if e != nil {
		return e
	}
	id := options[i].Label
	c, _ := d.models.Get(name, id)
	def := "0"
	if c.MaxCost > 0 {
		def = home.Dollars(c.MaxCost)
	}
	for {
		v, e := t.Input("Dollars a "+id+" task may spend, 0 for your default", def)
		if e != nil {
			return e
		}
		n, err := strconv.ParseFloat(strings.TrimPrefix(v, "$"), 64)
		if err != nil || n < 0 {
			t.Say("✗", "give dollars, like 10")
			continue
		}
		c.MaxCost = n
		keep(d.models, name, id, c, listed[id])
		return nil
	}
}
