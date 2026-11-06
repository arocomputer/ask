# Settings

ask needs a model and a key for its provider. `ask settings` sets both up; you can also edit two
small files, or use the provider's own key variable.

## ask settings

Choose **Connect a provider**, then a provider. API keys stay hidden as you paste, with a short
acknowledgement when input arrives. Ask checks the key with one tiny request before saving it,
then asks for models and a default. Each completed action saves immediately; settings stays open
until you choose **Done** or press Esc at the main menu.

```text
ask / settings

  Default model
  Models
❙ Connect a provider
  Disconnect a provider
  Timeout
  Done

ChatGPT, API keys or installed harnesses

```

The focused item is bold with a narrow `❙` bar beside it. Typing filters lists; arrows move,
Enter selects, and Space toggles models in multiselect lists. Esc clears a filter, then goes
back without saving the unfinished prompt. Completed changes remain saved. Model actions appear
once a provider is connected. A terminal is required; in scripts, use the files below.

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

Choose **Connect a provider → ChatGPT** in `ask settings` to use your ChatGPT Plus or Pro plan instead of an API key.
It follows OpenAI's sign-in for open-source tools: you approve Ask in your browser, and its
requests count against your plan. Manage how much ask may use at
[ChatGPT settings → Usage](https://chatgpt.com/settings/usage).

```text
Connect a provider  ChatGPT

ask / connect ChatGPT
Open this link in your browser:
https://auth.openai.com/api/accounts/authorize?...
After signing in, copy the address of the page that cannot load.
Paste it below. This link stays active until you cancel.
Callback URL

❙ http://127.0.0.1:1455/auth/callback?...

… characters

Connected to ChatGPT as you@example.com
Usage settings  https://chatgpt.com/settings/usage
```

It works wherever ask runs. When ask runs at your screen, it opens your browser, and the sign-in
finishes by itself when the browser comes back. Over SSH, or anywhere without a screen, open
the link on any device, your phone included; after you approve, paste the address the browser
lands on, then press Enter. The prompt shows the pasted address separately and reports its
character count, including on narrow phone terminals. SSH is detected automatically; there is
no `--remote` flag. Both ways are always open, so nothing needs choosing.
If a pasted URL is incomplete or belongs to another attempt, ask keeps the current login link
active and lets you paste again. It does not silently start a new sign-in. Ctrl-C cancels it.

The models are your account's own, named `chatgpt/MODEL`. The sign-in renews itself; removing
ChatGPT in `ask settings` signs out, ending the session with OpenAI too. One ChatGPT account at a
time: sign out to switch.
New registrations request the display name **Ask**; an existing registration may retain the
name it was originally given. The command, provider identifiers and filesystem paths remain lowercase.

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
ask / doctor

ok    Runtime    Bun 1.4.4
ok    Home       /home/you/.ask is writable
ok    Catalog    218 providers, updated about 2 hours ago
ok    Model      opencode-go/glm-5.3
ok    Key        OpenCode Go accepts the pasted key
ok    claude     Claude Code is signed in
ok    Sandbox    bubblewrap + Landlock 6; no command network; read-only Git metadata
ok    Worker     background tasks can start
ok    Git        git 2.47.3
```

Each entry is one thing a task needs; each installed harness gets an entry of its own. Narrow
terminals stack the details below the name. Anything broken is marked `fail` with how to fix it,
and `ask doctor` then exits 1. The key check sends one tiny request.

## Environment

- `ASK_HOME` moves `~/.ask`.
- `ASK_PARENT` names the agent conversation calling ask, for one ask can't recognize by itself
  (see [Sessions](sessions.md#whose-sessions)).
- Output is monochrome: the terminal's own foreground/background, bold and dim text. No RGB or
  named colors are forced, so it works on dark and light themes.
- `NO_COLOR` disables emphasis; `CLICOLOR_FORCE` forces monochrome emphasis for prose. Piped
  tables always remain plain TSV, and JSON requests keep their machine-readable format.
- `TERM=dumb` disables styling and interactive prompts.
