# Models

A model is `provider/model` for ask's own harness, or `harness:model` for an external
[harness](extensions.md#harnesses), either with an optional `#effort`:

```text
opencode-go/glm-5.3
openai/gpt-5.5#high
claude:sonnet-5.5
```

- **provider** is an endpoint ask's own harness talks to. The built-in providers are `openai`,
  `opencode` (OpenCode Console) and `opencode-go`; any other endpoint that speaks the OpenAI
  Responses protocol is a provider once it has a `base_url` in [auth.json](config.md#authjson).
  OpenCode's endpoints serve every text model through that protocol, Claude and Gemini included.
- **harness** is the prefix an installed extension serves, such as `claude` or `codex`.
- **model** is the model as the provider or harness names it. Native names are passed to the
  API as typed; harness names are lowercased.
- **effort** is passed on: as the reasoning effort for a native session, as `ASK_EFFORT` to a harness.

`-m` chooses the model for one session; `model` in [config.json](config.md) is the default.

## The model list

```sh
ask models             # provider/model and harness:model, with a display name
ask models --refresh   # download the models.dev listing again
ask models --json
```

For each provider you have a credential for, `ask models` lists the models you declare and a
cached snapshot of [models.dev](https://models.dev), fetched by `ask setup` or `--refresh` into
`~/.ask/cache/models.json`. Then come each harness's models: those you declare under its prefix,
and those it lists itself. The list is advisory: any model a provider accepts works whether or
not it is listed, and a listed model is not a promise that your account can use it.

## models.json

Declare the models you use, with a display name, or with prices so ask shows cost:

```json
{
  "opencode-go": {
    "glm-5.3": "GLM 5.3",
    "kimi-k3": { "name": "Kimi K3", "input": 3, "output": 15, "cached": 0.3, "context": 262144 }
  },
  "claude": { "sonnet-5.5": "Sonnet 5.5" }
}
```

Keys are providers or harness prefixes, then model ids. Prices are USD per million tokens. A
declared model replaces the fetched entry with the same id, keeping the fetched name and prices
it does not set. ask never writes this file.

## Cost

A native session's cost is the declared or fetched prices applied to the exact token counts the
provider reported, including the cached part of the input. A model without prices shows tokens
only. `--max-cost` and `max_cost` in config stop a turn once its cost passes the limit; without
prices there is nothing to compare, so set a `timeout` too.
