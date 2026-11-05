package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

// LoadDeclared reads the models you declare in ~/.ask/models.json, keyed by provider or
// extension prefix, then model id, with a display name or an object of name and prices:
//
//	{"opencode-go": {"glm-5.3": "GLM 5.3", "kimi-k3": {"name": "Kimi K3", "input": 3, "output": 15}},
//	 "claude": {"sonnet-5.5": "Sonnet 5.5"}}
//
// A missing file declares nothing; a malformed one is an error naming the entry.
func LoadDeclared(path string) (Catalog, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Catalog{}, nil
	}
	if err != nil {
		return nil, err
	}
	var raw map[string]map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("%s must map providers to models, like {\"opencode-go\": {\"glm-5.3\": \"GLM 5.3\"}}: %v", path, err)
	}
	c := Catalog{}
	for name, models := range raw {
		for id, v := range models {
			m := Model{ID: id}
			if json.Unmarshal(v, &m.Name) != nil {
				var full Model
				if err := json.Unmarshal(v, &full); err != nil {
					return nil, fmt.Errorf("%s: %s/%s must be a name or {\"name\", \"input\", \"output\", \"cached\", \"context\"}", path, name, id)
				}
				full.ID = id
				m = full
			}
			c[name] = append(c[name], m)
		}
		sort.Slice(c[name], func(i, j int) bool { return c[name][i].ID < c[name][j].ID })
	}
	return c, nil
}

// Merge lays declared models over fetched ones: a declared model replaces a fetched one with
// the same id, keeping the fetched name and prices it does not set. Each provider's list is
// sorted by id.
func (c Catalog) Merge(declared Catalog) Catalog {
	out := Catalog{}
	for name, list := range c {
		out[name] = append([]Model{}, list...)
	}
	for name, list := range declared {
		for _, d := range list {
			replaced := false
			for i, m := range out[name] {
				if !strings.EqualFold(m.ID, d.ID) {
					continue
				}
				if d.Name == "" {
					d.Name = m.Name
				}
				if d.Input == 0 && d.Output == 0 {
					d.Input, d.Output, d.Cached = m.Input, m.Output, m.Cached
				}
				if d.Context == 0 {
					d.Context = m.Context
				}
				out[name][i], replaced = d, true
			}
			if !replaced {
				out[name] = append(out[name], d)
			}
		}
		sort.Slice(out[name], func(i, j int) bool { return out[name][i].ID < out[name][j].ID })
	}
	return out
}
