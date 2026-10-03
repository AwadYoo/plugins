# @magpie-community/opencode-trae-auth

Signs in to **Trae CN** (trae.cn, ByteDance's AI IDE) with your Trae CN
account, the way the IDE does, and makes its model requests. The free tier
works as well. Provider id: `trae-cn`.

> **Experimental.** The protocol was worked out from two open-source relays,
> [wangqi233/trae2api](https://github.com/wangqi233/trae2api) and
> [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn).
> The plugin hasn't been run against a real Trae CN account yet. If something
> fails, open an issue and include the error magpie shows.

## Sign-in

One way, **Trae CN account (browser)**. The plugin opens trae.cn's
authorization page (`www.trae.cn/authorization`, the IDE's client
`ono9krqynydwx5`). Sign in there and allow the sign-in. trae.cn then sends the
browser back to a callback on `http://127.0.0.1:<port>/authorize`; it accepts
no other kind of callback. The callback carries the account's Cloud-IDE-JWT,
refresh token and account. Nothing needs pasting back.

At sign-in the plugin creates the account's device and names it to the
authorization page: `device_id` (19 digits) and `machine_id` (32 hex). Every
request then sends that same device. The relays saw requests dropped when the
device was new each time.

## Requests

Chat completions (`@ai-sdk/openai-compatible`) are translated for the IDE
agent's `POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`:

- **Request:**
  - The messages go as `{role, content: [{type: "text", text}]}`.
  - The model goes as `config_name` and `model`, and as `model_name` the
    `__dev` model the function's list names for it, when it names one.
  - The function is the one whose model list has the model, the first that
    names a `__dev` model for it (in the order `chat_v3`, the classic IDE's;
    `solo_work_lite`, SOLO's Work mode; `solo_agent`, the TRAE agent's;
    `solo_agent_lite`). If Trae answers 4001, 4023 or 1005, the plugin tries
    the others once and remembers which one worked.
- **Headers:** TRAE SOLO CN 0.1.69's (`x-ide-version`/`x-app-version`
  0.1.69, version code 20260917; Trae offers a model only to clients new
  enough for it): `Authorization: Cloud-IDE-JWT …`, `X-Cloudide-Token`,
  `x-app-id`, the device headers and `x-uid`.
- **Answer:** Trae always answers in its own SSE events:
  - `output` gives `response`/`content` and `reasoning_content`/`reasoning`.
  - `token_usage`, `done` and `error` mark usage, the end and failures.
  - Queue events are ignored.

  The plugin turns these into an OpenAI stream or a single body.
- **Tools:**
  - Trae's chat has no turn for a tool call or its result, so the tools are
    named twice:
    - natively in `tools`, with `parameters` as a JSON string;
    - in a system prompt that asks for each call as a
      `<tool_call>{"name", "arguments"}</tool_call>` block.
  - Calls from either source become OpenAI `tool_calls`.
  - Earlier calls and their results go back in as text.
  - Images aren't sent.

The model list is the account's own, from
`/api/ide/v1/batch_get_detail_param`, every function's list in one ask, as
TRAE SOLO CN asks it (`/api/ide/v1/get_detail_param`, one function at a
time, when the batch gives none). The lists are put together: SOLO and the
TRAE agent list models `chat_v3` doesn't (deepseek-v4.1-flash is the TRAE
agent's, `solo_agent`). Left out are the IDE's helpers (`usage` other than
`chat_completion`: summary, fast_apply…), configs switched off and the
custom-model slots. Context is the list's `context_window_tokens.dev`
(`max` is Max mode's), output the `__dev` model's `max_tokens`. When no
list can be read, the plugin uses the models Trae CN's `chat_v3` is
known to serve: GLM-5.2, GLM-5, Kimi K2.6, Qwen 3.7 Plus, DeepSeek V4 Pro
and DeepSeek V4 Flash.

## Renewal

The JWT is renewed with the refresh token at
`api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`. Trae issues a new
refresh token each time and spends the old one, so only one renewal runs at
a time.

magpie renews the JWT ten minutes before it ends (`refreshLead`) through
`auth.refresh`. Each request also checks it, two minutes before the end, for
OpenCode.

The account is marked for a new sign-in in these cases:

- the refresh token is turned away;
- a request is answered 401, or with code 1001.

Trae signs other clients out of an account when its token is renewed. The
IDE may therefore ask you to sign in again after magpie renews.

## Errors

| Trae's answer | What the agent gets |
| --- | --- |
| 401 / code 1001 | 401, and the account is marked for a new sign-in |
| code 4008 / 1005 (quota, plan) | 429 |
| Anything else | Trae's message and code, as a 502 or Trae's own status |

## Usage

magpie's usage card shows the account's credits:

- **Source:** `api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`.
- **What it adds up:** each entitlement pack's `credits_limit` (-1 means
  unlimited) and what the pack has used.
- **What it shows:** credits left as the balance, and the share used as a
  window.
