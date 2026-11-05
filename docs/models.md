# Models

A model is named `provider/model`, as the [models.dev](https://models.dev) catalog names it:
`opencode-go/glm-5.3`, `openai/gpt-5.5`, `anthropic/claude-sonnet-5-5`. A name without its
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
each. Models that can't call tools, or that need an API ask doesn't speak (such as Google's
native one), are left out.

Every conversation is kept in one format, so a session can switch models, even between APIs, in
a later turn with `"model"`.

## Effort

`"effort"` asks a reasoning model to think more or less: `low`, `medium` or `high`. It becomes
the Responses API's reasoning effort, chat completions' `reasoning_effort`, or a thinking budget
for the Messages API.

## Usage

Each turn records the tokens it used: input, output, and the part of the input the provider
served from its cache. ask asks providers to cache the conversation where they let it, since
every step resends it. Prices aren't tracked; limits are the turn's `timeout` and 100 steps.

## Long conversations

When a conversation no longer fits the model's context, ask shortens older tool outputs and tries
again before failing with a hint to start a narrower task or use a larger model.
