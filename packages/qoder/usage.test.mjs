// auth.usage tells what magpie's built-in Qoder account shows
// (internal/provider/qoder_usage.go), against Qoder's replies as its tests
// give them (qoder_test.go).
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const USAGE = {
  displayMode: "qoder",
  qoderUsage: {
    userType: "pro",
    userQuota: { total: 100, used: 25 },
    addOnQuota: { cap: 50, remaining: 40 },
    orgResourcePackage: { total: 20, used: 10 },
    dedicatedResourcePackages: [{ name: "Team", total: 10, used: 2 }],
  },
}

const account = () => ({
  type: "oauth",
  access: "jt-one",
  refresh: "rt-one",
  expires: Date.now() + 3_600_000,
  accountId: "one@x",
  uid: "u1",
  deviceToken: "dt-old",
  deviceRefresh: "drt-old",
})

async function plugin(serve) {
  let auth = account()
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    return serve(u.pathname, init)
  }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await QoderAuthPlugin({ client })
  return { usage: () => hooks.auth.usage(async () => auth), seen, auth: () => auth }
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status })
const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"

test("a refused device token is rotated, saved, and the usage read with it", async () => {
  const p = await plugin((path, init) => {
    if (path === "/api/v1/deviceToken/refresh") {
      expect(JSON.parse(init.body)).toEqual({ refresh_token: "drt-old" })
      return json({ device_token: "dt-new", refresh_token: "drt-new" })
    }
    if (path === "/sash/api/v2/me/usage") {
      expect(init.headers["Cosy-ClientType"]).toBe("10")
      return init.headers.Authorization === "Bearer dt-new" ? json(USAGE) : new Response("", { status: 401 })
    }
    return new Response("", { status: 404 })
  })
  expect(await p.usage()).toEqual({
    plan: "pro",
    windows: [
      { name: "Credits", used: 25, display: "25 / 100 credits" },
      { name: "Add-on credits", used: 20, display: "10 / 50 credits" },
      { name: "Shared credits", used: 50, display: "10 / 20 credits" },
      { name: "Team", used: 20, display: "2 / 10 credits" },
    ],
  })
  expect(p.seen).toEqual(["/sash/api/v2/me/usage", "/api/v1/deviceToken/refresh", "/sash/api/v2/me/usage"])
  expect(p.auth()).toMatchObject({ deviceToken: "dt-new", deviceRefresh: "drt-new", access: "jt-one", refresh: "rt-one" })
})

test("a refused device refresh says usage is unavailable, chat still working", async () => {
  const p = await plugin((path) => new Response("", { status: path === "/api/v1/deviceToken/refresh" ? 403 : 401 }))
  expect(await p.usage()).toEqual({
    error:
      "Qoder usage is unavailable: Qoder refused the account-page sign-in (chat still works) — sign in again to see usage (qoder device token refresh: upstream HTTP 403)",
  })
  expect(p.auth().deviceToken).toBe("dt-old")
})

test("another failure is Qoder's status", async () => {
  const p = await plugin(() => new Response("", { status: 500 }))
  expect(await p.usage()).toEqual({ error: "qoder usage: upstream HTTP 500" })
})

test("an enterprise account has a plan and no windows", async () => {
  const p = await plugin(() => json({ displayMode: "enterprise" }))
  expect(await p.usage()).toEqual({ plan: "Enterprise" })
})

test("an unknown display mode, or no quota, is an error", async () => {
  let p = await plugin(() => json({ displayMode: "team" }))
  expect(await p.usage()).toEqual({ error: "qoder usage: unknown display mode" })
  p = await plugin(() => json({ displayMode: "qoder", qoderUsage: null }))
  expect(await p.usage()).toEqual({ error: "qoder usage: missing quota data" })
})

test("snake_case fields, an expiry, units, and pools too thin to show", () => {
  const u = _internal.parseUsage({
    displayMode: "qoder",
    qoderUsage: {
      user_type: "Pro Trial",
      expires_at: 1790812800, // seconds
      user_quota: { total: 2000000, remaining: 500000, unit: "tokens" },
      add_on_quota: { total: 0, used: 0 }, // no total
      org_resource_package: { total: 10 }, // neither used nor remaining
      dedicated_resource_packages: [{ total: 5, used: 9 }, { total: 5, remaining: 9 }, { total: "5", used: 1 }],
    },
  })
  expect(u).toEqual({
    plan: "Pro Trial",
    until: "2026-10-01T00:00:00.000Z",
    windows: [
      { name: "Credits", used: 75, display: "1.5e+06 / 2e+06 tokens" },
      { name: "Dedicated credits", used: 100, display: "9 / 5 credits" },
    ],
  })
  expect(_internal.when("2026-10-01T08:00:00+08:00")).toBe("2026-10-01T00:00:00.000Z")
  expect(_internal.when(1790812800000)).toBe("2026-10-01T00:00:00.000Z")
  expect(_internal.when("1790812800")).toBe("2026-10-01T00:00:00.000Z")
  expect(_internal.when(0)).toBeUndefined()
})

// the loader's fetch, as OpenCode's engine calls it, against a listing and
// a chat reply
async function chat(listing, reply) {
  const auth = { ...account(), machineId: "m1", name: "One" }
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/model/list")) return json(listing)
    return reply()
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, hooks, auth }
}

