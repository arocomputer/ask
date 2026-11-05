# Models

A model is named `provider/model`, as the [models.dev](https://models.dev) catalog names it:
`opencode-go/glm-5.3`, `openai/gpt-5.5`, `anthropic/claude-sonnet-5-5`. ask adds two providers of
its own: `chatgpt/` for your ChatGPT plan (see [Settings](settings.md#chatgpt)) and `claude/` for
your installed Claude Code (below). A name without its
provider gets a suggestion. `ask models` lists the models you chose in `ask settings`, or every
model of the providers you have keys for; `ask models PROVIDER` lists all of that provider's.

## The catalog

ask downloads models.dev's catalog once a day into `~/.ask/cache/models.json`, and uses the copy
it has when the network is down. For each model, the catalog says how to reach it: the endpoint,
and which kind of API it speaks. ask speaks three:

- OpenAI's **Responses** API, for OpenAI's models and gateways that offer it.
- **Chat completions**, which most providers and gateways serve.
- Anthropic's **Messages** API, for Anthropic's models and gateways that offer it.

A gateway can serve different models through different APIs, and ask follows the catalog for
each. Signed in to ChatGPT, the `chatgpt` provider adds your account's own models, which OpenAI
lists for that account, through the Responses API. Models that can't call tools, or that need an API ask doesn't speak (such as Google's
native one), are left out.

Every conversation is kept in one format, so a session can switch models, even between APIs, in
a later turn with `"model"`.

## Claude Code

`claude/MODEL` runs the task with your own installed [Claude Code](https://claude.com/claude-code),
signed in its own way, such as with your Claude subscription. It is a different route from
`anthropic/MODEL`, which is ask's own loop calling Anthropic's API with your API key:

| | `anthropic/claude-sonnet-5-5` | `claude/sonnet` |
| --- | --- | --- |
| Runs | ask's own loop and tools | your Claude Code and its tools |
| Signs in with | your Anthropic API key | Claude Code's own sign-in (`claude`, then `/login`) |

Model names are Claude Code's own: an alias like `sonnet`, `opus`, `fable` or `haiku` (always its
current model of that kind), or a full id like `claude-sonnet-5-5`.

ask starts the unmodified `claude` you installed and never reads, stores or passes on its
sign-in. It keeps each run to the task with Claude Code's documented controls: no hooks, no MCP
servers, no slash commands, only your own settings (a repository's `.claude/` settings can't
change the run), no auto memory and no background tasks. A read-only task gets only Read, Grep
and Glob, and every other tool is refused; a write task gets Claude Code's tools and runs
without permission prompts. The steps it takes show in `ask show` like any task's. A session
started on Claude Code continues there, through Claude Code's own session; it can't switch to a
model outside Claude Code, nor the other way round.

Anthropic permits running the unmodified Claude Code with the user's own sign-in, and asks
developers building on it to use API keys; ask's reading is that running your own Claude Code
on your own machine is the first case. Anthropic decides how its terms apply, so if that matters
to you, use `anthropic/` models with an API key.

## Effort

`"effort"` asks a reasoning model to think more or less: `low`, `medium` or `high`. It becomes
the Responses API's reasoning effort, chat completions' `reasoning_effort`, a thinking budget for
the Messages API, or Claude Code's `--effort`, which also takes `xhigh` and `max`.

## Usage

Each turn records the tokens it used: input, output, and the part of the input the provider
served from its cache. ask asks providers to cache the conversation where they let it, since
every step resends it. Prices aren't tracked; limits are the turn's `timeout` and 100 steps.

## Long conversations

When a conversation no longer fits the model's context, ask shortens older tool outputs and tries
again before failing with a hint to start a narrower task or use a larger model.
