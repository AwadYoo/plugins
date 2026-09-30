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
