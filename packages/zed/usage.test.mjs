// auth.usage tells what magpie's built-in Zed account shows
// (internal/provider/zed_usage.go), against Zed's replies as its tests
// give them (zed_test.go).
import { afterEach, expect, test } from "bun:test"
import { ZedAuthPlugin } from "./index.mjs"

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

test("a free account reads No plan, and the plan it moved to is kept", async () => {
  const { u, saved } = await run(auth(), () => new Response(me("zed_free")))
  expect(u).toEqual({ plan: "No plan", until: "2026-10-01T00:00:00Z" })
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
