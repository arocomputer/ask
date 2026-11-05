// Package test exercises the real binary in isolated homes with a compiled fake agent.
package test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

var askBin, fakeBin, root string

// TestMain builds ask and the fake once for tests and benchmarks, using Go, git and a POSIX shell.
func TestMain(m *testing.M) {
	_, file, _, _ := runtime.Caller(0)
	root = filepath.Dir(filepath.Dir(filepath.Dir(file)))
	build, e := os.MkdirTemp("", "ask-test-build-")
	if e != nil {
		panic(e)
	}
	askBin = filepath.Join(build, "ask")
	fakeBin = filepath.Join(build, "fake")
	for _, item := range [][2]string{{askBin, "."}, {fakeBin, "./src/test/fake"}} {
		cmd := exec.Command("go", "build", "-o", item[0], item[1])
		cmd.Dir = root
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if e := cmd.Run(); e != nil {
			os.RemoveAll(build)
			os.Exit(1)
		}
	}
	code := m.Run()
	os.RemoveAll(build)
	os.Exit(code)
}

type object map[string]any

func (o object) s(k string) string { x, _ := o[k].(string); return x }

func (o object) n(k string) float64 { x, _ := o[k].(float64); return x }

func (o object) b(k string) bool { x, _ := o[k].(bool); return x }

type setup struct {
	t              testing.TB
	tmp, home, log string
	cwd            string // where ask runs; s.tmp when empty
	env            map[string]string
}

// fresh installs the fake in a realpath-normalized temp HOME and ASK_HOME for a test or benchmark.
func fresh(t testing.TB) *setup {
	t.Helper()
	tmp, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	s := &setup{t: t, tmp: tmp, home: filepath.Join(tmp, "home"), log: filepath.Join(tmp, "calls.jsonl")}
	s.env = map[string]string{"PATH": os.Getenv("PATH"), "HOME": tmp, "ASK_HOME": s.home, "FAKE_LOG": s.log}
	s.mkdir(filepath.Join(s.home, "agents"))
	if e := os.Symlink(fakeBin, filepath.Join(s.home, "agents", "fake")); e != nil {
		t.Fatal(e)
	}
	return s
}

func (s *setup) mkdir(path string) {
	s.t.Helper()
	if e := os.MkdirAll(path, 0755); e != nil {
		s.t.Fatal(e)
	}
}

func (s *setup) write(path, text string) {
	s.t.Helper()
	s.mkdir(filepath.Dir(path))
	if e := os.WriteFile(path, []byte(text), 0600); e != nil {
		s.t.Fatal(e)
	}
}

func (s *setup) json(path string, v any) {
	s.t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		s.t.Fatal(e)
	}
	s.write(path, string(b))
}

func (s *setup) read(path string) string {
	s.t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		s.t.Fatal(e)
	}
	return string(b)
}

func (s *setup) script(kind, name, body string) { s.t.Helper(); s.scriptAt(s.home, kind, name, body) }

func (s *setup) scriptAt(dir, kind, name, body string) {
	s.t.Helper()
	path := filepath.Join(dir, kind, name)
	s.write(path, "#!/bin/sh\n"+body+"\n")
	if e := os.Chmod(path, 0755); e != nil {
		s.t.Fatal(e)
	}
}

type output struct {
	code           int
	stdout, stderr string
}

type running struct {
	cmd  *exec.Cmd
	done chan output
}

// start exposes the child for signal tests and closes stdin after writing the prompt.
func (s *setup) start(args []string, input string, extra map[string]string) *running {
	s.t.Helper()
	cmd := exec.Command(askBin, args...)
	cmd.Dir = s.tmp
	if s.cwd != "" {
		cmd.Dir = s.cwd
	}
	env := map[string]string{}
	for k, v := range s.env {
		env[k] = v
	}
	for k, v := range extra {
		env[k] = v
	}
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if e := cmd.Start(); e != nil {
		s.t.Fatal(e)
	}
	r := &running{cmd: cmd, done: make(chan output, 1)}
	go func() {
		_ = cmd.Wait()
		r.done <- output{cmd.ProcessState.ExitCode(), stdout.String(), stderr.String()}
	}()
	s.t.Cleanup(func() { _ = cmd.Process.Kill() })
	return r
}

func (r *running) wait(t testing.TB) output {
	t.Helper()
	select {
	case out := <-r.done:
		return out
	case <-time.After(20 * time.Second):
		_ = r.cmd.Process.Kill()
		t.Fatal("ask did not finish")
		return output{}
	}
}

func (s *setup) ask(args ...string) output { s.t.Helper(); return s.run(args, "", nil) }

func (s *setup) run(args []string, input string, extra map[string]string) output {
	s.t.Helper()
	return s.start(args, input, extra).wait(s.t)
}

