package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/arocomputer/ask/internal/home"
)

// TestRunReportsUsageWhileRunning delivers usage an agent rewrites its report with before it exits.
func TestRunReportsUsageWhileRunning(t *testing.T) {
	root := t.TempDir()
	p := home.Paths{Home: root, Agents: filepath.Join(root, "agents")}
	os.MkdirAll(p.Agents, 0700)
	script := "#!/bin/sh\necho '{\"input\":1200,\"output\":30}' > \"$ASK_REPORT\"\nsleep 1.2\n" +
		"echo '{\"input\":2400,\"output\":90,\"cost\":0.05}' > \"$ASK_REPORT\"\necho done\n"
	if e := os.WriteFile(filepath.Join(p.Agents, "x"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	seen := []home.Object{}
	r := New(p).Run(Model{Agent: "x", ID: "m"}, "hi", home.O("dir", root, "timeout", 10.0), func(u home.Object) { seen = append(seen, u) })
	if len(seen) == 0 || seen[0].N("input") != 1200 || seen[0].Has("cost") {
		t.Fatalf("no live usage before exit: %v", seen)
	}
	if u, _ := r.Get("usage").(home.Object); u.N("cost") != 0.05 {
		t.Fatalf("final usage: %v", r.Get("usage"))
	}
}
