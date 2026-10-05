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
    Text under `message`, `delta` or an event with no name is the answer's
    too.
  - `token_usage`, `done` and `error` mark usage, the end and failures.
    `done`'s `finish_reason` `length`/`max_tokens` is OpenAI's `length`.
  - Queue events are ignored.
  - A `{"reasoning_content": …}` object written into the text is reasoning,
    and reasoning Trae sends again is sent once.

  The plugin turns these into an OpenAI stream or a single body. A reply
  that fails (an `error` event, or Trae's stream breaking off) ends with the
  error and `[DONE]`, with no finish.
- **Tools:**
  - Trae's chat has no turn for a tool call or its result, so the tools are
    named twice:
    - natively in `tools`, with `parameters` as a JSON string;
    - in a system prompt that asks for each call as a
      `<tool_call>{"name", "arguments"}</tool_call>` block.
  - GLM also writes its own template, `<tool_call>name<arg_key>k</arg_key>
    <arg_value>v</arg_value></tool_call>` (a string kept as written, other
    types read as JSON), and sometimes a whole call into a native call's
    name; both are read as the call.
  - Calls from either source become OpenAI `tool_calls`. A name matching a
    requested tool but for case or punctuation (`Read`) goes on as the
    request's (`read`); any other goes on as written, so the agent can say
    the tool doesn't exist.
  - Earlier calls and their results go back in as text.
  - Images aren't sent.

The model list is the account's own, from
`/api/ide/v1/batch_get_detail_param`, every function's list in one ask, as
TRAE SOLO CN asks it (`/api/ide/v1/get_detail_param`, one function at a
time, when the batch gives none). The lists are put together: SOLO and the
TRAE agent list models `chat_v3` doesn't (deepseek-v4.1-flash is the TRAE
agent's, `solo_agent`). Left out are the IDE's helpers (`usage` other than
`chat_completion`: summary, fast_apply…), configs switched off and the
custom-model slots. Context is the list's `context_window_tokens.dev`,
output the `__dev` model's `max_tokens`. A model with a `__max` model and
a bigger `context_window_tokens.max` is listed again as its Max,
`<id>-max` ("… (Max)"), with that window and the `__max` model's
`max_tokens`; the two can come from different functions' lists (chat_v3
can name the `__max` model, a SOLO list the windows). It asks the
`__max` model through the function that names it, with `max_tokens` set
and `user_message_context.model_info.prompt_max_tokens` the window less
it, as Max mode does.

Reasoning: the models reason, but Trae's request takes no effort or
thinking level, so the plugin lists no variants and a level an agent
picks does nothing.

When no
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
- **What it shows:** one Credits window: the credits used of the packs'
  total, with the share, which magpie shows as used or left like
  WorkBuddy's.

## Daily check-in

Trae CN gives credits for a daily check-in (每日签到). magpie can press it
once a day for each account (Settings, or the switch on the usage card).
It asks Trae CN's own pages through
this plugin's fetch, which sends them as the account: its Cloud-IDE-JWT
(renewed first when near its end) and its device id.

- **Status:** `POST api.trae.cn/trae/api/v2/ug/checkin_credits/status`,
  body `{}`: `enable`, `checked_in`, `credits`.
- **Claim:** `POST api.trae.cn/trae/api/v2/ug/checkin_credits/claim`,
  body `{}`, only while it is on and today's isn't in.
- **What comes back:** Trae's answer as it is. A 401 or code 1001 marks
  the account for a new sign-in. Code 9095 means this device has checked
  in today; nothing sends another device id to get round it.

Only `api.trae.cn`'s `/trae/api/` pages are sent this way; any other URL
that isn't a chat request is still refused (400). Needs 0.1.4 or later.
