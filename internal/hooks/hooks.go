// Package hooks implements ordered task, result, title and name hooks with fail-open errors and cached declarations.
package hooks

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/process"
)

// Hooks keeps an invocation's declared events and paths.
type Hooks struct {
	Paths    home.Paths
	mu       sync.Mutex
	declared map[string][]string
	failures map[string]string
}

// New creates an invocation-local hook cache.
func New(p home.Paths) *Hooks {
	return &Hooks{Paths: p, declared: map[string][]string{}, failures: map[string]string{}}
}

// forEvent discovers hooks in name order and caches their declared events.
func (h *Hooks) forEvent(event string) []find.Executable {
	h.mu.Lock()
	defer h.mu.Unlock()
	all := find.Sorted(h.Paths, "hooks")
	chosen := []find.Executable{}
	for _, x := range all {
		events, ok := h.declared[x.Path]
		if !ok {
			r := process.Run(x.Path, []string{"events"}, process.Options{Env: h.Paths.Env(nil), Timeout: 10 * time.Second})

			if r.Code == 0 {
				events = strings.Fields(r.Stdout)
			} else {
				events = []string{"task", "result", "title"}
				reason := process.Reason(r.Stderr)
				if r.TimedOut {
					reason = "timed out"
				}
				if reason == "" {
					if r.Signal != 0 {
						reason = "killed by " + process.SignalName(r.Signal)
					} else {
						reason = fmt.Sprintf("exit %d", r.Code)
					}
				}
				h.failures[x.Path] = reason
			}
			h.declared[x.Path] = events
		}
		for _, e := range events {
			if e == event {
				chosen = append(chosen, x)
				break
			}
		}
	}
	return chosen
}

// call sends a hook its event, input and contract environment, returning fail-open errors.
func (h *Hooks) call(path, event string, input any, dir, ref string) home.Object {
	h.mu.Lock()
	failure := h.failures[path]
	h.mu.Unlock()
	if failure != "" {
		return home.O("error", failure)
	}
	r := process.Run(path, []string{event}, process.Options{Input: home.JSON(input, false), Dir: dir, Env: h.Paths.Env(map[string]string{"ASK_RUN": ref, "ASK_EVENT": event}), Timeout: 600 * time.Second})

	if r.TimedOut {
		return home.O("error", "timed out")
	}
	if r.Code != 0 {
		why := process.Reason(r.Stderr)
		if why == "" {
			if r.Signal != 0 {
				why = "killed by " + process.SignalName(r.Signal)
			} else {
				why = fmt.Sprintf("exit %d", r.Code)
			}
		}
		return home.O("error", why)
	}
	if home.Trim(r.Stdout) == "" {
		return home.Object{}
	}
	v, e := home.ParsePayload(r.Stdout)
	if e != nil {
		return home.O("error", "printed something other than JSON")
	}
	return v
}

// Note is a hook name and its note, follow-up or failure text.
type Note struct{ Name, Text string }

// notes collects explicit notes and failed-hook diagnostics without deciding the task outcome.
func notes(answer home.Object, name string, all []Note) []Note {
	if answer.B("error") {
		all = append(all, Note{name, "failed: " + home.String(answer.Get("error"))})
	}
	if text := home.Trim(answer.S("note")); text != "" {
		all = append(all, Note{name, text})
	}
	return all
}

// Before applies task changes in name order, returning a refusal only when explicit: a
// "refuse" that is not a string leaves a note and refuses nothing.
// Every executable failure leaves a note and preserves the task.
func (h *Hooks) Before(t home.Object, ref string) (home.Object, string, []Note) {
	all := []Note{}
	found := h.forEvent("task")
	for _, x := range found {
		a := h.call(x.Path, "task", struct {
			Task home.TaskRecord `json:"task"`
		}{home.TaskRecords([]home.Object{t})[0]}, t.S("dir"), ref)

		all = notes(a, x.Name, all)
		if why, ok := a.Get("refuse").(string); ok {
			if why == "" {
				why = "refused"
			}
			return t, x.Name + ": " + why, all
		} else if a.Has("refuse") {
			all = append(all, Note{x.Name, "ignored \"refuse\": expected a string"})
		}
		change, _ := a.Get("task").(home.Object)
		if a.Has("task") && change == nil {
			all = append(all, Note{x.Name, "ignored task changes: expected an object"})
		}

		for key, val := range change {
			want := map[string]string{"prompt": "string", "model": "string", "write": "boolean", "json": "boolean", "timeout": "number", "schema": "object"}[key]
			kind := home.Kind(val)

			if want != "" && (kind == want || (key == "schema" && kind == "boolean")) && val != nil && (kind != "number" || home.Number(val) > 0) {
				t = t.Clone()
				t.Set(key, val)
			} else {
				all = append(all, Note{x.Name, fmt.Sprintf("ignored a change to \"%s\"", key)})
			}
		}
	}
	return t, "", all
}

// After checks a result, stopping at the first explicit failure or follow-up; a "fail" that
// is not a string leaves a note and fails nothing.
func (h *Hooks) After(t, result home.Object, ref string) (*Note, *Note, []Note) {
	all := []Note{}
	dir := result.S("dir")
	if dir == "" {
		dir = t.S("dir")
	}
	found := h.forEvent("result")
	for _, x := range found {
		a := h.call(x.Path, "result", struct {
			Task   home.TaskRecord    `json:"task"`
			Result *home.ResultRecord `json:"result"`
		}{home.TaskRecords([]home.Object{t})[0], home.ResultRecords([]home.Object{result})[0]}, dir, ref)

		all = notes(a, x.Name, all)
		if why, ok := a.Get("fail").(string); ok {
			if why == "" {
				why = "failed"
			}
			return nil, &Note{x.Name, why}, all
		} else if a.Has("fail") {
			all = append(all, Note{x.Name, "ignored \"fail\": expected a string"})
		}
		if prompt := home.Trim(a.S("followup")); prompt != "" {
			return &Note{x.Name, prompt}, nil, all
		}
	}
	return nil, nil, all
}

// Title lets declared hooks replace host or agent-session titles; failures preserve them and return notes.
func (h *Hooks) Title(title string, command []string, description, dir string, task home.Object) (string, []Note) {
	all := []Note{}
	found := h.forEvent("title")
	for _, x := range found {
		answer := h.call(x.Path, "title", struct {
			Title       string      `json:"title"`
			Command     []string    `json:"command"`
			Description string      `json:"description"`
			Task        home.Object `json:"task,omitempty"`
		}{title, command, description, task}, dir, "")
		all = notes(answer, x.Name, all)
		if next := strings.TrimSpace(answer.S("title")); next != "" && !answer.B("error") {
			title = strings.Join(strings.Fields(next), " ")
		}
	}
	return title, all
}

// Name lets declared hooks rename a new run from its prompts; failures keep the name and return notes.
func (h *Hooks) Name(name string, prompts []string, dir string) (string, []Note) {
	all := []Note{}
	for _, x := range h.forEvent("name") {
		answer := h.call(x.Path, "name", struct {
			Name    string   `json:"name"`
			Prompts []string `json:"prompts"`
		}{name, prompts}, dir, "")
		all = notes(answer, x.Name, all)
		if next := strings.TrimSpace(answer.S("name")); next != "" && !answer.B("error") {
			name = next
		}
	}
	return name, all
}
