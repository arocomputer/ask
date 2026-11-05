package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/process"
)

// Tool is one function the model may call. Run receives the session's directory and the parsed
// arguments and returns what the model sees. Paths are confined to that directory.
type Tool struct {
	Name        string
	Description string
	Parameters  json.RawMessage
	Run         func(ctx context.Context, dir string, args config.Object) (string, error)
}

const (
	readLimit   = 64 * 1024
	outputLimit = 32 * 1024
	listLimit   = 500
)

// Tools returns the read tools, plus write, edit and shell for a write session. A read session has no
// way to change a file or start a process: that is how ask enforces read-only.
func Tools(write bool) []Tool {
	tools := []Tool{
		{"read", "Read a file. Returns its text, up to 64 KiB from the optional 1-based start line; call again with a later start line for more.",
			schema(`{"path":{"type":"string","description":"File path, relative to the working directory"},"line":{"type":"integer","description":"1-based line to start from"}}`, "path"), readFile},
		{"list", "List a directory's entries, directories with a trailing slash. Omit path for the working directory.",
			schema(`{"path":{"type":"string","description":"Directory path, relative to the working directory"}}`), listDir},
		{"grep", "Search file contents with a regular expression, recursively from path (default: the working directory). Returns matching lines as path:line:text, at most 200.",
			schema(`{"pattern":{"type":"string","description":"Regular expression"},"path":{"type":"string","description":"File or directory to search"},"glob":{"type":"string","description":"Only files matching this glob, like *.go"}}`, "pattern"), grep},
	}
	if write {
		tools = append(tools,
			Tool{"write", "Create or replace a file with the given content, creating parent directories.",
				schema(`{"path":{"type":"string"},"content":{"type":"string"}}`, "path", "content"), writeFile},
			Tool{"edit", "Replace one exact occurrence of old with new in a file. Fails unless old occurs exactly once.",
				schema(`{"path":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"}}`, "path", "old", "new"), editFile},
			Tool{"shell", "Run a shell command in the working directory and return its exit status and output. Default timeout 120 seconds, at most 600.",
				schema(`{"command":{"type":"string"},"timeout":{"type":"integer","description":"Seconds before the command is stopped"}}`, "command"), shell},
		)
	}
	return tools
}

// schema builds a strict object schema from a properties literal and its required names.
func schema(properties string, required ...string) json.RawMessage {
	if required == nil {
		required = []string{}
	}
	req, _ := json.Marshal(required)
	return json.RawMessage(`{"type":"object","properties":` + properties + `,"required":` + string(req) + `,"additionalProperties":false}`)
}

// resolve confines a tool path to the session's directory, following symlinks in what exists.
func resolve(dir, path string) (string, error) {
	if path == "" {
		path = "."
	}
	full := path
	if !filepath.IsAbs(full) {
		full = filepath.Join(dir, full)
	}
	full = filepath.Clean(full)
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	// Resolve the deepest existing ancestor so a symlink cannot point outside the directory.
	probe := full
	for {
		if real, err := filepath.EvalSymlinks(probe); err == nil {
			rest := strings.TrimPrefix(full, probe)
			full = real + rest
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
		probe = parent
	}
	if full != root && !strings.HasPrefix(full, root+string(filepath.Separator)) {
		return "", fmt.Errorf("%s is outside the working directory", path)
	}
	return full, nil
}

func readFile(_ context.Context, dir string, args config.Object) (string, error) {
	path, err := resolve(dir, args.S("path"))
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := config.UTF8(b)
	start := int(args.N("line"))
	if start > 1 {
		lines := strings.SplitAfter(text, "\n")
		if start > len(lines) {
			return "", fmt.Errorf("%s has only %d lines", args.S("path"), len(lines))
		}
		text = strings.Join(lines[start-1:], "")
	}
	if len(text) > readLimit {
		cut := readLimit
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		if nl := strings.LastIndexByte(text[:cut], '\n'); nl > 0 {
			cut = nl + 1
		}
		shown := strings.Count(text[:cut], "\n")
		text = text[:cut] + fmt.Sprintf("\n[truncated; continue from line %d]", max(start, 1)+shown)
	}
	return text, nil
}

func listDir(_ context.Context, dir string, args config.Object) (string, error) {
	path, err := resolve(dir, args.S("path"))
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", err
	}
	names := []string{}
	for _, e := range entries {
		n := e.Name()
		if n == ".git" {
			continue
		}
		if e.IsDir() {
			n += "/"
		}
		names = append(names, n)
	}
	sort.Strings(names)
	if len(names) > listLimit {
		names = append(names[:listLimit], fmt.Sprintf("[%d more entries]", len(names)-listLimit))
	}
	if len(names) == 0 {
		return "(empty)", nil
	}
	return strings.Join(names, "\n"), nil
}

