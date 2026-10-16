package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/hooks"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/task"
)

// titlePath resolves literal host paths relative to preceding cd commands.
func titlePath(dir, path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		h, _ := os.UserHomeDir()
		path = filepath.Join(h, strings.TrimPrefix(path, "~"))
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, path)
	}
	return path
}

// invocationTitle describes task-running invocations without preparing or executing tasks.
// in is the invocation's heredoc, and files holds files earlier commands write from heredocs,
// which do not exist yet when a host asks for the title.
func invocationTitle(a *agent.Registry, argv []string, description, dir string, in shellInput, files map[string]string) (string, home.Object) {
	args := argv[1:]
	command := "run"
	if len(args) == 0 {
		return "", nil
	}
	if _, ok := options[args[0]]; ok && args[0] != "run" {
		command = args[0]
		args = args[1:]
	} else if find.Path(a.Paths, "commands", args[0]) != "" {
		return "", nil
	}
	if command != "run" && command != "batch" {
		return "", nil
	}
	opts, words, err := parse(command, args)
	if err != nil || opts.B("help") {
		return "", nil
	}
	for _, f := range []string{"-t", "-j"} {
		if opts.Has(f) {
			if _, err := number(f, opts.S(f), f == "-j"); err != nil {
				return "", nil
			}
		}
	}
	if opts.Has("--title") && strings.TrimSpace(opts.S("--title")) == "" {
		return "", nil
	}
	invocationDir := dir
	if opts.Has("-C") {
		dir = titlePath(dir, opts.S("-C"))
	}
	prompt := strings.Join(words, " ")
	label := ""
	if command == "batch" {
		if opts.B("--resume") {
			if len(words) > 0 {
				return "", nil
			}
			for key := range opts {
				if !has([]string{"--resume", "-j", "--no-hooks"}, key) {
					return "", nil
				}
			}
			label = "Resume " + opts.S("--resume")
			if r, _, err := runs.Open(a.Paths, opts.S("--resume")); err == nil && len(r.Tasks) > 0 {
				prompt = r.Tasks[0].S("prompt")
			}
		} else {
			if len(words) > 1 {
				return "", nil
			}
			label = "Batch"
			prompt = ""
			text, found := in.Stdin, in.HasStdin
			if len(words) == 1 && words[0] != "-" {
				path := titlePath(invocationDir, words[0])
				text, found = files[path]
				if !found {
					b, err := os.ReadFile(path)
					text, found = string(b), err == nil
				}
			}
			if items, err := readTasks(text); found && err == nil {
				names := []string{}
				known := true
				for _, item := range items {
					t, ok := item.(home.Object)
					if !ok {
						known = false
						break
					}
					if prompt == "" {
						prompt = t.S("prompt")
					}
					model := t.S("model")
					if model == "" {
						model = opts.S("-m")
					}
					if model == "" && t.B("continue") {
						if r, i, e := runs.Open(a.Paths, t.S("continue")); e == nil && i >= 0 {
							model = r.Results[i].S("model")
						}
					}
					if model == "" {
						model = defaultModel(a)
					}
					m, err := agent.Parse(a.Paths, model)
					if err != nil {
						known = false
						break
					}
					name := a.Name(m, "")
					if !has(names, name) {
						names = append(names, name)
					}
				}
				if known {
					label = "Batch of " + home.String(len(items))
					if len(names) <= 3 {
						label += " · " + strings.Join(names, ", ")
					}
				}
			}
		}
	} else {
		model := opts.S("-m")
		write := opts.B("-w")
		worktree := opts.B("--worktree")
		if opts.B("-c") {
			r, i, e := runs.Open(a.Paths, opts.S("-c"))
			if e != nil || i < 0 {
				return "", nil
			}
			old := r.Tasks[i]
			if model == "" {
				model = r.Results[i].S("model")
			}
			if !opts.B("-r") && !opts.B("-w") {
				write = r.Results[i].B("write") || !r.Results[i].Has("write") && old.B("write")
			}
			worktree = worktree || old.B("worktree")
			if prompt == "" || prompt == "-" {
				prompt = old.S("prompt")
			}
		}
		if model == "" {
			model = defaultModel(a)
		}
		m, err := agent.Parse(a.Paths, model)
		if err != nil {
			return "", nil
		}
		label = a.Name(m, "")
		jobDescription := description
		if opts.Has("--title") {
			jobDescription = opts.S("--title")
		}
		job := task.JobTitle(jobDescription, prompt, label)
		if job != "" && (prompt != "-" || strings.TrimSpace(description) != "") {
			label += " · " + job
		}
		if worktree {
			if !write {
				return "", nil
			}
			label += " · worktree"
		} else if write {
			label += " · write"
		}
		return label, opts
	}
	jobDescription := description
	if opts.Has("--title") {
		jobDescription = opts.S("--title")
	}
	if job := task.JobTitle(jobDescription, prompt, label); job != "" {
		label += " · " + job
	}
	return label, opts
}

// commandTitle finds the first literal ask program and applies optional host-title hooks.
func commandTitle(a *agent.Registry, command, description string) string {
	commands, inputs, ok := shellCommands(command)
	if !ok {
		return ""
	}
	dir, _ := os.Getwd()
	files := map[string]string{}
	for i, argv := range commands {
		for len(argv) > 0 && assignment.MatchString(argv[0]) {
			argv = argv[1:]
		}
		if len(argv) == 0 {
			continue
		}
		if argv[0] == "cd" && len(argv) == 2 {
			dir = titlePath(dir, argv[1])
			continue
		}
		if argv[0] == "cat" && len(argv) == 1 && inputs[i].HasStdin && inputs[i].Out != "" {
			files[titlePath(dir, inputs[i].Out)] = inputs[i].Stdin
			continue
		}
		if filepath.Base(argv[0]) != "ask" {
			continue
		}
		title, opts := invocationTitle(a, argv, description, dir, inputs[i], files)
		if title != "" && !opts.B("--no-hooks") {
			var notes []hooks.Note
			title, notes = hooks.New(a.Paths).Title(title, argv, description, dir, nil)
			for _, n := range notes {
				fmt.Fprintf(os.Stderr, "ask: hook %s · %s\n", n.Name, strings.Join(strings.Fields(n.Text), " "))
			}
		}
		return title
	}
	return ""
}

// hookTitle answers a PreToolUse hook event on stdin, the format Claude Code uses: for a shell
// command that runs ask, it prints the tool input with the title as its description and
// run_in_background set; for anything else, or input it cannot read, it prints nothing.
// It always exits 0, so a host never blocks a command on a title.
func hookTitle(a *agent.Registry) (int, error) {
	b, _ := io.ReadAll(os.Stdin)
	if !strings.Contains(string(b), "ask") {
		return 0, nil
	}
	v, err := home.ParseJSON(home.UTF8(b))
	event, _ := v.(home.Object)
	input, _ := event.Get("tool_input").(home.Object)
	command, _ := input.Get("command").(string)
	if err != nil || command == "" {
		return 0, nil
	}
	description, _ := input.Get("description").(string)
	title := commandTitle(a, command, description)
	if title == "" {
		return 0, nil
	}
	updated := input.Clone()
	updated.Set("description", title)
	updated.Set("run_in_background", true)
	fmt.Fprintln(os.Stdout, home.JSON(home.O("hookSpecificOutput", home.O("hookEventName", "PreToolUse", "updatedInput", updated)), false))
	return 0, nil
}

// defaultModel is the model setting, or "" when there is none or settings.json is unreadable.
func defaultModel(a *agent.Registry) string {
	s, _ := a.Paths.ReadSettings()
	return s.S("model")
}
