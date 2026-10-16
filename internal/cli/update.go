package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
	"github.com/arocomputer/ask/internal/update"
)

// updateCommand runs ask update: it replaces a directly installed ask with the latest release,
// or says how to update one Homebrew or go install manages. --check only reports.
func updateCommand(p home.Paths, version string, check bool) (int, error) {
	if !update.Release(version) {
		fmt.Fprintf(os.Stderr, "ask: this is a development build (%s); update it from source\n", version)
		return 1, nil
	}
	var latest string
	e := updateProgress("Checking for updates", func() error {
		var err error
		latest, err = update.Latest(15 * time.Second)
		return err
	})
	if e != nil {
		return 0, e
	}
	remember(p, latest)
	if !update.Newer(latest, version) {
		fmt.Fprintf(os.Stderr, "ask: %s is the latest\n", version)
		return 0, nil
	}
	method := update.Method()
	if check || method != "direct" {
		fmt.Fprintf(os.Stderr, "ask: %s is out (you have %s); update with: %s\n", latest, version, update.Hint(method))
		if check {
			return 1, nil
		}
		return 0, nil
	}
	fmt.Fprintf(os.Stderr, "ask: updating %s to %s\n", version, latest)
	if e := updateProgress("Installing "+latest, func() error { return update.Apply(latest) }); e != nil {
		return 0, e
	}
	fmt.Fprintf(os.Stderr, "ask: updated to %s; see what's new: https://github.com/arocomputer/ask/releases/tag/%s\n", latest, latest)
	return 0, nil
}

// updateProgress adds transient terminal feedback without changing piped output.
func updateProgress(label string, work func() error) error {
	if status.IsTerminal(os.Stderr) {
		return tui.Activity(os.Stderr, label, status.UTF8(), process.OnStop, work)
	}
	return work()
}

// checked is the once-a-day record of the latest release, in ask's home.
type checked struct {
	At     time.Time `json:"at"`
	Latest string    `json:"latest"`
}

// remember records the latest release, so the notice needn't ask again today.
func remember(p home.Paths, latest string) {
	b, _ := json.Marshal(checked{time.Now(), latest})
	os.MkdirAll(p.Home, 0700)
	os.WriteFile(filepath.Join(p.Home, ".update-check"), b, 0600)
}

// notice tells a person at a terminal, at most once a day, that a newer ask is out. It never
// speaks in a pipe, to an agent, or for a development build, and ASK_NO_UPDATE_CHECK silences it.
func notice(p home.Paths, version string) {
	if !update.Release(version) || os.Getenv("ASK_NO_UPDATE_CHECK") != "" || !status.IsTerminal(os.Stderr) {
		return
	}
	var c checked
	if b, e := os.ReadFile(filepath.Join(p.Home, ".update-check")); e == nil {
		json.Unmarshal(b, &c)
	}
	if time.Since(c.At) > 24*time.Hour {
		latest, e := update.Latest(1500 * time.Millisecond)
		if e != nil {
			return
		}
		remember(p, latest)
		c.Latest = latest
		if update.Newer(latest, version) {
			text := fmt.Sprintf("\nask %s is out (you have %s): %s", latest, version, update.Hint(update.Method()))
			if status.CanStyle(os.Stderr) {
				text = "\x1b[2m" + text + "\x1b[0m"
			}
			fmt.Fprintln(os.Stderr, text)
		}
	}
}
