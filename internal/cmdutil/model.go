package cmdutil

import (
	"strings"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/extension"
	"github.com/arocomputer/ask/internal/provider"
)

// Model is a resolved model specification: PROVIDER/MODEL for ask's own harness,
// HARNESS:MODEL for an installed external harness, either plus #effort. Spec is the form
// records keep, Name its display name when the model list has one. Picked says ask chose it
// because neither -m nor config named one.
type Model struct {
	Spec, Provider, ID, Effort, Name string
	Native, Picked                   bool
}

// Split reads a recorded spec: native (provider, id) for provider/id, external for harness:id.
func Split(spec string) (native bool, name, id string) {
	spec, _, _ = strings.Cut(spec, "#")
	if h, m, ok := strings.Cut(spec, ":"); ok {
		return false, h, m
	}
	if p, m, ok := strings.Cut(spec, "/"); ok {
		return true, p, m
	}
	return true, "", spec
}

// Providers lists the native providers: the known ones, then auth.json's own.
func Providers(auth config.Object) []string {
	names := []string{}
	for _, k := range provider.Known {
		names = append(names, k.Name)
	}
	return append(names, config.Custom(auth, names)...)
}

// Provider returns the spec for a native provider name, with auth.json's base_url applied.
func Provider(auth config.Object, name string) (provider.Spec, bool) {
	return provider.For(name, config.BaseURL(auth, name))
}

// Resolve parses a specification and checks its provider or harness. An empty spec uses the
// model key of config.json, and without one ask picks a model itself (see Pick).
func Resolve(p config.Paths, cfg config.Object, spec string) (Model, error) {
	spec = config.Trim(spec)
	if spec == "" {
		spec = cfg.S("model")
	}
	picked := false
	if spec == "" {
		var err error
		if spec, err = Pick(p); err != nil {
			return Model{}, err
		}
		picked = true
	}
	body, effort, _ := strings.Cut(spec, "#")
	effort = config.Trim(effort)
	if harness, id, ok := strings.Cut(body, ":"); ok {
		harness, id = strings.ToLower(config.Trim(harness)), strings.ToLower(config.Trim(id))
		if harness == "" || id == "" || strings.ContainsAny(id, " \t/") {
			return Model{}, config.Usage("an external harness's model is harness:id, like claude:sonnet-5.5; see ask models")
		}
		if extension.Path(p, harness) == "" {
			installed := strings.Join(extension.Harnesses(p), ", ")
			if installed == "" {
				installed = "none"
			}
			return Model{}, config.Usage("%q is not an installed harness (installed: %s); ask install claude or codex adds one; ask's own harness takes provider/model", harness, installed)
		}
		return Model{Spec: join(harness+":"+id, effort), Provider: harness, ID: id, Effort: effort}, nil
	}
	name, id, qualified := strings.Cut(body, "/")
	name, id = strings.ToLower(config.Trim(name)), config.Trim(id)
	auth, err := p.ReadAuth()
	if err != nil {
		return Model{}, err
	}
	if !qualified && name != "" && !strings.ContainsAny(name, " \t") {
		return Model{}, config.Usage("models are named provider/model; did you mean %s?", guess(p, auth, body))
	}
	if !qualified || name == "" || id == "" || strings.ContainsAny(id, " \t:") {
		return Model{}, config.Usage("models are named provider/model, like opencode-go/glm-5.3, or harness:model, like claude:sonnet-5.5; see ask models")
	}
	if _, ok := Provider(auth, name); !ok {
		return Model{}, config.Usage("%q is not a provider (%s); for an external harness write %s:%s", name, strings.Join(Providers(auth), ", "), name, id)
	}
	if config.Credential(auth, name) == "" {
		return Model{}, config.Usage("no credential for %s: set %s or run ask setup", name, config.KeyVar(name))
	}
	m := Model{Spec: join(name+"/"+id, effort), Provider: name, ID: id, Effort: effort, Native: true, Picked: picked}
	if catalog, err := Catalog(p); err == nil {
		if listed, ok := catalog.Find(name, id); ok {
			m.Name = listed.Name
		}
	}
	return m, nil
}

// Pick chooses a model when none is named: for the first provider with a credential, its
// default, else the first model declared for it in models.json. It fails when no provider is
// set up.
func Pick(p config.Paths) (string, error) {
	auth, err := p.ReadAuth()
	if err != nil {
		return "", err
	}
	declared, _ := provider.LoadDeclared(p.Models)
	for _, name := range Providers(auth) {
		if config.Credential(auth, name) == "" {
			continue
		}
		if spec, ok := Provider(auth, name); ok && spec.Default != "" {
			return name + "/" + spec.Default, nil
		}
		if list := declared[name]; len(list) > 0 {
			return name + "/" + list[0].ID, nil
		}
	}
	return "", config.Usage("no model provider is set up yet; run ask setup")
}

// guess completes a model named without its provider: the credentialed provider that lists
// it, else the first credentialed provider.
func guess(p config.Paths, auth config.Object, id string) string {
	catalog, _ := Catalog(p)
	first := ""
	for _, name := range Providers(auth) {
		if config.Credential(auth, name) == "" {
			continue
		}
		if first == "" {
			first = name
		}
		if _, ok := catalog.Find(name, id); ok {
			return name + "/" + id
		}
		if spec, ok := Provider(auth, name); ok && strings.EqualFold(spec.Default, id) {
			return name + "/" + id
		}
	}
	if first == "" {
		first = "opencode-go"
	}
	return first + "/" + id
}

func join(spec, effort string) string {
	if effort != "" {
		return spec + "#" + effort
	}
	return spec
}
