# Agent environments

Edit `~/.ask/environment.json` (`$ASK_HOME/environment.json` when overridden) to
control what Ask passes to each agent. This file is optional and is never rewritten
by installation or updates. It contains variable **names**, not credentials:

```json
{
  "agents": {
    "pi": {
      "integrations": {
        "mcp": false,
        "plugins": false,
        "skills": false,
        "hooks": true
      }
    },
    "my-agent": {
      "inherit": ["HOME", "PATH", "TMPDIR", "LANG", "MY_PROVIDER_API_KEY"]
    }
  }
}
```

`inherit` is an exact allowlist of inherited environment variable names. If present,
it **replaces** the adapter's default list; `[]` passes only Ask's contract fields.
There are no patterns, values, interpolation or shell commands in this file.
Missing variables stay absent. An omitted `inherit` uses the selected adapter's
defaults, or the existing full inheritance for adapters without defaults. To add a
custom auth/helper variable, copy the `inherit` list from the selected adapter's
installed `packages/ask/packages/NAME/agents/NAME.environment.json` under Ask's home,
then add its name. Keep the default auth and path variables you need. For example,
a Codex custom provider's `env_key` may name a variable outside the shipped list.

The policy applies to tasks, batches, follow-ups, installation readiness and model discovery. Changes take
effect on the next agent launch; saved sessions do not freeze the policy. Ask always
supplies fresh contract fields such as `ASK_HOME`, `ASK_BIN`, `ASK_CONTRACT` and
per-task inputs. Inherited `ASK_ENVIRONMENT` and `ASK_ENVIRONMENT_REQUESTED` are discarded. Ask task/result and
other hooks and custom commands keep their existing environment and behavior.
Environment configuration errors fail the agent launch, without printing the
configuration's text or values. Unknown keys and wrong types are errors.

## Available defaults

Pi, Claude, Codex and OpenCode ship environment allowlists. They preserve `HOME`,
their config directory overrides, proxy/CA settings and provider authentication.
Claude includes Anthropic OAuth/API tokens, Bedrock/AWS profiles and federation,
Vertex ADC and Foundry/Azure identity. Codex retains `CODEX_HOME`, OpenAI and Azure
endpoints/keys, plus AWS and Google identity settings. OpenCode includes its
multi-provider keys, GitHub/Copilot tokens and AWS, Google and Azure identity.
Existing credential files and keychains remain available. Config-defined helpers
keep their configuration; helpers with custom environment dependencies need an
`inherit` override. The exact variable names are in each sidecar. Node preloads,
terminal integration tokens and unrelated application credentials are excluded.

All four declare preferred defaults of `mcp: false`, `plugins: false`,
`skills: false`, `hooks: true`. **Only the controls below are enforced.** An omitted
setting can fall back to normal harness behavior with a warning when independent,
policy-preserving controls are unavailable. Successful tasks save that limitation
in their run note and show it in status; adapter stderr alone would be hidden.
An explicit `false` must be enforced or the launch fails, even if it equals a
default. Pi retains its stricter refusal behavior when required controls are absent.

| Adapter | Enforced by default | Limitations |
| --- | --- | --- |
| Pi | MCP, extensions, skills, templates and themes disabled | Possible extension policy hooks cause refusal; see below |
| Claude | MCP disabled with strict empty config; skills/commands disabled; read built-in tools limited | Checks installed help; older CLIs retain unavailable controls' normal behavior with a warning. Plugins retain normal behavior with a warning |
| Codex | Environment inheritance only | Normal MCP/plugins/skills/hooks retained with a warning; explicit integration restrictions refused |
| OpenCode v1/v2 | Environment inheritance only | Normal MCP/plugins/skills/hooks retained with a warning; explicit integration restrictions refused |

`hooks: true` preserves the harness's own hook configuration and trust decisions;
it does not force hooks on or override administrator policy. `hooks: false` is
refused by all four because optional hooks cannot be separated safely from policy
hooks. Ask's own hooks keep their existing behavior.

