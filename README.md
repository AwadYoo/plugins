# magpie-commuity plugins

[OpenCode](https://opencode.ai) provider plugins for coding-plan
subscriptions, maintained by the community. Each package signs in to one
subscription and makes its requests. The packages work in OpenCode and in
[magpie](https://usemagpie.ai), which runs OpenCode's provider plugins.

| Package | Signs in to | Provider id |
|---|---|---|
| _(one row per package, added with it)_ | | |

## Use

magpie:

```sh
magpie plugin add @magpie-commuity/opencode-<name>-auth
magpie plugin login <provider id>
```

The same actions are in the app: Settings → Plugins, then Add provider →
From plugins.

OpenCode, in `opencode.json`:

```json
{ "plugin": ["@magpie-commuity/opencode-<name>-auth"] }
```

then `opencode auth login`.

## Writing a package

Each package is a folder under `packages/<name>/`:

- **`package.json`**
  - name: `@magpie-commuity/opencode-<name>-auth`
  - `"type": "module"`, `"main": "./index.mjs"`
  - version, `"license": "MIT"`
  - no runtime dependencies unless one is really needed. Bun's and Node's
    `fetch`, `crypto` and `fs` usually cover it.
- **`index.mjs`**
  - Exports one async plugin function, as OpenCode's `Plugin` type
    describes.
  - Returns an `auth` hook: `{ provider, loader, methods }`.
    - A browser sign-in is `{ type: "oauth", label, prompts?, authorize }`.
      `authorize` returns `{ url, instructions, method: "auto" | "code", callback }`.
    - A key is `{ type: "api", label }`.
    - `loader(getAuth, provider)` returns what the AI SDK is given:
      `baseURL`, `apiKey`, `headers` and a `fetch` that signs each request
      and refreshes the token (saving it with `client.auth.set`).
  - A provider that models.dev doesn't list is declared in a `config` hook
    that sets `config.provider[<id>] = { name, npm, api, models }`. The npm
    field names the AI SDK package the models speak:
    `@ai-sdk/openai-compatible` (chat completions), `@ai-sdk/openai`
    (Responses) or `@ai-sdk/anthropic` (Messages).
  - A list the account decides goes in the `provider: { id, models(provider, { auth }) }`
    hook.
- **`README.md`**: what the package signs in to, how, where the sign-in is
  kept, and the models.

The provider id is the one magpie's built-in subscription has (`grok`,
`zcode`, `workbuddy`, `commandcode-plan`, …). While magpie still has the
built-in, the plugin's provider shows as `<id>-plugin`. Once the built-in
is gone, it takes over the same id, so an agent set to `<id>/<model>` keeps
working.

## Checking a package

```sh
bun scripts/check.mjs [<name>]        # loads each plugin and checks its hooks; signs in to nothing
MAGPIE=/path/to/magpie scripts/try.sh <name> [login <id> | provider test <id>-plugin]
```

`try.sh` runs magpie in a sandbox HOME (`.sandbox/<name>`), so your own
magpie, agents and sign-ins are left alone.

## License

MIT
