# Host titles

A host, like Claude Code, can label the ask commands its agents run, without guessing the model
or parsing ask flags:

```sh
ask title --command "$command" --description "$description"
```

`command` and `description` above are shell variables supplied by the host. To try it directly:

```sh
ask title --command 'ask --model claude:sonnet-5.5 "Review login"' --description "review login"
```

`--command` is the complete shell command. ask splits literal shell words, quotes, backslash
escapes, assignments, redirects, pipes, `&&`, `||`, semicolons and newlines, then finds the
first simple command whose program basename is `ask`. It never executes the command. Shell
expansions, compound shell syntax and incomplete input return no title.

A task title is `Model · Job`, with effort, and a ` · write` or ` · worktree` suffix.
Follow-ups inherit the recorded model and access unless overridden. A readable batch task file
with known models gets `Batch of N`, plus distinct display names when there are at most three;
unknown tasks get `Batch`. Tasks may also come from a literal heredoc, given to `ask batch -` or
written by an earlier `cat > FILE <<'EOF'` in the same command, since that file doesn't exist yet
when the host asks. A batch file path is resolved from the invocation
directory, even when `--directory` sets the tasks' working directory. Resumes get `Resume RUN`.

Job text comes from the trimmed description, with its first letter capitalized; leading
` · ` parts the title already says, like the model in `Sonnet 5.5 · Fix it`, are dropped. Without one,
ask uses the first prompt line (including saved follow-up or task-file prompts), clipped to
60 characters with `…`. Models use the same display names as `ask models --names`.

Non-task commands, user commands, help and unparseable commands print nothing. Both cases
exit 0; misuse of `ask title` exits 2. Title hooks can replace the title; `--no-hooks` in the
inner invocation skips them. Only model-listing agent processes can start.

## Claude Code

Claude Code shows each background command in its task list by the command's description. Let ask
write that description: `ask settings set hook on` adds a `PreToolUse` hook for `Bash` to
`~/.claude/settings.json`, or add it yourself:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "ask title --hook" }] }
    ]
  }
}
```

`ask title --hook` reads Claude Code's hook event on stdin. For a command that runs ask, it answers
with the same tool input and the title as its description, so an ask run can show as
`Sonnet 5.5 · Fix the login test · write`. It preserves the caller's choice of foreground or
background execution. For any other command it prints nothing and Claude Code carries on. It never blocks
a command: unreadable input prints nothing and exits 0. The original command is never changed.

## Agent sessions

Every official agent receives the same `ASK_TITLE`, formatted as `Model · Job`, with effort and
write/worktree suffixes when they apply. `--title TEXT` overrides the prompt text in that title;
batch task objects may use their own `title` field. Claude Code sets its session name, Codex names
its thread through the app-server, OpenCode sets its session title, and Pi and e name their
sessions. A `title` hook can customize
the result before it reaches the agent. This applies whether ask was started from a host app or a
terminal.

Receiving `ASK_TITLE` does not guarantee a native title: some harnesses have no noninteractive
session-naming API. Each official agent's page documents whether it applies the title. ask's own
host titles still work independently of that harness feature.

```sh
ask --model codex:gpt-6.1-sol --title "Review login" "Inspect the login flow."
```

## Other hosts

Any host that can relabel a shell command before running it can use the same title:

```sh
ask title --command "$command" --description "$description"
```

It prints the title, or nothing when the command isn't an ask task. Hosts that speak Claude Code's
hook format can use `ask title --hook` as it is. The shell tools of Codex, Pi and OpenCode 2 have no
description to show, but their agent sessions are still named as described above. See [Hooks](hooks.md) for ask's own `title`
event, which can customize host and agent-session titles.
