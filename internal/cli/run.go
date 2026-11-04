package cli

import (
	"cmp"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/hooks"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// taskOptions reads the task fields shared by single and batch commands.
func taskOptions(opts home.Object) (home.Object, error) {
	t := home.Object{}
	if opts.B("-m") {
		t.Set("model", opts.Get("-m"))
	}
	if opts.Has("--title") {
		title := strings.Join(strings.Fields(opts.S("--title")), " ")
		if title == "" {
			return nil, home.Usage("--title needs a nonempty title")
		}
		t.Set("title", title)
	}
	if opts.B("-r") || opts.B("-w") {
		t.Set("write", opts.B("-w"))
	}
	if opts.B("--worktree") {
		t.Set("worktree", true)
	}
	if opts.B("--json") {
		t.Set("json", true)
	}
	if opts.B("--schema") {
		text, e := home.ReadInput(opts.S("--schema"), "schema")
		if e != nil {
			return nil, e
		}
		schema, e := home.ParseJSON(text)
		if e != nil {
			return nil, home.Usage("cannot parse schema %s: %s", opts.S("--schema"), e)
		}
		_ = schema
		t.Set("schema", json.RawMessage(text))
	}
	if opts.B("-C") {
		t.Set("dir", opts.Get("-C"))
	}
	if opts.Has("--max-cost") {
		n, e := strconv.ParseFloat(strings.TrimPrefix(opts.S("--max-cost"), "$"), 64)
		if e != nil || n < 0 {
			return nil, home.Usage("--max-cost takes dollars, like 2.50 (0 for no limit), not %q", opts.S("--max-cost"))
		}
		t.Set("max_cost", n)
	}
	if opts.B("-t") {
		n, e := number("-t", opts.S("-t"), false)
		if e != nil {
			return nil, e
		}
		if n > 2000000 {
			return nil, home.Usage("-t needs at most 2000000 seconds, not \"%s\"", opts.S("-t"))
		}
		t.Set("timeout", n)
	}
	return t, nil
}

// readTasks accepts a JSON array or nonblank JSON lines, with source-specific diagnostics.
func readTasks(text string) ([]any, error) {
	trimmed := home.Trim(text)
	if trimmed == "" {
		return nil, home.Usage("no tasks: pass a JSON array or JSON lines in FILE or on stdin")
	}
	decode := func(text, where string) (any, error) {
		v, e := home.ParseJSON(text)
		if e != nil {
			return nil, home.Usage("cannot parse %s: %s", where, e)
		}
		return v, nil
	}
	items := []any{}
	if strings.HasPrefix(trimmed, "[") {
		v, e := decode(trimmed, "the batch")
		if e != nil {
			return nil, e
		}
		items, _ = v.([]any)
	} else {
		for i, line := range strings.Split(text, "\n") {
			line = home.Trim(line)
			if line == "" {
				continue
			}
			v, e := decode(line, fmt.Sprintf("line %d", i+1))
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
	}
	if len(items) == 0 {
		return nil, home.Usage("no tasks: the batch is empty")
	}
	return items, nil
}

// prepare validates task fields and resolves follow-ups without starting model processes.
func prepare(a *agent.Registry, items []any, defaults home.Object, label string, single bool) ([]home.Object, error) {
	return runs.Prepare(a.Paths, items, defaults, label, single, func(where string) error {
		return home.Usage("%s needs a model: give -m MODEL, or set \"model\" in ~/.ask/settings.json", where)
	})
}

// runName names a new run before its tasks are prepared, so worktrees and branches carry it:
// a single follow-up takes over its conversation's name; otherwise name hooks may rename the
// first prompt's slug, and a number keeps it apart from earlier runs. defaults are the options
// a batch applies to tasks that don't set their own, or nil.
func runName(a *agent.Registry, items []any, defaults home.Object, hooksOn bool) (string, []hooks.Note) {
	prompts := []string{}
	worktree := false
	for _, item := range items {
		t, _ := item.(home.Object)
		prompts = append(prompts, home.String(t.Get("prompt")))
		if t.Has("worktree") {
			worktree = worktree || t.B("worktree")
		} else {
			worktree = worktree || defaults.B("worktree")
		}
	}
	if len(items) == 1 {
		t, _ := items[0].(home.Object)
		if ref, ok := t.Get("continue").(string); ok {
			if name := runs.Inherit(a.Paths, ref); name != "" {
				return name, nil
			}
		}
	}
	name := runs.Slug(prompts[0])
	var notes []hooks.Note
	if hooksOn {
		dir, _ := os.Getwd()
		var chosen string
		chosen, notes = hooks.New(a.Paths).Name(name, prompts, worktree, dir)
		if clean := runs.Clean(chosen); clean != "" && chosen != name {
			name = clean
		}
	}
	return runs.Unique(a.Paths, name), notes
}

// reporter serializes complete status lines from parallel tasks to stderr.
func reporter(a *agent.Registry, r *runs.Run, live *status.Live) func(runs.Event) {
	var mu sync.Mutex
	activity := map[int]string{}
	shown := map[int]time.Time{}
	return func(e runs.Event) {
		mu.Lock()
		defer mu.Unlock()
		if live == nil {
			if e.Kind == "start" {
				delete(activity, e.Index)
				delete(shown, e.Index)
			}
			if e.Kind == "activity" {
				if e.Activity == "" || e.Activity == activity[e.Index] || time.Since(shown[e.Index]) < 5*time.Second {
					return
				}
				activity[e.Index], shown[e.Index] = e.Activity, time.Now()
			}
			if e.Kind != "usage" { // plain status lines report usage once, at the end
				fmt.Fprintln(os.Stderr, status.StyledLine(status.EventLine(r, e), os.Stderr))
			}
			return
		}
		name := ""
		if e.Kind == "start" {
			name = e.Started.Name
		}
		live.Update(e, name, status.EventLine(r, e))
	}
}

// answerText prints JSON task values as JSON and ordinary answers as text.
func answerText(t, r home.Object) string {
	if t.B("json") || t.Has("schema") && t.Get("schema") != nil {
		return home.JSON(r.Get("answer"), false)
	}
	answer := r.Get("answer")
	if raw, ok := answer.(json.RawMessage); ok {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return text
		}
		return string(raw)
	}
	return home.String(answer)
}

// runOne records and executes one prompt, printing only a successful answer.
func runOne(a *agent.Registry, opts home.Object, words []string) (int, error) {
	prompt := strings.Join(words, " ")
	// An inherited pipe looks just like intentional context. Read it alongside an argument
	// only when requested, so shell loops and callers holding stdin open remain safe.
	if prompt == "" || prompt == "-" || opts.B("--stdin") {
		if stdinTerminal() {
			if opts.B("--stdin") {
				return 0, home.Usage("--stdin needs piped or redirected input")
			}
			return 0, home.Usage("no prompt: give it as an argument, or pipe it in")
		}
		if opts.S("--schema") == "-" {
			return 0, home.Usage("stdin cannot supply both the prompt and --schema; use a schema file")
		}
		input, e := home.ReadInput("-", "prompt")
		if e != nil {
			return 0, e
		}
		if prompt == "" || prompt == "-" {
			prompt = input
		} else if input != "" {
			prompt += "\n\n" + input
		}
	}
	return runPrompt(a, opts, prompt)
}

// runPrompt records and executes a prompt already read from arguments or stdin.
func runPrompt(a *agent.Registry, opts home.Object, prompt string) (int, error) {
	t, e := taskOptions(opts)
	if e != nil {
		return 0, e
	}
	t.Set("prompt", prompt)
	if opts.Has("-c") {
		t.Set("continue", opts.Get("-c"))
	}
	id := runs.NewID()
	name, notes := runName(a, []any{t}, nil, !opts.B("--no-hooks"))
	tasks, e := prepare(a, []any{t}, nil, cmp.Or(name, id), true)
	if e != nil {
		return 0, e
	}
	r, e := runs.Create(a.Paths, id, name, tasks)
	if e != nil {
		return 0, e
	}
	live := status.NewLive(r, "", false)
	process.OnStop(func() { live.Finish("ask "+r.Label()+" · stopped", true) })
	defer process.OnStop(nil)
	report := reporter(a, r, live)
	for _, n := range notes {
		report(runs.Event{Kind: "note", Note: n})
	}
	results, e := runs.Execute(a, r, 1, !opts.B("--no-hooks"), report)
	process.AwaitShutdown()
	final := ""
	if e == nil {
		final = status.Done(results[0])
	}
	live.Finish(final, false)
	if e != nil {
		// An admission failure must not take over the conversation's name with an empty run.
		if results == nil && runs.Owner(r) == 0 {
			if err := runs.Delete(r); err != nil {
				return 0, err
			}
		}
		return 0, e
	}
	if !results[0].B("ok") {
		return 1, nil
	}
	fmt.Fprintln(os.Stdout, answerText(tasks[0], results[0]))
	return 0, nil
}

// continueRun follows an explicit prompt or chooses recovery from the saved run state.
func continueRun(a *agent.Registry, opts home.Object, words []string) (int, error) {
	if len(words) == 0 || home.Trim(words[0]) == "" {
		return 0, home.Usage("ask continue needs a run; see ask runs")
	}
	ref := words[0]
	prompt := strings.Join(words[1:], " ")
	fromStdin := prompt == "-"
	if fromStdin && stdinTerminal() {
		return 0, home.Usage("no prompt: pipe it in after -")
	}
	if (prompt == "" || fromStdin) && !stdinTerminal() {
		var err error
		if fromStdin {
			prompt, err = home.ReadInput("-", "prompt")
		} else {
			prompt, err = availablePrompt()
		}
		if err != nil {
			return 0, err
		}
	}
	if fromStdin && home.Trim(prompt) == "" {
		return 0, home.Usage("no prompt on stdin")
	}
	if home.Trim(prompt) != "" {
		if opts.Has("-C") {
			return 0, home.Usage("a follow-up uses its original directory; remove --directory")
		}
		if opts.Has("-j") {
			return 0, home.Usage("--jobs is for rerunning a batch without a prompt")
		}
		opts.Set("-c", ref)
		return runPrompt(a, opts, prompt)
	}
	r, at, err := runs.Open(a.Paths, ref)
	if err != nil {
		return 0, err
	}
	if runs.Owner(r) != 0 {
		return 0, home.Usage("%s is still running; use ask wait %s", ref, ref)
	}
	todo := 0
	for i, result := range r.Results {
		if !result.B("ok") && (at < 0 || len(r.Tasks) == 1 || at == i) {
			todo++
		}
	}
	if todo == 0 {
		if !stdinTerminal() {
			return 0, home.Usage("%s is complete; give a prompt to continue the conversation (or pipe it with ask continue %s -)", ref, ref)
		}
		p := &tui.Prompter{In: os.Stdin, Out: os.Stderr, Color: status.CanStyle(os.Stderr), Unicode: status.UTF8(), OnStop: process.OnStop}
		ref, prompt, err = completedFollowup(p, r, at, ref)
		if err != nil {
			return 0, err
		}
		return continueRun(a, opts, []string{ref, prompt})
	}
	for key := range opts {
		if !has([]string{"-j", "--no-hooks"}, key) {
			return 0, home.Usage("recovering a saved run keeps its original options; only --jobs and --no-hooks apply; give a prompt to change task options")
		}
	}
	jobs, err := jobCount(a, opts)
	if err != nil {
		return 0, err
	}
	var selected []int
	if at >= 0 && len(r.Tasks) > 1 {
		selected = []int{at}
	}
	results, err := execute(a, r, jobs, !opts.B("--no-hooks"), nil, len(r.Tasks) > 1, true, selected...)
	if err != nil {
		return 0, err
	}
	if len(results) == 1 || len(selected) != 0 {
		index := 0
		if len(selected) != 0 {
			index = selected[0]
		}
		if !results[index].B("ok") {
			return 1, nil
		}
		fmt.Fprintln(os.Stdout, answerText(r.Tasks[index], results[index]))
		return 0, nil
	}
	fmt.Fprintln(os.Stdout, home.JSON(home.ResultRecords(results), true))
	for _, result := range results {
		if !result.B("ok") {
			return 1, nil
		}
	}
	return 0, nil
}

// completedFollowup collects a new prompt; complete batches first choose one conversation.
func completedFollowup(p *tui.Prompter, r *runs.Run, at int, ref string) (string, string, error) {
	if at < 0 {
		choices := make([]tui.Option, len(r.Tasks))
		for i, task := range r.Tasks {
			choices[i] = tui.Option{Label: task.S("id") + " · " + task.S("prompt")}
		}
		var err error
		at, err = p.Select("Follow up on task", choices, 0)
		if err != nil {
			return "", "", err
		}
		ref = runs.Ref(r, at)
	}
	prompt, err := p.Input("Follow-up", "")
	if err != nil {
		return "", "", err
	}
	if home.Trim(prompt) == "" {
		return "", "", home.Usage("no follow-up prompt entered")
	}
	return ref, prompt, nil
}

// batch records or resumes tasks and prints all results in task order.
func batch(a *agent.Registry, opts home.Object, words []string) (int, error) {
	jobs, e := jobCount(a, opts)
	if e != nil {
		return 0, e
	}
	var r *runs.Run
	var notes []hooks.Note
	if opts.B("--resume") {
		extra := []string{}
		for key := range opts {
			if !has([]string{"--resume", "-j", "--no-hooks"}, key) {
				extra = append(extra, key)
			}
		}
		extra = append(extra, words...)
		if len(extra) > 0 {
			return 0, home.Usage("--resume reruns a batch as it was recorded; it takes only -j and --no-hooks, not %s", strings.Join(extra, " "))
		}
		r, _, e = runs.Open(a.Paths, opts.S("--resume"))
		if e != nil {
			return 0, e
		}
	} else {
		if len(words) > 1 {
			return 0, home.Usage("ask batch takes one file of tasks, not %d", len(words))
		}
		path := "-"
		if len(words) > 0 && words[0] != "" {
			path = words[0]
		}
		text, e := home.ReadInput(path, "tasks")
		if e != nil {
			return 0, e
		}
		items, e := readTasks(text)
		if e != nil {
			return 0, e
		}
		defaults, e := taskOptions(opts)
		if e != nil {
			return 0, e
		}
		id := runs.NewID()
		var name string
		name, notes = runName(a, items, defaults, !opts.B("--no-hooks"))
		tasks, e := prepare(a, items, defaults, cmp.Or(name, id), false)
		if e != nil {
			return 0, e
		}
		r, e = runs.Create(a.Paths, id, name, tasks)
		if e != nil {
			return 0, e
		}
	}
	results, e := execute(a, r, jobs, !opts.B("--no-hooks"), notes, true, opts.B("--resume"))
	if e != nil {
		if results == nil && !opts.B("--resume") && runs.Owner(r) == 0 {
			if err := runs.Delete(r); err != nil {
				return 0, err
			}
		}
		return 0, e
	}
	fmt.Fprintln(os.Stdout, home.JSON(home.ResultRecords(results), true))
	for _, x := range results {
		if !x.B("ok") {
			return 1, nil
		}
	}
	return 0, nil
}

// jobCount is how many tasks run at once: -j, else the jobs setting, else 4.
func jobCount(a *agent.Registry, opts home.Object) (int, error) {
	jobs := 4
	if settings, e := a.Paths.ReadSettings(); e != nil {
		return 0, e
	} else if settings.Has("jobs") {
		jobs = int(settings.N("jobs"))
	}
	if opts.B("-j") {
		n, e := number("-j", opts.S("-j"), true)
		if e != nil {
			return 0, e
		}
		jobs = integer(n)
	}
	return jobs, nil
}

// execute runs a created run's unfinished tasks with the live rows and status lines a batch
// shows on stderr, and returns every task's result in task order.
func execute(a *agent.Registry, r *runs.Run, jobs int, hooksOn bool, notes []hooks.Note, batch, smart bool, selected ...int) ([]home.Object, error) {
	todo := 0
	for i, x := range r.Results {
		if !x.B("ok") && (len(selected) == 0 || selected[0] == i) {
			todo++
		}
	}
	begin := time.Now()
	header := status.BatchStart(r, jobs, todo)
	var live *status.Live
	if len(selected) == 0 {
		live = status.NewLive(r, header, batch)
	} else {
		batch = false
	}
	if batch && live == nil {
		fmt.Fprintln(os.Stderr, status.StyledLine(header, os.Stderr))
	}
	process.OnStop(func() { live.Finish("ask "+r.Label()+" · stopped", true) })
	defer process.OnStop(nil)
	report := reporter(a, r, live)
	for _, n := range notes {
		report(runs.Event{Kind: "note", Note: n})
	}
	run := runs.Execute
	if smart {
		run = runs.Continue
	}
	results, e := run(a, r, jobs, hooksOn, report, selected...)
	process.AwaitShutdown()
	summary := ""
	if batch {
		summary = status.BatchEnd(r, float64(time.Since(begin).Milliseconds())/1000)
	} else if e == nil && len(results) == 1 {
		summary = status.Done(results[0])
	}
	live.Finish(summary, false)
	if e != nil {
		return results, e
	}
	if batch && live == nil {
		fmt.Fprintln(os.Stderr, status.StyledLine(summary, os.Stderr))
	}
	return results, nil
}
