// Package setup knows what ask setup offers: the official agents and whether their CLIs are
// installed, the ask skill for each host that reads skills, and Claude Code's title hook. It
// reports state and makes changes; the CLI decides what to ask and when.
package setup

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/arocomputer/ask/internal/home"
)

// Agent is an official agent package and the CLI it runs.
type Agent struct{ Name, CLI, Title string }

// Agents are the official agents ask setup offers, built into ask from packages/NAME.
var Agents = []Agent{
	{"claude", "claude", "Claude Code"},
	{"codex", "codex", "Codex"},
	{"opencode", "opencode", "OpenCode (v1 or v2)"},
	{"copilot", "copilot", "GitHub Copilot CLI"},
	{"gemini", "gemini", "Gemini CLI"},
	{"pi", "pi", "Pi"},
	{"e", "e", "e"},
	{"cursor", "cursor-agent", "Cursor CLI"},
	{"aider", "aider", "Aider"},
	{"amp", "amp", "Amp"},
	{"qwen", "qwen", "Qwen Code"},
	{"kimi", "kimi", "Kimi Code"},
	{"goose", "goose", "Goose"},
	{"cline", "cline", "Cline CLI"},
	{"kilo", "kilo", "Kilo CLI"},
	{"continue", "cn", "Continue CLI"},
	{"openhands", "openhands", "OpenHands CLI"},
	{"vibe", "vibe", "Mistral Vibe"},
}

// FindCLI returns where a CLI is installed, looking on PATH and where installers put it, or "".
func FindCLI(name string) string {
	if path, e := exec.LookPath(name); e == nil {
		return path
	}
	h, _ := os.UserHomeDir()
	for _, dir := range []string{filepath.Join(h, ".local", "bin"), filepath.Join(h, ".claude", "local"), filepath.Join(h, "."+name, "bin"),
		"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", filepath.Join(h, ".bun", "bin"), filepath.Join(h, ".npm-global", "bin")} {
		path := filepath.Join(dir, name)
		if info, e := os.Stat(path); e == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return path
		}
	}
	if name == "cursor-agent" {
		return FindCLI("agent")
	}
	return ""
}

// Host is an app that reads skills from SkillDir, present when its config folder exists.
type Host struct{ Name, Title, Config, SkillDir string }

// Hosts are the apps ask setup can teach to use ask, by their skill folders.
func Hosts() []Host {
	h, _ := os.UserHomeDir()
	at := func(parts ...string) string { return filepath.Join(append([]string{h}, parts...)...) }
	return []Host{
		{"claude-code", "Claude Code", at(".claude"), at(".claude", "skills", "ask")},
		{"codex", "Codex", at(".codex"), at(".codex", "skills", "ask")},
		{"opencode", "Opencode", at(".config", "opencode"), at(".config", "opencode", "skills", "ask")},
		{"cursor", "Cursor", at(".cursor"), at(".cursor", "skills", "ask")},
		{"pi", "pi", at(".pi", "agent"), at(".pi", "agent", "skills", "ask")},
	}
}

// Present reports whether the host is installed here.
func (h Host) Present() bool { info, e := os.Stat(h.Config); return e == nil && info.IsDir() }

// mark is the line that says ask setup wrote a skill and may update it.
const mark = "<!-- Written by ask setup, which keeps it up to date. Delete this line to keep your own edits. -->"

