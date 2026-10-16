// Package cli implements ask's commands, option validation, stdout/stderr contract and exit codes.
package cli

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"syscall"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/packages"
	"github.com/arocomputer/ask/internal/process"
)

var options = map[string][]string{
	"run":   {"-m", "-r", "-w", "--worktree", "-c", "--json", "--schema", "-C", "-t", "--max-cost", "--title", "--no-hooks"},
	"batch": {"-m", "-r", "-w", "--worktree", "--json", "--schema", "-C", "-t", "--max-cost", "--title", "-j", "--resume", "--no-hooks"},
	"bench": {"-m", "-r", "-w", "-C", "-t", "--max-cost", "--title", "-j", "-n", "--json", "--keep", "--yes", "--no-hooks"},
	"title": {"--command", "--description", "--hook"},
	"setup": {"--check", "--json", "--yes"}, "settings": {"--json", "--dry-run"}, "docs": {"--raw", "--search", "--url"}, "update": {"--check"},
	"show": {"--json"}, "runs": {"-n", "--all"}, "wait": {}, "clean": {"--days", "--dry-run", "--yes"}, "stop": {}, "models": {"--names", "--all", "--enable", "--disable", "--max-cost"}, "help": {}, "install": {}, "packages": {}, "remove": {},
}

var long = map[string]string{"--model": "-m", "--read": "-r", "--write": "-w", "--continue": "-c", "--directory": "-C", "--dir": "-C", "--timeout": "-t", "--jobs": "-j"}

var value = map[string]bool{"-m": true, "-c": true, "--schema": true, "-C": true, "-t": true, "-j": true, "-n": true, "--resume": true, "--command": true, "--description": true, "--agents": true, "--days": true, "--max-cost": true, "--title": true, "--search": true, "--worktrees": true, "--branches": true, "--skills": true}

// suggestion returns a valid option only when the spelling is one edit away.
func suggestion(command, wrong string) string {
	choices := append([]string{"--help", "-h", "--version", "-V"}, options[command]...)
	for alias, short := range long {
		if has(options[command], short) {
			choices = append(choices, alias)
		}
	}
	for _, right := range choices {
		if oneEdit(wrong, right) {
			return right
		}
	}
	return ""
}

// oneEdit recognizes one inserted, removed, changed or transposed character.
func oneEdit(a, b string) bool {
	if a == b {
		return false
	}
	if len(a) > len(b) {
		a, b = b, a
	}
	if len(b)-len(a) > 1 {
		return false
	}
	for i := 0; i < len(a); i++ {
		if a[i] == b[i] {
			continue
		}
		if len(a) == len(b) {
			return a[i+1:] == b[i+1:] || i+1 < len(a) && a[i] == b[i+1] && a[i+1] == b[i] && a[i+2:] == b[i+2:]
		}
		return a[i:] == b[i+1:]
	}
	return len(b) == len(a)+1
}

// has tests membership in a command's accepted option list.
func has(list []string, item string) bool {
	for _, x := range list {
		if x == item {
			return true
		}
	}
	return false
}

// number validates a numeric option and reports the original text on failure.
func number(flag, text string, whole bool) (float64, error) {
	n := home.Number(text)
	if !(n > 0) || (whole && (math.IsInf(n, 0) || math.Trunc(n) != n)) {
		kind := "number"
		if whole {
			kind = "whole number"
		}
		return 0, home.Usage("%s needs a %s above 0, not \"%s\"", flag, kind, text)
	}
	return n, nil
}

// integer bounds allocation counts without truncating the set of available tasks or runs.
func integer(n float64) int {
	if n > float64(math.MaxInt32) {
		return math.MaxInt32
	}
	return int(n)
}

// parse validates options per command and treats every word after -- as literal input.
func parse(command string, argv []string) (home.Object, []string, error) {
	opts := home.Object{}
	words := []string{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--" {
			words = append(words, argv[i+1:]...)
			break
		}
		if arg == "-h" || arg == "--help" {
			opts.Set("help", true)
		} else if strings.HasPrefix(arg, "-") && arg != "-" {
			flag := arg
			if alias, ok := long[arg]; ok {
				flag = alias
			}
			if !has(options[command], flag) {
				if right := suggestion(command, arg); right != "" {
					return nil, nil, home.Usage("unknown option %s; did you mean %s?", arg, right)
				}
				return nil, nil, home.Usage("unknown option %s", arg)
			}
			if !value[flag] {
				opts.Set(flag, true)
			} else if i+1 >= len(argv) {
				return nil, nil, home.Usage("missing value for %s", arg)
			} else {
				i++
				if command == "bench" && flag == "-m" && opts.B("-m") {
					opts.Set(flag, opts.S("-m")+","+argv[i]) // each -m adds a model to compare
				} else {
					opts.Set(flag, argv[i])
				}
			}
		} else {
			words = append(words, arg)
		}
	}
	if opts.B("-r") && opts.B("-w") {
		return nil, nil, home.Usage("choose one of -r (read) or -w (read and write)")
	}
	return opts, words, nil
}

