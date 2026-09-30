// auth.usage tells what magpie's built-in Command Code account shows
// (internal/provider/commandcode_plan.go, cmdQuota), against the replies its
// tests give (commandcode_plan_test.go, commandcode_go_test.go).
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.waits.subWait = 9_000
})

const api = { type: "api", key: "own-key" }

async function run(a, replies) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    seen.push({ path, auth: init.headers.Authorization })
    const r = replies[path]
    return r === undefined ? new Response("", { status: 404 }) : typeof r === "number" ? new Response("", { status: r }) : Response.json(r)
  }
  const hooks = await CommandCodePlugin()
  return { u: await hooks.auth.usage(async () => a), seen }
}

test("a Max account: its 5 hours, its week and its credits, and its period", async () => {
  const reset = Date.now() + 3600_000
  const week = Date.now() + 72 * 3600_000
  const { u, seen } = await run(api, {
    "/alpha/billing/subscriptions": { success: true, data: { planId: "individual-max-monthly", status: "active", currentPeriodEnd: "2026-10-28T00:00:00Z", cancelAtPeriodEnd: true } },
    "/alpha/billing/credits": {
      credits: { monthlyCredits: 100.5, purchasedCredits: 10, freeCredits: 0 },
      windowLimits: { limited: true, fiveHour: { used: 25, cap: 100, resetAt: reset }, weekly: { used: 30, cap: 300, resetAt: week } },
    },
  })
  expect(u).toEqual({
    plan: "Max",
    until: "2026-10-28T00:00:00.000Z",
    renew: "off",
    windows: [
      { name: "5 hours", used: 25, span: 18000, resetsAt: new Date(reset).toISOString() },
      { name: "Weekly", used: 10, span: 604800, resetsAt: new Date(week).toISOString() },
      { name: "Credits", used: 30.9375, display: "$49.50 / $160.00" },
    ],
  })
  expect(seen.every((x) => x.auth === "Bearer own-key")).toBe(true)
})

test("no plan: the credits bought are a balance", async () => {
  const { u } = await run(api, {
    "/alpha/billing/subscriptions": { success: true, data: null },
    "/alpha/billing/credits": { credits: { monthlyCredits: 0, purchasedCredits: 7.25, freeCredits: 0 } },
  })
  expect(u).toEqual({ plan: "No plan", balance: "$7.25", windows: [] })
})

test("Go: the month's $10 is the pool", async () => {
  const { u } = await run(api, {
    "/alpha/billing/subscriptions": { data: { planId: "individual-go", status: "active" } },
    "/alpha/billing/credits": { credits: { monthlyCredits: 4 } },
  })
  expect(u).toEqual({ plan: "Go", windows: [{ name: "Credits", used: 60, display: "$6.00 / $10.00" }] })
})

test("credits that can't be read keep the plan and say why", async () => {
  const { u } = await run(api, {
    "/alpha/billing/subscriptions": { data: { planId: "individual-pro-monthly", status: "active", cancelAtPeriodEnd: false } },
    "/alpha/billing/credits": 503,
  })
  expect(u).toEqual({ plan: "Pro", renew: "auto", error: "Service Unavailable", windows: [] })
})

test("a canceled subscription is No plan; an unread one leaves the plan unsaid", async () => {
  let { u } = await run(api, { "/alpha/billing/subscriptions": { data: { planId: "individual-pro", status: "canceled" } }, "/alpha/billing/credits": 413 })
  expect(u).toEqual({ plan: "No plan", error: "Request Entity Too Large", windows: [] })
  _internal.subsSeen.clear() // a plan read is kept ten minutes
  ;({ u } = await run(api, { "/alpha/billing/subscriptions": 401, "/alpha/billing/credits": 401 }))
  expect(u).toEqual({ error: "Unauthorized", windows: [] })
})