// Skill is the ask skill, in the SKILL.md format Claude Code, Codex, Opencode, Cursor and pi share.
const Skill = `---
name: ask
description: Delegate focused questions, reviews or implementation tasks to coding agents through Ask, including independent tasks in parallel or a second model's opinion.
---
` + mark + `

Run ` + "`ask help`" + ` for usage, ` + "`ask help COMMAND`" + ` for a command's options,
` + "`ask models`" + ` for the models available here, ` + "`ask models --roles`" + ` for user-defined roles, and
` + "`ask docs PAGE`" + ` (or ` + "`ask docs --search TERM`" + `) for the full docs.

Use Ask when an independent investigation, review or bounded implementation can move the work
forward. Handle small, tightly coupled steps directly when a handoff would cost more than it helps.
Give each task the goal, relevant files or context, constraints and the evidence you want back.
For a review, ask for concrete findings with file and line references; for a fix, name the scope
and validation to run. Review the returned evidence and changes before integrating them.

- ` + "`ask \"prompt\"`" + ` or ` + "`ask run \"prompt\"`" + `: a read-only answer, using the configured default model; use ` + "`--model MODEL`" + ` to choose one.
- ` + "`git diff | ask --stdin \"Review this diff for bugs; give file, line and impact.\"`" + `: append the diff to the instruction. An argument prompt includes stdin only with ` + "`--stdin`" + `; ` + "`git diff | ask`" + ` uses stdin alone as the prompt.
- ` + "`ask run --model MODEL --write \"task\"`" + `: let it edit files and run commands; add ` + "`--worktree`" + ` to work on its own branch.
- ` + "`ask continue RUN \"follow-up\"`" + `: follow up in that run's conversation, inheriting its model and read/write access unless overridden.
- ` + "`ask continue RUN`" + ` without a prompt: finish stopped/failed work in a usable saved session, otherwise restart and announce it; leave successful batch tasks alone. Running work gets wait guidance; completed work asks for a follow-up in a terminal. Auth/refusal/cost blockers require an explicit prompt after resolution.
- ` + "`ask batch FILE`" + `: many tasks in parallel, one JSON result array.

Delegate independent questions in a batch; give parallel write tasks separate worktrees and avoid
overlapping ownership. Running tests or builds needs write access. A worktree starts from HEAD,
so pass relevant uncommitted context explicitly. Choose models from ` + "`ask models`" + ` rather than guessing ids.

A role is an explicit user-defined alias for an exact model and effort, usable as MODEL in runs,
batches and benches. Respect the user's role choices; ask does not route tasks automatically.
Follow-ups inherit the recorded model even if the role changes later.

RUN is the name or id in a status line; use RUN/TASK for a batch task. Script aliases remain supported:
` + "`--continue RUN`" + ` / ` + "`-c RUN`" + ` for follow-ups, ` + "`ask batch --resume RUN`" + ` for batch recovery.

For parallel handoff, use ` + "`ask start [run options] \"task\"`" + `. It prints only a stable run ID
once a detached worker holds the run lock and has recorded pending work. Keep those IDs:

    a=$(ask start --model MODEL "first task")
    b=$(ask start --model MODEL "second task")
    finished=$(ask wait --id "$a" "$b")
    ask show "$finished"

` + "`ask wait A B`" + ` returns the first finished selection, including saved completions;
` + "`--id`" + ` prints identity only, without mixing the answer. Remove the returned ID from your
set before waiting for the rest; waiting does not consume results. Check wait's exit status:
1 means failed or stopped, 2 means a usage error. ` + "`ask wait ID`" + ` prints that run's answer.
` + "`ask stop ID`" + ` cancels its worker and agents; interrupting wait only stops waiting.
No-argument wait snapshots active work in the current repo (current directory outside git),
so use explicit IDs for handoff. Names move to their latest follow-up; IDs stay fixed.
Normal runs print only answers on stdout; start and wait --id explicitly print identity.
Status and errors go to stderr. Private worker logs contain lifecycle messages only.

If JSON/schema validation fails, ` + "`ask show RUN --json`" + ` includes ` + "`raw_answer`" + ` for inspection or repair;
the run still fails. Keep that content out of status logs; prefer ordinary text unless a structured
consumer needs JSON or a schema.
`

// SkillState is "missing", "current", "outdated" (written by an older ask) or "yours".
func SkillState(h Host) string {
	b, e := os.ReadFile(filepath.Join(h.SkillDir, "SKILL.md"))
	switch {
	case e != nil:
		return "missing"
	case string(b) == Skill:
		return "current"
	case strings.Contains(string(b), mark):
		return "outdated"
	}
	return "yours"
}

// WriteSkill adds or updates the ask skill for a host; it never replaces one it did not write.
func WriteSkill(h Host) error {
	if SkillState(h) == "yours" {
		return nil
	}
	if e := os.MkdirAll(h.SkillDir, 0755); e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(h.SkillDir, "SKILL.md"), []byte(Skill), 0644)
}

// HookCommand is the Claude Code PreToolUse command that titles ask runs.
const HookCommand = "ask title --hook"

// claudeSettings is Claude Code's user settings file.
func claudeSettings() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".claude", "settings.json")
}