// runCommand replaces ask with a user command, preserving its streams and signal behavior.
func runCommand(p home.Paths, path string, args []string) (int, error) {
	if e := syscall.Exec(path, append([]string{path}, args...), p.Env(nil)); e != nil {
		fmt.Fprintf(os.Stderr, "ask: cannot run %s: %s\n", path, e)
		return 1, nil
	}
	return 0, nil
}

// main selects built-in or user commands before parsing command-specific options.
func main(argv []string, version string) (int, error) {
	p := home.New()
	if len(argv) == 1 && (argv[0] == "--version" || argv[0] == "-V") {
		fmt.Fprintln(os.Stdout, version)
		return 0, nil
	}
	packages.Refresh(p)
	command := "run"
	if len(argv) > 0 {
		if _, ok := options[argv[0]]; ok && argv[0] != "run" {
			command = argv[0]
		}
		if command == "run" && !strings.HasPrefix(argv[0], "-") {
			if path := find.Path(p, "commands", argv[0]); path != "" {
				return runCommand(p, path, argv[1:])
			}
		}
	}
	args := argv
	if command != "run" {
		args = argv[1:]
	}
	opts, words, e := parse(command, args)
	if e != nil {
		return 0, e
	}
	if len(argv) == 0 || command == "run" && len(argv) == 1 && opts.B("help") || command == "help" && len(words) == 0 {
		printHelp(overview(agent.New(p)))
		return 0, nil
	}
	if opts.B("help") {
		topic := command
		if topic == "help" {
			topic = "run"
		}
		printHelp(topicHelp(topic))
		return 0, nil
	}
	if has([]string{"runs", "packages"}, command) && len(words) != 0 {
		return 0, home.Usage("ask %s takes no arguments", command)
	}
	a := agent.New(p)
	switch command {
	case "title":
		if opts.B("--hook") && len(words) == 0 && !opts.Has("--command") && !opts.Has("--description") {
			return hookTitle(a)
		}
		if len(words) != 0 || !opts.Has("--command") || opts.B("--hook") {
			return 0, home.Usage("ask title needs --command STRING and optional --description TEXT, or --hook alone")
		}
		if title := commandTitle(a, opts.S("--command"), opts.S("--description")); title != "" {
			fmt.Fprintln(os.Stdout, title)
		}
		return 0, nil
	case "batch":
		return batch(a, opts, words)
	case "bench":
		return bench(a, opts, words)
	case "setup":
		if len(words) == 1 {
			return 0, home.Usage("ask setup takes no arguments; did you mean ask settings %s?", words[0])
		}
		if len(words) > 1 {
			return 0, home.Usage("ask setup takes no arguments")
		}
		return setupCommand(p, opts)
	case "settings":
		return settingsCommand(p, opts, words)
	case "docs":
		return docsCommand(opts, words)
	case "update":
		if len(words) != 0 {
			return 0, home.Usage("ask update takes no arguments")
		}
		return updateCommand(p, version, opts.B("--check"))
	case "show":
		return show(p, opts, words)
	case "wait":
		return wait(p, words)
	case "clean":
		if len(words) != 0 {
			return 0, home.Usage("ask clean takes no arguments")
		}
		return clean(p, opts)
	case "stop":
		return stop(p, words)
	case "runs":
		return listRuns(p, opts)
	case "models":
		return models(a, opts, words)
	case "help":
		if len(words) != 1 {
			return 0, home.Usage("ask help takes one command")
		}
		text := topicHelp(words[0])
		if text == "" {
			return 0, home.Usage("unknown help topic %q", words[0])
		}
		printHelp(text)
		return 0, nil
	case "install":
		return install(p, words)
	case "packages":
		return listPackages(p)
	case "remove":
		return remove(p, words)
	default:
		return runOne(a, opts, words)
	}
}

// Main runs one CLI invocation and reports errors with the original exit-status contract.
func Main(argv []string, version string) int {
	process.Listen()
	code, e := main(argv, version)
	process.AwaitShutdown()
	if len(argv) == 0 || !has([]string{"title", "update"}, argv[0]) {
		notice(home.New(), version)
	}
	if e != nil {
		var usage *home.UsageError
		if errors.As(e, &usage) {
			topic := "run"
			if len(argv) > 0 {
				if _, ok := options[argv[0]]; ok {
					topic = argv[0]
				}
			}
			message := strings.Join(strings.Fields(e.Error()), " ")
			if message == "unknown option -help; did you mean --help?" || message == "unknown option -version; did you mean --version?" {
				fmt.Fprintf(os.Stderr, "ask: %s\n", message)
			} else if topic == "help" {
				fmt.Fprintf(os.Stderr, "ask: %s; see ask help\n", message)
			} else {
				fmt.Fprintf(os.Stderr, "ask: %s; see ask help %s\n", message, topic)
			}
			if strings.Contains(e.Error(), "needs a model") || strings.Contains(e.Error(), "bad model") || strings.Contains(e.Error(), "no agent") {
				fmt.Fprintln(os.Stderr, modelLines(agent.New(home.New())))
			}
			return 2
		}
		fmt.Fprintln(os.Stderr, "ask: "+e.Error())
		return 1
	}
	return code
}
