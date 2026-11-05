# Setup

`ask setup` sets ask up the first time. It asks before each change and reads its answers from
stdin, so a script can drive it too. Change anything later with [`ask config`](config.md).

```text
$ ask setup
openai API key (enter to skip):
opencode API key (enter to skip):
OpenCode has a key for opencode-go; use it for ask too? [Y/n]
opencode-go: saved to ~/.ask/auth.json
Download the model list from models.dev? [Y/n]
Default model, like opencode-go/glm-5.3 (enter to skip): opencode-go/glm-5.3
Codex is installed; add it as a harness, so codex:MODEL runs it? [Y/n]
Write the ask skill for Claude Code? [Y/n]
Write the ask skill for Codex? [Y/n]
```

- **Credentials** go to `~/.ask/auth.json`, mode 0600, one per provider: OpenAI, OpenCode
  Console and OpenCode Go. When OpenCode itself already holds an API key for one of them, setup
  offers to copy it rather than ask again. `NAME_API_KEY` in the environment works too and wins.
  ask does not sign in for you; a token from a subscription sign-in works where the provider
  permits it.
- **The model list** is a snapshot of [models.dev](https://models.dev) with display names and
  prices, for `ask models` and the cost shown on each session. Any model id works without it.
- **The default model** goes to `config.json`, so `ask "task"` needs no `-m`.
- **External harnesses** for Claude Code and Codex are offered when those CLIs are installed, and
  written to `~/.ask/agent/extensions/NAME/`; see [Extensions](extensions.md). They use the CLI's own login.
- **The ask skill** goes to each agent that reads skills and is installed here: Claude Code,
  Codex, OpenCode, Cursor and pi, at `skills/ask/SKILL.md` in its folder. It teaches when to
  delegate, how to pass context, and the launch, wait, show and continue workflow. ask updates
  the skills it wrote and never replaces one you wrote (it marks its own with a comment line;
  delete that line to keep your edits).
