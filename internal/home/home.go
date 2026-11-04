// Package home owns ask's local paths, contract environment and atomic records.
package home

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Paths holds the state directories and the resolved executable for this ask.
type Paths struct{ Home, Runs, Worktrees, Agents, Packages, Bin string }

// New resolves paths once, honoring ASK_HOME and the current user's HOME.
func New() Paths {
	h, _ := os.UserHomeDir()
	root := os.Getenv("ASK_HOME")
	if root == "" {
		root = filepath.Join(h, ".ask")
	}
	bin, _ := os.Executable()
	if real, err := filepath.EvalSymlinks(bin); err == nil {
		bin = real
	}
	return Paths{root, filepath.Join(root, "runs"), filepath.Join(root, "worktrees"), filepath.Join(root, "agents"), filepath.Join(root, "packages"), bin}
}

// Env clears inherited per-task variables and supplies contract version 1.
func (p Paths) Env(vars map[string]string) []string {
	drop := map[string]bool{}
	for _, k := range []string{"ASK_MODEL", "ASK_EFFORT", "ASK_ACCESS", "ASK_SCHEMA", "ASK_SESSION", "ASK_REPORT", "ASK_MAX_COST", "ASK_TITLE", "ASK_RUN", "ASK_EVENT", "ASK_CONTRACT", "ASK_BIN", "ASK_HOME"} {
		drop[k] = true
	}
	env := []string{}
	for _, e := range os.Environ() {
		k, _, _ := strings.Cut(e, "=")
		if !drop[k] {
			env = append(env, e)
		}
	}
	env = append(env, "ASK_CONTRACT=1", "ASK_BIN="+p.Bin, "ASK_HOME="+p.Home)
	for k, v := range vars {
		env = append(env, k+"="+v)
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

// ReadInput reads a named file or stdin, turning I/O failures into usage errors.
func ReadInput(path, what string) (string, error) {
	var b []byte
	var err error
	if path == "-" {
		b, err = io.ReadAll(os.Stdin)
	} else {
		b, err = os.ReadFile(path)
	}
	if err != nil {
		why := FileError(err, "open", path)
		if os.IsNotExist(err) {
			why = "no such file"
		}
		return "", Usage("cannot read %s %s: %s", what, path, why)
	}
	return UTF8(b), nil
}

// FileError renders filesystem errors in the existing CLI's vocabulary.
func FileError(err error, op, path string) string {
	code, text := "", ""
	switch {
	case os.IsNotExist(err):
		code, text = "ENOENT", "no such file or directory"
	case os.IsPermission(err):
		code, text = "EACCES", "permission denied"
	}
	if info, e := os.Stat(path); e == nil && info.IsDir() {
		return "EISDIR: illegal operation on a directory, read"
	}
	if code != "" {
		return fmt.Sprintf("%s: %s, %s '%s'", code, text, op, path)
	}
	return err.Error()
}

// Tilde abbreviates a home prefix as the status-line contract does.
func Tilde(path string) string {
	h, _ := os.UserHomeDir()
	if h != "" && (path == h || strings.HasPrefix(path, h+string(os.PathSeparator))) {
		return "~" + strings.TrimPrefix(path, h)
	}
	return path
}

// Settings are the keys settings.json may hold, each replacing a built-in default:
// model (the default -m), roles (names for exact model specifications), timeout (seconds per
// task), jobs (batch tasks at once), max_cost (USD a task may spend; none when absent or 0),
// worktrees (a path whose last part holds {name}) and branches (a worktree's branch name,
// holding {name}).
var Settings = []string{"model", "roles", "timeout", "jobs", "max_cost", "worktrees", "branches"}

// ReadSettings reads the optional settings.json, like {"worktrees": "~/code/worktrees/ask-{name}"}.
// Unknown keys and malformed values are errors.
func (p Paths) ReadSettings() (Object, error) {
	path := filepath.Join(p.Home, "settings.json")
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Object{}, nil
	}
	if err != nil {
		return nil, Usage("cannot read %s: %s", path, FileError(err, "open", path))
	}
	v, err := ParseJSON(UTF8(b))
	if err != nil {
		return nil, Usage("cannot parse %s: %s", path, err)
	}
	o, ok := v.(Object)
	if !ok {
		return nil, Usage(`%s must be a JSON object, like {"worktrees": "~/code/worktrees/ask-{name}"}`, path)
	}
	if e := checkRoleDuplicates(UTF8(b)); e != nil {
		return nil, Usage("%s: %s", path, e)
	}
	if e := p.checkSettings(o); e != nil {
		return nil, e
	}
	return o, nil
}

// SettingsText checks settings and returns settings.json's text for them, leaving out keys with
// empty values; no settings at all is "", no file.
func (p Paths) SettingsText(o Object) (string, error) {
	keep := Object{}
	for k, v := range o {
		if v != nil && v != "" {
			keep[k] = v
		}
	}
	if e := p.checkSettings(keep); e != nil {
		return "", e
	}
	if len(keep) == 0 {
		return "", nil
	}
	return JSON(keep, true) + "\n", nil
}

// WriteSettings checks and saves settings, removing the file when none are left.
func (p Paths) WriteSettings(o Object) error {
	text, e := p.SettingsText(o)
	if e != nil {
		return e
	}
	return p.writeText("settings.json", text)
}

// writeText replaces a file in ask's home atomically, or removes it for "".
func (p Paths) writeText(name, text string) error {
	path := filepath.Join(p.Home, name)
	if text == "" {
		if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
			return e
		}
		return nil
	}
	if e := os.MkdirAll(p.Home, 0700); e != nil {
		return e
	}
	tmp := filepath.Join(p.Home, "."+name+".tmp")
	if e := os.WriteFile(tmp, []byte(text), 0600); e != nil {
		return e
	}
	return os.Rename(tmp, path)
}