// HookOn reports whether Claude Code runs a PreToolUse hook that titles ask runs, this one or
// one of your own (any command naming ask title or ask-title).
func HookOn() bool {
	b, e := os.ReadFile(claudeSettings())
	if e != nil {
		return false
	}
	var s struct {
		Hooks struct {
			PreToolUse []struct {
				Hooks []struct{ Command string } `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if json.Unmarshal(b, &s) != nil {
		return false
	}
	for _, m := range s.Hooks.PreToolUse {
		for _, h := range m.Hooks {
			if strings.Contains(h.Command, "ask title") || strings.Contains(h.Command, "ask-title") {
				return true
			}
		}
	}
	return false
}

// SetHook adds or removes ask's own title hook in Claude Code's settings.
func SetHook(on bool) error {
	path, _, after, e := HookEdit(on)
	if e != nil {
		return e
	}
	if e := os.MkdirAll(filepath.Dir(path), 0755); e != nil {
		return e
	}
	return os.WriteFile(path, after, 0644)
}

// HookEdit returns Claude Code's settings file with ask's own title hook added or removed, keeping
// every other setting, its order and its text as they are, and the file's text now ("" when it
// doesn't exist). Hooks you wrote yourself are left alone.
func HookEdit(on bool) (path string, before, after []byte, err error) {
	path = claudeSettings()
	b, e := os.ReadFile(path)
	if e == nil {
		before = b
	} else if os.IsNotExist(e) {
		b, e = []byte("{}"), nil
	}
	if e != nil {
		return path, nil, nil, e
	}
	keys, values, e := topLevel(b)
	if e != nil {
		return path, nil, nil, home.Usage("cannot read %s: %s", path, e)
	}
	hooks := map[string]any{}
	at := -1
	for i, k := range keys {
		if k == "hooks" {
			at = i
			if e := json.Unmarshal(values[i], &hooks); e != nil {
				return path, nil, nil, home.Usage("cannot read the hooks in %s: %s", path, e)
			}
		}
	}
	list, _ := hooks["PreToolUse"].([]any)
	kept := []any{}
	for _, m := range list {
		if entry, ok := m.(map[string]any); ok && isOurs(entry) {
			continue
		}
		kept = append(kept, m)
	}
	if on {
		kept = append(kept, map[string]any{"matcher": "Bash", "hooks": []any{map[string]any{"type": "command", "command": HookCommand}}})
	}
	if len(kept) == 0 {
		delete(hooks, "PreToolUse")
	} else {
		hooks["PreToolUse"] = kept
	}
	raw, _ := json.Marshal(hooks)
	switch {
	case len(hooks) == 0 && at >= 0:
		keys, values = append(keys[:at], keys[at+1:]...), append(values[:at], values[at+1:]...)
	case len(hooks) == 0:
	case at < 0:
		keys, values = append(keys, "hooks"), append(values, raw)
	default:
		values[at] = raw
	}
	var out bytes.Buffer
	out.WriteString("{")
	for i, k := range keys {
		if i > 0 {
			out.WriteString(",")
		}
		name, _ := json.Marshal(k)
		out.Write(name)
		out.WriteString(":")
		out.Write(values[i])
	}
	out.WriteString("}")
	var pretty bytes.Buffer
	if e := json.Indent(&pretty, out.Bytes(), "", "  "); e != nil {
		return path, nil, nil, e
	}
	pretty.WriteString("\n")
	return path, before, pretty.Bytes(), nil
}

// isOurs reports whether a PreToolUse entry is exactly the one SetHook adds.
func isOurs(entry map[string]any) bool {
	list, _ := entry["hooks"].([]any)
	if len(list) != 1 {
		return false
	}
	h, _ := list[0].(map[string]any)
	return h["command"] == HookCommand
}

// topLevel splits a JSON object into its keys and raw values, in order.
func topLevel(b []byte) ([]string, []json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	if t, e := dec.Token(); e != nil || t != json.Delim('{') {
		return nil, nil, os.ErrInvalid
	}
	keys, values := []string{}, []json.RawMessage{}
	for dec.More() {
		t, e := dec.Token()
		if e != nil {
			return nil, nil, e
		}
		var v json.RawMessage
		if e := dec.Decode(&v); e != nil {
			return nil, nil, e
		}
		keys, values = append(keys, t.(string)), append(values, v)
	}
	return keys, values, nil
}
