package runs

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
)

// TestOwnerRequiresHeldLock treats a stale PID, even a reused live PID, as idle.
func TestOwnerRequiresHeldLock(t *testing.T) {
	r := &Run{Dir: t.TempDir()}
	if e := os.WriteFile(filepath.Join(r.Dir, "lock"), []byte(strconv.Itoa(os.Getpid())), 0600); e != nil {
		t.Fatal(e)
	}
	if got := Owner(r); got != 0 {
		t.Fatalf("stale lock owned by %d", got)
	}

}

// TestAddUsageKeepsOnlyReported never invents zero token counts for an agent that reports only cost.
func TestAddUsageKeepsOnlyReported(t *testing.T) {
	got := home.JSON(AddUsage(home.O("cost", 0.5), home.O("cost", 0.25)), false)
	if got != `{"cost":0.75}` {
		t.Fatal(got)
	}
}

func TestCompleteUsageOmitsMissingRounds(t *testing.T) {
	first := home.O("input", 100, "cost", 0.2)
	second := home.O("input", 50)
	got := completeUsage(first, second)
	if home.JSON(got, false) != `{"input":150}` {
		t.Fatalf("partial cost presented as total: %v", got)
	}
	if got := completeUsage(first, nil); got != nil {
		t.Fatalf("unreported round treated as zero: %v", got)
	}
}

func TestExecuteReloadsResultsAfterLock(t *testing.T) {
	root := t.TempDir()
	p := home.Paths{Home: root, Runs: filepath.Join(root, "runs")}
	r, err := Create(p, "abc123", "", []home.Object{home.O("id", "1", "prompt", "test", "model", "fake:small", "dir", root, "timeout", 1.0)})
	if err != nil {
		t.Fatal(err)
	}
	if err := home.WriteJSON(filepath.Join(r.Dir, "results.json"), home.ResultRecords([]home.Object{home.O("ok", true, "answer", "already done")})); err != nil {
		t.Fatal(err)
	}
	got, err := Execute(agent.New(p), r, 1, false, func(Event) { t.Error("finished task was rerun") }, nil)
	if err != nil || len(got) != 1 || !got[0].B("ok") {
		t.Fatalf("results: %v, error: %v", got, err)
	}
}

func TestCreate(t *testing.T) {
	t.Run("concurrent claims cannot share a human name", func(t *testing.T) {
		root := t.TempDir()
		p := home.Paths{Home: root, Runs: filepath.Join(root, "runs")}
		gate := make(chan struct{})
		var wg sync.WaitGroup
		claimed := make(chan *Run, 2)
		for _, id := range []string{"first1", "second"} {
			wg.Go(func() {
				<-gate
				r, err := Create(p, id, "same-name", []home.Object{home.O("id", "1", "prompt", id)})
				if err == nil {
					claimed <- r
				}
			})
		}
		close(gate)
		wg.Wait()
		close(claimed)
		if len(claimed) != 1 {
			t.Fatalf("got %d successful claims", len(claimed))
		}
		r := <-claimed
		opened, _, err := Open(p, "same-name")
		if err != nil || opened.ID != r.ID || opened.Tasks[0].S("prompt") != r.ID {
			t.Fatalf("name resolved the wrong work: %v %v", opened, err)
		}
	})
	t.Run("duplicate IDs cannot overwrite or shadow existing work", func(t *testing.T) {
		root := t.TempDir()
		p := home.Paths{Home: root, Runs: filepath.Join(root, "runs")}
		_, err := Create(p, "abc123", "name", []home.Object{home.O("id", "1", "prompt", "original")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Create(p, "abc123", "different", []home.Object{home.O("prompt", "replacement")}); err == nil {
			t.Fatal("duplicate ID accepted")
		}
		if _, err := Create(p, "new123", "abc123", []home.Object{home.O("prompt", "shadow")}); err == nil {
			t.Fatal("name shadowing an ID accepted")
		}
		r, _, err := Open(p, "abc123")
		if err != nil || r.Tasks[0].S("prompt") != "original" {
			t.Fatalf("original changed: %v %v", r, err)
		}
	})
}

func TestExecuteAdmission(t *testing.T) {
	for _, behavior := range []string{"readiness failure", "pending state failure"} {
		t.Run(behavior, func(t *testing.T) {
			root := t.TempDir()
			p := home.Paths{Home: root, Runs: filepath.Join(root, "runs")}
			r, err := Create(p, "abc123", "", []home.Object{home.O("id", "1", "prompt", "must not execute")})
			if err != nil {
				t.Fatal(err)
			}
			if behavior == "pending state failure" {
				if err := os.Mkdir(pendingPath(r), 0700); err != nil {
					t.Fatal(err)
				}
			}
			refused := errors.New("launcher disconnected")
			ready := false
			results, err := Execute(agent.New(p), r, 1, false, func(Event) {
				t.Error("task started before admission")
			}, func() error {
				ready = true
				return refused
			})
			if results != nil || err == nil || ready != (behavior == "readiness failure") {
				t.Fatalf("results %v, err %v, ready %v", results, err, ready)
			}
			if behavior == "readiness failure" && !errors.Is(err, refused) {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(r.Dir, "results.json")); !os.IsNotExist(err) {
				t.Fatalf("unadmitted work saved results: %v", err)
			}
		})
	}
}
