// auth.usage tells the plan and quota GetUserStatus says, against a reply
// shaped as a live Teams account's (magpie's built-in Devin account showed
// none of it).
import { afterEach, expect, test } from "bun:test"
import { DevinAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const auth = { type: "api", key: "devin-key", metadata: { email: "d@x.dev", plan: "Teams" } }

const status = (plan = {}) => ({
  userStatus: {
    planStatus: {
      planInfo: { planName: "Teams", teamsTier: "TEAMS_TIER_DEVIN_TEAMS", billingStrategy: "BILLING_STRATEGY_QUOTA", monthlyPromptCredits: -1, isDevin: true },
      planStart: "2026-09-26T21:45:55Z",
      planEnd: "2026-10-26T21:45:55Z",
      availablePromptCredits: -1,
      dailyQuotaRemainingPercent: 100,
      weeklyQuotaRemainingPercent: 99,
      overageBalanceMicros: "46807746",
      dailyQuotaResetAtUnix: "1790841600",
      weeklyQuotaResetAtUnix: "1791100800",
      ...plan,
    },
  },
})

async function run(a, reply) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return reply()
  }
  const hooks = await DevinAuthPlugin()
  return { u: await hooks.auth.usage(async () => a), seen }
}

test("a Teams plan: its end, its day and week, the extra usage balance", async () => {
  const { u, seen } = await run(auth, () => Response.json(status()))
  expect(u).toEqual({
    plan: "Teams",
    until: "2026-10-26T21:45:55Z",
    balance: "$46.81",
    windows: [
      { name: "Daily", used: 0, span: 86400, resetsAt: 1790841600 },
      { name: "Weekly", used: 1, span: 604800, resetsAt: 1791100800 },
    ],
  })
  expect(seen[0].url).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus")
  expect(seen[0].headers).toEqual({ "Content-Type": "application/json", "Connect-Protocol-Version": "1" })
  expect(seen[0].body.metadata).toMatchObject({ ideName: "devin-cli", extensionName: "devin-cli", apiKey: "devin-key", locale: "en" })
})

test("a quota with no share left is used up; a hidden one isn't shown; ACUs with a limit are", async () => {
  const s = status({ dailyQuotaRemainingPercent: undefined, overageBalanceMicros: undefined, acuConsumed: 12.5, acuLimit: 50 })
  s.userStatus.planStatus.planInfo.hideWeeklyQuota = true
  const { u } = await run({ ...auth, metadata: { ...auth.metadata, server: "https://eu.example" } }, () => Response.json(s))
  expect(u).toEqual({
    plan: "Teams",
    until: "2026-10-26T21:45:55Z",
    windows: [
      { name: "Daily", used: 100, span: 86400, resetsAt: 1790841600 },
      { name: "ACUs", used: 25, display: "12.5 / 50 ACUs", resetsAt: "2026-10-26T21:45:55Z", aside: true },
    ],
  })
})

test("a plan without quotas is its name alone", async () => {
  const s = { userStatus: { planStatus: { planInfo: { planName: "Free" } } } }
  expect((await run(auth, () => Response.json(s))).u).toEqual({ plan: "Free", windows: [] })
})

test("a refused key says to sign in again", async () => {
  const { u } = await run(auth, () => Response.json({ code: "unauthenticated", message: "invalid api key" }, { status: 401 }))
  expect(u).toEqual({ error: "invalid api key — sign in to Devin again", windows: [] })
  expect((await run({ type: "oauth" }, () => Response.json({}))).u).toEqual({ error: "Devin isn't signed in" })
})