## Claude controls and opt-in

Claude Code 2.1.318's actual `--help` was inspected. Before every task and follow-up,
the adapter probes `--help` without changing config or invoking reset modes. When
supported, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` prevents configured
MCP startup and `--disable-slash-commands` disables skills and commands. Read runs
also use `--tools Read,Grep,Glob`; `--allowedTools` alone is a permission grant,
not a tool inventory limit. The ordinary permission mode is `manual` in newer
help and `default` in older versions. Existing deny rules remain in place.

Set `skills: true` to retain normal skill discovery, or `mcp: true` for normal MCP
configuration on trusted write runs. MCP opt-in is refused on read runs. Plugins
can supply skills, MCP and policy hooks, and there is no confirmed independent
global plugin-off control. Defaults therefore retain plugins with a visible
limitation; explicit `plugins: false` is refused. To acknowledge normal loading
without that warning on trusted write runs:

```json
{"agents":{"claude":{"integrations":{"mcp":true,"plugins":true,"skills":true,"hooks":true}}}}
```

Plugins opt-in requires MCP and skills opt-in too, and is refused for read runs.
Claude's `--bare`, `--safe-mode`, `--restricted`, empty settings sources and blanket
hook resets are not used: they can discard auth, instructions or policy hooks.
Normal settings, `CLAUDE.md` and keychain/config auth discovery remain intact.
The optional real-CLI test uses a local API/MCP fixture to verify config auth,
instructions and hook execution without a real model or account.

## Codex and OpenCode limitations

Codex 0.166.0's top-level, `exec`, `exec resume` and `app-server` help were inspected.
`--ignore-user-config` preserves the auth directory but drops config-defined
providers, auth selection and hooks. It is not used. A local app-server config
probe confirmed that `-c mcp_servers={}` leaves inherited servers present because
config tables merge. Feature/tool restrictions alone do not establish a global
MCP/skill/plugin loading boundary. Ask retains config, `AGENTS.md`, execpolicy
rules and hook trust; it does not add bypass flags. The auxiliary thread-naming
app-server uses the same preserved environment and config.

OpenCode 2.2.5's actual top-level, `run`, `debug` and `serve` help were inspected.
Its additive config/discovery and plugin hooks do not provide a confirmed global
minimal reset preserving authentication, project instructions and policy. V1 and
v2 keep their existing version checks, tool permissions and startup behavior.
`--standalone` on v2 isolates the server lifetime, not integration loading.
`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and inline `OPENCODE_CONFIG_CONTENT` are
preserved; inline content must be a JSON object. Injected agent settings retain
inline providers, plugins and other agents. Permissions cannot stop plugins from
executing code or MCP servers from connecting.

Both adapters therefore retain normal integrations with a limitation note by
default. Explicit `false` for any integration fails before launching a task or
model-discovery CLI. Setting all four integrations to `true` acknowledges normal
loading and removes the warning; it does not override native enablement or trust.
There is no claim of integration isolation for either adapter, including read runs.

## Pi defaults and opt-in

Pi inherits runtime paths, locale,
proxy/CA settings, its config/session directory overrides and supported provider
authentication variables. This includes Anthropic keys, OAuth/bearer and federation
settings, OpenAI and other provider keys, Copilot tokens, Vertex ADC and AWS
profiles, session tokens, web identity and container credential paths. `HOME` and
`PI_CODING_AGENT_DIR` are preserved: existing `auth.json`, `models.json`, OAuth
refresh state, ADC and AWS files continue to work. Custom providers and credential
helpers may need extra variable names. The complete list is in the adapter's
`pi.environment.json`. Unrelated parent variables, Node preload options, terminal
integration tokens and arbitrary application credentials are not inherited by
default. Ask does not copy, print or save credential values in its policy.

