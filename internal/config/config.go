// Package config owns ask's home folder: the files you edit (config.json, auth.json,
// models.json), the fetched cache, and the agent folder that holds sessions, worktrees and
// extensions. It also builds the environment contract external harnesses receive. Nothing is
// created until it is used. It imports nothing else of ask's.
package config

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Contract is the version of the harness contract, given to external harnesses as ASK_CONTRACT.
const Contract = "4"

// Paths are ask's files and folders, and the resolved executable of this ask:
//
//	~/.ask/config.json, auth.json, models.json   what you edit
//	~/.ask/cache/                                fetched data, safe to delete
//	~/.ask/agent/sessions, worktrees, extensions what the subagent did, where it worked, what it can use
type Paths struct {
	Home, Config, Auth, Models, Cache      string
	Agent, Sessions, Worktrees, Extensions string
	Bin                                    string
}

// New resolves paths once, honoring ASK_HOME and the current user's HOME.
func New() Paths {
	h, _ := os.UserHomeDir()
	root := os.Getenv("ASK_HOME")
	if root == "" {
		root = filepath.Join(h, ".ask")
	}
	if absolute, err := filepath.Abs(root); err == nil {
		root = absolute
	}
	bin, _ := os.Executable()
	if real, err := filepath.EvalSymlinks(bin); err == nil {
		bin = real
	}
	agent := filepath.Join(root, "agent")
	return Paths{
		Home: root, Config: filepath.Join(root, "config.json"), Auth: filepath.Join(root, "auth.json"),
		Models: filepath.Join(root, "models.json"), Cache: filepath.Join(root, "cache"),
		Agent: agent, Sessions: filepath.Join(agent, "sessions"), Worktrees: filepath.Join(agent, "worktrees"),
		Extensions: filepath.Join(agent, "extensions"), Bin: bin,
	}
}

// contractVars are the variables ask sets for a harness; inherited copies are dropped first.
var contractVars = []string{"ASK_MODEL", "ASK_EFFORT", "ASK_ACCESS", "ASK_SCHEMA", "ASK_SESSION", "ASK_REPORT", "ASK_EVENTS", "ASK_MAX_COST", "ASK_TITLE", "ASK_CONTRACT", "ASK_BIN", "ASK_HOME", "ASK_PARENT"}

// Env is the environment an external harness runs with: the caller's, minus inherited contract
// variables, plus the contract version, ask's path and home, and vars.
func (p Paths) Env(vars map[string]string) []string {
	drop := map[string]bool{}
	for _, k := range contractVars {
		drop[k] = true
	}
	env := []string{}
	for _, e := range os.Environ() {
		k, _, _ := strings.Cut(e, "=")
		if !drop[k] {
			env = append(env, e)
		}
	}
	env = append(env, "ASK_CONTRACT="+Contract, "ASK_BIN="+p.Bin, "ASK_HOME="+p.Home)
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+vars[k])
	}
	return env
}

// UsageError is a caller error, printed with a help pointer and exit status 2.
type UsageError struct{ Message string }

// Error returns the usage message without its CLI prefix or help pointer.
func (e *UsageError) Error() string { return e.Message }

// Usage constructs a formatted command-line error.
func Usage(format string, args ...any) error { return &UsageError{fmt.Sprintf(format, args...)} }

// WriteJSON atomically replaces a private JSON record using a unique temporary file.
func WriteJSON(path string, v any) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = io.WriteString(f, JSON(v, true)+"\n"); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// ReadInput reads a named file or stdin (for "-"), turning I/O failures into usage errors.
func ReadInput(path, what string) (string, error) {
	var b []byte
	var err error
	if path == "-" {
		b, err = io.ReadAll(os.Stdin)
	} else {
		b, err = os.ReadFile(path)
	}
	if err != nil {
		return "", Usage("cannot read %s %s: %s", what, path, err)
	}
	return UTF8(b), nil
}

// Tilde abbreviates a home prefix for status lines.
func Tilde(path string) string {
	h, _ := os.UserHomeDir()
	if h != "" && (path == h || strings.HasPrefix(path, h+string(os.PathSeparator))) {
		return "~" + strings.TrimPrefix(path, h)
	}
	return path
}

// Keys are the keys config.json may hold. model is the default -m; timeout is seconds per
// turn; max_cost is the dollars a turn may spend (0 for no limit); worktree requires a
// separate worktree for every write session; worktrees is where they go, a path whose last
// part holds {name}; branches names their branch, holding {name}.
var Keys = []string{"model", "timeout", "max_cost", "worktree", "worktrees", "branches"}

// ReadConfig reads the optional config.json. Unknown keys and malformed values are errors.
func (p Paths) ReadConfig() (Object, error) {
	path := p.Config
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Object{}, nil
	}
	if err != nil {
		return nil, Usage("cannot read %s: %s", path, err)
	}
	v, err := ParseJSON(UTF8(b))
	if err != nil {
		return nil, Usage("cannot parse %s: %s", path, err)
	}
	o, ok := v.(Object)
	if !ok {
		return nil, Usage(`%s must be a JSON object, like {"model": "opencode-go/glm-5.3"}`, path)
	}
	if e := p.check(o); e != nil {
		return nil, e
	}
	return o, nil
}

