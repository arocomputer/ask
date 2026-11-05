// Package agent implements local model discovery and the version 1 agent contract.
package agent

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/arocomputer/ask/src/find"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/process"
)

// Model splits the agent:model#effort specification. ID is lowercase, the one spelling of a model
// that models.json lookups, run records and the agent (ASK_MODEL) all see; Spec is rebuilt from it.
type Model struct{ Spec, Agent, ID, Effort string }

// Resolve expands an optional user-defined role, then parses its exact model specification.
// Records and agent calls use only the resolved model, never the role name.
func Resolve(p home.Paths, settings home.Object, spec string) (Model, error) {
	if !strings.Contains(spec, ":") {
		target, ok := home.Roles(settings)[spec]
		if !ok {
			return Model{}, home.Usage("unknown model role %q; expected agent:id[#effort] or a configured role; see ask models --roles", spec)
		}
		spec = target.(string)
	}
	return Parse(p, spec)
}

// Parse validates an exact model specification, lowercases its id, and requires its agent to be installed.
func Parse(p home.Paths, spec string) (Model, error) {
	name, id, effort, err := home.ParseModelSpec(spec)
	if err != nil {
		return Model{}, err
	}
	if find.Path(p, "agents", name) == "" {
		names := []string{}
		for _, x := range find.Sorted(p, "agents") {
			names = append(names, x.Name)
		}
		text := strings.Join(names, ", ")
		if text == "" {
			text = "none"
		}
		return Model{}, home.Usage("no agent %q in %s; installed: %s; run ask setup, or ask install %s if it is an official agent", name, p.Agents, text, name)
	}
	spec = name + ":" + id
	if effort != "" {
		spec += "#" + effort
	}
	return Model{spec, name, id, effort}, nil
}

type listedModel struct{ id, name string }
type listing struct {
	models []listedModel
	error  string
	ready  chan struct{}
}

// Registry caches agent-owned lists during an invocation; models.json ids are added per call.
type Registry struct {
	Paths  home.Paths
	mu     sync.Mutex
	listed map[string]*listing
}

// New creates an invocation-local registry.
func New(p home.Paths) *Registry { return &Registry{Paths: p, listed: map[string]*listing{}} }

// models caches one agent's declaration without serializing different agents' listings.
func (a *Registry) models(name string) listing {
	a.mu.Lock()
	own, ok := a.listed[name]
	if !ok {
		own = &listing{ready: make(chan struct{})}
		a.listed[name] = own
	}
	a.mu.Unlock()
	if !ok {
		executable := find.Path(a.Paths, "agents", name)
		env, err := a.Paths.AgentEnv(name, executable, nil)
		if err != nil {
			own.error = err.Error()
			close(own.ready)
			return *own
		}
		r := process.Run(executable, []string{"models"}, process.Options{Env: env, Timeout: 10 * time.Second})
		if r.Code != 0 {

			own.error = process.Reason(r.Stderr)
			if own.error == "" {
				if r.TimedOut {
					own.error = "timed out"
				} else {
					own.error = exitText(r)
					if r.Signal == 0 && r.Code >= 0 {
						own.error = "exit " + own.error
					}
				}
			}
		} else {
			for _, line := range strings.Split(r.Stdout, "\n") {
				if home.Trim(line) == "" {
					continue
				}
				bits := strings.Split(line, "\t")
				m := listedModel{id: strings.ToLower(home.Trim(bits[0]))}
				if len(bits) > 1 {
					m.name = home.Trim(bits[1])
				}
				own.models = append(own.models, m)
			}
		}
		close(own.ready)
	}
	<-own.ready
	return listing{models: append([]listedModel{}, own.models...), error: own.error}
}

// List returns model ids in agent order and each listing failure as "agent: reason".
// Entry is a model ask can reach, as agent:id, with its listed name and whether models.json
// turns it off.
type Entry struct {
	ID, Name string
	Off      bool
	Listed   bool // the agent lists it, rather than models.json adding it
}

// Catalog lists every model each agent offers, then the ones models.json adds that it doesn't,
// with each agent's listing failure as "name: reason".
func (a *Registry) Catalog(config home.Models) ([]Entry, []string) {
	names := find.Sorted(a.Paths, "agents")
	all := make([]listing, len(names))
	var wg sync.WaitGroup
	for i, x := range names {
		wg.Add(1)
		go func(i int, name string) { defer wg.Done(); all[i] = a.models(name) }(i, x.Name)
	}
	wg.Wait()
	entries, errors := []Entry{}, []string{}
	for i, x := range names {
		seen := map[string]bool{}
		for _, m := range all[i].models {
			seen[m.id] = true
			c, _ := config.Get(x.Name, m.id)
			entries = append(entries, Entry{x.Name + ":" + m.id, m.name, c.Off, true})
		}
		extra := []string{}
		for id, c := range config[x.Name] {
			if !seen[id] && !c.Off {
				extra = append(extra, id)
			}
		}
		sort.Strings(extra)
		for _, id := range extra {
			entries = append(entries, Entry{ID: x.Name + ":" + id})
		}
		if all[i].error != "" {
			errors = append(errors, x.Name+": "+all[i].error)
		}
	}
	return entries, errors
}

