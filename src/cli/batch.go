package cli

import (
	"cmp"
	"fmt"
	"os"
	"strings"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/hooks"
	"github.com/arocomputer/ask/src/runs"
)

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

// batch admits detached tasks by default; --wait prints all results in task order.
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
			if !has([]string{"--resume", "-j", "--no-hooks", "--wait"}, key) {
				extra = append(extra, key)
			}
		}
		extra = append(extra, words...)
		if len(extra) > 0 {
			return 0, home.Usage("--resume reruns a batch as it was recorded; it takes only -j, --no-hooks and --wait, not %s", strings.Join(extra, " "))
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
		if path == "-" && stdinTerminal() {
			return 0, home.Usage("ask batch needs a task file or piped input")
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
		if !opts.B("--wait") {
			return startWorker(a.Paths, launchRequest{Name: name, Notes: notes, Tasks: home.TaskRecords(tasks), WorktreeLabel: id, Jobs: jobs, Hooks: !opts.B("--no-hooks")})
		}
		r, e = runs.Create(a.Paths, id, name, tasks)
		if e != nil {
			return 0, e
		}
	}
	if !opts.B("--wait") {
		return recoverWorker(a.Paths, r, jobs, !opts.B("--no-hooks"))
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