By default Pi gets `--no-mcp`, `--no-extensions`, `--no-skills`,
`--no-prompt-templates` and `--no-themes`. Both read and write runs set
`PI_OFFLINE=1` to avoid startup package downloads; model API requests still work.
The adapter checks installed `--help` for the required flags before sending a task;
a CLI without reliable controls fails instead of ignoring the restriction. Pi
1.5.0's real help was inspected: `--tools read,grep,find,ls` alone **keeps MCP tools**,
while `--no-mcp` prevents native MCP server connections and tool registration.

Set `skills: true` to allow Pi's normal skill discovery. It leaves MCP and
extensions disabled. `mcp: true` permits all normally configured native MCP
servers for a **write** run (using explicit `--extension builtin:mcp` while other
extensions stay disabled); there is no per-server allowlist in Ask. MCP opt-in is
refused for read runs because the adapter cannot enforce a read boundary on those
tools. This includes follow-ups.

Extensions can supply tools, skills, MCP bridges and policy hooks. Ask cannot
classify arbitrary extension code. Before disabling extensions, it conservatively
checks global and project/ancestor `.pi` settings for `extensions`, `packages` or
`hooks`, and checks extension directories. Configured sources, even currently
disabled ones, unreadable sources and malformed settings cause a refusal rather
than silently suppressing a possible policy hook. Ask does not resolve packages or
execute extension code to inspect it. Review the sources, then explicitly opt in
for trusted write runs if needed:

```json
{
  "agents": {
    "pi": {
      "integrations": {
        "mcp": true,
        "plugins": true,
        "skills": true,
        "hooks": true
      }
    }
  }
}
```

`plugins` means Pi's extension/package discovery. Enabling it requires MCP and
skills opt-in too: arbitrary extensions could reintroduce either. Read runs refuse
plugins. `hooks: false` is always refused because Pi cannot disable optional hooks
separately from policy hooks. This is a conservative check of known Pi sources,
not a guarantee about future harness discovery rules or concurrently edited files.
Ask does not pass `--no-context-files`, change `HOME` to an empty directory, strip
project instructions, force project approval, or bypass harness trust policy.
`AGENTS.md` and related context discovery retain Pi's normal behavior.

## Limits and other adapters

These controls govern startup inheritance and harness integration loading. They
are **not an OS sandbox**, filesystem isolation, network blocking, a secret vault
or a guarantee against malicious tools. Agents still run as the current user;
write runs and explicitly enabled integrations can read files, obtain credentials,
start processes and access the network. Pi itself writes sessions and may migrate
configuration or cache search binaries. Clearing an environment variable does not
revoke access to credential files. A continued conversation can still contain text
from previously enabled integrations.

Official adapters other than these four retain their existing environment/integration
behavior unless you configure an `inherit` allowlist. They do not yet declare
integration controls; any explicit `integrations` entry for such an adapter fails
before it runs, including `false`. There is no blanket minimal-mode claim for them.

## Adapter contract

An executable at `agents/NAME` may ship a JSON sidecar
`agents/NAME.environment.json` with `inherit` (default variable names) and
`integrations` (supported keys mapped to default booleans). Ask uses the sidecar of
the executable selected by normal discovery, so a local override does not acquire
an official package's claims. Sidecars ship with packages; user policy stays in
Ask's home. A missing sidecar preserves the previous contract.

Ask merges configured integration booleans over declared defaults and passes that
object as `ASK_ENVIRONMENT`. It also passes the user's explicitly configured
integration object as `ASK_ENVIRONMENT_REQUESTED` (`{}` if none). Explicit
restrictions must be enforced or refused before sending a task to the harness.
Unavailable defaults may retain normal behavior only with an accurate limitation
note. A directly invoked adapter without `ASK_ENVIRONMENT_REQUESTED` treats every
key in `ASK_ENVIRONMENT` as explicit. Declaring a key does not promise every
combination is possible. Integration semantics belong in adapters; core only validates and passes
the policy. Generic environment filtering also works for custom agents with no
sidecar. This is an additive contract; `ASK_CONTRACT` stays at 1.

docs  docs/environment.md
