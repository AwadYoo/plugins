// The usage card: the account's credits from its entitlement packs; and
// the model list, the account's own when Trae answers.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

let f
afterEach(() => f?.close())

test("credits are the packs' limits and what they used", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ is_credits_billing: false, user_entitlement_pack_list: [
    { entitlement_base_info: { quota: { credits_limit: 300 }, end_time: 1790000000 }, usage: { credits_amount: 75 } },
    { entitlement_base_info: { quota: {} }, usage: {} }, // a feature pack, no credits
    { entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 25 } },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(f.seen[0].json).toEqual({ require_usage: true, req_source: 0 })
  expect(f.seen[0].headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
  expect(u.plan).toBe("Free")
  expect(u.user).toBe("Ann")
  expect(u.signIn).toBe("kept")
  expect(u.balance).toBe("300 of 400 credits left")
  expect(u.windows).toEqual([{ name: "Credits", used: 25, resetsAt: new Date(1790000000 * 1000).toISOString() }])
})

test("unlimited packs say so", () => {
  expect(_internal.credits({ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: -1 } }, usage: { credits_amount: 3 } }] }).unlimited).toBe(true)
})

test("a 401 reading credits marks the account", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/pay/ide_user_ent_usage", () => json({ code: 1001, message: "not login" }, 401))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => signedIn())
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("sign in again")
})

async function given(hooks) {
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider["trae-cn"]
  return { id: "trae-cn", models: Object.fromEntries(Object.entries(p.models).map(([id, m]) => [id, { id, ...m }])) }
}

test("the config declares the known models; the live list replaces them", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", () => json({ config_info_list: [
    { config_name: "glm-5.2", display_name: "GLM-5.2", context_window_size: { max: [200000] } },
    { config_name: "DeepSeek-V4-Pro", display_name: "DeepSeek-V4-Pro" },
  ] }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(Object.keys(p.models)).toContain("kimi-k2.6")
  const live = await hooks.provider.models(p, { auth: signedIn() })
  expect(Object.keys(live)).toEqual(["glm-5.2", "DeepSeek-V4-Pro"])
  expect(live["glm-5.2"].limit.context).toBe(200000)
  expect(f.seen[0].json.function).toBe("chat_v3")
})

test("when the list can't be read, the known models stand", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/get_detail_param", () => new Response("down", { status: 503 }))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const p = await given(hooks)
  expect(await hooks.provider.models(p, { auth: signedIn() })).toBe(p.models)
})
