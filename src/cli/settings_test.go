package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/tui"
)

func TestSettingsApply(t *testing.T) {
	t.Run("review reports a partial save without claiming saved", func(t *testing.T) {
		root := t.TempDir()
		t.Setenv("HOME", root)
		t.Setenv("ASK_HOME", filepath.Join(root, "ask"))
		if err := os.Mkdir(filepath.Join(root, ".codex"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".codex", "skills"), []byte("blocked"), 0600); err != nil {
			t.Fatal(err)
		}
		d, err := newDraft(home.New())
		if err != nil {
			t.Fatal(err)
		}
		d.skills["codex"] = true
		if err := d.set("jobs", "7"); err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		saved, err := d.review(&tui.Prompter{In: strings.NewReader("\r"), Out: &out})
		if saved || err == nil || !strings.Contains(err.Error(), "some changes may already be saved") {
			t.Fatalf("review hid partial application: saved=%v, err=%v", saved, err)
		}
		if strings.Contains(out.String(), "saved\r\n") {
			t.Fatalf("review claimed success: %q", out.String())
		}
		s, err := d.p.ReadSettings()
		if err != nil || s.N("jobs") != 7 {
			t.Fatalf("successful part was lost: %v, %v", s, err)
		}
	})
	for _, part := range []string{"settings", "models", "hook", "skill", "removal"} {
		t.Run(part+" failure is reported and independent changes still apply", func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("ASK_HOME", filepath.Join(root, "ask"))
			p := home.New()
			if err := os.MkdirAll(p.Home, 0700); err != nil {
				t.Fatal(err)
			}
			d, err := newDraft(p)
			if err != nil {
				t.Fatal(err)
			}
			if err := d.set("jobs", "7"); err != nil {
				t.Fatal(err)
			}
			blocked := filepath.Join(p.Home, "settings.json")
			switch part {
			case "models":
				blocked = filepath.Join(p.Home, "models.json")
			case "hook":
				d.hook = true
				blocked = filepath.Join(root, ".claude", "settings.json")
			case "skill":
				d.skills["codex"] = true
				blocked = filepath.Join(root, ".codex", "skills", "ask", "SKILL.md")
			case "removal":
				d.remove["claude"] = true
				blocked = ""
			}
			if blocked != "" {
				if err := os.MkdirAll(blocked, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var messages []string
			if d.apply(func(mark, text string) { messages = append(messages, mark+" "+text) }) {
				t.Fatal("failed apply reported success")
			}
			if !strings.Contains(strings.Join(messages, "\n"), "✗ ") {
				t.Fatalf("failure was hidden: %v", messages)
			}
			if part != "settings" {
				saved, err := p.ReadSettings()
				if err != nil || saved.N("jobs") != 7 {
					t.Fatalf("independent settings change was lost: %v, %v", saved, err)
				}
			}
		})
	}
}
