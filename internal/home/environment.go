package home

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// AgentEnv applies environment.json only to agents (including model discovery), never Ask
// hooks or commands. A selected executable may declare defaults and supported integrations
// in PATH.environment.json. No agent identities or provider credentials belong in core.
func (p Paths) AgentEnv(name, executable string, vars map[string]string) ([]string, error) {
	defaults, err := environmentObject(executable + ".environment.json")
	if err != nil {
		return nil, err
	}
	config, err := environmentObject(filepath.Join(p.Home, "environment.json"))
	if err != nil {
		return nil, err
	}
	if err = environmentKeys(config, "agents"); err != nil {
		return nil, err
	}
	agents := Object{}
	if v, exists := config["agents"]; exists {
		var ok bool
		agents, ok = v.(Object)
		if !ok {
			return nil, fmt.Errorf("environment.json: agents must be an object")
		}
	}
	for _, value := range agents {
		policy, ok := value.(Object)
		if !ok {
			return nil, fmt.Errorf("environment.json: each agent must be an object")
		}
		if err := checkEnvironment(policy); err != nil {
			return nil, err
		}
	}
	if err := environmentKeys(defaults, "inherit", "integrations"); err != nil {
		return nil, err
	}
	if v, exists := defaults["inherit"]; exists {
		if _, err := environmentNames(v); err != nil {
			return nil, err
		}
	}
	supported := Object{}
	if v, exists := defaults["integrations"]; exists {
		var ok bool
		supported, ok = v.(Object)
		if !ok {
			return nil, fmt.Errorf("environment manifest: integrations must be an object")
		}
		if err := checkIntegrations(supported); err != nil {
			return nil, err
		}
	}
	policy, _ := agents[name].(Object)
	integrations := Object{}
	for k, v := range supported {
		integrations[k] = v
	}
	if requested, ok := policy["integrations"].(Object); ok {
		for key, value := range requested {
			if _, ok := supported[key]; !ok {
				return nil, fmt.Errorf("environment.json: agent %s cannot enforce the requested integration policy", name)
			}
			integrations[key] = value
		}
	}
	inherit, filtered := defaults["inherit"]
	if v, exists := policy["inherit"]; exists {
		inherit, filtered = v, true
	}
	env := p.Env(vars)
	if filtered {
		names, err := environmentNames(inherit)
		if err != nil {
			return nil, err
		}
		keep := map[string]bool{}
		for _, key := range names {
			keep[key] = true
		}
		// Keep freshly supplied contract fields; they cannot be inherited or removed by policy.
		contract := map[string]bool{"ASK_HOME": true, "ASK_BIN": true, "ASK_CONTRACT": true}
		for key := range vars {
			contract[key] = true
		}
		out := []string{}
		for _, entry := range env {
			key, _, _ := strings.Cut(entry, "=")
			if keep[key] || contract[key] {
				out = append(out, entry)
			}
		}
		env = out
	}
	if len(integrations) != 0 {
		env = append(env, "ASK_ENVIRONMENT="+JSON(integrations, false))
		// Adapters may retain legacy behavior when a default cannot be enforced by an
		// installed CLI. An explicit user policy must instead be enforced or refused.
		requested, _ := policy["integrations"].(Object)
		if requested == nil {
			requested = Object{}
		}
		env = append(env, "ASK_ENVIRONMENT_REQUESTED="+JSON(requested, false))
	}
	return env, nil
}

// Diagnostics deliberately omit input text, keys and values: a malformed file can contain secrets.
func environmentObject(path string) (Object, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Object{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read environment configuration")
	}
	v, err := ParseJSON(UTF8(b))
	if err != nil {
		return nil, fmt.Errorf("invalid environment configuration JSON")
	}
	o, ok := v.(Object)
	if !ok {
		return nil, fmt.Errorf("environment configuration must be an object")
	}
	return o, nil
}

func environmentKeys(o Object, allowed ...string) error {
	for key := range o {
		found := false
		for _, known := range allowed {
			if key == known {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("environment configuration has an unknown field")
		}
	}
	return nil
}

func checkEnvironment(o Object) error {
	if err := environmentKeys(o, "inherit", "integrations"); err != nil {
		return err
	}
	if v, ok := o["inherit"]; ok {
		if _, err := environmentNames(v); err != nil {
			return err
		}
	}
	if v, exists := o["integrations"]; exists {
		integrations, ok := v.(Object)
		if !ok {
			return fmt.Errorf("environment configuration: integrations must be an object")
		}
		return checkIntegrations(integrations)
	}
	return nil
}

func checkIntegrations(o Object) error {
	if err := environmentKeys(o, "mcp", "plugins", "skills", "hooks"); err != nil {
		return err
	}
	for _, v := range o {
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("environment configuration: integrations must be booleans")
		}
	}
	return nil
}

func environmentNames(v any) ([]string, error) {
	values, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("environment configuration: inherit must be an array of variable names")
	}
	names := []string{}
	for _, value := range values {
		name, ok := value.(string)
		if !ok || !environmentName.MatchString(name) {
			return nil, fmt.Errorf("environment configuration: inherit must contain exact variable names")
		}
		names = append(names, name)
	}
	return names, nil
}
