package runs

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/task"
)

// safeWorktreeID replaces characters unsafe in branch names and filesystem paths, dots included,
// since git refuses names like v1..v2, api.lock and 1.0.
func safeWorktreeID(id string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_-", r) {
			return r
		}
		return '_'
	}, id)
}

// Prepare validates task fields and inherits a followed-up task's agent, access and location.
// New worktrees are named after label, the run's name or ID. The model and timeout settings
// fill in what neither the task nor its defaults give. A task's cost limit is its own max_cost,
// else the limit of the run it follows up, else its model's in models.json, else the max_cost
// setting; 0 means none. A model that
// models.json turns off is refused. An explicit -r in defaults is a ceiling: a task asking for
// write access is refused rather than run with it. Roles resolve before saving; the model is
// stored as agent.Parse spells it, so later role edits cannot change a saved run.
func Prepare(p home.Paths, items []any, defaults home.Object, label string, single bool, missing func(string) error) ([]home.Object, error) {
	settings, e := p.ReadSettings()
	if e != nil {
		return nil, e
	}
	models, e := p.ReadModels()
	if e != nil {
		return nil, e
	}
	out := []home.Object{}
	for i, item := range items {
		where := fmt.Sprintf("task %d", i+1)
		if single {
			where = "ask"
		}
		original, ok := item.(home.Object)
		if !ok {
			return nil, home.Usage("%s must be a JSON object", where)
		}
		t := defaults.Clone()
		for key, val := range original {
			if val != nil {
				t.Set(key, val)
			}
		}
		if _, ok := t.Get("prompt").(string); !ok || home.Trim(t.S("prompt")) == "" {
			return nil, home.Usage("%s has no \"prompt\"", where)
		}
		for _, key := range []string{"write", "json", "worktree"} {
			if t.Has(key) {
				if _, ok := t.Get(key).(bool); !ok {
					return nil, home.Usage("%s: \"%s\" must be true or false", where, key)
				}
			}
		}
		if defaults.Has("write") && !defaults.B("write") && t.B("write") {
			return nil, home.Usage("%s asks for \"write\": true, but -r makes every task read-only", where)
		}
		for _, key := range []string{"model", "dir", "continue", "title"} {
			if t.Has(key) {
				if _, ok := t.Get(key).(string); !ok {
					return nil, home.Usage("%s: \"%s\" must be a string", where, key)
				}
				if key == "title" && home.Trim(t.S(key)) == "" {
					return nil, home.Usage("%s: \"title\" must not be empty", where)
				}
			}
		}
		if t.Has("schema") && t.Get("schema") != nil && home.Kind(t.Get("schema")) != "object" && home.Kind(t.Get("schema")) != "boolean" {
			return nil, home.Usage("%s: \"schema\" must be a JSON Schema object", where)
		}
		timeout := 900.0
		if settings.Has("timeout") {
			timeout = settings.N("timeout")
		}
		if t.Has("timeout") {
			n, ok := t.Get("timeout").(float64)
			if !ok || !(n > 0 && n <= 2000000) {
				return nil, home.Usage("%s: timeout must be a number of seconds above 0, at most 2000000", where)
			}
			timeout = n
		}
		taskID := home.String(original.Get("id"))
		if original.Get("id") == nil {
			taskID = strconv.Itoa(i + 1)
		}
		dir := t.S("dir")
		if !t.Has("dir") {
			dir = "."
		}
		dir, _ = filepath.Abs(dir)
		x := home.O("id", taskID, "prompt", t.Get("prompt"), "model", t.Get("model"), "write", t.Get("write"))
		if t.Has("title") {
			x.Set("title", t.Get("title"))
		}
		x.Set("json", t.B("json"))
		if t.Has("schema") {
			x.Set("schema", t.Get("schema"))
		}
		x.Set("dir", dir)
		x.Set("timeout", timeout)
		if t.B("continue") {
			prev, at, e := Open(p, t.S("continue"))
			if e != nil {
				return nil, e
			}
			if at < 0 {
				return nil, home.Usage("run %s has %d tasks; continue one of them, like %s/%s", prev.Label(), len(prev.Tasks), prev.Label(), prev.Tasks[0].S("id"))
			}
			if Owner(prev) != 0 {
				return nil, home.Usage("%s is still running; use ask wait %s", t.S("continue"), t.S("continue"))
			}
			old, result := prev.Tasks[at], prev.Results[at]
			if result == nil {
				resumed, _, usable := recoverTask(prev, at, false)
				if !usable {
					return nil, home.Usage("%s cannot be continued: it has not finished and has no usable saved session", t.S("continue"))
				}
				result = home.O("model", resumed.Get("model"), "write", resumed.Get("write"), "session", resumed.Get("session"))
				if kept := resumed.Get("kept_worktree"); kept != nil {
					result.Set("worktree", kept)
				}
			}
			if !result.B("session") {
				return nil, home.Usage("%s cannot be continued: its agent reported no session", t.S("continue"))
			}
			if x.Get("model") == nil {
				x.Set("model", result.Get("model"))
			}
			m, e := agent.Resolve(p, settings, x.S("model"))
			if e != nil {
				return nil, e
			}
			prior, e := agent.Parse(p, result.S("model"))
			if e != nil {
				return nil, e
			}
			if m.Agent != prior.Agent {
				return nil, home.Usage("%s ran on %s; a follow-up must use the same agent", t.S("continue"), result.S("model"))
			}
			if x.Get("write") == nil {
				if result.Has("write") {
					x.Set("write", result.Get("write"))
				} else {
					x.Set("write", old.Get("write"))
				}
			}
			x.Set("dir", old.Get("dir"))
			if old.Has("worktree") {
				x.Set("worktree", old.Get("worktree"))
			}
			if kept, ok := result.Get("worktree").(home.Object); ok {
				x.Set("kept_worktree", kept)
				x.Set("reuse", true)
			}
			if t.B("worktree") && !x.B("worktree") {
				return nil, home.Usage("%s: a follow-up runs where %s ran, which is not a worktree; drop --worktree", where, t.S("continue"))
			}
			x.Set("session", result.Get("session"))
			if !t.Has("max_cost") && old.N("max_cost") > 0 {
				t.Set("max_cost", old.Get("max_cost"))
			}
			x.Set("continues", Ref(prev, at))
		} else if t.B("worktree") {
			name := label
			if !single {
				name += "-" + strconv.Itoa(i+1) + "-" + safeWorktreeID(taskID)
			}
			x.Set("worktree", name)
		}
		if settings.B("worktree") && x.B("write") {
			if t.Has("worktree") && !t.B("worktree") {
				return nil, home.Usage(`%s: writes always run in a worktree; remove "worktree": false`, where)
			}
			if !x.B("worktree") {
				if t.B("continue") {
					return nil, home.Usage("%s: writes always run in a worktree; %s started outside one, so it cannot be continued with write access", where, t.S("continue"))
				}
				if git.Root(x.S("dir")) == "" {
					return nil, home.Usage("%s: writes need a git worktree; %s is not in a git repository", where, x.S("dir"))
				}
				name := label
				if !single {
					name += "-" + strconv.Itoa(i+1) + "-" + safeWorktreeID(taskID)
				}
				x.Set("worktree", name)
			}
		}
		if !x.B("model") && settings.Has("model") {
			x.Set("model", settings.S("model"))
		}
		if !x.B("model") {
			return nil, missing(where)
		}
		m, e := agent.Resolve(p, settings, x.S("model"))
		if e != nil {
			return nil, e
		}
		x.Set("model", m.Spec)
		entry, _ := models.Get(m.Agent, m.ID)
		if entry.Off {
			return nil, home.Usage("%s: %s:%s is off in models.json; turn it on with ask models %s:%s --enable", where, m.Agent, m.ID, m.Agent, m.ID)
		}
		limit := settings.N("max_cost")
		if entry.MaxCost > 0 {
			limit = entry.MaxCost
		}
		if t.Has("max_cost") {
			n, ok := t.Get("max_cost").(float64)
			if !ok || n < 0 {
				return nil, home.Usage("%s: max_cost must be dollars, 0 or more (0 for no limit)", where)
			}
			limit = n
		}
		if limit > 0 {
			x.Set("max_cost", limit)
		}
		x.Set("write", x.B("write"))
		if x.B("worktree") && !x.B("write") {
			kept, err := task.KeptWorktree(p, x)
			if err != nil {
				return nil, err
			}
			if kept == nil {
				return nil, home.Usage("%s: a worktree is for write runs; add -w", where)
			}
			info, err := os.Stat(kept.Path)
			if err != nil || !info.IsDir() {
				return nil, home.Usage("%s: a worktree is for write runs; add -w", where)
			}
		}
		if _, e := os.Stat(x.S("dir")); e != nil {
			return nil, home.Usage("%s: no directory %s", where, x.S("dir"))
		}
		out = append(out, x)
	}
	return out, nil
}
