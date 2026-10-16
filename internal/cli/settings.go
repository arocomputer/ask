package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/packages"
	"github.com/arocomputer/ask/internal/setup"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// draft holds every change a settings session makes. Nothing is written until review shows the
// changes and you save them, so leaving discards them.
type draft struct {
	p               home.Paths
	settings        home.Object
	models          home.Models
	hook            bool
	skills          map[string]bool
	install, remove map[string]bool
}

// newDraft starts a draft from what is saved now.
func newDraft(p home.Paths) (*draft, error) {
	s, e := p.ReadSettings()
	if e != nil {
		return nil, e
	}
	m, e := p.ReadModels()
	if e != nil {
		return nil, e
	}
	return &draft{p, s.Clone(), m.Clone(), setup.HookOn(), map[string]bool{}, map[string]bool{}, map[string]bool{}}, nil
}

// mustSettings reads saved settings, or none when they can't be read.
func mustSettings(p home.Paths) home.Object { s, _ := p.ReadSettings(); return s }

// settingKeys are what ask settings set takes: settings.json's keys, the Claude Code hook and
// the apps that get the ask skill.
var settingKeys = append(append([]string{}, home.Settings...), "hook", "skills")

// set changes one setting in the draft; an empty value returns it to its default.
func (d *draft) set(key, value string) error {
	switch key {
	case "hook":
		switch value {
		case "on", "true", "yes":
			d.hook = true
		case "off", "false", "no", "":
			d.hook = false
		default:
			return home.Usage("hook is on or off, not %q", value)
		}
		return nil
	case "skills":
		known := map[string]bool{}
		for _, h := range setup.Hosts() {
			known[h.Name] = true
		}
		for _, name := range strings.Split(value, ",") {
			name = strings.TrimSpace(name)
			switch {
			case name == "all":
				for _, h := range setup.Hosts() {
					if h.Present() {
						d.skills[h.Name] = true
					}
				}
			case known[name]:
				d.skills[name] = true
			case name != "":
				return home.Usage("skills are claude-code, codex, opencode, cursor, pi or all, not %q", name)
			}
		}
		return nil
	}
	s := d.settings.Clone()
	var v any = value
	if value == "" {
		v = nil
	} else if key == "timeout" || key == "jobs" || key == "max_cost" {
		n, e := strconv.ParseFloat(strings.TrimPrefix(value, "$"), 64)
		if e != nil {
			return home.Usage("%s must be a number, not %q", key, value)
		}
		v = n
	}
	if name, id, _ := strings.Cut(value, ":"); key == "model" && value != "" && (name == "" || id == "") {
		return home.Usage("model must be agent:id[#effort], like claude:sonnet-5.5, not %q", value)
	}
	s.Set(key, v)
	if v == nil {
		s.Delete(key)
	}
	if _, e := d.p.SettingsText(s); e != nil {
		return e
	}
	d.settings = s
	return nil
}

// read returns a file's text, or "" when it doesn't exist.
func read(path string) string { b, _ := os.ReadFile(path); return string(b) }

// changes lists what saving the draft would change, file by file.
func (d *draft) changes() ([]tui.Change, error) {
	out := []tui.Change{}
	names := []string{}
	for name := range d.install {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		out = append(out, tui.Change{Path: home.Tilde(packages.BuiltinDir(d.p, name)), Summary: "install the " + name + " agent, built into ask"})
	}
	names = names[:0]
	for name := range d.remove {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		out = append(out, tui.Change{Path: home.Tilde(packages.BuiltinDir(d.p, name)), Summary: "remove the " + name + " agent"})
	}
	settingsPath := filepath.Join(d.p.Home, "settings.json")
	after, e := d.p.SettingsText(d.settings)
	if e != nil {
		return nil, e
	}
	if before := read(settingsPath); before != after {
		out = append(out, tui.Change{Path: home.Tilde(settingsPath), Before: before, After: after})
	}
	modelsPath := filepath.Join(d.p.Home, "models.json")
	if before, after := read(modelsPath), home.ModelsText(d.models); before != after {
		saved, _ := d.p.ReadModels()
		if home.ModelsText(saved) != after {
			out = append(out, tui.Change{Path: home.Tilde(modelsPath), Before: before, After: after})
		}
	}
	if d.hook != setup.HookOn() {
		path, before, after, e := setup.HookEdit(d.hook)
		if e != nil {
			return nil, e
		}
		out = append(out, tui.Change{Path: home.Tilde(path), Before: string(before), After: string(after)})
	}
	for _, h := range setup.Hosts() {
		if !d.skills[h.Name] {
			continue
		}
		path := filepath.Join(h.SkillDir, "SKILL.md")
		switch setup.SkillState(h) {
		case "missing":
			out = append(out, tui.Change{Path: home.Tilde(path), After: setup.Skill})
		case "outdated":
			out = append(out, tui.Change{Path: home.Tilde(path), Before: read(path), After: setup.Skill})
		}
	}
	return out, nil
}

