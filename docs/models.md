# Models

A model is named `provider/model`, as the [models.dev](https://models.dev) catalog names it:
`opencode-go/glm-5.3`, `openai/gpt-5.5`, `anthropic/claude-sonnet-5-5`. ask adds providers of its
own: `chatgpt/` for your ChatGPT plan (see [Settings](settings.md#chatgpt)), and one per
[harness](#harnesses), like `claude/` and `codex/`. A name without its provider gets a
suggestion. `ask models` lists the models you chose in `ask settings`, or every
model of the providers you have keys for; `ask models PROVIDER` lists all of that provider's.

## The catalog

Ask downloads models.dev's catalog once a day into `~/.ask/cache/models.json`, and uses the copy
it has when the network is down. For each model, the catalog says how to reach it: the endpoint,
and which kind of API it speaks. ask speaks three:

- OpenAI's **Responses** API, for OpenAI's models and gateways that offer it.
- **Chat completions**, which most providers and gateways serve.
- Anthropic's **Messages** API, for Anthropic's models and gateways that offer it.

Catalog presence means Ask knows a model's endpoint and a supported protocol; it does not certify
the provider's authentication method. Settings offers a curated API-key list plus ChatGPT and
installed coding-agent sign-ins. For other endpoints, use the custom OpenAI-compatible option in
[Settings](settings.md#custom-openai-compatible-endpoints). A catalog model may also be configured
manually with a compatible credential, but catalog inclusion alone is not a guided or verified
connection.

A gateway can serve different models through different APIs, and ask follows the catalog for
each. Signed in to ChatGPT, the `chatgpt` provider adds your account's own models, which OpenAI
lists for that account, through the Responses API. Models that can't call tools, or that need an API ask doesn't speak (such as Google's
native one), are left out.

Every conversation is kept in one format, so a session can switch models, even between APIs or
harnesses, in a later turn with `"model"`.

## Harnesses

`claude/MODEL` and `codex/MODEL` run the task with your own installed Claude Code or Codex,
signed in its own way, once `ask install claude` or `ask install codex` has turned it on. See
[Harnesses and extensions](extensions.md). `claude/sonnet` and `anthropic/claude-sonnet-5-5` are
different routes: the first runs your Claude Code with its sign-in, the second ask's own loop
with your Anthropic API key.

## Effort

`"effort"` asks a reasoning model to think more or less: `low`, `medium` or `high`. It becomes
the Responses API's reasoning effort, chat completions' `reasoning_effort`, a thinking budget for
the Messages API, Claude Code's `--effort` (which also takes `xhigh` and `max`), or Codex's
reasoning effort.

## Usage

Each turn records the tokens it used: input, output, and the part of the input the provider
served from its cache. ask asks providers to cache the conversation where they let it, since
every step resends it. Prices aren't tracked; limits are the turn's `timeout` and 100 steps.

## Long conversations

When a conversation no longer fits the model's context, ask shortens older tool outputs and tries
again before failing with a hint to start a narrower task or use a larger model.
