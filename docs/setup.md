# Setup

`ask setup` sets ask up the first time, and again whenever you switch provider or default model.
It asks before each change and reads its answers from stdin, so a script can drive it too.
Change single keys later with [`ask config`](config.md).

```text
$ ask setup
Which provider should ask use?
  1. OpenCode Go  key found in OpenCode
  2. OpenCode Zen
  3. OpenAI
  4. Another OpenAI-compatible endpoint
Choose [1]:
OpenCode already has a key for OpenCode Go; use it? [Y/n]
✓ opencode-go: saved to ~/.ask/auth.json
Download model names and prices from models.dev? [Y/n]
Default model:
   1. deepseek-v4-pro  DeepSeek V4 Pro
   2. glm-5.3  GLM 5.3
Default model, a number or an id [glm-5.3]:
✓ default model: opencode-go/glm-5.3
Codex is installed; add it as a harness, so codex:MODEL runs it? [Y/n]
Write the ask skill for Claude Code? [Y/n]
Write the ask skill for Codex? [Y/n]
```

- **The provider** is one you pick: OpenCode Go, OpenCode Zen, OpenAI, or another endpoint that
  speaks the OpenAI Responses protocol, added by a name and base URL. Its key goes to
  `~/.ask/auth.json`, mode 0600, and is not echoed as you paste it. When OpenCode itself already
  holds an API key for it, setup offers to copy it rather than ask. `NAME_API_KEY` in the environment works too and wins.
  ask does not sign in for you; a token from a subscription sign-in works where the provider
  permits it.
- **The model list** is a snapshot of [models.dev](https://models.dev) with display names and
  prices, for `ask models` and the cost shown on each session. Any model id works without it.
- **The default model** goes to `config.json`, so `ask "task"` needs no `-m`. Without one, ask
  picks a model itself and says which; see [Models](models.md).
- **External harnesses** for Claude Code and Codex are offered when those CLIs are installed, and
  written to `~/.ask/agent/extensions/NAME/`; see [Extensions](extensions.md). They use the CLI's own login.
- **The ask skill** goes to each agent that reads skills and is installed here: Claude Code,
  Codex, OpenCode, Cursor and pi, at `skills/ask/SKILL.md` in its folder. It teaches when to
  delegate, how to pass context, and the launch, wait, show and continue workflow. ask updates
  the skills it wrote and never replaces one you wrote (it marks its own with a comment line;
  delete that line to keep your edits).