test("seconds and string amounts read as magpie reads them; a half cent goes to the even one", async () => {
  const { u } = await run(api, {
    "/alpha/billing/subscriptions": { data: { planId: "individual-pro", status: "active", currentPeriodEnd: 1790000000 } },
    "/alpha/billing/credits": { credits: { monthlyCredits: "29.875" }, windowLimits: { fiveHour: { used: "5", cap: 0 }, weekly: { used: 150, cap: "100", resetAt: 0 } } },
  })
  expect(u).toEqual({
    plan: "Pro",
    until: new Date(1790000000 * 1000).toISOString(),
    windows: [{ name: "Weekly", used: 100, span: 604800 }, { name: "Credits", used: 0.4166666666666667, display: "$0.12 / $30.00" }],
  })
})

test("a sign-in that isn't a key is no account", async () => {
  expect((await run({ type: "oauth" }, {})).u).toEqual({ error: "not signed in" })
})

test("a slow subscription: the windows go without it, and the next card has it", async () => {
  _internal.waits.subWait = 50
  let answer
  const slow = new Promise((r) => (answer = r))
  const credits = { credits: { monthlyCredits: 35 }, windowLimits: { limited: true, fiveHour: { used: 1, cap: 100 } } }
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") {
      await slow
      return Response.json({ data: { planId: "individual-goat", status: "active", cancelAtPeriodEnd: true } })
    }
    return Response.json(credits)
  }
  const hooks = await CommandCodePlugin()
  const first = await hooks.auth.usage(async () => api)
  expect(first).toEqual({ windows: [{ name: "5 hours", used: 1, span: 18000 }] })
  answer()
  await new Promise((r) => setTimeout(r, 20))
  const next = await hooks.auth.usage(async () => api)
  expect(next).toEqual({ plan: "GOAT", renew: "off", windows: [{ name: "5 hours", used: 1, span: 18000 }, { name: "Credits", used: 50, display: "$35.00 / $70.00" }] })
})

test("a plan read is saved with the key, once", async () => {
  const sets = []
  globalThis.fetch = async (url) =>
    new URL(String(url)).pathname === "/alpha/billing/subscriptions"
      ? Response.json({ data: { planId: "individual-goat", status: "active" } })
      : Response.json({ credits: { monthlyCredits: 70 } })
  const hooks = await CommandCodePlugin({ client: { auth: { set: async (x) => sets.push(x) } } })
  const a = { type: "api", key: "own-key", metadata: { email: "me", keyName: "laptop" } }
  expect((await hooks.auth.usage(async () => a)).plan).toBe("GOAT")
  expect(sets).toEqual([
    { path: { id: "commandcode-plan" }, body: { type: "api", key: "own-key", metadata: { email: "me", keyName: "laptop", plan: "GOAT", planId: "individual-goat" } } },
  ])
  await hooks.auth.usage(async () => ({ ...a, metadata: { ...a.metadata, plan: "GOAT", planId: "individual-goat" } }))
  expect(sets.length).toBe(1)
})

test("a plan saved stands in for a subscription slow to read: waited for a moment, the credits pooled by it", async () => {
  let answer
  const slow = new Promise((r) => (answer = r))
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/alpha/billing/subscriptions") {
      await slow
      return Response.json({ success: false, error: "write CONNECTION_CLOSED" })
    }
    return Response.json({ credits: { monthlyCredits: 35 } })
  }
  const hooks = await CommandCodePlugin()
  const t = Date.now()
  const u = await hooks.auth.usage(async () => ({ ...api, metadata: { plan: "GOAT", planId: "individual-goat" } }))
  expect(Date.now() - t).toBeLessThan(3_000)
  expect(u).toEqual({ plan: "GOAT", windows: [{ name: "Credits", used: 50, display: "$35.00 / $70.00" }] })
  answer()
})

test("a subscription Command Code couldn't read is unread, not No plan", async () => {
  const { u } = await run(api, {
    "/alpha/billing/subscriptions": { success: false, error: "write CONNECTION_CLOSED db.local:5432" },
    "/alpha/billing/credits": { credits: { monthlyCredits: 0, purchasedCredits: 0 } },
  })
  expect(u.plan).toBeUndefined()
  const hooks = await CommandCodePlugin()
  expect((await hooks.auth.usage(async () => ({ ...api, metadata: { plan: "GOAT" } }))).plan).toBe("GOAT")
})
