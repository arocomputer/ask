# Settings

ask needs a model and a key for its provider. `ask settings` sets both up; you can also edit two
small files, or use the provider's own key variable.

## ask settings

The first time, it asks which provider to use, takes its API key (hidden as you paste it, then
checked with one tiny request before it is saved), asks which of the provider's models you want,
and which is the default:

```text
? Which provider? OpenCode Go
! Get a key at https://opencode.ai/console
? Paste your OpenCode Go API key: ******************
✓ Logged in to OpenCode Go
? Which OpenCode Go models do you want? GLM-5.3, MiniMax-M3
✓ Saved 2 models
? Default model? GLM-5.3
✓ Default model set to opencode-go/glm-5.3
```

Run it again and it asks what to change: the default model, your models, adding or removing a
provider, or the timeout. In every list, typing filters it, the arrow keys move, Enter picks and,
in a list of models, Space toggles one. It needs a terminal; in a script, use the files below.

## Sandbox

OS confinement is enabled by default. To disable it, add `"sandbox": false` to
`~/.ask/config.json` (or `$ASK_HOME/config.json`). Omit the field or set it to `true` to enable it.
This is a config-only boolean, with no mode switcher or per-task override.

New turns inherit the setting; interrupted turns retain their recorded choice. Built-in tools
and the shipped Claude Code/Codex adapters honor it. Extensions receive `Run.sandbox`.
Existing read/write tool selection remains independent: disabling confinement does not add
write tools to built-in read tasks. Without confinement, read-only intent is not OS-enforced.

Disabled task processes have normal account-level filesystem and network access. Environment
credential filtering, cancellation and output limits remain, but accessible credential files
are no longer protected by OS policy. `ask doctor` reports the disabled setting.

`ask.sandbox` is a bundled, short-lived Linux helper executable, not a service or daemon.
Disabled execution does not require it or bubblewrap.

## ChatGPT

Choose **ChatGPT** in `ask settings` to use your ChatGPT Plus or Pro plan instead of an API key.
It follows OpenAI's sign-in for open-source tools: you approve ask in your browser, and its
requests count against your plan. Manage how much ask may use at
[ChatGPT settings → Usage](https://chatgpt.com/settings/usage).

```text
? Which provider? ChatGPT
! Open this link on any device to sign in with ChatGPT:
https://auth.openai.com/api/accounts/authorize?...
  After you approve, your browser lands on a page that won't load. Copy that page's address and paste it here.
? Paste the address, or finish in the browser: pasted
✓ Signed in to ChatGPT as you@example.com
! You're using your ChatGPT plan. Manage how much ask may use at https://chatgpt.com/settings/usage
```

It works wherever ask runs. When ask runs at your screen, it opens your browser, and the sign-in
finishes by itself when the browser comes back. Over SSH, or anywhere without a screen, open
the link on any device, your phone included; after you approve, paste the address the browser
lands on. Both ways are always open, so nothing needs choosing.

The models are your account's own, named `chatgpt/MODEL`. The sign-in renews itself; removing
ChatGPT in `ask settings` signs out, ending the session with OpenAI too. One ChatGPT account at a
time: sign out to switch.

## Claude Code and Codex

Once `ask install claude` or `ask install codex` has turned a harness on, it is listed in
`ask settings` as a provider. Choosing it checks that it is installed and signed in, then asks
which models you want. ask never signs in for them: if one isn't signed in, sign in its own way
(`claude`, then `/login`; `codex login`). See [Harnesses and extensions](extensions.md).

## The files

`~/.ask/config.json`:

```json
{
  "model": "opencode-go/glm-5.3",
  "models": ["opencode-go/glm-5.3", "opencode-go/minimax-m3"],
  "timeout": 900
}
```

- `model` is the default for tasks that don't name one.
- `models` are the models you chose; `ask models` lists them and `ask settings` offers them
  first. A request can still use any model in the catalog.
- `timeout` is how many seconds a turn may run before it is stopped (default 900).
- `tools` turns tools of ask's own loop off: `{"shell": false}`; see `ask tools` and
  [turning tools off](extensions.md#turning-tools-off-and-replacing-them).
- `extensions` and `harnesses` are what `ask install` turned on and how each harness runs; see
  [Harnesses and extensions](extensions.md#changing-how-a-harness-runs).

`~/.ask/auth.json`, mode 0600, holds pasted keys, and the ChatGPT sign-in under `chatgpt`:

```json
{ "opencode-go": { "api_key": "..." } }
```

When it asks for a key, `ask settings` says where to make one and how it starts. For the
common providers:

| Provider | Where | Starts with |
| --- | --- | --- |
| OpenCode Go, OpenCode | [opencode.ai/console](https://opencode.ai/console), Account › Personal API keys (a workspace with Go for `opencode-go`) | `oc_sk_` |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `sk-` |
| Anthropic | [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) | `sk-ant-` |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | `sk-or-` |
| DeepSeek | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | `sk-` |
| xAI | [console.x.ai](https://console.x.ai), API Keys | `xai-` |
| Mistral | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) | |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | `gsk_` |
| Together AI | [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys) | |
| Fireworks AI | [app.fireworks.ai/account/api-keys](https://app.fireworks.ai/account/api-keys) | `fw_` |
| Cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai), API Keys | `csk-` |
| Z.AI | [z.ai/manage-apikey/apikey-list](https://z.ai/manage-apikey/apikey-list) | |
| Moonshot AI | [platform.kimi.ai/console/api-keys](https://platform.kimi.ai/console/api-keys) | `sk-` |
| DeepInfra | [deepinfra.com/dash/api_keys](https://deepinfra.com/dash/api_keys) | |

Other providers get a link to their docs. OpenCode's free models only work inside OpenCode, so
ask doesn't offer them.

A provider may also have `"base_url"` to send its requests somewhere other than the catalog's
endpoint, such as a proxy.

## Keys from the environment

A provider's own variable works without settings: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY` and so on, as the [catalog](models.md) names them. A pasted key wins over the
variable. ask never reads another program's saved logins.

## ask doctor

```text
✓ Runtime   Bun 1.4.4
✓ Home      /home/you/.ask is writable
✓ Catalog   218 providers, updated about 2 hours ago
✓ Model     opencode-go/glm-5.3
✓ Key       OpenCode Go accepts the pasted key
✓ claude    Claude Code 2.1.318 is signed in (claude.ai)
✓ Sandbox   Landlock 6; no Unix sockets before Linux 7.1
✓ Worker    background tasks can start
✓ Git       git 2.47.3
```

Each line is one thing a task needs; each installed harness gets a line of its own. Anything broken is marked `X` with how to fix it under it,
and `ask doctor` then exits 1. The key check sends one tiny request.

## Environment

- `ASK_HOME` moves `~/.ask`.
- `ASK_PARENT` names the agent conversation calling ask, for one ask can't recognize by itself
  (see [Sessions](sessions.md#whose-sessions)).
- `NO_COLOR` turns color off; `CLICOLOR_FORCE` keeps it when output is piped.
