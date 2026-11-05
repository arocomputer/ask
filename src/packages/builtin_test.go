package packages

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/arocomputer/ask/src/find"
	"github.com/arocomputer/ask/src/home"
)

func TestBuiltinReplacement(t *testing.T) {
	t.Run("failed promotion restores the previous tree", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "agent")
		if err := os.Mkdir(dir, 0755); err != nil {
			t.Fatal(err)
		}
		old := filepath.Join(dir, "previous")
		if err := os.WriteFile(old, []byte("old installation"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := replaceBuiltin(dir, filepath.Join(t.TempDir(), "missing")); err == nil {
			t.Fatal("missing staged tree was promoted")
		}
		if got, err := os.ReadFile(old); err != nil || string(got) != "old installation" {
			t.Fatalf("previous installation lost: %q, %v", got, err)
		}
	})
	t.Run("refresh recovers a replacement interrupted before promotion", func(t *testing.T) {
		p := home.Paths{Packages: t.TempDir()}
		if _, err := InstallBuiltin(p, "claude"); err != nil {
			t.Fatal(err)
		}
		dir := BuiltinDir(p, "claude")
		backup := filepath.Join(filepath.Dir(dir), ".claude.previous")
		if err := os.Rename(dir, backup); err != nil {
			t.Fatal(err)
		}
		if got := find.PackageDirs(p); len(got) != 0 {
			t.Fatalf("replacement artifacts discovered as packages: %v", got)
		}
		if err := Refresh(p); err != nil {
			t.Fatal(err)
		}
		if !current(p, "claude") {
			t.Fatal("interrupted replacement was not restored")
		}
		if _, err := os.Stat(backup); !os.IsNotExist(err) {
			t.Fatalf("backup remains after recovery: %v", err)
		}
	})
	t.Run("recovery after promotion keeps the replacement", func(t *testing.T) {
		parent := t.TempDir()
		dir := filepath.Join(parent, "agent")
		backup := filepath.Join(parent, ".agent.previous")
		for _, path := range []string{dir, backup} {
			if err := os.Mkdir(path, 0755); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(dir, "new"), []byte("replacement"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := recoverBuiltin(dir); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(dir, "new")); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(backup); !os.IsNotExist(err) {
			t.Fatalf("old backup remains: %v", err)
		}
	})
}
