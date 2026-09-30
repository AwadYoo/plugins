# @magpie-community/opencode-qoder-auth

Your [Qoder](https://qoder.com) subscription in OpenCode and
[magpie](https://usemagpie.ai), with provider id `qoder`.

## Sign-in

**Sign in with Qoder** is the sign-in Qoder's desktop client uses:

1. A PKCE device flow opens qoder.com's account page.
2. openapi.qoder.sh is polled every 2 s until you authorize, for at most
   15 minutes.
3. The device token is traded for a job token, and the account's email and
   name are read.

What is kept: the job token, its refresh token and expiry, the uid, the
device token and a machine id made for this sign-in. OpenCode keeps them in
`auth.json`; magpie keeps them in `plugin-auth.json`.

The job token is refreshed 5 minutes before it runs out. Qoder spends a
refresh token once, so the new pair is saved straight away, and refreshes
never run at the same time. When Qoder refuses a refresh (401 or 403), the
request says to sign in again.

## Requests

Qoder serves its models on the API its client talks to:
`api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`. The
plugin's `fetch` takes the chat completion OpenCode sends and does the rest
itself.

**Writing the request**

- It writes the chat completion as Qoder's request:
  - Qoder's own system line comes before yours.
  - Messages become text and image blocks.
  - Tool calls and results become OpenAI tool turns. Images a tool returned
    follow in a user turn.
  - Your tools become Qoder's native function tools.
  - The model's own configuration from Qoder's list goes with it.
- It picks the reasoning effort from the model's own levels:
  - The nearest level to the one asked, the higher one on a tie.
  - The model's default when none is asked.
  - The lowest level for "none", when the model can't turn thinking off.
- It encodes the body with the client's codec and signs the call with the
  client's COSY envelope. The envelope carries:
  - the account, AES-encrypted, with the key wrapped by Qoder's RSA key;
  - an MD5 signature;
  - the machine id and the client's headers.

**Reading the reply**

- Qoder's SSE comes back as a chat completion, streamed or not, with
  reasoning and usage.
- Tool calls Qoder writes as XML or JSON in its text become tool calls.
  Tool calls it sends the OpenAI way keep Qoder's id.

**Errors**

| What Qoder says | What the request returns |
|---|---|
| A refused sign-in | 401 |
| A quota | 429 |
| A failure before the answer starts | Qoder's status |
| A failure after the answer has started | The stream ends with an error |

## Models

The `provider.models` hook reads the account's own list, as Qoder's client
asks for it (`/algo/api/v2/model/list`). It keeps the enabled chat models
and leaves out "auto" and "default", which route inside Qoder. It takes
each model's reasoning levels from its `thinking_config`.

The `config` hook declares the list as it was on 2026-09-30:

- Ultimate, Performance, Efficient
- Sonus, Cantus
- Qwen3.8-Max, Qwen3.8-Flash, Qwen3.7-Max, Qwen3.7-Plus
- Kimi-K3, Kimi-K2.8-Preview
- GLM-5.3, GLM-5.3-Flash
- DeepSeek-V4-Pro, DeepSeek-Flash
- MiniMax-M3

Every model speaks chat completions (`@ai-sdk/openai-compatible`).

## Not here

- Qoder's usage and quota display.
- Several accounts at once.
- magpie's web-search stand-in.

## Credits

The protocol (endpoints, COSY envelope, body codec and device flow) comes
from [CLIProxyAPI](https://github.com/ufec/CLIProxyAPI)'s Qoder support, by
way of magpie. Its MIT license is in `LICENSE-CLIProxyAPI`.