// List returns the ids of the models that are on, and listing failures.
func (a *Registry) List(config home.Models) ([]string, []string) {
	entries, errors := a.Catalog(config)
	ids := []string{}
	for _, e := range entries {
		if !e.Off {
			ids = append(ids, e.ID)
		}
	}
	return ids, errors
}

// Name prefers the report, then the listed model name, then a title-cased model id.
func (a *Registry) Name(m Model, reported string) string {
	name := reported
	if name == "" {
		listed := a.models(m.Agent)

		for _, x := range listed.models {
			if strings.EqualFold(x.id, m.ID) {
				name = x.name
				break
			}
		}
	}
	if name == "" {
		bits := strings.FieldsFunc(m.ID, func(r rune) bool { return r == '/' })
		name = m.ID
		if len(bits) > 0 {
			words := strings.FieldsFunc(bits[len(bits)-1], func(r rune) bool { return r == '-' })
			for i, w := range words {
				r := []rune(w)
				r[0] = unicode.ToUpper(r[0])
				words[i] = string(r)
			}
			name = strings.Join(words, " ")
		}
	}
	if m.Effort != "" {
		name += " (" + m.Effort + ")"
	}
	return name
}

// exitText describes a process exit, including termination by a signal.
func exitText(r process.Result) string {
	if r.Signal != 0 {
		return "killed by " + process.SignalName(r.Signal)
	}
	if r.Code < 0 {
		return "could not start"
	}
	return fmt.Sprint(r.Code)
}

