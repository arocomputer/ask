package config

import (
	"os"
	"sort"
	"strings"
)

// KeyVar is the environment variable holding a provider's credential: OPENAI_API_KEY,
// OPENCODE_GO_API_KEY and so on. It takes precedence over auth.json.
func KeyVar(name string) string {
	return strings.ToUpper(strings.ReplaceAll(name, "-", "_")) + "_API_KEY"
}

// Credential returns a provider's bearer token from the environment or auth.json, or "".
func Credential(auth Object, name string) string {
	if key := os.Getenv(KeyVar(name)); key != "" {
		return key
	}
	entry, _ := auth.Get(name).(Object)
	return entry.S("api_key")
}

// BaseURL returns the endpoint auth.json gives a provider, or "".
func BaseURL(auth Object, name string) string {
	entry, _ := auth.Get(name).(Object)
	return entry.S("base_url")
}

// Custom lists the providers auth.json defines by a base_url, sorted, beyond the known ones.
func Custom(auth Object, known []string) []string {
	skip := map[string]bool{}
	for _, k := range known {
		skip[k] = true
	}
	names := []string{}
	for name := range auth {
		if !skip[name] && BaseURL(auth, name) != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}
