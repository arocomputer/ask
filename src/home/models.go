package home

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Model is one model's entry in models.json: off hides and refuses it; MaxCost (USD, 0 for
// none) replaces the max_cost setting for its runs.
type Model struct {
	Off     bool
	MaxCost float64
}

// Models is models.json, by agent then model id. An id an agent doesn't list is added to its
// models unless it is off.
type Models map[string]map[string]Model

// Get returns an entry, and whether models.json has one. Ids are keyed lowercase, so a model's
// entry applies however its id is spelled.
func (m Models) Get(agent, id string) (Model, bool) {
	x, ok := m[agent][strings.ToLower(id)]
	return x, ok
}

// Delete removes an entry, so the model is on with your default cost limit again.
func (m Models) Delete(agent, id string) {
	delete(m[agent], strings.ToLower(id))
	if len(m[agent]) == 0 {
		delete(m, agent)
	}
}

// Set records an entry.
func (m Models) Set(agent, id string, x Model) {
	if m[agent] == nil {
		m[agent] = map[string]Model{}
	}
	m[agent][strings.ToLower(id)] = x
}

// ReadModels reads models.json. Each agent maps model ids to true (on), false (off) or
// {"enabled": bool, "max_cost": USD}; an agent's list of ids, the older form, turns them on.
// Ids ignore case, so one spelled two ways is refused rather than guessing which entry applies.
func (p Paths) ReadModels() (Models, error) {
	path := filepath.Join(p.Home, "models.json")
	out := Models{}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, Usage("cannot read %s: %s", path, FileError(err, "open", path))
	}
	v, err := ParseJSON(UTF8(b))
	if err != nil {
		return nil, Usage("cannot parse %s: %s", path, err)
	}
	bad := Usage(`%s must map agent names to their models, like {"opencode": {"deepseek-4.1-flash": true, "glm-5.3-flash": false}}`, path)
	agents, ok := v.(Object)
	if !ok {
		return nil, bad
	}
	for agent, val := range agents {
		switch list := val.(type) {
		case []any:
			for _, id := range list {
				s, ok := id.(string)
				if !ok {
					return nil, bad
				}
				out.Set(agent, s, Model{})
			}
		case Object:
			for id, entry := range list {
				if _, dup := out.Get(agent, id); dup {
					return nil, Usage(`%s: %s:%s is named twice; model ids ignore case`, path, agent, id)
				}
				switch e := entry.(type) {
				case bool:
					out.Set(agent, id, Model{Off: !e})
				case Object:
					x := Model{}
					for k, v := range e {
						switch k {
						case "enabled":
							on, ok := v.(bool)
							if !ok {
								return nil, Usage(`%s: %s:%s "enabled" must be true or false`, path, agent, id)
							}
							x.Off = !on
						case "max_cost":
							n, ok := v.(float64)
							if !ok || n < 0 {
								return nil, Usage(`%s: %s:%s "max_cost" must be dollars, 0 or more`, path, agent, id)
							}
							x.MaxCost = n
						default:
							return nil, Usage(`%s: %s:%s has an unknown key %q; keys: enabled, max_cost`, path, agent, id, k)
						}
					}
					out.Set(agent, id, x)
				default:
					return nil, bad
				}
			}
		default:
			return nil, bad
		}
	}
	return out, nil
}

// ModelsText returns models.json's text: agents and ids sorted, true or false for an entry with
// no cost limit; no entries at all is "", no file.
func ModelsText(m Models) string {
	agents := []string{}
	for a := range m {
		if len(m[a]) > 0 {
			agents = append(agents, a)
		}
	}
	if len(agents) == 0 {
		return ""
	}
	sort.Strings(agents)
	var b strings.Builder
	b.WriteString("{")
	for i, a := range agents {
		ids := []string{}
		for id := range m[a] {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString("\n  " + JSON(a, false) + ": {")
		for j, id := range ids {
			x := m[a][id]
			var v any = !x.Off
			if x.MaxCost > 0 {
				v = O("enabled", !x.Off, "max_cost", x.MaxCost)
			}
			if j > 0 {
				b.WriteString(",")
			}
			b.WriteString("\n    " + JSON(id, false) + ": " + JSON(v, false))
		}
		b.WriteString("\n  }")
	}
	b.WriteString("\n}\n")
	return b.String()
}

// WriteModels saves models.json, removing it when it holds nothing.
func (p Paths) WriteModels(m Models) error { return p.writeText("models.json", ModelsText(m)) }

// Clone copies models, so a draft can change them freely.
func (m Models) Clone() Models {
	out := Models{}
	for a, ids := range m {
		for id, x := range ids {
			out.Set(a, id, x)
		}
	}
	return out
}