// Run sends the prompt on stdin and reads the optional report even after failure or timeout.
// While the agent runs, progress (if not nil) gets usage and coarse activity snapshots each poll.
// The user-facing title goes as ASK_TITLE; max_cost goes as ASK_MAX_COST, and ask stops the
// agent once its reported cost passes it; the session survives, so a follow-up continues the work.
// events is an optional pre-created private append-only JSONL path, supplied as ASK_EVENTS.
// Adapters append complete UTF-8 lines of at most 16 KiB (including the newline): objects with
// type message, reasoning, tool or tool_result, string text and optional string tool. They must
// truncate oversized payloads safely, omit hidden reasoning and suppress obvious credential
// values; this is not comprehensive redaction. Event errors must not prevent a final answer.
// Readers advance byte offsets only past complete lines, retaining partial tails for later reads.
func (a *Registry) Run(m Model, prompt string, t home.Object, events string, progress func(Progress)) home.Object {
	work, err := os.MkdirTemp("", "ask-")
	if err != nil {
		return home.O("ok", false, "note", err.Error())
	}
	defer os.RemoveAll(work)
	access := "read"
	if t.B("write") {
		access = "write"
	}
	vars := map[string]string{"ASK_MODEL": m.ID, "ASK_EFFORT": m.Effort, "ASK_ACCESS": access, "ASK_REPORT": filepath.Join(work, "report.json")}
	if events != "" {
		vars["ASK_EVENTS"] = events
	}
	if title := t.S("title"); title != "" {
		vars["ASK_TITLE"] = title
	}
	if t.Has("schema") && t.Get("schema") != nil {
		vars["ASK_SCHEMA"] = filepath.Join(work, "schema.json")
		if e := os.WriteFile(vars["ASK_SCHEMA"], []byte(home.JSON(t.Get("schema"), false)), 0600); e != nil {
			return home.O("ok", false, "note", e.Error())
		}
	}
	if t.B("session") {
		vars["ASK_SESSION"] = t.S("session")
	}
	timeout := t.N("timeout")
	if timeout == 0 {
		timeout = 900
	}
	limit := t.N("max_cost")
	if limit > 0 {
		vars["ASK_MAX_COST"] = strconv.FormatFloat(limit, 'f', -1, 64)
	}
	executable := find.Path(a.Paths, "agents", m.Agent)
	env, err := a.Paths.AgentEnv(m.Agent, executable, vars)
	if err != nil {
		return home.O("ok", false, "note", err.Error())
	}
	done, stop := make(chan struct{}), make(chan struct{})
	watched := make(chan struct{})
	overLimit := false
	session := t.S("session")
	go func() {
		defer close(watched)
		if progress == nil && limit <= 0 {
			return
		}
		tick := time.NewTicker(500 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
			}
			if b, err := os.ReadFile(vars["ASK_REPORT"]); err == nil {
				var report Report
				if json.Unmarshal(b, &report) == nil {
					if reported := home.Trim(report.Session); reported != "" {
						session = reported
					}
					usage := report.usage()
					if limit > 0 && usage != nil && usage.Has("cost") && usage.N("cost") > limit && !overLimit {
						overLimit = true
						close(stop)
					}
					if progress != nil {
						// Repeat snapshots so a rate-limited display can show a suppressed category
						// even when the agent has no new events during a long operation.
						progress(Progress{Usage: usage, Activity: report.activity(), Session: home.Trim(report.Session), Blocker: costBlocker(overLimit, limit)})
					}
				}
			}
		}
	}()
	r := process.Run(executable, nil, process.Options{Input: prompt, Dir: t.S("dir"), Env: env, Timeout: process.Timeout(timeout), Stop: stop})
	close(done)
	<-watched

	report := Report{}
	if b, err := os.ReadFile(vars["ASK_REPORT"]); err == nil {
		_ = json.Unmarshal(b, &report)
	}
	meta := home.O("usage", nil, "name", home.Trim(report.Name), "session", home.Trim(report.Session))
	if !meta.B("session") {
		meta.Set("session", session)
	}
	if usage := report.usage(); usage != nil {
		meta.Set("usage", usage)
	}

	meta.Set("ok", false)
	switch {
	case r.TimedOut:
		meta.Set("note", "timed out")
	case overLimit:
		meta.Set("note", "stopped at the $"+home.Dollars(limit)+" cost limit")
	case r.Code != 0:
		why := process.Reason(r.Stderr)
		if why == "" {
			why = exitText(r)
			if r.Signal == 0 && r.Code >= 0 {
				why = "exit " + why
			}
		}
		meta.Set("note", why)
	case home.Trim(r.Stdout) == "":
		meta.Set("note", "no answer")
	default:
		meta.Set("ok", true)
		meta.Set("text", r.Stdout)
		meta.Set("note", home.Trim(report.Note))
		// An agent that reports cost only at the end can't be stopped on it; its answer stands, noted.
		if u, _ := meta.Get("usage").(home.Object); limit > 0 && u.N("cost") > limit {
			over := "spent $" + home.Dollars(u.N("cost")) + ", over the $" + home.Dollars(limit) + " cost limit"
			meta.Set("note", strings.TrimPrefix(home.Trim(report.Note)+"; "+over, "; "))
		}
	}
	if progress != nil {
		failure := ""
		if !meta.B("ok") {
			failure = meta.S("note")
		}
		progress(Progress{Usage: report.usage(), Session: home.Trim(report.Session), Blocker: failure})
	}
	return meta
}

// Report is the agent's optional version 1 metadata; unknown fields are ignored.
// Pointer counts distinguish an omitted metric from a reported zero.
type Report struct {
	// Decode activity separately: a bad optional signal must never hide valid cost or usage.
	Activity json.RawMessage `json:"activity"`
	Session  string          `json:"session"`
	Name     string          `json:"name"`
	Input    *float64        `json:"input"`
	Output   *float64        `json:"output"`
	Cached   *float64        `json:"cached"`
	Cost     *float64        `json:"cost"`
	Note     string          `json:"note"`
}

// usage returns the report's valid counts and cost, or nil when it has none.
func (report Report) usage() home.Object {
	usage := home.Object{}
	for key, n := range map[string]*float64{"input": report.Input, "output": report.Output, "cached": report.Cached, "cost": report.Cost} {
		if n != nil && *n >= 0 && !math.IsInf(*n, 0) && !math.IsNaN(*n) {
			usage.Set(key, *n)
		}
	}
	if len(usage) == 0 {
		return nil
	}
	return usage
}

// Progress carries live metadata. Session and Blocker may be saved for interrupted recovery;
// activity and usage are presentation snapshots.
type Progress struct {
	Usage    home.Object
	Activity string
	Session  string
	Blocker  string
}

// activity accepts only fixed, non-sensitive categories, never agent-supplied display text.
func (report Report) activity() string {
	var value string
	if json.Unmarshal(report.Activity, &value) != nil {
		return ""
	}
	switch value {
	case "thinking", "running commands", "editing files", "searching", "using tools", "answering":
		return value
	}
	return ""
}

func costBlocker(over bool, limit float64) string {
	if over {
		return "stopped at the $" + home.Dollars(limit) + " cost limit"
	}
	return ""
}