// mustChanges is changes, or none when they can't be worked out.
func (d *draft) mustChanges() []tui.Change { c, _ := d.changes(); return c }

// apply saves the draft, saying how each part went, and starts a new draft from the result. It
// returns false when an agent it installed isn't ready.
func (d *draft) apply(say func(string, string)) bool {
	ready := true
	for name := range d.remove {
		if line, e := packages.Remove(d.p, "ask/packages/"+name); e != nil {
			say("✗", e.Error())
		} else {
			say("✓", line)
		}
	}
	for name := range d.install {
		ready = installAgent(d.p, say, name) && ready
	}
	fail := func(e error) {
		if e != nil {
			say("✗", e.Error())
		}
	}
	fail(d.p.WriteSettings(d.settings))
	if saved, _ := d.p.ReadModels(); home.ModelsText(saved) != home.ModelsText(d.models) {
		fail(d.p.WriteModels(d.models))
	}
	if d.hook != setup.HookOn() {
		fail(setup.SetHook(d.hook))
	}
	for _, h := range setup.Hosts() {
		if d.skills[h.Name] {
			fail(setup.WriteSkill(h))
		}
	}
	if next, e := newDraft(d.p); e == nil {
		*d = *next
	}
	return ready
}

// review shows what saving would change and asks; it returns whether the draft was saved.
func (d *draft) review(t *tui.Prompter) (bool, error) {
	changes, e := d.changes()
	if e != nil {
		return false, e
	}
	if len(changes) == 0 {
		t.Say("✓", "nothing to save")
		return true, nil
	}
	fmt.Fprint(t.Out, "\r\n")
	tui.Review(t.Out, changes, t.Color, termWidth())
	fmt.Fprint(t.Out, "\r\n")
	yes, e := t.Confirm("Save these changes?", true)
	if e != nil || !yes {
		return false, e
	}
	d.apply(t.Say)
	t.Say("✓", "saved")
	return true, nil
}

// finish ends a session with changes pending: save them, throw them away, or keep editing.
// It returns errBack to keep editing.
func (d *draft) finish(t *tui.Prompter) error {
	n := len(d.mustChanges())
	if n == 0 {
		return nil
	}
	options := []tui.Option{{Label: "Review and save", Note: status.Plural(n, "change")}, {Label: "Discard", Note: "keep what is saved"}, {Label: "Keep editing"}}
	i, e := t.Select("You have unsaved changes", options, 0)
	if e != nil {
		return e
	}
	switch i {
	case 0:
		saved, e := d.review(t)
		if e == nil && !saved {
			return errBack
		}
		return e
	case 1:
		t.Say("•", "discarded "+status.Plural(n, "change"))
		return nil
	}
	return errBack
}

// changedSetting reports whether a settings key differs between the draft and what is saved.
func (d *draft) changedSetting(keys ...string) bool {
	saved := mustSettings(d.p)
	for _, k := range keys {
		if home.JSON(saved.Get(k), false) != home.JSON(d.settings.Get(k), false) {
			return true
		}
	}
	return false
}

