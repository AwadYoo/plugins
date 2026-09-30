# @magpie-community/opencode-commandcode-auth

Signs in to a [Command Code](https://commandcode.ai) plan (Pro, GOAT, Max,
Ultra, Go, Teams Pro) and makes its requests, in OpenCode and in magpie.
Provider id: `commandcode-plan`.

## Signing in

An account is a Command Code API key. There are three ways to get one:

- **Command Code (browser)**: the CLI's own sign-in. Studio asks you to
  approve a key for this machine, then posts it to a callback on
  `127.0.0.1`. The plugin checks the key with `/alpha/whoami` and reads the
  plan.
- **Command Code CLI's sign-in**: takes the account `commandcode login`
  signed in to, from `~/.commandcode/auth.json`. The file is only read,
  never changed.
- **API key**: paste a key from
  [commandcode.ai/settings/keys](https://commandcode.ai/settings/keys).

The key is kept where OpenCode keeps sign-ins (`auth.json`; in magpie,
`plugin-auth.json`) as `{ "type": "api", "key", "metadata": { "email": <user>, "plan" } }`.
Keys don't expire, so there is nothing to refresh.

## Requests

- **Every plan but Go** uses the Provider API at
  `https://api.commandcode.ai/provider/v1`. Every request carries the key
  as both `Authorization: Bearer` and `x-api-key`.
  - Claude models speak Anthropic's Messages API.
  - The other models speak chat completions.
- **Go** has no Provider API access. Its key is only accepted where the CLI
  asks, `POST /alpha/generate`, in the CLI's own format (command-code
  1.72.2 and its headers). The plugin's `fetch` handles this:
  - It turns OpenCode's chat completion into that format.
  - It turns the line-by-line reply back into a chat completion, streamed
    or not.
  - Failures keep their statuses: a model the plan lacks is a 403, running
    out of credits is a 402, and a usage-window limit is a 429.

The plan is read from `/alpha/billing/subscriptions`. It is cached for 10
minutes; after a failed read, the plugin tries again after 1 minute.

## Models

The `config` hook declares the default list:

| Model | Context window |
|---|---|
| Claude Sonnet 5 | 1M |
| Claude Opus 5.5 | 1M |
| GPT-6 Sol | 1.05M |
| DeepSeek V4 Pro | 1M |
| DeepSeek V4 Flash | 1M |
| Kimi K3 | 1M |
| GLM-5.3 | 1M |
| MiniMax M3 | 1M |

Once signed in, the `provider.models` hook replaces the default list with
the account's own:

- **Every plan but Go**: the Provider API's `/models` list. Each model's
  `supported_endpoints` picks the API it speaks.
- **Go**: the CLI's table, since there is no list to ask for:
  - GPT-6 Luna
  - GPT-5.6 Luna
  - DeepSeek V4 Pro
  - DeepSeek V4 Flash
  - Kimi K3
  - GLM-5.3
  - MiniMax M3
  - Qwen 3.8 Max
  - Qwen 3.8 Flash
  - MiMo V2.6 Pro

  The Go models carry their reasoning levels, and a requested level is
  fitted to the nearest one the model has.

## Not included

- Usage and quota (`/alpha/billing/credits`, the 5-hour and weekly windows).
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