// WriteConfig checks and saves config.json, removing the file when nothing is left.
func (p Paths) WriteConfig(o Object) error {
	keep := Object{}
	for k, v := range o {
		if v != nil && v != "" && v != false && v != 0.0 {
			keep[k] = v
		}
	}
	if e := p.check(keep); e != nil {
		return e
	}
	path := p.Config
	if len(keep) == 0 {
		if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
			return e
		}
		return nil
	}
	if e := os.MkdirAll(p.Home, 0700); e != nil {
		return e
	}
	return WriteJSON(path, keep)
}

// check rejects unknown keys and values of the wrong kind, naming the key.
func (p Paths) check(o Object) error {
	path := p.Config
	for key, val := range o {
		bad := ""
		switch key {
		case "model":
			if s, ok := val.(string); !ok || Trim(s) == "" {
				bad = `a model like "opencode-go/glm-5.3"`
			}
		case "timeout":
			if n, ok := val.(float64); !ok || !(n > 0 && n <= 2000000) {
				bad = "a number of seconds above 0"
			}
		case "max_cost":
			if n, ok := val.(float64); !ok || n < 0 {
				bad = "dollars a turn may spend, like 2.50 (0 for no limit)"
			}
		case "worktree":
			if _, ok := val.(bool); !ok {
				bad = "true or false"
			}
		case "worktrees":
			if _, e := p.worktreeTemplate(val); e != nil {
				return e
			}
		case "branches":
			if s, ok := val.(string); !ok || strings.Count(s, "{name}") != 1 || strings.ContainsAny(s, " ~^:?*[\\") || strings.HasPrefix(s, "-") || strings.HasPrefix(s, "/") {
				bad = `a branch name holding {name} once, like "ask/{name}"`
			}
		default:
			return Usage("%s has an unknown key %q; keys: %s", path, key, strings.Join(Keys, ", "))
		}
		if bad != "" {
			return Usage("%s: %q must be %s", path, key, bad)
		}
	}
	return nil
}

// Branch returns the branch for the worktree named name: the branches setting with {name}
// replaced, or ask/NAME.
func (p Paths) Branch(name string) (string, error) {
	s, e := p.ReadConfig()
	if e != nil {
		return "", e
	}
	tmpl := "ask/{name}"
	if s.Has("branches") {
		tmpl = s.S("branches")
	}
	return strings.Replace(tmpl, "{name}", name, 1), nil
}

// worktreeTemplate validates a worktrees setting: an absolute or ~ path, returned absolute with ~
// expanded, or a path inside the repository a session starts in, like ".ask/worktrees/{name}",
// returned relative.
func (p Paths) worktreeTemplate(v any) (string, error) {
	s, _ := v.(string)
	if s == "~" || strings.HasPrefix(s, "~/") {
		h, _ := os.UserHomeDir()
		s = filepath.Join(h, s[1:])
	}
	clean := filepath.Clean(s)
	dir, last := filepath.Split(clean)
	escapes := clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator))
	if s == "" || escapes || strings.Count(s, "{name}") != 1 || !strings.Contains(last, "{name}") || dir == "" {
		return "", Usage(`%s: "worktrees" must be an absolute, ~ or in-repository path whose last part holds {name} once, like "~/code/worktrees/ask-{name}" or ".ask/worktrees/{name}"`, p.Config)
	}
	return clean, nil
}

// Worktree returns where the worktree named name goes for the repository whose main checkout is
// root: the worktrees setting with {name} replaced (a relative setting under root), or
// worktrees/NAME in ask's home.
func (p Paths) Worktree(root, name string) (string, error) {
	s, e := p.ReadConfig()
	if e != nil {
		return "", e
	}
	tmpl := filepath.Join(p.Worktrees, "{name}")
	if s.Has("worktrees") {
		if tmpl, e = p.worktreeTemplate(s.Get("worktrees")); e != nil {
			return "", e
		}
	}
	path := strings.Replace(tmpl, "{name}", name, 1)
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	return path, nil
}

// ReadAuth reads auth.json: provider credentials, like {"openai": {"api_key": "sk-..."}}.
func (p Paths) ReadAuth() (Object, error) {
	path := p.Auth
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Object{}, nil
	}
	if err != nil {
		return nil, Usage("cannot read %s: %s", path, err)
	}
	v, err := ParseJSON(UTF8(b))
	o, ok := v.(Object)
	if err != nil || !ok {
		return nil, Usage("%s must be a JSON object of providers, like {\"openai\": {\"api_key\": \"...\"}}", path)
	}
	return o, nil
}

// WriteAuth saves credentials privately (mode 0600).
func (p Paths) WriteAuth(o Object) error {
	if e := os.MkdirAll(p.Home, 0700); e != nil {
		return e
	}
	path := p.Auth
	if e := WriteJSON(path, o); e != nil {
		return e
	}
	return os.Chmod(path, 0600)
}
