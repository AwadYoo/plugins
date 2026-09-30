// auth.usage tells what magpie's built-in Kiro usage told for the same
// answer (internal/provider/kiro_test.go TestKiroLimits).
import { test, expect, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin, _internal
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin, _internal } = await import("./index.mjs"))
})
// nothing leaves the machine
const offline = async () => { throw new Error("no network in tests") }
globalThis.fetch = offline
afterEach(() => (globalThis.fetch = offline))

const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const auth = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600_000, method: "social",
  region: "us-east-1", profileArn: PROFILE }
const FREE = { subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, userInfo: { email: "me@example.com" },
  usageBreakdownList: [{ displayName: "Credit", displayNamePlural: "Credits", currentUsageWithPrecision: 12.5, usageLimitWithPrecision: 50,
    nextDateReset: 1790000000, freeTrialInfo: { freeTrialStatus: "ACTIVE", currentUsageWithPrecision: 100, usageLimitWithPrecision: 500,
      freeTrialExpiry: 1791000000 } }] }

function answer(status, body) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  }
  return calls
}
const usage = async (a = auth) => (await plugin({ client: { auth: { set: async () => {} } } })).auth.usage(async () => a)

test("a free account's credits and trial", async () => {
  const calls = answer(200, FREE)
  expect(await usage()).toEqual({
    plan: "Kiro Free",
    user: "me@example.com",
    windows: [
      { name: "Free trial", used: 20, resetsAt: new Date(1791000000_000).toISOString(), display: "100 / 500" },
      { name: "Credits", used: 25, resetsAt: new Date(1790000000_000).toISOString(), display: "12.5 / 50", span: 30 * 24 * 3600 },
    ],
  })
  const u = new URL(calls[0].url)
  expect(u.pathname).toEndWith("/Get-Usage-Limits")
  expect(Object.fromEntries(u.searchParams)).toEqual({ origin: "KIRO_CLI", profileArn: PROFILE, resourceType: "CREDIT", isEmailRequired: "true" })
  expect(calls[0].init.headers.Authorization).toBe("Bearer test-access")
})

test("names, resets and counts as Go says them", () => {
  const { windows, plan } = _internal.usageOf({ subscriptionInfo: { subscriptionTitle: "kiro  pro plus" }, nextDateReset: 1800000000,
    usageBreakdownList: [
      { displayName: "Vibe", currentUsageWithPrecision: 1.005, usageLimitWithPrecision: 1000000 },
      { currentUsageWithPrecision: 3, usageLimitWithPrecision: 0 }, // no limit: skipped
      { currentUsageWithPrecision: 150.1, usageLimitWithPrecision: 100, nextDateReset: 0,
        freeTrialInfo: { freeTrialStatus: "EXPIRED", usageLimitWithPrecision: 10 } },
    ] })
  expect(plan).toBe("Kiro Pro Plus")
  expect(windows.map((w) => [w.name, w.display, w.resetsAt])).toEqual([
    ["Vibe", "1 / 1e+06", new Date(1800000000_000).toISOString()], // Go's %.2f of 1.005 is 1.00
    ["Credits", "150.1 / 100", new Date(1800000000_000).toISOString()],
  ])
  expect(windows[1].used).toBeCloseTo(150.1) // the host clamps it to 100; Go's built-in didn't
})

test("Kiro's refusal is the card's error", async () => {
  answer(403, { message: "The bearer token included in the request is invalid." })
  expect(await usage()).toEqual({ error: "Kiro: The bearer token included in the request is invalid. (403)" })
  answer(500, "")
  expect(await usage()).toEqual({ error: "Kiro: Internal Server Error" })
})

test("no account, no usage", async () => {
  const calls = answer(200, FREE)
  expect(await usage(null)).toEqual({ error: "not signed in" })
  expect(calls).toEqual([])
})

// the loader's fetch answering a Messages request
async function ask(a) {
  const hooks = await plugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => a)
  const res = await l.fetch("https://kiro.invalid/v1/messages", { method: "POST", body: JSON.stringify({ model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) })
  return { status: res.status, message: (await res.json()).error.message }
}
const stale = { ...auth, expires: Date.now() - 60_000 }

test("a refresh that failed for a while is no lapsed sign-in (no 401); one Kiro refused is", async () => {
  answer(500, "")
  expect(await ask(stale)).toEqual({ status: 502, message: "refreshing Kiro's sign-in: 500" })
  globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND") }
  expect(await ask(stale)).toEqual({ status: 502, message: "refreshing Kiro's sign-in: getaddrinfo ENOTFOUND" })
  answer(401, { error: "invalid_grant" })
  expect(await ask(stale)).toEqual({ status: 401, message: "Kiro's sign-in has expired; sign in again" })
  expect(await ask({ ...stale, refresh: "" })).toEqual({ status: 401, message: "Kiro's sign-in has expired; sign in again" })
})

test("errors don't name Kiro, which magpie adds", async () => {
  answer(500, { message: "boom" })
  expect(await ask(auth)).toEqual({ status: 500, message: "boom" })
})