// settingsCommand runs ask settings: the menu in a terminal, or get, set, unset and NAME for
// scripts and agents. set and unset show what they change, then save; --dry-run only shows it.
func settingsCommand(p home.Paths, opts home.Object, words []string) (int, error) {
	terminal := status.IsTerminal(os.Stdin) && status.IsTerminal(os.Stdout)
	if len(words) == 0 {
		if terminal {
			return interactive(p, "", false)
		}
		return getSettings(p, "", opts.B("--json"))
	}
	switch words[0] {
	case "get":
		if len(words) > 2 {
			return 0, home.Usage("ask settings get takes at most one key, like ask settings get model")
		}
		key := ""
		if len(words) == 2 {
			key = words[1]
		}
		return getSettings(p, key, opts.B("--json"))
	case "set", "unset":
		want := 3
		if words[0] == "unset" {
			want = 2
		}
		if len(words) != want {
			return 0, home.Usage("ask settings set KEY VALUE, or ask settings unset KEY; keys: %s", strings.Join(settingKeys, ", "))
		}
		key, value := words[1], ""
		if want == 3 {
			value = words[2]
		}
		if !has(settingKeys, key) {
			return 0, home.Usage("no setting %q; keys: %s", key, strings.Join(settingKeys, ", "))
		}
		d, e := newDraft(p)
		if e != nil {
			return 0, e
		}
		if key == "skills" && value == "" {
			return 0, home.Usage("ask settings set skills APP,... or all; a skill you no longer want is a file to delete")
		}
		if e := d.set(key, value); e != nil {
			return 0, e
		}
		changes, e := d.changes()
		if e != nil {
			return 0, e
		}
		if len(changes) == 0 {
			fmt.Fprintln(os.Stderr, "ask: "+key+" is already that")
			return 0, nil
		}
		tui.Review(os.Stderr, changes, status.CanStyle(os.Stderr), termWidth())
		if opts.B("--dry-run") {
			return 0, nil
		}
		d.apply(func(mark, text string) { fmt.Fprintln(os.Stderr, mark+" "+text) })
		return 0, nil
	}
	if len(words) > 1 {
		return 0, home.Usage("ask settings takes get, set, unset or an agent's name")
	}
	name := words[0]
	if find.Path(p, "agents", name) == "" && !packages.Builtin(name) {
		return 0, home.Usage("no agent %q; ask settings opens all your settings", name)
	}
	if terminal {
		return interactive(p, name, false)
	}
	config, e := p.ReadModels()
	if e != nil {
		return 0, e
	}
	entries, _ := agent.New(p).Catalog(config)
	for _, x := range entries {
		if owner, id, _ := strings.Cut(x.ID, ":"); owner == name {
			state := "on"
			if x.Off {
				state = "off"
			}
			if c, _ := config.Get(owner, id); c.MaxCost > 0 {
				state += "\tmax $" + home.Dollars(c.MaxCost)
			}
			fmt.Fprintf(os.Stdout, "%s\t%s\n", x.ID, state)
		}
	}
	return 0, nil
}

// getSettings prints every setting, or one key's value, with defaults marked; --json prints the
// values that apply.
func getSettings(p home.Paths, key string, asJSON bool) (int, error) {
	s, e := p.ReadSettings()
	if e != nil {
		return 0, e
	}
	defaults := home.O("timeout", 900.0, "jobs", 4.0, "max_cost", 0.0, "worktrees", "~/.ask/worktrees/{name}", "branches", "ask/{name}")
	values := home.Object{}
	for _, k := range home.Settings {
		if s.Has(k) {
			values.Set(k, s.Get(k))
		} else if defaults.Has(k) {
			values.Set(k, defaults.Get(k))
		} else {
			values.Set(k, nil)
		}
	}
	values.Set("hook", setup.HookOn())
	skills := home.Object{}
	for _, h := range setup.Hosts() {
		if h.Present() {
			skills.Set(h.Name, setup.SkillState(h))
		}
	}
	values.Set("skills", skills)
	if key != "" {
		if !has(settingKeys, key) {
			return 0, home.Usage("no setting %q; keys: %s", key, strings.Join(settingKeys, ", "))
		}
		v := values.Get(key)
		switch {
		case asJSON:
			fmt.Fprintln(os.Stdout, home.JSON(v, false))
		case v == nil:
			fmt.Fprintln(os.Stdout)
		case key == "hook":
			fmt.Fprintln(os.Stdout, map[bool]string{true: "on", false: "off"}[v == true])
		default:
			fmt.Fprintln(os.Stdout, home.String(v))
		}
		return 0, nil
	}
	if asJSON {
		fmt.Fprintln(os.Stdout, home.JSON(values, true))
		return 0, nil
	}
	for _, k := range home.Settings {
		fmt.Fprintf(os.Stdout, "%-10s %s\n", k, settingText(s, k))
	}
	fmt.Fprintf(os.Stdout, "%-10s %s\n", "hook", map[bool]string{true: "on", false: "off"}[setup.HookOn()])
	added := []string{}
	for _, h := range setup.Hosts() {
		if h.Present() && setup.SkillState(h) != "missing" {
			added = append(added, h.Name)
		}
	}
	fmt.Fprintf(os.Stdout, "%-10s %s\n", "skills", strings.Join(added, ", "))
	return 0, nil
}

// termWidth is the terminal's width, for full-width review rows.
func termWidth() int { w, _ := status.TerminalSize(); return w }
