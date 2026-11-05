// Package extension finds, installs and runs extensions: folders under ~/.ask/agent/extensions,
// named however their author likes, whose extension.json says what their executables are for.
// A harness serves a model prefix (claude:sonnet-5.5) under the harness contract; tools are
// offered to the model in ask's own harness; commands become ask NAME; instructions tell the
// model how to use the tools. Nothing runs inside ask's process: every piece is a file or an
// executable you can read.
package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/arocomputer/ask/internal/config"
)

// Manifest is extension.json. Every key is optional; unknown keys are errors, so a typo never
// silently does nothing. Commands are paths relative to the extension's folder.
type Manifest struct {
	Harness      *Harness          `json:"harness,omitempty"`
	Tools        []Tool            `json:"tools,omitempty"`
	Commands     map[string]string `json:"commands,omitempty"`
	Instructions string            `json:"instructions,omitempty"`
}

// Harness serves models named PREFIX:MODEL by running Command under the harness contract.
type Harness struct {
	Prefix  string `json:"prefix"`
	Command string `json:"command"`
}

// Tool is an executable ask's harness offers the model. It reads the call's arguments as JSON
// on stdin and writes its result on stdout. Access "read" offers it in every session; anything
// else only in write sessions.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Command     string          `json:"command"`
	Access      string          `json:"access,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// Extension is an installed folder and its manifest. Err is set when the manifest is missing
// or wrong; such an extension provides nothing.
type Extension struct {
	Name, Dir string
	Manifest
	Err error
}

var (
	prefixName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	toolName   = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)
)

// Builtin tool names, which an extension's tools may not take.
var reserved = map[string]bool{"read": true, "list": true, "grep": true, "write": true, "edit": true, "shell": true}

// Load reads one extension folder.
func Load(dir string) Extension {
	e := Extension{Name: filepath.Base(dir), Dir: dir}
	b, err := os.ReadFile(filepath.Join(dir, "extension.json"))
	if err != nil {
		e.Err = fmt.Errorf("no extension.json")
		return e
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e.Manifest); err != nil {
		e.Err = fmt.Errorf("extension.json: %v", err)
		return e
	}
	e.Err = e.check()
	return e
}

// check validates names and that every command is an executable inside the folder.
func (e Extension) check() error {
	if h := e.Harness; h != nil {
		if !prefixName.MatchString(h.Prefix) {
			return fmt.Errorf("harness prefix %q must be lowercase letters, digits and dashes", h.Prefix)
		}
		if _, err := e.Path(h.Command); err != nil {
			return fmt.Errorf("harness: %v", err)
		}
	}
	seen := map[string]bool{}
	for _, t := range e.Tools {
		if !toolName.MatchString(t.Name) || reserved[t.Name] || seen[t.Name] {
			return fmt.Errorf("tool name %q is invalid, built in or repeated", t.Name)
		}
		seen[t.Name] = true
		if t.Description == "" {
			return fmt.Errorf("tool %s needs a description", t.Name)
		}
		if len(t.Parameters) > 0 {
			var v map[string]any
			if json.Unmarshal(t.Parameters, &v) != nil {
				return fmt.Errorf("tool %s: parameters must be a JSON Schema object", t.Name)
			}
		}
		if _, err := e.Path(t.Command); err != nil {
			return fmt.Errorf("tool %s: %v", t.Name, err)
		}
	}
	for name, command := range e.Commands {
		if !prefixName.MatchString(name) {
			return fmt.Errorf("command name %q must be lowercase letters, digits and dashes", name)
		}
		if _, err := e.Path(command); err != nil {
			return fmt.Errorf("command %s: %v", name, err)
		}
	}
	if e.Instructions != "" {
		if _, err := e.file(e.Instructions); err != nil {
			return fmt.Errorf("instructions: %v", err)
		}
	}
	return nil
}

// file resolves a path relative to the folder, refusing one that leaves it.
func (e Extension) file(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", fmt.Errorf("%q must be a path inside the extension's folder", rel)
	}
	full := filepath.Join(e.Dir, rel)
	if full != e.Dir && !strings.HasPrefix(full, e.Dir+string(filepath.Separator)) {
		return "", fmt.Errorf("%q leaves the extension's folder", rel)
	}
	if _, err := os.Stat(full); err != nil {
		return "", fmt.Errorf("%s does not exist", rel)
	}
	return full, nil
}

// Path resolves an executable inside the folder.
func (e Extension) Path(rel string) (string, error) {
	full, err := e.file(rel)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(full); err != nil || info.IsDir() || info.Mode()&0111 == 0 {
		return "", fmt.Errorf("%s is not executable", rel)
	}
	return full, nil
}

// Text reads the extension's instructions, or "".
func (e Extension) Text() string {
	path, err := e.file(e.Instructions)
	if e.Instructions == "" || err != nil {
		return ""
	}
	b, _ := os.ReadFile(path)
	if len(b) > 8*1024 {
		b = b[:8*1024]
	}
	return config.Trim(config.UTF8(b))
}

// All lists the installed extensions, sorted by folder name, broken ones included with Err.
func All(p config.Paths) []Extension {
	entries, _ := os.ReadDir(p.Extensions)
	out := []Extension{}
	for _, d := range entries {
		if d.IsDir() && !strings.HasPrefix(d.Name(), ".") {
			out = append(out, Load(filepath.Join(p.Extensions, d.Name())))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Working lists the extensions whose manifests are valid.
func Working(p config.Paths) []Extension {
	out := []Extension{}
	for _, e := range All(p) {
		if e.Err == nil {
			out = append(out, e)
		}
	}
	return out
}

// Path returns the executable serving a harness prefix: the first extension, by folder name,
// that declares it; "" when none does.
func Path(p config.Paths, prefix string) string {
	for _, e := range Working(p) {
		if e.Harness != nil && e.Harness.Prefix == prefix {
			path, _ := e.Path(e.Harness.Command)
			return path
		}
	}
	return ""
}

// Harnesses lists the harness prefixes the installed extensions serve, sorted.
func Harnesses(p config.Paths) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, e := range Working(p) {
		if e.Harness != nil && !seen[e.Harness.Prefix] {
			seen[e.Harness.Prefix] = true
			out = append(out, e.Harness.Prefix)
		}
	}
	sort.Strings(out)
	return out
}

// Command returns the executable for ask NAME from the first extension declaring it.
func Command(p config.Paths, name string) (string, bool) {
	for _, e := range Working(p) {
		if rel, ok := e.Commands[name]; ok {
			path, err := e.Path(rel)
			return path, err == nil
		}
	}
	return "", false
}