// checkSettings rejects unknown keys and values of the wrong kind, naming the key.
func (p Paths) checkSettings(o Object) error {
	path := filepath.Join(p.Home, "settings.json")
	for key, val := range o {
		bad := ""
		switch key {
		case "model":
			if s, ok := val.(string); !ok || Trim(s) == "" {
				bad = `a model like "claude:sonnet-5.5"`
			}
		case "roles":
			if e := checkRoles(val); e != nil {
				return Usage("%s: %s", path, e)
			}
		case "timeout":
			if n, ok := val.(float64); !ok || !(n > 0 && n <= 2000000) {
				bad = "a number of seconds above 0"
			}
		case "max_cost":
			if n, ok := val.(float64); !ok || n < 0 {
				bad = "dollars a task may spend, like 2.50 (0 for no limit)"
			}
		case "jobs":
			if n, ok := val.(float64); !ok || n < 1 || n != float64(int(n)) {
				bad = "a whole number of tasks, 1 or more"
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
			return Usage("%s has an unknown setting %q; settings: %s", path, key, strings.Join(Settings, ", "))
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
	s, e := p.ReadSettings()
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
// expanded, or a path inside the repository a run starts in, like ".ask/worktrees/{name}",
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
		return "", Usage(`%s: "worktrees" must be an absolute, ~ or in-repository path whose last part holds {name} once, like "~/code/worktrees/ask-{name}" or ".ask/worktrees/{name}"`, filepath.Join(p.Home, "settings.json"))
	}
	return clean, nil
}

// Worktree returns where the worktree named name goes for the repository whose main checkout is
// root: the worktrees setting with {name} replaced (a relative setting under root), or
// worktrees/NAME in ask's home.
func (p Paths) Worktree(root, name string) (string, error) {
	tmpl, e := p.worktreesSetting()
	if e != nil {
		return "", e
	}
	path := strings.Replace(tmpl, "{name}", name, 1)
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	return path, nil
}

// WorktreeNames returns the names of the worktrees already in the worktrees location. A relative
// setting has one location per repository, so it lists none; git.Add still keeps names apart.
func (p Paths) WorktreeNames() []string {
	tmpl, e := p.worktreesSetting()
	if e != nil || !filepath.IsAbs(tmpl) {
		return nil
	}
	dir, last := filepath.Split(tmpl)
	prefix, suffix, _ := strings.Cut(last, "{name}")
	names := []string{}
	entries, _ := os.ReadDir(dir)
	for _, d := range entries {
		n := d.Name()
		if len(n) > len(prefix)+len(suffix) && strings.HasPrefix(n, prefix) && strings.HasSuffix(n, suffix) {
			names = append(names, n[len(prefix):len(n)-len(suffix)])
		}
	}
	return names
}

// worktreesSetting is the configured worktrees template, or ask's own worktrees folder.
func (p Paths) worktreesSetting() (string, error) {
	s, e := p.ReadSettings()
	if e != nil {
		return "", e
	}
	if !s.Has("worktrees") {
		return filepath.Join(p.Worktrees, "{name}"), nil
	}
	return p.worktreeTemplate(s.Get("worktrees"))
}
