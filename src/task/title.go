package task

import (
	"strings"
	"unicode"
)

// JobTitle uses a supplied description or the prompt's first line, avoiding model text already in the label.
func JobTitle(description, prompt, label string) string {
	parts := strings.Split(strings.TrimSpace(description), " · ")
	for len(parts) > 1 && saidIn(label, parts[0]) {
		parts = parts[1:]
	}
	text := strings.TrimSpace(strings.Join(parts, " · "))
	if text == "" {
		text, _, _ = strings.Cut(strings.TrimSpace(prompt), "\n")
		r := []rune(text)
		if len(r) > 60 {
			text = string(r[:59]) + "…"
		}
	}
	text = strings.Join(strings.Fields(text), " ")
	r := []rune(text)
	if len(r) > 0 {
		r[0] = unicode.ToUpper(r[0])
	}
	return string(r)
}

// saidIn reports whether part repeats one of label's parts, such as its model with or without effort.
func saidIn(label, part string) bool {
	part = strings.ToLower(strings.TrimSpace(part))
	for _, have := range strings.Split(strings.ToLower(label), " · ") {
		if part != "" && (have == part || strings.HasPrefix(have, part+" (")) {
			return true
		}
	}
	return false
}

// Title is the one-line, user-facing name for a task's agent session.
func Title(model, prompt, override string, write, worktree bool) string {
	line := JobTitle(override, prompt, model)
	runes := []rune(line)
	if override == "" && len(runes) > 60 {
		line = string(runes[:59]) + "…"
	}
	runes = []rune(line)
	if len(runes) > 0 {
		runes[0] = unicode.ToUpper(runes[0])
		line = string(runes)
	}
	if line != "" {
		model += " · " + line
	}
	if worktree && write {
		return model + " · worktree"
	}
	if write {
		return model + " · write"
	}
	return model
}
