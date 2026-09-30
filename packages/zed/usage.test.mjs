// auth.usage tells what magpie's built-in Zed account shows
// (internal/provider/zed_usage.go), against Zed's replies as its tests
// give them (zed_test.go).
import { afterEach, expect, test } from "bun:test"
import { ZedAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const me = (plan, overdue = false) =>
  JSON.stringify({
    user: { legacy_user_id: 4242, github_login: "octo", name: "Octo Cat" },
    organizations: [{ id: "org-team", name: "Team" }, { id: "org-me", name: "Me", is_personal: true }],
    default_organization_id: "org-me",
    plans_by_organization: { "org-me": plan },
    plan: { plan_v3: plan, subscription_period: { started_at: "2026-09-01T00:00:00Z", ended_at: "2026-10-01T00:00:00Z" }, has_overdue_invoices: overdue },
  })

const auth = (plan = "zed_pro") => ({
  type: "oauth",
  access: "plain-access",
  refresh: JSON.stringify({ userId: "4242", systemId: "", org: "org-me", plan, planName: "Pro" }),
  expires: 0,
  accountId: "octo",
})

async function run(a, reply) {
  const seen = []
  const saved = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization })
    return reply()
  }
  const client = { auth: { set: async (x) => saved.push(x) } }
  const hooks = await ZedAuthPlugin({ client })
  return { u: await hooks.auth.usage(async () => a), seen, saved }
}

test("a Pro account: its plan and its period's end, no windows", async () => {
  const { u, seen, saved } = await run(auth(), () => new Response(me("zed_pro")))
  expect(u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z" })
  expect(seen).toEqual([{ url: "https://cloud.zed.dev/client/users/me", auth: "4242 plain-access" }])
  expect(saved).toEqual([])
})

test("a free account reads Free, as the built-in's row names it, and the plan it moved to is kept", async () => {
  const { u, saved } = await run(auth(), () => new Response(me("zed_free")))
  expect(u).toEqual({ plan: "Free", until: "2026-10-01T00:00:00Z" })
  expect(saved.length).toBe(1)
  expect(JSON.parse(saved[0].body.refresh)).toMatchObject({ plan: "zed_free", planName: "Free" })
})

test("an overdue invoice is the error it is", async () => {
  const { u } = await run(auth(), () => new Response(me("zed_pro", true)))
  expect(u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", error: "Zed: this account has an overdue invoice, so its models are paused (see zed.dev/account)" })
})

test("a refused pair says the sign-in expired", async () => {
  const { u } = await run(auth(), () => new Response("", { status: 401 }))
  expect(u).toEqual({ error: "octo: the Zed sign-in has expired — sign in again" })
})

test("another failure says Zed's message", async () => {
  const { u } = await run(auth(), () => new Response(JSON.stringify({ code: "x", message: "down for a bit" }), { status: 503 }))
  expect(u).toEqual({ error: "Zed: down for a bit (503)" })
})

test("a business plan picked by organization", async () => {
  const body = JSON.parse(me("zed_free"))
  body.plans_by_organization["org-me"] = "zed_business"
  const { u } = await run(auth("zed_business"), () => new Response(JSON.stringify(body)))
  expect(u.plan).toBe("Business")
})

test("an account reply that can't be read is an error, as zed.FetchMe's", async () => {
  expect((await run(auth(), () => new Response("<html>oops</html>"))).u).toEqual({ error: "Zed: an unreadable account: invalid character '<' looking for beginning of value" })
  expect((await run(auth(), () => new Response(""))).u).toEqual({ error: "Zed: an unreadable account: unexpected end of JSON input" })
  expect((await run(auth(), () => new Response("[]"))).u).toEqual({ error: "Zed: an unreadable account: json: cannot unmarshal array into Go value of type zed.Me" })
})

// complete's answer to a request, the token already minted once
async function ask(replies) {
  const s = _internal.stateOf(auth())
  _internal.tokens.clear()
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url).replace("https://cloud.zed.dev", ""))
    return replies.shift()()
  }
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) })
  return { res, body: await res.json(), seen }
}

test("a model token refused right after it was minted isn't a lapsed sign-in (no 401)", async () => {
  const tok = () => new Response(JSON.stringify({ token: "llm" }))
  const no = () => new Response("", { status: 401 })
  const { res, body, seen } = await ask([tok, no, tok, no])
  expect(seen).toEqual(["/client/llm_tokens", "/completions", "/client/llm_tokens", "/completions"])
  expect(res.status).toBe(403)
  expect(body.error.message).toBe("the sign-in was refused — sign in again")
})

test("the account's own sign-in refused is a 401, worded as the built-in's", async () => {
  const { res, body } = await ask([() => new Response("", { status: 401 })])
  expect(res.status).toBe(401)
  expect(body.error.message).toBe("octo's Zed sign-in has expired — sign in again")
})

test("errors don't name Zed, which magpie adds", async () => {
  const tok = () => new Response(JSON.stringify({ token: "llm" }))
  let r = await ask([tok, () => new Response(JSON.stringify({ code: "x", message: "down for a bit" }), { status: 503 })])
  expect(r.res.status).toBe(503)
  expect(r.body.error.message).toBe("down for a bit")
  r = await ask([tok, () => new Response("", { status: 402 })])
  expect(r.body.error.message).toBe("payment required — this account's plan doesn't include Zed's hosted models, or its allowance is used up (see zed.dev/account)")
  r = await ask([() => new Response("", { status: 500 })])
  expect(r.body.error.message).toBe("Internal Server Error (500)")
})

test("a model Zed gives no limits has none made up", async () => {
  const e = _internal.entry({ provider: "anthropic", id: "x", display_name: "X" })
  expect(e.limit).toEqual({ context: 0, output: 0 })
  expect(_internal.entry({ provider: "anthropic", id: "y", max_token_count: 1000, max_output_tokens: 10 }).limit).toEqual({ context: 1000, output: 10 })
})
