// Package test exercises the real binary in isolated homes, against a fake OpenAI server for
// the native harness and a compiled fake agent for the external contract.
package test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

var askBin, fakeBin, root string

// TestMain builds ask and the fake agent once.
func TestMain(m *testing.M) {
	_, file, _, _ := runtime.Caller(0)
	root = filepath.Dir(filepath.Dir(filepath.Dir(file)))
	build, e := os.MkdirTemp("", "ask-test-build-")
	if e != nil {
		panic(e)
	}
	askBin = filepath.Join(build, "ask")
	fakeBin = filepath.Join(build, "fake")
	for _, item := range [][2]string{{askBin, "."}, {fakeBin, "./internal/test/fake"}} {
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

// setup is one test's isolated ask: its own HOME and ASK_HOME, a fake provider, and the fake
// harness installed as the extension "fake", serving fake:MODEL.
type setup struct {
	t         testing.TB
	tmp, home string
	cwd       string
	env       map[string]string
	provider  *fakeProvider
}

// fresh makes an isolated home with the fake harness and a fake OpenAI endpoint.
func fresh(t testing.TB) *setup {
	t.Helper()
	tmp, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	s := &setup{t: t, tmp: tmp, home: filepath.Join(tmp, "home")}
	s.provider = newFakeProvider(t)
	s.env = map[string]string{
		"PATH": os.Getenv("PATH"), "HOME": tmp, "ASK_HOME": s.home, "FAKE_LOG": filepath.Join(tmp, "calls.jsonl"),
		"OPENAI_API_KEY": "test-key", "OPENAI_BASE_URL": s.provider.URL(),
	}
	ext := filepath.Join(s.home, "agent", "extensions", "fake")
	s.write(filepath.Join(ext, "extension.json"), `{"harness": {"prefix": "fake", "command": "fake"}}`)
	if e := os.Symlink(fakeBin, filepath.Join(ext, "fake")); e != nil {
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

func (s *setup) read(path string) string {
	s.t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		s.t.Fatal(e)
	}
	return string(b)
}

// config writes config.json.
func (s *setup) config(v any) {
	s.t.Helper()
	b, _ := json.Marshal(v)
	s.write(filepath.Join(s.home, "config.json"), string(b))
}

type output struct {
	code           int
	stdout, stderr string
}

type running struct {
	cmd  *exec.Cmd
	done chan output
}

// start runs ask with the setup's environment, stdin from input, in s.cwd or s.tmp.
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
	case <-time.After(30 * time.Second):
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

// launch starts a session and returns its ID, failing unless it was admitted.
func (s *setup) launch(args ...string) string {
	s.t.Helper()
	out := s.ask(args...)
	if out.code != 0 {
		s.t.Fatalf("launch failed: %d %s", out.code, out.stderr)
	}
	id := strings.TrimSpace(out.stdout)
	match(s.t, id, `^[0-9a-z]{6}$`)
	return id
}

// record reads a session's session.json, flattened: the session's fields with its latest
// turn's laid over them, plus "turns", the number of turns.
func (s *setup) record(id string) object {
	s.t.Helper()
	raw := obj(s.t, s.read(filepath.Join(s.sessionDir(id), "session.json")))
	turns := raw["turns"].([]any)
	out := object{}
	for k, v := range raw {
		if k != "turns" {
			out[k] = v
		}
	}
	for k, v := range turns[len(turns)-1].(map[string]any) {
		out[k] = v
	}
	out["turns"] = float64(len(turns))
	return out
}

// sessionDir is a session's folder.
func (s *setup) sessionDir(id string) string {
	s.t.Helper()
	entries, _ := os.ReadDir(filepath.Join(s.home, "agent", "sessions"))
	for _, d := range entries {
		if strings.HasSuffix(d.Name(), "-"+id) {
			return filepath.Join(s.home, "agent", "sessions", d.Name())
		}
	}
	s.t.Fatalf("no session %s", id)
	return ""
}

// hasSession reports whether a session's folder still exists.
func (s *setup) hasSession(id string) bool {
	entries, _ := os.ReadDir(filepath.Join(s.home, "agent", "sessions"))
	for _, d := range entries {
		if strings.HasSuffix(d.Name(), "-"+id) {
			return true
		}
	}
	return false
}

// calls reads what the fake harness logged.
func (s *setup) calls() []object {
	s.t.Helper()
	b, e := os.ReadFile(s.env["FAKE_LOG"])
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		s.t.Fatal(e)
	}
	out := []object{}
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line != "" {
			out = append(out, obj(s.t, line))
		}
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

// in runs ask in dir.
func (s *setup) in(dir string, args ...string) output {
	s.t.Helper()
	s.cwd = dir
	defer func() { s.cwd = "" }()
	return s.ask(args...)
}

func until(t testing.TB, condition func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if condition() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out waiting")
}

func exists(path string) bool { _, e := os.Stat(path); return e == nil }

func eq(t testing.TB, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v; want %#v", got, want)
	}
}

func match(t testing.TB, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%q does not match %q", text, pattern)
	}
}

func noMatch(t testing.TB, text, pattern string) {
	t.Helper()
	if regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%q unexpectedly matches %q", text, pattern)
	}
}

func obj(t testing.TB, text string) object {
	t.Helper()
	var o object
	if e := json.Unmarshal([]byte(text), &o); e != nil {
		t.Fatalf("bad JSON %q: %s", text, e)
	}
	return o
}

func objects(t testing.TB, text string) []object {
	t.Helper()
	var a []object
	if e := json.Unmarshal([]byte(text), &a); e != nil {
		t.Fatalf("bad JSON %q: %s", text, e)
	}
	return a
}