// grep prefers ripgrep, then git grep inside a repository, then POSIX grep.
func grep(ctx context.Context, dir string, args config.Object) (string, error) {
	pattern := args.S("pattern")
	if pattern == "" {
		return "", errors.New("pattern is required")
	}
	path, err := resolve(dir, args.S("path"))
	if err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(dir, path)
	if rel == "" || strings.HasPrefix(rel, "..") {
		rel = path
	}
	var cmd *exec.Cmd
	glob := args.S("glob")
	switch {
	case onPath("rg"):
		a := []string{"-n", "--no-heading", "--color", "never", "--max-count", "200", "-e", pattern}
		if glob != "" {
			a = append(a, "-g", glob)
		}
		cmd = exec.CommandContext(ctx, "rg", append(a, rel)...)
	case onPath("git") && inRepo(dir):
		a := []string{"-c", "core.fsmonitor=false", "grep", "-n", "-I", "-E", "-e", pattern, "--", rel}
		if glob != "" {
			a = append(a, filepath.Join(rel, "**", glob))
		}
		cmd = exec.CommandContext(ctx, "git", a...)
	default:
		a := []string{"-rn", "-I", "-E", "-e", pattern}
		if glob != "" {
			a = append(a, "--include", glob)
		}
		cmd = exec.CommandContext(ctx, "grep", append(a, rel)...)
	}
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	text := config.UTF8(out)
	if err != nil && text == "" {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
			return "(no matches)", nil
		}
		return "", fmt.Errorf("search failed: %s", strings.TrimSpace(config.UTF8(exitStderr(err))))
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) > 200 {
		lines = append(lines[:200], "[more matches not shown]")
	}
	return clip(strings.Join(lines, "\n"), outputLimit), nil
}

func exitStderr(err error) []byte {
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.Stderr
	}
	return []byte(err.Error())
}

func onPath(name string) bool { _, err := exec.LookPath(name); return err == nil }

func inRepo(dir string) bool {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--is-inside-work-tree")
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	return cmd.Run() == nil
}

func writeFile(_ context.Context, dir string, args config.Object) (string, error) {
	path, err := resolve(dir, args.S("path"))
	if err != nil {
		return "", err
	}
	if !args.Has("content") {
		return "", errors.New("content is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(args.S("content")), 0644); err != nil {
		return "", err
	}
	return "wrote " + args.S("path"), nil
}

func editFile(_ context.Context, dir string, args config.Object) (string, error) {
	path, err := resolve(dir, args.S("path"))
	if err != nil {
		return "", err
	}
	old := args.S("old")
	if old == "" {
		return "", errors.New("old must not be empty")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := string(b)
	switch strings.Count(text, old) {
	case 0:
		return "", errors.New("old text not found in " + args.S("path"))
	case 1:
	default:
		return "", errors.New("old text occurs more than once in " + args.S("path") + "; include more context")
	}
	info, _ := os.Stat(path)
	mode := os.FileMode(0644)
	if info != nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(path, []byte(strings.Replace(text, old, args.S("new"), 1)), mode); err != nil {
		return "", err
	}
	return "edited " + args.S("path"), nil
}

func shell(ctx context.Context, dir string, args config.Object) (string, error) {
	command := args.S("command")
	if config.Trim(command) == "" {
		return "", errors.New("command is required")
	}
	timeout := args.N("timeout")
	if timeout <= 0 {
		timeout = 120
	}
	if timeout > 600 {
		timeout = 600
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			close(stop)
		case <-done:
		}
	}()
	r := process.Run("sh", []string{"-c", command}, process.Options{Dir: dir, Env: toolEnv(), Timeout: time.Duration(timeout * float64(time.Second)), Stop: stop})
	close(done)
	var b strings.Builder
	switch {
	case r.TimedOut:
		b.WriteString("timed out after " + strconv.Itoa(int(timeout)) + " seconds\n")
	case r.Signal != 0:
		b.WriteString("killed by " + process.SignalName(r.Signal) + "\n")
	default:
		b.WriteString("exit " + strconv.Itoa(r.Code) + "\n")
	}
	if r.Stdout != "" {
		b.WriteString(clip(r.Stdout, outputLimit))
		if !strings.HasSuffix(r.Stdout, "\n") {
			b.WriteString("\n")
		}
	}
	if r.Stderr != "" {
		b.WriteString("stderr:\n" + clip(r.Stderr, outputLimit/2))
	}
	return b.String(), nil
}

// External is a tool an extension provides: an executable that reads the call's arguments as
// JSON on stdin, runs in the session's directory and writes its result on stdout. It runs at
// most 120 seconds and sees the same environment as the shell tool.
func External(name, description string, parameters json.RawMessage, path string) Tool {
	if len(parameters) == 0 {
		parameters = schema(`{}`)
	}
	return Tool{name, description, parameters, func(ctx context.Context, dir string, args config.Object) (string, error) {
		stop := make(chan struct{})
		done := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				close(stop)
			case <-done:
			}
		}()
		r := process.Run(path, nil, process.Options{Input: config.JSON(args, false), Dir: dir, Env: toolEnv(), Timeout: 120 * time.Second, Stop: stop})
		close(done)
		switch {
		case r.TimedOut:
			return "", errors.New(name + " timed out after 120 seconds")
		case r.Code != 0:
			why := process.Reason(r.Stderr)
			if why == "" {
				why = "exit " + strconv.Itoa(r.Code)
			}
			return "", errors.New(why)
		}
		return clip(r.Stdout, outputLimit), nil
	}}
}

// toolEnv is the environment commands run with: the worker's, minus provider credentials
// (*_API_KEY) and ask's own variables, which a command has no business reading.
func toolEnv() []string {
	env := []string{}
	for _, e := range os.Environ() {
		k, _, _ := strings.Cut(e, "=")
		if strings.HasSuffix(k, "_API_KEY") || strings.HasPrefix(k, "ASK_") {
			continue
		}
		env = append(env, e)
	}
	return env
}

// clip keeps the start of long output and says how much was cut.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("\n[truncated %d bytes]", len(s)-cut)
}
