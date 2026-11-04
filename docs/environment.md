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
custom auth/helper variable for Pi, copy the `inherit` list from the installed
`packages/ask/packages/pi/agents/pi.environment.json` under Ask's home, then add its
name. Keep the default auth and path variables you need.

The policy applies to tasks, batches, follow-ups and model discovery. Changes take
effect on the next agent launch; saved sessions do not freeze the policy. Ask always
supplies fresh contract fields such as `ASK_HOME`, `ASK_BIN`, `ASK_CONTRACT` and
per-task inputs. An inherited `ASK_ENVIRONMENT` is discarded. Ask task/result and
other hooks and custom commands keep their existing environment and behavior.
Environment configuration errors fail the agent launch, without printing the
configuration's text or values. Unknown keys and wrong types are errors.

## Pi defaults and opt-in

Pi is the first adapter with minimal defaults. It inherits runtime paths, locale,
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

Other official adapters currently retain their existing environment/integration
behavior unless you configure an `inherit` allowlist. They do not yet declare
integration controls; any explicit `integrations` entry for such an adapter fails
before it runs, including `false`. There is no blanket minimal-mode claim for them.
Installed Claude Code help shows that `--bare`, `--safe-mode` and `--restricted`
combine restrictions with changes to auth, instruction discovery or settings/hooks;
Ask does not use them as substitutes for independent controls. Codex and other
harnesses need separately researched adapters and policy-preserving tests.

## Adapter contract

An executable at `agents/NAME` may ship a JSON sidecar
`agents/NAME.environment.json` with `inherit` (default variable names) and
`integrations` (supported keys mapped to default booleans). Ask uses the sidecar of
the executable selected by normal discovery, so a local override does not acquire
an official package's claims. Sidecars ship with packages; user policy stays in
Ask's home. A missing sidecar preserves the previous contract.

Ask merges configured integration booleans over declared defaults and passes that
object as `ASK_ENVIRONMENT`. The adapter must enforce it, or refuse before sending
the task to its harness. Declaring a key does not promise every combination is
possible. Integration semantics belong in adapters; core only validates and passes
the policy. Generic environment filtering also works for custom agents with no
sidecar. This is an additive contract; `ASK_CONTRACT` stays at 1.
