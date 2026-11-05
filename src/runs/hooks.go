package runs

import (
	"sort"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/hooks"
	"github.com/arocomputer/ask/src/process"
	"github.com/arocomputer/ask/src/task"
)

// chain combines two file changes, dropping an added file that was subsequently deleted.
func chain(first, second string) string {
	if first == "added" {
		if second == "deleted" {
			return ""
		}
		return "added"
	}
	if first == "deleted" {
		if second == "added" {
			return "modified"
		}
		return "deleted"
	}
	return second
}

// AddUsage sums usage objects, keeping each count and cost only when one reports it; nil when none has usage.
func AddUsage(list ...any) any {
	var sum home.Object
	for _, v := range list {
		part, ok := v.(home.Object)
		if !ok || !home.Truth(v) {
			continue
		}
		if sum == nil {
			sum = home.Object{}
		}
		for _, key := range []string{"input", "output", "cached", "cost"} {
			if part.Has(key) {
				sum.Set(key, sum.N(key)+part.N(key))
			}
		}
	}
	if sum == nil {
		return nil
	}
	return sum
}

// completeUsage sums only metrics reported by both rounds; an unknown round makes the total unknown.
func completeUsage(a, b any) any {
	first, ok := a.(home.Object)
	if !ok {
		return nil
	}
	second, ok := b.(home.Object)
	if !ok {
		return nil
	}
	sum, _ := AddUsage(first, second).(home.Object)
	for _, key := range []string{"input", "output", "cached", "cost"} {
		if !first.Has(key) || !second.Has(key) {
			delete(sum, key)
		}
	}
	if len(sum) == 0 {
		return nil
	}
	return sum
}

// combine keeps the last answer while summing time, usage, commits and cumulative file changes.
func combine(a, b home.Object) home.Object {
	x := b.Clone()
	x.Set("seconds", home.Number(home.Fixed(a.N("seconds")+b.N("seconds"), 1)))
	x.Set("usage", completeUsage(a.Get("usage"), b.Get("usage")))
	x.Set("followups", a.N("followups")+1)
	if a.Has("changes") || b.Has("changes") {
		files := map[string]string{}
		if list, ok := a.Get("changes").([]any); ok {
			for _, v := range list {
				c, _ := v.(home.Object)
				files[c.S("path")] = c.S("change")
			}
		}
		if list, ok := b.Get("changes").([]any); ok {
			for _, v := range list {
				c, _ := v.(home.Object)
				path := c.S("path")
				if first, ok := files[path]; ok {
					files[path] = chain(first, c.S("change"))
				} else {
					files[path] = c.S("change")
				}
			}
		}
		paths := []string{}
		for p, c := range files {
			if c != "" {
				paths = append(paths, p)
			}
		}
		sort.Strings(paths)
		list := []any{}
		for _, p := range paths {
			list = append(list, home.O("path", p, "change", files[p]))
		}
		x.Set("changes", list)
		x.Set("commits", a.N("commits")+b.N("commits"))
		if a.B("worktree") && !b.B("worktree") && len(list) > 0 {
			x.Set("worktree", a.Get("worktree"))
		}
	}
	return x
}

// withHooks applies refusal and result decisions, allowing at most three session follow-ups.
func withHooks(a *agent.Registry, h *hooks.Hooks, t home.Object, ref, events string, report func(Event)) (final home.Object) {
	var worktree *git.Worktree
	defer func() {
		if worktree == nil {
			return
		}
		if !process.Stopping() && git.Unchanged(worktree) && git.Remove(worktree) {
			final.Delete("worktree")
		} else if final != nil {
			final.Set("worktree", home.O("path", worktree.Path, "branch", worktree.Branch))
		}
	}()
	if h != nil {
		changed, refused, notes := h.Before(t, ref)
		for _, n := range notes {
			report(Event{Kind: "note", Note: n})
		}
		t = changed
		if refused != "" {
			return home.O("id", t.Get("id"), "model", t.Get("model"), "name", t.Get("model"), "ok", false, "error", "refused by hook "+refused, "seconds", 0, "usage", nil, "session", nil, "dir", t.Get("dir"))
		}
	}
	started := func(info task.Started) { worktree = info.Worktree; report(Event{Kind: "start", Started: info}) }
	var earlier any // usage of finished rounds, so live usage keeps counting through follow-ups
	following := false
	progress := func(p agent.Progress) {
		report(Event{Kind: "metadata", Progress: p})
		if p.Usage != nil {
			var usage any = p.Usage
			if following {
				usage = completeUsage(earlier, p.Usage)
			}
			if sum, ok := usage.(home.Object); ok {
				report(Event{Kind: "usage", Result: sum})
			}
		}
		report(Event{Kind: "activity", Activity: p.Activity})
	}
	result := task.Run(a, t, h, events, started, progress)
	if process.Stopping() {
		return nil
	}
	for round := 0; h != nil; round++ {
		if process.Stopping() {
			return nil
		}
		x := home.O("run", ref)
		for key, val := range result {
			x.Set(key, val)
		}
		followup, fail, notes := h.After(t, x, ref)
		if process.Stopping() {
			return nil
		}
		for _, n := range notes {
			report(Event{Kind: "note", Note: n})
		}
		if fail != nil {
			result = result.Clone()
			result.Delete("answer")
			result.Delete("note")
			result.Set("ok", false)
			result.Set("error", "failed by hook "+fail.Name+": "+fail.Text)
			return result
		}
		if followup == nil {
			break
		}
		if round == 3 || !result.B("session") {
			text := "asked for a follow-up, but the agent reported no session"
			if round == 3 {
				text = "asked for a follow-up after 3; stopping"
			}
			report(Event{Kind: "note", Note: hooks.Note{Name: followup.Name, Text: text}})
			break
		}
		report(Event{Kind: "followup", Note: *followup})
		next := t.Clone()
		if worktree != nil {
			next.Set("kept_worktree", home.O("path", worktree.Path, "branch", worktree.Branch))
			next.Set("reuse", true)
		}
		next.Set("prompt", followup.Text)
		next.Set("session", result.Get("session"))
		earlier = result.Get("usage")
		following = true
		nextResult := task.Run(a, next, h, events, started, progress)
		if process.Stopping() {
			return nil
		}
		result = combine(result, nextResult)
	}
	return result
}
