// provider.models says what the built-in's model list did to the account's
// mark (internal/provider/zed.go zedFetchModels): Zed refusing the sign-in
// while the list is read marked it lapsed; anything else left it alone.
import { afterEach, expect, test } from "bun:test"
import { ZedAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
  _internal.lists.clear()
})

let n = 0
const auth = () => ({
  type: "oauth",
  access: "plain-access-" + ++n,
  refresh: JSON.stringify({ userId: String(5000 + n), systemId: "", org: "org-me", plan: "zed_pro" }),
  expires: 0,
  accountId: "octo",
})

const list = JSON.stringify({ models: [{ provider: "anthropic", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_token_count: 1000, max_output_tokens: 100 }] })

async function models(a, route) {
  const seen = []
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    return route(u.pathname)
  }
  const hooks = await ZedAuthPlugin({})
  return { run: () => hooks.provider.models({ models: { declared: {} } }, { auth: a }), seen }
}

test("the model token refused: the sign-in expired, as zedLapse marked it", async () => {
  const { run, seen } = await models(auth(), () => new Response("unauthorized", { status: 401 }))
  const err = await run().catch((e) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.signIn).toBe("expired")
  expect(err.message).toContain("the Zed sign-in has expired")
  expect(seen).toEqual(["/client/llm_tokens"])
})

test("the list refused with the token just minted: kept, the declared models", async () => {
  // a stale token is minted again once; /models refusing both is no word on
  // the account's own sign-in, which the built-in left unmarked
  const { run, seen } = await models(auth(), (p) =>
    p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response("nope", { status: 401 }),
  )
  expect(await run()).toEqual({ declared: {} })
  expect(seen).toEqual(["/client/llm_tokens", "/models", "/client/llm_tokens", "/models"])
})

test("Zed down: no word on the sign-in, the declared models", async () => {
  const { run } = await models(auth(), () => new Response("bad gateway", { status: 502 }))
  expect(await run()).toEqual({ declared: {} })
})

test("a list read: the account's models", async () => {
  const { run } = await models(auth(), (p) => (p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response(list)))
  expect(Object.keys(await run())).toEqual(["claude-sonnet-5"])
})

test("refused after a list was read: still says expired", async () => {
  const a = auth()
  let refuse = false
  const { run } = await models(a, (p) => {
    if (refuse) return new Response("unauthorized", { status: 401 })
    return p === "/client/llm_tokens" ? new Response(JSON.stringify({ token: "tok" })) : new Response(list)
  })
  expect(Object.keys(await run())).toEqual(["claude-sonnet-5"])
  // the list goes stale and the token with it
  const uid = JSON.parse(a.refresh).userId
  _internal.lists.set(uid, { at: 0, models: _internal.lists.get(uid).models })
  _internal.tokens.clear()
  refuse = true
  const err = await run().catch((e) => e)
  expect(err.signIn).toBe("expired")
})
