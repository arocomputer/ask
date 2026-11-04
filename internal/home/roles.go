package home

import (
	"encoding/json"
	"regexp"
	"strings"
)

var modelPattern = regexp.MustCompile(`^([a-z0-9][a-z0-9_-]*):([^#\s]+)(?:#(\S+))?$`)
var rolePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)

// ParseModelSpec checks agent:id[#effort] syntax without requiring an installed agent.
// Model ids are lowercase; effort keeps its spelling for the agent.
func ParseModelSpec(spec string) (agent, id, effort string, err error) {
	m := modelPattern.FindStringSubmatch(spec)
	if m != nil {
		for _, r := range m[2] + m[3] {
			if Space(r) {
				m = nil
				break
			}
		}
	}
	if m == nil {
		return "", "", "", Usage("bad model %q: expected agent:id[#effort]; see `ask models`", spec)
	}
	return m[1], strings.ToLower(m[2]), m[3], nil
}

// Roles returns the optional, validated role-to-model map in settings.
func Roles(settings Object) Object {
	roles, _ := settings.Get("roles").(Object)
	return roles
}

// ParseRoles decodes an editable role map, rejecting duplicate names and invalid targets.
func ParseRoles(text string) (Object, error) {
	v, err := ParseJSON(text)
	if err != nil {
		return nil, Usage("cannot parse roles: %s", err)
	}
	if err := checkRoleDuplicates(`{"roles":` + text + `}`); err != nil {
		return nil, err
	}
	if err := checkRoles(v); err != nil {
		return nil, err
	}
	return v.(Object), nil
}

func checkRoles(val any) error {
	roles, ok := val.(Object)
	if !ok {
		return Usage(`"roles" must be an object mapping names to agent:id[#effort] strings`)
	}
	for name, target := range roles {
		if !rolePattern.MatchString(name) {
			return Usage(`role %q: names must match [a-z][a-z0-9_-]*; uppercase names and model syntax are not allowed`, name)
		}
		s, ok := target.(string)
		if !ok {
			return Usage("role %q must target an agent:id[#effort] string", name)
		}
		if _, _, _, err := ParseModelSpec(s); err != nil || strings.Count(s, "#") > 1 {
			return Usage("role %q: expected agent:id[#effort], got %q; roles cannot reference roles (including cycles)", name, s)
		}
	}
	return nil
}

// checkRoleDuplicates catches ambiguous role definitions before JSON's last-key-wins decoding.
// Other settings retain their existing decoding rules.
func checkRoleDuplicates(text string) error {
	d := json.NewDecoder(strings.NewReader(text))
	if token, _ := d.Token(); token != json.Delim('{') {
		return nil
	}
	seenRoles := false
	for d.More() {
		key, _ := d.Token()
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil {
			return err
		}
		if key != "roles" {
			continue
		}
		if seenRoles {
			return Usage(`"roles" is defined twice`)
		}
		seenRoles = true
		r := json.NewDecoder(strings.NewReader(string(raw)))
		if token, _ := r.Token(); token != json.Delim('{') {
			continue
		}
		seen := map[string]bool{}
		for r.More() {
			key, _ := r.Token()
			name := key.(string)
			if seen[name] {
				return Usage("role %q is defined twice", name)
			}
			seen[name] = true
			if err := r.Decode(&raw); err != nil {
				return err
			}
		}
	}
	return nil
}
