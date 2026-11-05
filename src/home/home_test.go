package home

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestTildeNeedsPathBoundary avoids shortening another user's home prefix.
func TestTildeNeedsPathBoundary(t *testing.T) {
	h, _ := os.UserHomeDir()
	if got := Tilde(h + "other/x"); got != h+"other/x" {
		t.Fatal(got)
	}
	if got := Tilde(filepath.Join(h, "x")); got != "~/x" {
		t.Fatal(got)
	}
}

// TestConcurrentWriteJSON never shares a temporary pathname between writers.
func TestConcurrentWriteJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "results.json")
	var wg sync.WaitGroup
	errors := make(chan error, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errors <- WriteJSON(path, strings.Repeat("x", 10000)+string(rune('a'+i%26)))
		}(i)
	}
	wg.Wait()
	close(errors)
	for e := range errors {
		if e != nil {
			t.Fatal(e)
		}
	}
}
