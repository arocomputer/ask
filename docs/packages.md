# Packages

A package is a git repository shaped like `~/.ask`: any of `agents/`, `hooks/` and `commands/`.
Packages are how people share what they built for ask and keep it up to date, without forking ask
or copying files by hand.

```text
team-tools/
├── agents/     my-cli
├── hooks/      verify
└── commands/   review
```

## Official agents

ask comes with an official package for each common coding agent CLI, in
[`packages/`](../packages) of its repository and built into the binary. A bare name installs one,
without the network:

```sh
ask install claude                # Claude Code
ask install codex opencode        # Codex and OpenCode
ask install copilot gemini
ask install pi e cursor aider amp qwen kimi
ask install goose cline kilo continue openhands vibe
```

```text
ask: installed ask/packages/claude: agents: claude
ask: claude is ready: 4 models, see ask models
```

ask refreshes installed official packages to match its build, without the network. Replacements
are serialized per package across ask processes. Each new tree is assembled beside the installed
one, which is kept as a backup until promotion succeeds. Failed promotion restores the previous
installation; an interrupted replacement is recovered on the next invocation. If restoration
fails, the error names the retained backup for manual recovery. Hidden staging directories,
backups and lock files are not discoverable packages.

Automatic refresh failures warn on stderr and let the requested command continue with the
previous installation when available. Explicit `ask install NAME` or `ask update packages`
reports installation failures with exit 1. `ask remove claude` removes one.

Installing these packages does not install their CLIs or Node.js. The official agents need
Node.js 18 or newer and an authenticated CLI (OpenCode needs a connected provider); see
[Install](install.md#set-up).

After installing, ask checks each agent the package brings by asking it for its models. An agent
that can't run says why, like a CLI that isn't installed, and `ask install` exits 1:

```text
ask: codex is not ready: Codex not found: install it from https://developers.openai.com/codex, or set ASK_CODEX_BIN to its path
```

An adapter is not a promise that every harness has the same features. Read-only runs must be
enforced by tool restrictions or a sandbox, not just by instructions to the model. An adapter
that cannot enforce them refuses a read run rather than silently granting writes. Native session
titles, continuation, token counts and cost reporting depend on the harness; consult
`ask docs NAME` before relying on them. ask validates JSON answers itself when the harness has no
native schema flag.

### Harness capabilities

All packages are built into ask; `ask install NAME` connects an already installed CLI.
`ask docs NAME` gives setup instructions, research sources and detailed limits.

| Agent | Access | Continue | Native title | Usage |
| --- | --- | --- | --- | --- |
| claude | Read/write | Yes | Yes | Live tokens, final cost |
| codex | Read/write | Yes | Best-effort | Live tokens |
| opencode | Read/write | Yes | Yes | Live tokens/cost |
| copilot | Read/write | Yes | New sessions | Final tokens |
| gemini | Read/write¹ | Yes | No | Final tokens |
| pi | Read/write | Yes | Yes | Live tokens/cost |
| e | Read/write | Yes | Yes | Live tokens, final cost |
| cursor | Write only | Yes | No | None |
| aider | Write only | No | No | Final tokens/cost |
| amp | Write only | Same mode | New threads | Live tokens |
| qwen | Write only | Yes | No | Tokens |
| kimi | Read/write | Same access | No | None |
| goose | Write only | Yes | New sessions² | New-run totals only |
| cline | Write only | Yes | No | None |
| kilo | Read/write | Yes | Yes | Live tokens/cost |
| continue | Write only | No | No | None |
| openhands | Write only | Yes | No | None |
| vibe | Write only | Yes | No | Native price cap, no usage |

¹ Gemini refuses read runs when system policies prevent applying/verifying ask's restrictive
admin policy. Trusted folders remain an upstream prerequisite.

² Goose appends a unique suffix to the supplied title because it resumes sessions by name.
Its follow-up usage is omitted rather than counting earlier turns again.

No usage means cost limits cannot be measured by ask. Final-only cost can produce an overspend
note but cannot stop a turn midway. Vibe's native price cap depends on the configured model
pricing.

Read access is a model-tool boundary unless the harness provides an OS sandbox; it does not make an
installed CLI or plugin untrusted-code-safe.

Several CLIs have no reliable machine-readable model list. Those adapters intentionally list no
models; use the harness's own model listing and `ask models NAME:ID --enable` to add exact IDs.

Continue needs `ASK_CONTINUE_CONFIG` (a JSON-encoded config), Vibe needs `VIBE_MODELS`, and Qwen
reads its native `modelProviders` settings. e currently requires building upstream from source; it
never changes directory-trust settings for you.

### Choosing harnesses

The October 2026 expansion surveyed Copilot, Gemini CLI, Pi, Cursor CLI, Aider, Goose, Cline,
Kilo, Amp, Continue, OpenHands, Amazon Q/Kiro, Mistral Vibe, Qwen Code and Kimi Code; e was
included by request. Selection considers adoption signals and a usable noninteractive CLI, not
just whether an IDE extension can read ask's skill.

For context, the [npm downloads API](https://api.npmjs.org/downloads/point/last-week/@github/copilot)
reported about 1.72 million weekly downloads for Copilot, 870 thousand for Pi's former
`@mariozechner/pi-coding-agent` package, 453 thousand for Gemini CLI, 33 thousand for Kilo and
27 thousand for Amp for September 28–October 4, 2026. GitHub repositories also show substantial
interest in Aider, Goose, Cline, Continue and OpenHands.

Downloads and repository stars are imperfect adoption proxies, not counts of active CLI users;
IDE/platform popularity alone does not establish that a CLI is mature. e is a requested
development-stage integration, not a claim of widespread adoption.

**Deferred: Amazon Q / Kiro.** Kiro has a real
[headless CLI](https://kiro.dev/docs/cli/headless/) with model selection and JSON streaming, but its
published docs do not define the event fields needed to separate answers from tool output and
identify failed/interrupted runs.

The retired [Amazon Q CLI source](https://github.com/aws/amazon-q-developer-cli) has a different
argument and output contract and cannot establish Kiro's wire format. No placeholder adapter is
installed; support needs a verified success/tool/failure stream fixture first. This is a
contract-verification gap, not a claim that Kiro lacks headless mode.

## Install, update, remove

```sh
ask install team/tools                   # OWNER/REPO on GitHub
ask install https://gitlab.com/team/tools.git
ask install ~/code/my-ask-tools          # a local repository, while you work on it
ask update packages                      # update installed packages only
ask install                              # older form: update every installed package
ask packages                             # what is installed, and what each offers
ask remove tools
```

```text
ask/packages/claude         agents: claude
github.com/team/tools       agents: my-cli · commands: review · hooks: verify
```

`ask install` clones into `~/.ask/packages/HOST/OWNER/REPO`, and updating pulls fast-forward only;
official packages go to `~/.ask/packages/ask/packages/NAME`. Nothing runs at install time except
the readiness check: no scripts, no prompts.

A bare NAME always means an official package and `OWNER/REPO` always means GitHub, whatever folders
are here; name a local repository by a path such as `./tools`, `../team/tools` or `~/code/tools`.
Installing a source where another one is already installed, like a second local `team/tools`,
fails: remove the first.

Your own agent can be a package too: put it in `agents/` of a repository and
`ask install you/your-agents`.

## Which one runs

ask looks for an agent, hook or command in `~/.ask` first, then in each package in path order. The
first one with the name wins, so **yours always win**: to change something a package offers, put
your own of the same name in `~/.ask`, and your package updates still apply to everything else.

A package's executables run with your permissions, like any software you install. Install packages
from people you trust, and read what they do.
