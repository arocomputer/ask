package test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// BenchmarkLatency times complete subprocesses, including output capture. TestMain builds both
// binaries before benchmarks run; fixture reset and completion checks are outside the timer.
func BenchmarkLatency(b *testing.B) {
	for _, c := range []struct {
		name string
		args []string
	}{
		{"startup", []string{"help"}},
		{"task", []string{"--model", "fake:small", "--read", "--timeout", "10", "hello"}},
	} {
		b.Run(c.name, func(b *testing.B) {
			b.StopTimer()
			s := fresh(b)
			s.env["ASK_NO_UPDATE_CHECK"] = "1"
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				// Keep run-name lookup and fake logging independent of the iteration count.
				if e := os.RemoveAll(filepath.Join(s.home, "runs")); e != nil {
					b.Fatal(e)
				}
				if e := os.Remove(s.log); e != nil && !os.IsNotExist(e) {
					b.Fatal(e)
				}
				cmd := exec.Command(askBin, c.args...)
				cmd.Dir = s.tmp
				for k, v := range s.env {
					cmd.Env = append(cmd.Env, k+"="+v)
				}
				var stdout, stderr bytes.Buffer
				cmd.Stdout, cmd.Stderr = &stdout, &stderr

				b.StartTimer()
				e := cmd.Run()
				b.StopTimer()

				if e != nil {
					b.Fatalf("ask %v: %v\n%s", c.args, e, stderr.String())
				}
				calls := s.calls()
				if c.name == "startup" {
					if !strings.Contains(stdout.String(), "ask [options] PROMPT") || len(calls) != 0 {
						b.Fatalf("expected help without an agent call; stdout=%q calls=%v", stdout.String(), calls)
					}
					continue
				}
				if stdout.String() != "fake: hello\n" || len(calls) != 1 || calls[0].s("stdin") != "hello" || calls[0].s("model") != "small" {
					b.Fatalf("expected one completed fake task; stdout=%q calls=%v", stdout.String(), calls)
				}
				if dirs := s.dirs(); len(dirs) != 1 {
					b.Fatalf("expected one saved run, got %v", dirs)
				}
				results := s.runFile("results.json")
				if len(results) != 1 || !results[0].b("ok") || results[0].s("answer") != "fake: hello" {
					b.Fatalf("expected a successful saved answer, got %v", results)
				}
			}
		})
	}
}
