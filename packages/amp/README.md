# amp

The official ask agent for [Amp](https://ampcode.com). It runs `amp --execute --stream-json` for
ask, so `ask -w -m amp:medium "..."` hands a task to Amp. **Write runs only**: see
[Read and write](#read-and-write).

## Install

```sh
ask install amp
```

Requires Amp, signed in (`amp login`, or `AMP_API_KEY` set to an access token for scripts), and
Node.js 18 or newer. The agent finds both even when they are not on ask's `PATH`: Amp in
`~/.amp/bin` (or `$AMP_HOME/bin`), `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` or
`~/.bun/bin`; Node.js in Homebrew, `/usr/local/bin`, Volta, nvm (the newest), fnm or
`~/.local/bin`. Without one, `ask models` shows what to install.

## Models

**These are routing modes, not exact models.** Amp has no model flag: it picks the models, the
system prompt and the tools behind each of its modes, and changes them as models improve. So the
"model" in `amp:medium` is the Amp mode `low`, `medium`, `high` or `ultra` (see Amp's
[Dial](https://ampcode.com/docs/the-dial)), and a run's record names the mode, not what answered.
An effort (`amp:high#max`) is passed as `--effort`. Any other name is passed to Amp as a mode, for
the modes plugins define. A thread keeps the mode it started with; a follow-up requesting a
different mode is refused rather than silently using the old one.

## Read and write

**Read runs are refused**: the agent exits 1 before starting Amp. Amp has no read-only switch its
own settings cannot override. `amp.tools.enable` is one more setting that a workspace
`.amp/settings.json`, a plugin or your user settings can change, and the list of enabled tools
only appears after Amp has started, too late to promise nothing ran.

**Write runs** (`ask -w`) pass `--dangerously-allow-all` with your own settings, since nothing can
answer Amp's permission prompts in a run. Use `ask -w` in a worktree you can throw away.

## Follow-ups

Amp's first message reports its thread id. ask stores an opaque continuation record containing
the mode and thread id, so `ask continue RUN "prompt"` continues the correct thread with
`amp threads continue ID` and validates that the mode has not changed. A follow-up's prompt is
passed as is.

## Titles

`ASK_TITLE` becomes the new thread's `--title`. A follow-up keeps its thread's title.

## Usage

Tokens are summed from Amp's assistant messages and shown live. Amp reports no cost in this
output, so `--max-cost` has nothing to measure for it, and runs show no cost.

## Environment

| Variable | |
| --- | --- |
| `ASK_AMP_BIN` | The `amp` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)). Amp enforces no schema, so
`ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Sources

What the agent relies on, from Amp's own documentation and published SDK:

- [Execute mode](https://ampcode.com/docs/cli/execute-mode): `--execute`, prompt on stdin, `AMP_API_KEY`
- [Streaming JSON](https://ampcode.com/docs/cli/streaming-json): the events, session id and usage
- [The Dial](https://ampcode.com/docs/the-dial): modes
- [Configuration](https://ampcode.com/docs/cli/settings): settings files and `amp.tools.enable`
- [TypeScript SDK](https://ampcode.com/docs/sdk/typescript) and the
  [`@sourcegraph/amp-sdk`](https://www.npmjs.com/package/@sourcegraph/amp-sdk) package: the flags
  it passes (`--mode`, `--effort`, `--dangerously-allow-all`, `threads continue`)
- [Spawning orbs](https://ampcode.com/docs/cli/spawning-orbs): `--title` on a new execute-mode thread

## Testing

```sh
cd packages/amp && node --test
```

The tests drive a fake `amp` in `test/bin`; they need no network or account. To try the real thing
by hand:

```sh
echo "say hi" | ASK_MODEL=low ASK_ACCESS=write ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/amp/agents/amp
cat /tmp/r.json
```
