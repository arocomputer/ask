package cli

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/status"
)

// modelLines groups each local agent's model ids, or why it could not list them, one agent per
// row with the names aligned, wrapped to 80 columns so help reads the same on any terminal or pipe.
func modelLines(a *agent.Registry) string {
	config, err := a.Paths.ReadModels()
	if err != nil {
		return "  " + strings.Join(strings.Fields(err.Error()), " ")
	}
	ids, failures := a.List(config)
	agents := find.Sorted(a.Paths, "agents")
	if len(agents) == 0 {
		return "  None yet; run ask setup"
	}
	width := 0
	for _, entry := range agents {
		width = max(width, len(entry.Name))
	}
	rows := []string{}
	for _, entry := range agents {
		words := []string{}
		for _, id := range ids {
			if name, model, _ := strings.Cut(id, ":"); name == entry.Name {
				words = append(words, model)
			}
		}
		for _, failure := range failures {
			if reason, ok := strings.CutPrefix(failure, entry.Name+": "); ok {
				words = append([]string{"(could not list: " + strings.Join(strings.Fields(reason), " ") + ")"}, words...)
			}
		}
		if len(words) > 12 {
			words = []string{fmt.Sprintf("%d models; ask models --all lists; ask settings %s chooses", len(words), entry.Name)}
		}
		if len(words) == 0 {
			words = []string{"(lists none; give an id)"}
		}
		indent := strings.Repeat(" ", 2+width+3)
		line := fmt.Sprintf("  %-*s   %s", width, entry.Name, words[0])
		for _, w := range words[1:] {
			if len(line)+2+len(w) > 80 {
				rows = append(rows, line)
				line = indent + w
			} else {
				line += "  " + w
			}
		}
		rows = append(rows, line)
	}
	return strings.Join(rows, "\n")
}

var commandDescription = regexp.MustCompile(`ask-command:\s*(.+)`)

// overview presents the same concise command map to terminals and pipes.
func overview(a *agent.Registry) string {
	lines := []string{`ask · hand tasks to coding agents

Usage
  ask --model MODEL [options] PROMPT       Run a task
  ask --continue RUN [options] PROMPT      Follow up in the same conversation

Commands
  setup      Set ask up the first time
  settings   Change agents, defaults, worktrees and apps
  batch      Run many tasks in parallel
  bench      Compare models on the same tasks
  show       Print a saved answer
  wait       Wait for the next run to finish, then print it
  runs       List recent runs
  stop       Stop a running run
  clean      Remove finished worktrees and old runs
  models     List available models
  title      Name a command for a host
  docs       Read the docs
  update     Update ask to the latest release
  install    Install or update packages
  packages   List installed packages
  remove     Remove a package`}
	commands := find.Sorted(a.Paths, "commands")
	if len(commands) > 0 {
		own := []string{"Your commands"}
		for _, c := range commands {
			desc := ""
			if b, err := os.ReadFile(c.Path); err == nil {
				text := string(b)
				if len(text) > 4096 {
					text = text[:4096]
				}
				if m := commandDescription.FindStringSubmatch(text); m != nil {
					desc = home.Trim(m[1])
				}
			}
			if _, builtin := options[c.Name]; builtin {
				desc = "(hidden: ask's own " + c.Name + " wins; rename yours)"
			}
			own = append(own, fmt.Sprintf("  %-10s %s", c.Name, desc))
		}
		lines = append(lines, strings.Join(own, "\n"))
	}
	lines = append(lines, `Options
  --model MODEL        agent:id[#effort]
  --write              Allow edits and commands (default: read only)
  --worktree           Work in a new git worktree (with --write)
  --directory DIR      Directory to work in
  --timeout SECONDS    Seconds per task (default: 900, or your settings)
  --max-cost USD       Cost limit per task (default: model or settings)
  --json, --schema F   Require JSON, or JSON matching a schema
  --no-hooks           Skip your hooks

Models
`+modelLines(a), "Short forms: -m, -w, -c, -C, -t · ask help run · ask help COMMAND\ndocs  ask docs")
	return strings.Join(lines, "\n\n")
}

