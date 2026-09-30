// auth.usage tells the plan and quota GetUserStatus says, against a reply
// shaped as a live Teams account's (magpie's built-in Devin account showed
// none of it).
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DevinAuthPlugin, _internal } from "./index.mjs"

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
  // no plan: the row keeps the sign-in's, as `devin auth status` names it
  expect(u).toEqual({
    until: "2026-10-26T21:45:55Z",
    balance: "$46.81",
    windows: [
      { name: "1 day", used: 0, span: 86400, resetsAt: 1790841600 },
      { name: "7 days", used: 1, span: 604800, resetsAt: 1791100800 },
    ],
  })
  expect(seen[0].url).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus")
  expect(seen[0].headers).toEqual({ "Content-Type": "application/json", "Connect-Protocol-Version": "1" })
  expect(seen[0].body.metadata).toMatchObject({ ideName: "devin-cli", extensionName: "devin-cli", apiKey: "devin-key", locale: "en" })
})

test("a quota Devin says nothing left of isn't taken for used up; a hidden one isn't shown; ACUs with a limit are", async () => {
  const s = status({ dailyQuotaRemainingPercent: undefined, overageBalanceMicros: undefined, acuConsumed: 12.5, acuLimit: 50 })
  s.userStatus.planStatus.planInfo.hideWeeklyQuota = true
  const { u } = await run({ ...auth, metadata: { ...auth.metadata, server: "https://eu.example" } }, () => Response.json(s))
  expect(u).toEqual({
    until: "2026-10-26T21:45:55Z",
    windows: [{ name: "ACUs", used: 25, display: "12.5 / 50 ACUs", resetsAt: "2026-10-26T21:45:55Z", aside: true }],
  })
})

test("a plan billed otherwise, with resets and no share given, has no quota windows", async () => {
  const s = status({ dailyQuotaRemainingPercent: undefined, weeklyQuotaRemainingPercent: undefined, overageBalanceMicros: undefined })
  s.userStatus.planStatus.planInfo.billingStrategy = "BILLING_STRATEGY_CREDITS"
  expect((await run(auth, () => Response.json(s))).u).toEqual({ until: "2026-10-26T21:45:55Z", windows: [] })
})

test("a plan without quotas has no windows, and leaves the row's plan be", async () => {
  const s = { userStatus: { planStatus: { planInfo: { planName: "Free" } } } }
  expect((await run(auth, () => Response.json(s))).u).toEqual({ windows: [] })
})

test("a refused key says to sign in again", async () => {
  const { u } = await run(auth, () => Response.json({ code: "unauthenticated", message: "invalid api key" }, { status: 401 }))
  // worded so magpie's /sign-in has expired/ marks the account
  expect(u).toEqual({ error: "Devin's sign-in has expired — sign in again", windows: [] })
  expect(u.error).toMatch(/sign-in has expired/)
  const bare = await run(auth, () => new Response("", { status: 401 }))
  expect(bare.u.error).toBe("Devin's sign-in has expired — sign in again")
  expect((await run({ type: "oauth" }, () => Response.json({}))).u).toEqual({ error: "Devin isn't signed in" })
})

// the built-in sends none and minimal as asked (devinVariantIn): the
// family's variant nearest them
test("the efforts none and minimal go as given", () => {
  const { effortOf, variantFor, familiesOf, SNAPSHOT } = _internal
  expect(effortOf("none")).toBe("none")
  expect(effortOf("minimal")).toBe("minimal")
  const fs = familiesOf(SNAPSHOT)
  expect(variantFor(fs, "gpt-6-sol", effortOf("none"))).toBe("gpt-6-sol-none")
  expect(variantFor(fs, "gemini-3.5-flash", effortOf("minimal"))).toBe("gemini-3-5-flash-minimal")
})

// devinCollapse keeps a variant the user picked, at the effort its id is at
test("a variant the user picked stays in the list, at its own effort", () => {
  const { listed, familiesOf, SNAPSHOT } = _internal
  const fs = familiesOf(SNAPSHOT)
  const ids = (ms) => ms.map((m) => m.id)
  expect(ids(listed(fs))).not.toContain("swe-2-medium")
  const kept = listed(fs, ["swe-2-medium", "claude-opus-5-5-high-fast", "not-a-devin-model", "swe-2"])
  expect(kept.find((m) => m.id === "swe-2-medium")).toEqual({ id: "swe-2-medium", name: "SWE-2 Medium", context: 262000, output: 128000, efforts: ["medium"] })
  expect(kept.find((m) => m.id === "claude-opus-5-5-high-fast").efforts).toEqual(["high"])
  expect(ids(kept)).not.toContain("not-a-devin-model")
  expect(ids(kept).filter((id) => id === "swe-2").length).toBe(1)
})

// the built-in marks a model as taking images only when it does
// (m.Images || catalog.SeesImages): models.dev's word, from the catalog cache
test("only a model models.dev says takes images is given image input", () => {
  const { seesImages, runtimeModel, configModel, forgetImages } = _internal
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "magpie")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    anthropic: { models: { "claude-opus-5-5": { modalities: { input: ["text", "image"] } } } },
    zai: { models: { "glm-5-2": { modalities: { input: ["text"] } } } },
  }))
  forgetImages()
  const m = (id) => ({ id, name: id, context: 1, output: 1, efforts: [] })
  expect(seesImages("claude-opus-5-5")).toBe(true)
  expect(runtimeModel(m("claude-opus-5-5")).capabilities.input.image).toBe(true)
  expect(configModel(m("claude-opus-5-5")).modalities.input).toEqual(["text", "image"])
  for (const id of ["glm-5-2", "swe-2"]) {
    expect(runtimeModel(m(id)).capabilities.input.image).toBe(false)
    expect(runtimeModel(m(id)).capabilities.attachment).toBe(false)
    expect(configModel(m(id)).modalities.input).toEqual(["text"])
  }
})
