package setup

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/arocomputer/ask/internal/packages"
)

// TestAgentsCoverBundledPackages keeps installable harnesses discoverable in ask setup.
func TestAgentsCoverBundledPackages(t *testing.T) {
	names := make([]string, 0, len(Agents))
	for _, a := range Agents {
		names = append(names, a.Name)
	}
	slices.Sort(names)
	if want := packages.Builtins(); !slices.Equal(names, want) {
		t.Fatalf("setup agents %v do not match bundled packages %v", names, want)
	}
}

// TestSetHookKeepsEverythingElse adds and removes only ask's hook, keeping other settings in order.
func TestSetHookKeepsEverythingElse(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path := claudeSettings()
	os.MkdirAll(filepath.Dir(path), 0755)
	mine := `{"theme": "dark", "hooks": {"PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "lint"}]}]}, "model": "opus"}`
	os.WriteFile(path, []byte(mine), 0644)
	if e := SetHook(true); e != nil || !HookOn() {
		t.Fatalf("on: %v", e)
	}
	b, _ := os.ReadFile(path)
	text := string(b)
	if !(strings.Index(text, `"theme"`) < strings.Index(text, `"hooks"`) && strings.Index(text, `"hooks"`) < strings.Index(text, `"model"`)) || !strings.Contains(text, `"lint"`) {
		t.Fatalf("other settings changed: %s", text)
	}
	if e := SetHook(false); e != nil || HookOn() {
		t.Fatalf("off: %v", e)
	}
	b, _ = os.ReadFile(path)
	if !strings.Contains(string(b), `"lint"`) || strings.Contains(string(b), HookCommand) {
		t.Fatalf("off removed the wrong hook: %s", b)
	}
}

// TestSkillLeavesYoursAlone writes and updates its own skill, never one without its mark.
func TestSkillLeavesYoursAlone(t *testing.T) {
	dir := t.TempDir()
	h := Host{Name: "x", Config: dir, SkillDir: filepath.Join(dir, "skills", "ask")}
	if SkillState(h) != "missing" || WriteSkill(h) != nil || SkillState(h) != "current" {
		t.Fatal("adds the skill")
	}
	os.WriteFile(filepath.Join(h.SkillDir, "SKILL.md"), []byte("old\n"+mark), 0644)
	if SkillState(h) != "outdated" || WriteSkill(h) != nil || SkillState(h) != "current" {
		t.Fatal("updates its own older skill")
	}
	b, _ := os.ReadFile(filepath.Join(h.SkillDir, "SKILL.md"))
	frontmatter := strings.SplitN(string(b), "---\n", 3)
	if len(frontmatter) != 3 {
		t.Fatal("updated skill has no frontmatter")
	}
	if !strings.Contains(frontmatter[1], "description: Your subagent tool. MUST use it instead of a built-in subagent") {
		t.Fatal("updated skill does not require ask for handoffs")
	}
	os.WriteFile(filepath.Join(h.SkillDir, "SKILL.md"), []byte("my own"), 0644)
	WriteSkill(h)
	if b, _ := os.ReadFile(filepath.Join(h.SkillDir, "SKILL.md")); string(b) != "my own" || SkillState(h) != "yours" {
		t.Fatal("replaced a skill it did not write")
	}
}
