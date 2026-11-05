package provider

import (
	"os"
	"strings"
)

// Spec is a native provider: an endpoint that speaks the OpenAI Responses protocol. Reasoning
// says the endpoint returns encrypted reasoning items for replay, which OpenAI's own does and
// translating gateways do not.
type Spec struct {
	Name, BaseURL string
	Reasoning     bool
}

// Known are the endpoints ask ships. Any other name with a base_url in auth.json is a
// provider too, so a compatible endpoint or proxy needs no code.
var Known = []Spec{
	{"openai", "https://api.openai.com/v1", true},
	{"opencode", "https://opencode.ai/inference/openai/v1", false},
	{"opencode-go", "https://opencode.ai/inference/go/openai/v1", false},
}

// EnvName is a provider's name as an environment variable prefix: OPENCODE_GO for opencode-go.
func EnvName(name string) string { return strings.ToUpper(strings.ReplaceAll(name, "-", "_")) }

// For returns the spec for a provider name: a known one, or a custom one when base holds its
// endpoint. base, when set, overrides a known endpoint too, and $NAME_BASE_URL overrides both.
func For(name, base string) (Spec, bool) {
	spec, ok := Spec{}, false
	for _, k := range Known {
		if k.Name == name {
			spec, ok = k, true
		}
	}
	if !ok && base != "" {
		spec, ok = Spec{Name: name, BaseURL: base}, true
	}
	if !ok {
		return Spec{}, false
	}
	if base != "" {
		spec.BaseURL = base
	}
	if v := os.Getenv(EnvName(name) + "_BASE_URL"); v != "" {
		spec.BaseURL = v
	}
	return spec, true
}