const LISTING = {
  chat: [
    { key: "qmodel", display_name: "Q", enable: true, max_input_tokens: 1000 },
    { key: "fmodel", display_name: "F", enable: true, is_free: true },
    { key: "pmodel", display_name: "P", enable: true, price_factor: 0 },
    { key: "cmodel", display_name: "C", enable: true, priceFactor: 0.5 },
  ],
}

const ASK = { method: "POST", body: JSON.stringify({ model: "qmodel", messages: [{ role: "user", content: "hi" }] }) }

test("a refused chat, 401 or 403, is the built-in's 401 and leaves the account unmarked", async () => {
  for (const status of [401, 403]) {
    const { fetch } = await chat(LISTING, () => new Response("nope", { status }))
    const res = await fetch(API_CHAT, ASK)
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await res.json()).error.message).toBe("the sign-in lapsed — sign in again")
  }
  // refused in the stream, before any answer: the same
  const sse = (v) => new Response(`data: ${JSON.stringify(v)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  const { fetch } = await chat(LISTING, () => sse({ statusCodeValue: 403, body: "" }))
  const res = await fetch(API_CHAT, ASK)
  expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([401, "kept"])
})

test("other refusals keep their status and say nothing of the sign-in", async () => {
  for (const [status, want] of [[500, 500], [429, 429], [402, 402]]) {
    const { fetch } = await chat(LISTING, () => new Response("", { status }))
    const res = await fetch(API_CHAT, ASK)
    expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([want, null])
  }
  // an empty body is named as Go's http.StatusText names it; details may be an object
  expect(_internal.failure(502, "")).toEqual({ status: 502, message: "Bad Gateway" })
  expect(_internal.failure(400, JSON.stringify({ message: "bad", details: { error: { message: "effort" } } }))).toEqual({ status: 400, message: "bad: effort" })
})

test("a model list Qoder won't give is a 400, as the built-in's QoderModelOf answered, the account unmarked", async () => {
  for (const status of [401, 403, 500]) {
    const auth = { ...account(), machineId: "m1" }
    globalThis.fetch = async () => new Response("no", { status })
    const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
    const l = await hooks.auth.loader(async () => auth)
    const res = await l.fetch(API_CHAT, ASK)
    expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([400, null])
    expect((await res.json()).error.message).toBe(`Qoder models: HTTP ${status}: no`)
  }
})

// the loader's fetch for an account whose job token is due, the refresh answered by refresh()
async function due(refresh, fields = {}) {
  const auth = { ...account(), machineId: "m1", expires: 0, ...fields }
  globalThis.fetch = async (url) => (new URL(String(url)).pathname === "/api/v1/jobToken/refresh" ? refresh() : new Response("", { status: 500 }))
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return l.fetch(API_CHAT, ASK)
}

test("a refresh Qoder refuses (401 or 403) marks the account lapsed, as qoderRefreshFailed did", async () => {
  for (const status of [401, 403]) {
    const res = await due(() => new Response("", { status }))
    expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([401, "expired"])
    expect((await res.json()).error.message).toBe(`one@x's Qoder sign-in has expired — sign in again (qoder job token refresh: status ${status})`)
  }
})

test("no refresh token is a 401 the built-in didn't mark; a refresh that failed otherwise is a 502", async () => {
  let res = await due(() => new Response("", { status: 401 }), { refresh: "" })
  expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([401, "kept"])
  res = await due(() => new Response("", { status: 500 }))
  expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([502, null])
  expect((await res.json()).error.message).toBe("Qoder job token refresh: status 500")
})

test("errors don't name Qoder, which magpie adds", async () => {
  expect(_internal.failure(500, JSON.stringify({ message: "boom" }))).toEqual({ status: 500, message: "boom" })
  const { fetch } = await chat(LISTING, () => new Response("", { status: 500 }))
  let res = await fetch(API_CHAT, { method: "POST", body: JSON.stringify({ model: "nomodel", messages: [] }) })
  expect((await res.json()).error.message).toBe('unknown or disabled model "nomodel"')
  res = await fetch("https://api3.qoder.sh/v1/responses", { method: "POST", body: "{}" })
  expect((await res.json()).error.message).toBe("only chat completions are served")
  const gone = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await gone.auth.loader(async () => ({ type: "oauth" }))
  res = await l.fetch(API_CHAT, { method: "POST", body: JSON.stringify({ model: "qmodel", messages: [] }) })
  expect([res.status, res.headers.get("X-Magpie-Sign-In")]).toEqual([401, "kept"])
  expect((await res.json()).error.message).toBe("not signed in")
})

test("a model Qoder lists free (is_free, or a price_factor of 0) is marked free", async () => {
  const { hooks, auth } = await chat(LISTING, () => new Response(""))
  const ms = await hooks.provider.models({ models: {} }, { auth })
  expect(Object.fromEntries(Object.entries(ms).map(([k, m]) => [k, m.free]))).toEqual({ qmodel: false, fmodel: true, pmodel: true, cmodel: false })
  expect(_internal.modelInfo({ key: "x", isFree: true }).free).toBe(true)
})
