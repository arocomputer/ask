// Package root is the ask command itself: it dispatches to the command packages, then to
// extension commands, prints errors and turns them into exit status 0 (success or
// admission), 1 (a failed or stopped turn) or 2 (a usage error).
package root

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/arocomputer/ask/internal/cmd/clean"
	configcmd "github.com/arocomputer/ask/internal/cmd/config"
	cont "github.com/arocomputer/ask/internal/cmd/continue"
	"github.com/arocomputer/ask/internal/cmd/install"
	"github.com/arocomputer/ask/internal/cmd/models"
	"github.com/arocomputer/ask/internal/cmd/run"
	sessionscmd "github.com/arocomputer/ask/internal/cmd/sessions"
	"github.com/arocomputer/ask/internal/cmd/setup"
	"github.com/arocomputer/ask/internal/cmd/show"
	"github.com/arocomputer/ask/internal/cmd/stop"
	"github.com/arocomputer/ask/internal/cmd/wait"
	"github.com/arocomputer/ask/internal/cmd/worker"
	"github.com/arocomputer/ask/internal/cmdutil"
	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/extension"
)

// command is one ask command: its name, its page and what runs it.
type command struct {
	name string
	help cmdutil.Page
	run  func(config.Paths, []string) (int, error)
}

// core is how many commands lead the help page as CORE COMMANDS.
const core = 6

// commands are the built-in commands in help order.
var commands = []command{
	{"run", run.Help, run.Run},
	{"wait", wait.Help, wait.Run},
	{"show", show.Help, show.Run},
	{"continue", cont.Help, cont.Run},
	{"stop", stop.Help, stop.Run},
	{"sessions", sessionscmd.Help, sessionscmd.Run},
	{"models", models.Help, models.Run},
	{"config", configcmd.Help, configcmd.Run},
	{"setup", setup.Help, setup.Run},
	{"extensions", install.ListHelp, install.List},
	{"install", install.Help, install.Run},
	{"remove", install.RemoveHelp, install.Remove},
	{"clean", clean.Help, clean.Run},
}

// Main runs ask and returns its exit status.
func Main(args []string, version string) int {
	cmdutil.Version = version
	if len(args) > 0 && args[0] == "__worker" {
		return worker.Main(args[1:])
	}
	code, err := dispatch(config.New(), args, version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ask: %s\n", err)
		var usage *config.UsageError
		if errors.As(err, &usage) {
			return 2
		}
		return 1
	}
	return code
}

// dispatch picks the command: a built-in one, then an extension's, else the first word starts
// a prompt. -- before a prompt keeps a command's name from being taken as one.
func dispatch(p config.Paths, args []string, version string) (int, error) {
	if len(args) == 0 {
		return run.Run(p, args)
	}
	if opts, words, err := cmdutil.Parse(args, run.Flags); err == nil && opts.B("json") && len(words) == 0 && !opts.B("stdin") {
		return request(p, args)
	}
	switch args[0] {
	case "help", "--help", "-h":
		return help(p, args[1:])
	case "version", "--version", "-V":
		fmt.Fprintln(os.Stdout, version)
		return 0, nil
	}
	for _, c := range commands {
		if c.name == args[0] {
			return c.run(p, args[1:])
		}
	}
	if path, ok := extension.Command(p, args[0]); ok {
		return exec(p, path, args[1:])
	}
	return run.Run(p, args)
}

// request handles ask --json with no prompt: stdin holds either the prompt or a JSON request,
// which becomes the flags it stands for and goes to run, or to continue when it names a session.
func request(p config.Paths, args []string) (int, error) {
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 0, config.Usage("cannot read stdin: %s", err)
	}
	text := config.Trim(config.UTF8(b))
	extra, session, ok, err := cmdutil.Request(text)
	if err != nil {
		return 0, err
	}
	if !ok {
		return run.Run(p, append(args, "--", text))
	}
	if session != "" {
		return cont.Run(p, append(append([]string{session}, args...), extra...))
	}
	return run.Run(p, append(args, extra...))
}

// exec replaces ask with an extension's command, which gets the terminal, the signals and the
// exit status, plus ASK_BIN so it can call this ask back.
func exec(p config.Paths, path string, args []string) (int, error) {
	err := syscall.Exec(path, append([]string{path}, args...), p.Env(nil))
	return 0, fmt.Errorf("cannot run %s: %w", path, err)
}
