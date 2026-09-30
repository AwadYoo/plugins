// auth.usage tells what magpie's built-in WorkBuddy usage told for the same
// answers (internal/provider/workbuddy_test.go, workbuddy_ai_test.go).
import { test, expect, beforeAll, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { join } from "node:path"

let WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal, home
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  home = homedir()
  ;({ WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } = await import("./index.mjs"))
})
// nothing leaves the machine
const offline = async () => { throw new Error("no network in tests") }
globalThis.fetch = offline
afterEach(() => {
  globalThis.fetch = offline
  _internal.desktopHeld.clear()
})

const later = () => Date.now() + 3600_000
const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))
// the summary as the live API sends it: capacities as strings, some fractional
const PAID = { IsPaidUser: true, Packages: [
  { PackageCode: "coding", CycleTotalCapacity: "9500", CycleRemainCapacity: "7500", CycleUsedCapacity: "2000" },
  { PackageCode: "vibe", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500.00000000" },
] }

function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init?.headers) })
    const r = routes[u.pathname]
    return r ? r(init) : new Response("", { status: 404 })
  }
  return calls
}
const usageOf = async (plugin, auth, client = {}) => (await plugin({ client })).auth.usage(async () => auth)

test("a paid WorkBuddy account's credits", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () => ok(PAID) })
  const auth = { type: "oauth", access: "two-access", refresh: "r", expires: later(), uid: "u2", domain: "" }
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ plan: "Pro", windows: [{ name: "Credits", used: 25, display: "2500 / 10000" }] })
  const c = calls[0]
  expect(c.url.origin).toBe("https://copilot.tencent.com")
  expect(c.init.method).toBe("POST")
  expect(c.init.body).toBe("{}")
  expect(Object.fromEntries(["authorization", "x-user-id", "x-domain", "x-product", "x-ide-type", "user-agent"].map((h) => [h, c.headers.get(h)])))
    .toEqual({ authorization: "Bearer two-access", "x-user-id": "u2", "x-domain": "copilot.tencent.com", "x-product": "SaaS",
      "x-ide-type": "WorkBuddy", "user-agent": "WorkBuddy/5.5.6" })
})

test("a free WorkBuddy AI account, at its own site and domain", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () =>
    ok({ IsPaidUser: false, Packages: [{ CycleTotalCapacity: "1000", CycleUsedCapacity: "100" }] }) })
  const auth = { type: "oauth", access: "ai-access", expires: later(), uid: "ai2", domain: "www.codebuddy.ai" }
  expect(await usageOf(WorkBuddyAIAuthPlugin, auth)).toEqual({ plan: "Free", windows: [{ name: "Credits", used: 10, display: "100 / 1000" }] })
  expect(calls[0].url.origin).toBe("https://www.workbuddy.ai")
  expect(calls[0].headers.get("x-domain")).toBe("www.codebuddy.ai")
})

test("counts and plans as Go says them", () => {
  expect(_internal.usageOf({ IsPaidUser: true, Packages: [{ CycleTotalCapacity: 3300, CycleUsedCapacity: "438.88000002" }, {}] }, "Team"))
    .toEqual({ plan: "Team", windows: [{ name: "Credits", used: (100 * 438.88000002) / 3300, display: "438.88 / 3300" }] })
  // no capacity, no window
  expect(_internal.usageOf({ IsPaidUser: false, Packages: [{ CycleTotalCapacity: "", CycleUsedCapacity: null }] }, ""))
    .toEqual({ plan: "Free", windows: [] })
  expect(() => _internal.usageOf({ Packages: [{ CycleTotalCapacity: "lots" }] })).toThrow('strconv.ParseFloat: parsing "lots": invalid syntax')
})

test("WorkBuddy's refusals are the card's error", async () => {
  const auth = { type: "oauth", access: "a", expires: later(), uid: "u" }
  serve({ "/billing/meter/get-user-resource-summary": () => new Response("", { status: 401 }) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ error: "Unauthorized" })
  serve({ "/billing/meter/get-user-resource-summary": () => new Response(JSON.stringify({ code: 10085, msg: "" }), { status: 403 }) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ error: "error 10085" })
  serve({ "/billing/meter/get-user-resource-summary": () => new Response(JSON.stringify({ code: 11001, msg: "token expired" })) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ error: "token expired" })
  expect(await usageOf(WorkBuddyAuthPlugin, null)).toEqual({ error: "not signed in" })
})

test("a token near its end is renewed and saved, as the loader does", async () => {
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }),
    "/billing/meter/get-user-resource-summary": () => ok(PAID),
  })
  const auth = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() + 1000, uid: "u2" }
  const out = await usageOf(WorkBuddyAuthPlugin, auth, { auth: { set: async (x) => sets.push(x) } })
  expect(out.windows[0].used).toBe(25)
  expect(calls[0].headers.get("x-refresh-token")).toBe("old-refresh")
  expect(calls[1].headers.get("authorization")).toBe("Bearer new-access")
  expect(sets.length).toBe(1)
  expect(sets[0].path).toEqual({ id: "workbuddy" })
  expect(sets[0].body).toMatchObject({ access: "new-access", refresh: "new-refresh", uid: "u2" })
})

test("the desktop's sign-in is renewed in memory only", async () => {
  const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension") : join(home, ".local", "share", "CodeBuddyExtension")
  mkdirSync(join(dir, "Data", "Public", "auth"), { recursive: true })
  const file = join(dir, "Data", "Public", "auth", "workbuddy-desktop.info")
  const info = JSON.stringify({ auth: { accessToken: "desk-old", refreshToken: "desk-refresh", expiresAt: Date.now() + 1000, domain: "www.codebuddy.cn" },
    account: { uid: "u1", nickname: "旅行者" } })
  writeFileSync(file, info)
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "desk-new", expiresIn: 3600 }),
    "/billing/meter/get-user-resource-summary": () => ok(PAID),
  })
  const auth = { type: "oauth", access: "", refresh: "", expires: 0, source: "desktop", uid: "u1" }
  const client = { auth: { set: async (x) => sets.push(x) } }
  expect(await usageOf(WorkBuddyAuthPlugin, auth, client)).toEqual({ plan: "Pro", windows: [{ name: "Credits", used: 25, display: "2500 / 10000" }] })
  expect(calls[1].headers.get("authorization")).toBe("Bearer desk-new")
  expect(calls[1].headers.get("x-domain")).toBe("www.codebuddy.cn")
  expect(sets).toEqual([]) // never saved,
  expect(readFileSync(file, "utf8")).toBe(info) // nor written where the app keeps it
  // and held: the next ask doesn't renew again
  await usageOf(WorkBuddyAuthPlugin, auth, client)
  expect(calls.filter((c) => c.url.pathname.endsWith("/refresh")).length).toBe(1)
})

test("a desktop sign-in with the app signed out says why it failed", async () => {
  const p = await WorkBuddyAIAuthPlugin({ client: {} })
  const m = p.auth.methods.find((x) => x.label.endsWith("desktop's sign-in"))
  const r = await (await m.authorize()).callback()
  expect(r).toEqual({ type: "failed", error: "WorkBuddy AI desktop isn't signed in" })
})
