package test

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestAgents pins agent stdin, environment, schema files and optional report handling.
func TestAgents(t *testing.T) {
	t.Run("an agent is listed with its models.json ids, next to the others", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", "cat")
		s.json(filepath.Join(s.home, "models.json"), object{"echo": []string{"extra"}})
		r := s.ask("models")
		ids := []string{}
		for _, id := range strings.Split(strings.TrimSpace(r.stdout), "\n") {
			if strings.HasPrefix(id, "echo:") {
				ids = append(ids, id)
			}
		}
		eq(t, ids, []string{"echo:small", "echo:big", "echo:extra"})
	})
	t.Run("an agent gets the prompt on stdin, the run in its env and the directory as cwd", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `cat > "$HOME/prompt"; echo "$ASK_MODEL $ASK_EFFORT $ASK_ACCESS $(pwd)" > "$HOME/env"; echo answer`)
		r := s.ask("-m", "echo:small#high", "-w", "-C", s.tmp, "do it")
		eq(t, r.code, 0)
		eq(t, r.stdout, "answer\n")
		eq(t, s.read(filepath.Join(s.tmp, "prompt")), "do it")
		eq(t, strings.TrimSpace(s.read(filepath.Join(s.tmp, "env"))), "small high write "+s.tmp)
		match(t, r.stderr, ` · ok · Small One \(high\) · `)
	})
	t.Run("an agent gets --schema as a file in ASK_SCHEMA", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `cat "$ASK_SCHEMA" > "$HOME/schema"; echo '{"a": 1}'`)
		path := filepath.Join(s.tmp, "s.json")
		s.json(path, object{"type": "object"})
		r := s.ask("-m", "echo:small", "--schema", path, "go")
		eq(t, r.code, 0)
		jsonEqual(t, obj(t, s.read(filepath.Join(s.tmp, "schema"))), object{"type": "object"})
	})
	t.Run("a report names the model and gives usage and a note", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `echo '{"name": "Echo 2", "input": 1200, "output": 30, "cost": 0.5, "note": "partial"}' > "$ASK_REPORT"; echo ok`)
		r := s.ask("-m", "echo:big", "go")
		match(t, r.stderr, `(?m) · ok · Echo 2 · [\d.]+s · 1\.2k in · 30 out · \$0\.50 · partial$`)
	})
	t.Run("a failed agent's last stderr line is the error", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `echo noise >&2; echo "quota exceeded" >&2; exit 3`)
		r := s.ask("-m", "echo:big", "go")
		eq(t, r.code, 1)
		match(t, r.stderr, `(?m) · failed · .* · quota exceeded$`)
	})
	t.Run("an agent inherits no contract variable from an ask further up", func(t *testing.T) {
		s := fresh(t)
		path := filepath.Join(s.tmp, "s.json")
		s.json(path, object{"type": "object"})
		s.run([]string{"-m", "fake:small", "hi"}, "", map[string]string{"ASK_SCHEMA": path, "ASK_SESSION": "leaked"})
		_, hasSchema := s.calls()[0]["schema"]
		_, hasSession := s.calls()[0]["session"]
		eq(t, hasSchema, false)
		eq(t, hasSession, false)
	})
	t.Run("output split mid-character decodes, and a truncated character is replaced", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("stream", `cat >/dev/null; printf '\360\237'; sleep .01; printf '\220\247\342\202'`)
		r := s.ask("-m", "stream:small", "go")
		eq(t, r.code, 0)
		eq(t, r.stdout, "🐧�\n")
	})
}
