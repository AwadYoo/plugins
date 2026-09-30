// auth.usage tells what magpie's built-in Cursor account shows
// (internal/provider/cursor_usage.go), against Cursor's replies as its tests
// give them (cursor_usage_test.go).
import { afterEach, expect, test } from "bun:test"
import { CursorAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// a token that runs out in an hour
const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
const tok = jwt(Math.floor(Date.now() / 1000) + 3600)
const auth = { type: "oauth", access: tok, refresh: "", expires: 0, accountId: "a@b.c" }

const firstParty = ["grok-4.7-xhigh-fast", "cursor-grok-4.7-high-fast", "cursor-grok-4.6-high-fast", "grok-4.5-fast-high", "auto", "default", "composer-2.5", "COMPOSER-2.5-FAST", "composer"]
const bucketed = ["future-first-party", "grok-4.8-high", "cursor-grok-4.8-xhigh-fast"]
const others = ["claude-opus-5-5", "gpt-5.6-sol", "gemini-3.1-pro", "grok-3", "grok-4.70", "grok-4.80-high", "unknown-model"]
const provider = { models: Object.fromEntries([...firstParty, ...bucketed, ...others].map((id) => [id, { id }])) }

async function run(a, reply) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body })
    return reply()
  }
  const hooks = await CursorAuthPlugin()
  return { u: await hooks.auth.usage(async () => a, provider), seen }
}

// counts is whether a window counts model, as magpie reads the lists
// (internal/provider/plugin_usage.go)
function counts(w, model) {
  const m = model.toLowerCase()
  if (w.models?.length) return w.models.some((x) => x.toLowerCase() === m)
  if (w.notModels?.length) return !w.notModels.some((x) => x.toLowerCase() === m)
  return true
}

test("the period's three windows, reset at the cycle's end", async () => {
  const { u, seen } = await run(auth, () =>
    Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 12.5, apiPercentUsed: 40, totalPercentUsed: 20 } }),
  )
  expect(seen).toEqual([
    {
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: "{}",
    },
  ])
  const at = new Date(1792833042000).toISOString()
  expect(u.windows.map(({ models, notModels, ...w }) => w)).toEqual([
    { name: "Cursor Models", used: 12.5, resetsAt: at },
    { name: "Other Models", used: 40, resetsAt: at },
    { name: "Total", used: 20, resetsAt: at, aside: true },
  ])
  expect(u.error).toBeUndefined()
  expect(u.plan).toBeUndefined() // the sign-in's, as magpie's
})

for (const bucket of [["default", "composer-2.5", "cursor-grok-4.5-high", "future-first-party", "Grok-4.8"], undefined]) {
  test(`each model counts in the pool magpie puts it in (autoBucketModels ${bucket ? "given" : "left out"})`, async () => {
    const { u } = await run(auth, () =>
      Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 25, apiPercentUsed: 100, totalPercentUsed: 100 }, autoBucketModels: bucket }),
    )
    const [cursor, other, total] = u.windows
    const pool = bucket ? [...firstParty, ...bucketed] : firstParty
    const rest = bucket ? others : [...others, ...bucketed]
    for (const m of pool) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, true, false])
    for (const m of rest) expect([m, counts(cursor, m), counts(other, m)]).toEqual([m, false, true])
    expect(total.models).toBeUndefined()
    expect(total.notModels).toBeUndefined()
  })
}

test("an enterprise plan's spend is no window", async () => {
  expect((await run(auth, () => Response.json({ spendLimitUsage: {} }))).u).toEqual({ windows: [] })
})

test("a refused token is the status magpie says", async () => {
  expect((await run(auth, () => new Response("no", { status: 401 }))).u).toEqual({ error: "Unauthorized", windows: [] })
})

test("a run-out sign-in says so, and asks nothing", async () => {
  const { u, seen } = await run({ ...auth, access: jwt(1) }, () => Response.json({}))
  expect(u).toEqual({ error: "Cursor's sign-in has run out; sign in to Cursor again", windows: [] })
  expect(seen).toEqual([])
})