func (s *setup) calls() []object {
	s.t.Helper()
	b, e := os.ReadFile(s.log)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		s.t.Fatal(e)
	}
	out := []object{}
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		var call object
		if e := json.Unmarshal([]byte(line), &call); e != nil {
			s.t.Fatal(e)
		}
		out = append(out, call)
	}
	return out
}

func (s *setup) dirs() []string {
	s.t.Helper()
	entries, e := os.ReadDir(filepath.Join(s.home, "runs"))
	if e != nil {
		s.t.Fatal(e)
	}
	out := []string{}
	for _, d := range entries {
		out = append(out, d.Name())
	}
	return out
}

func (s *setup) runFile(name string) []object {
	s.t.Helper()
	return objects(s.t, s.read(filepath.Join(s.home, "runs", s.dirs()[0], name)))
}

func (s *setup) latest() string { s.t.Helper(); dirs := s.dirs(); return dirs[len(dirs)-1] }

func exists(path string) bool { _, e := os.Stat(path); return e == nil }

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func until(t *testing.T, condition func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if condition() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out waiting")
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v; want %#v", got, want)
	}
}

func match(t *testing.T, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%q does not match %q", text, pattern)
	}
}

func noMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%q unexpectedly matches %q", text, pattern)
	}
}

func objects(t testing.TB, text string) []object {
	t.Helper()
	var a []object
	if e := json.Unmarshal([]byte(text), &a); e != nil {
		t.Fatalf("bad JSON %q: %s", text, e)
	}
	return a
}

func obj(t testing.TB, text string) object {
	t.Helper()
	var o object
	if e := json.Unmarshal([]byte(text), &o); e != nil {
		t.Fatal(e)
	}
	return o
}

func jsonEqual(t *testing.T, got any, want any) {
	t.Helper()
	a, _ := json.Marshal(got)
	b, _ := json.Marshal(want)
	eq(t, string(a), string(b))
}

func runID(t *testing.T, stderr string) string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^ask ([\w-]+) `).FindStringSubmatch(stderr)
	if m == nil {
		t.Fatalf("no run id: %s", stderr)
	}
	return m[1]
}

func fields(list []object, keys ...string) [][]any {
	out := [][]any{}
	for _, o := range list {
		row := []any{}
		for _, k := range keys {
			row = append(row, o[k])
		}
		out = append(out, row)
	}
	return out
}

func stringsField(list []object, key string) []string {
	out := []string{}
	for _, o := range list {
		out = append(out, o.s(key))
	}
	return out
}

// repo creates a committed repository, independent of the developer's git configuration.
func (s *setup) repo() (string, func(...string) string) {
	s.t.Helper()
	dir := filepath.Join(s.tmp, "repo")
	s.mkdir(dir)
	git := s.gitAt(dir)
	git("init", "-q", "-b", "main")
	git("config", "user.email", "test@example.com")
	git("config", "user.name", "Test")
	s.write(filepath.Join(dir, "a.txt"), "one\n")
	git("add", ".")
	git("commit", "-qm", "first")
	return dir, git
}

func (s *setup) gitAt(dir string) func(...string) string {
	return func(args ...string) string {
		s.t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "HOME="+s.tmp, "GIT_CONFIG_NOSYSTEM=1")
		out, e := cmd.CombinedOutput()
		if e != nil {
			s.t.Fatalf("git %v: %s: %s", args, e, out)
		}
		return string(out)
	}
}

// hook installs a shell hook that records its input and contract variables before handling events.
func (s *setup) hook(name string, events []string, body string) {
	s.t.Helper()
	s.script("hooks", name, fmt.Sprintf("if [ \"$1\" = events ]; then printf '%%s\\n' '%s'; exit 0; fi\ninput=$(cat)\nprintf '{\"name\":\"%s\",\"event\":\"%%s\",\"input\":%%s,\"run\":\"%%s\"}\\n' \"$1\" \"$input\" \"$ASK_RUN\" >> \"$HOME/hook-calls\"\n%s", strings.Join(events, "\n"), name, body))
}

func (s *setup) hookCalls() []object {
	s.t.Helper()
	path := filepath.Join(s.tmp, "hook-calls")
	if !exists(path) {
		return nil
	}
	calls := []object{}
	for _, line := range strings.Split(strings.TrimSpace(s.read(path)), "\n") {
		calls = append(calls, obj(s.t, line))
	}
	return calls
}

func sorted(a []string) []string { sort.Strings(a); return a }

// localAgent installs a shell agent whose models are named, without a fake report.
func (s *setup) localAgent(name, body string) {
	s.t.Helper()
	s.script("agents", name, "PATH=/usr/bin:/bin:$PATH\nif [ \"$1\" = models ]; then printf 'small\\tSmall One\\nbig\\n'; exit 0; fi\n"+body)
}

// runIn runs ask in dir, for behavior that depends on the working directory.
func (s *setup) runIn(dir string, args ...string) output {
	s.t.Helper()
	s.cwd = dir
	defer func() { s.cwd = "" }()
	return s.ask(args...)
}