// topicHelp returns one command's page: what it does, usage, its fields or options, what it prints,
// examples, and its docs page. It returns "" for an unknown topic.
func topicHelp(topic string) string {
	switch topic {
	case "run":
		return `ask · run one task, or follow up on one

Usage
  ask --model MODEL [options] PROMPT
  ask --continue RUN [options] PROMPT

Options
  --model MODEL        agent:id[#effort], from ask models (or your default)
  --continue RUN       Follow up on RUN or RUN/TASK, in its conversation
  --write              Allow edits and commands (default: read only)
  --read               Explicitly require read-only access (alias: -r)
  --worktree           Work in a new git worktree and branch (with --write)
  --directory DIR      Directory to work in (default: current; alias: --dir, -C)
  --timeout SECONDS    Seconds per task (default: 900, or your settings; alias: -t)
  --title TEXT         Replace prompt text in agent session titles
  --max-cost USD       Dollars per task; 0 for no limit
  --json               Require a JSON answer
  --schema FILE        Require JSON matching this schema
  --no-hooks           Skip your hooks

Output
  stdout   The answer, and nothing else
  stderr   Status lines: ask RUN · state · model · details
  exit     0 ok · 1 failed · 2 usage error

Runs
  RUN is named from the prompt, like login-checked; a follow-up
  keeps the name. The run's id, like k3f9a2, works too.
  Use the RUN printed on stderr; examples below assume that name.
  Follow-ups keep their directory and inherit model and access.
  A positive recorded cost limit is inherited; else model, then settings.
  Pipe a prompt on stdin, or use - in place of PROMPT.

Examples
  ask --model claude:haiku-4.5 "Where is login checked?"
  ask --model codex:gpt-6.1-sol --title "Review login" "Inspect the login flow."
  ask --continue login-checked --write "Fix it and run the test."` + "\n\nShort forms: -m, -w, -c, -C, -t\ndocs  ask docs usage"
	case "bench":
		return `ask bench · compare models on the same tasks

Usage
  ask bench --model MODEL --model MODEL [options] FILE|-

Every task runs on every model, -n times each. An attempt passes when
its agent finishes and the task's check exits 0.

Tasks · a batch file, without model, plus
  check      Shell command run where the agent worked, the answer
             on stdin; exit 0 passes (default: finishing passes).
             Runs as you, even for read-only tasks; only use trusted checks

Options
  --model MODEL  A model to compare; repeat for each model
  -n N           Attempts per task and model (default: 1)
  --read         Require read-only tasks
  --write        Allow edits and commands
  --directory DIR  Directory for every task
  --timeout SECONDS  Time limit per task
  --title TEXT   Default session-title text for every attempt
  --max-cost USD Each attempt's cost limit
  -j N           Attempts at once (default: 4, or your settings)
  --keep         Keep write attempts' worktrees (default: discarded)
  --json         Print the report as JSON (default in a pipe)
  --yes          Start without asking in a terminal
  --no-hooks     Skip your hooks

Write attempts get fresh worktrees, discarded after their checks unless --keep.

Output
  stdout   A row per model: passed, median time, tokens, cost, $/pass
  stderr   Live rows and status lines, as in batch
  exit     0 when the bench ran, whatever passed · 2 usage error

Examples
  ask bench --model claude:sonnet-5.5 --model codex:gpt-6.1-sol -n 3 bench.json
  ask show RUN                     # the table again` + "\n\ndocs  ask docs bench"
	case "batch":
		return `ask batch · run tasks in parallel

Usage
  ask batch [options] FILE|-
  ask batch --resume RUN [-j N] [--no-hooks]

Tasks · a JSON array, or one object per line
  prompt     The task (required)
  id         Result id (default: position)
  model      agent:id[#effort] (default: --model, then followed-up run, then settings)
  continue   RUN or RUN/TASK to follow up
  write      Allow edits (default: --read/--write, then followed-up run, else read)
  worktree   Work in a new git worktree (default: --worktree)
  dir        Directory (default: --directory); follow-ups keep their previous directory
  timeout    Seconds (default: --timeout, then your settings, else 900)
  title      Text used in this task's session title (default: prompt)
  max_cost   Dollars this task may spend; 0 for no limit
             (default: --max-cost, then prior positive limit, then model/settings)
  json       Require a JSON answer
  schema     A JSON Schema, inline

Results · a JSON array on stdout, in task order
  run, id           RUN/TASK, and the task id
  model, name       Requested model and the model's own name
  ok                true or false
  answer, error     The answer, or why it failed
  seconds, usage    Time, and tokens and cost when reported
  session, dir      Agent session and the directory it worked in
  changes, commits  Files and commits a write run made
  worktree          The kept worktree and branch
  followups         Follow-ups your hooks asked for

Options
  --model, --read, --write, --worktree, --directory, --timeout   Task defaults
  --title TEXT                 Default session-title text for every task
  --json, --schema FILE         Defaults for JSON answers or a schema
  --max-cost USD               Each task's cost limit
  -j N                         Tasks at once (default: 4, or your settings)
  --no-hooks                   Skip your hooks

Use - for stdin; omitting FILE also reads stdin. Explicit --read refuses write tasks.

Examples
  ask batch -j 4 --model claude:haiku-4.5 tasks.json
  ask batch --resume summarize-public-api` + "\n\ndocs  ask docs batches"
	case "show":
		return `ask show · print a run again, without starting its agent

Usage
  ask show RUN [--json]
  ask show RUN/TASK [--json]

Output
  stdout   The answer; with --json, the whole result
  stderr   The run's status line

Examples
  ask show login-checked
  ask show summarize-public-api/api --json` + "\n\ndocs  ask docs runs"
	case "runs":
		return `ask runs · list recent runs, newest first

Usage
  ask runs [-n N] [--all]

Options
  -n N    How many (default: 20)
  --all   Every run, not only this repository's

Output
  RUN  ID  STARTED  STATUS  MODEL  TIME  TASK

Examples
  ask runs
  ask runs --all -n 50` + "\n\ndocs  ask docs runs"
	case "wait":
		return `ask wait · wait for the next run to finish, then print it

Usage
	  ask wait

Output
	  The first running run's answer on stdout, its status line on stderr, like ask show
	  exit        0 answer received, or no runs running · 1 failed or stopped

Examples
	  ask wait` + "\n\ndocs  ask docs runs"
	case "clean":
		return `ask clean · remove worktrees whose work has landed, and old runs

Usage
  ask clean [--days N] [--dry-run] [--yes]

Removes
  worktrees   Left by write runs, once clean and their changes are on main
              (merged or squash-merged), or when they changed nothing
  runs        Records older than N days (default 30) without a kept worktree

Options
  --days N    Age of runs to remove (default: 30)
  --dry-run   Show what would go, change nothing
  --yes       Remove without asking (needed without a terminal)

Examples
  ask clean
  ask clean --dry-run --days 7` + "\n\ndocs  ask docs runs"
	case "stop":
		return `ask stop · stop a run and its agents

Usage
  ask stop RUN

Output
  stderr   Stopped, or not running
  exit     0 stopped · 1 not running

Example
  ask stop login-checked` + "\n\ndocs  ask docs runs"
	case "models":
		return `ask models · list the models you can use, and turn them on or off

Usage
  ask models [--names] [--all]
  ask models MODEL... --enable | --disable | --max-cost USD

Output
  piped      One agent:id per line, the models that are on
  terminal   Grouped by agent, with each model's name and cost limit
  --names    agent:id and name, tab-separated, everywhere
  --all      Every model, with on or off

Changes, saved in ~/.ask/models.json
  --enable, --disable   Turn models on or off; off models are hidden and refused
  --max-cost USD        Their cost limit per task; 0 for your default

Examples
  ask models
  ask models --all
  ask models codex:gpt-5.6-sol opencode:gpt-4o --disable
  ask models claude:opus-5.5 --max-cost 10
  ask settings NAME                  # in a terminal, choose that agent's models` + "\n\ndocs  ask docs models"
	case "title":
		return `ask title · name a command for a host's task list

Usage
  ask title --command STRING [--description TEXT]
  ask title --hook        A PreToolUse hook event on stdin, as Claude Code sends it

Output
  stdout   MODEL · JOB, plus · write or · worktree when it applies;
           nothing when the command runs no task
  --hook   The tool input with the title as its description, in the background
  exit     0, or 2 when ask title itself is misused

Hooks
  title hooks may rename it; --no-hooks in the command skips them

Example
  ask title --command 'ask -m claude:haiku-4.5 "Check tests"' --description "check tests"` + "\n\ndocs  ask docs hosts"
	case "install":
		return `ask install · install agents and packages, or update every package

Usage
  ask install [SOURCE...]

Source
  NAME         An official agent, built into ask (see ask docs packages)
  OWNER/REPO   A GitHub repository
  URL          Any git repository
  PATH         A local git repository, like ./tools or ~/code/tools

Output
  stderr   What was installed, and whether each agent it brings is ready
  exit     0 ready · 1 an agent is not ready · 2 usage error

Examples
  ask install claude codex
  ask install owner/repo
  ask install` + "\n\ndocs  ask docs packages"
	case "packages":
		return `ask packages · list installed packages and what they offer

Usage
  ask packages

Example
  ask packages` + "\n\ndocs  ask docs packages"
	case "remove":
		return `ask remove · remove a package

Usage
  ask remove PACKAGE

Example
  ask remove owner/repo` + "\n\ndocs  ask docs packages"
	case "hooks":
		return `ask hooks · change tasks before they run and check results after

Hooks are executables in ~/.ask/hooks. The docs have the contract and examples.
This is a help topic, not an ask hooks command.` + "\n\ndocs  ask docs hooks"
	case "agents":
		return `ask agents · run a coding agent's CLI for ask

ask setup connects the official agents for the CLIs you have, and ask settings NAME changes
one. Your own are executables in
~/.ask/agents; the docs have the contract and examples.
This is a help topic, not an ask agents command.` + "\n\ndocs  ask docs agents"
	case "setup":
		return `ask setup · set ask up the first time, or check it

Usage
  ask setup             In a terminal: connect agents, then review settings and integrations;
                        once set up, your settings. Without a terminal: report only
  ask setup --yes       The recommended setup without asking: agents for the CLIs found,
                        the ask skill, task titles in Claude Code; shows what it changes
  ask setup --check     Report; exit 1 if no agent is ready or an installed agent can't run

Options
  --json   With --check, the report as JSON

Selected agents install during the walkthrough. The final review covers defaults
and app integrations; declining it leaves those agents installed.

Examples
  ask setup
  ask setup --check --json` + "\n\ndocs  ask docs setup"
	case "update":
		return `ask update · update ask to the latest release

Usage
  ask update            Replace this ask with the latest release, checked against its checksums
  ask update --check    Only say whether a newer release is out (exit 1 when one is)

ask installed by Homebrew or go install is updated there; ask update says how. In a terminal,
ask mentions a newer release at most once a day; ASK_NO_UPDATE_CHECK=1 turns that off.` + "\n\ndocs  ask docs install"
	case "docs":
		return `ask docs · read ask's docs, built in

Usage
  ask docs                  Every page, with what it covers
  ask docs PAGE             One page: styled in a terminal, markdown when piped
  ask docs --search TERM    Every line in the docs that mentions TERM

Options
  --raw     Markdown, even in a terminal
  --url     Print the page's GitHub URL (current main, not the bundled version)

Pages
  index, install, setup, settings, usage, runs, batches, bench, models, agents, hosts,
  hooks, commands, packages, compatibility, and each official agent's own page.
  A page's first letters are enough, like ask docs batch.

Examples
  ask docs settings
  ask docs --search worktree
  ask docs claude --raw` + "\n\ndocs  ask docs index"
	case "settings":
		return `ask settings · change agents, defaults, worktrees and apps

Usage
  ask settings                  In a terminal: every setting, grouped; edits wait for review
  ask settings NAME             One agent: install or remove it, its models, their cost limits
  ask settings get [KEY]        Print settings, or one value
  ask settings set KEY VALUE    Show what changes, then save it
  ask settings unset KEY        Back to the default

Keys
  model       The model when -m gives none, like claude:sonnet-5.5
  timeout     Seconds per task (default: 900)
  jobs        Batch tasks at once (default: 4)
  max_cost    Dollars a task may spend; ask stops it there (default: no limit)
  worktrees   Where --worktree works, like ~/code/worktrees/ask-{name}
  branches    A worktree's branch (default: ask/{name})
  hook        on or off: title ask runs in Claude Code's task list
  skills      Apps to give the ask skill: claude-code, codex, opencode, cursor, pi, all

Options
  --dry-run   With set or unset, show what would change and save nothing
  --json      With get, the values that apply, as JSON

Examples
  ask settings
  ask settings opencode
  ask settings set max_cost 2
  ask settings set worktrees '~/code/worktrees/ask-{name}' --dry-run
  ask settings get --json` + "\n\ndocs  ask docs settings"
	}
	return ""
}

// printHelp prints help, styled only on an interactive stdout: the title line's command and every
// section title in bold, the footer dim. Piped, it is the same text without escape codes.
func printHelp(text string) {
	lines := strings.Split(text, "\n")
	if status.CanStyle(os.Stdout) {
		for i, line := range lines {
			switch {
			case i == 0:
				if cmd, rest, ok := strings.Cut(line, " · "); ok {
					lines[i] = "\x1b[1m" + cmd + "\x1b[0m\x1b[2m · " + rest + "\x1b[0m"
				}
			case strings.HasPrefix(line, "docs  ") || strings.HasPrefix(line, "Short forms:"):
				lines[i] = "\x1b[2m" + line + "\x1b[0m"
			case line != "" && line[0] != ' ':
				lines[i] = "\x1b[1m" + line + "\x1b[0m"
			}
		}
	}
	fmt.Fprintln(os.Stdout, strings.Join(lines, "\n"))
}
