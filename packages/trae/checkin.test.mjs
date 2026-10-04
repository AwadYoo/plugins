// The daily check-in (签到): magpie asks Trae CN's own pages on
// api.trae.cn (/trae/api/v2/ug/checkin_credits/status, then /claim)
// through the account's fetch, which sends them as the account.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin } from "./index.mjs"
import { fakeTrae, json, signedIn } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function fetcher(auth = signedIn(), client = {}) {
  const hooks = await TraeCNAuthPlugin({ client })
  return hooks.auth.loader(async () => auth)
}

test("a check-in page is sent as the account, its answer back as it is", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: false, credits: 100 }))
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json({ code: 0, credits: 100 }))
  const o = await fetcher()
  const st = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", headers: { authorization: "Bearer trae" }, body: "{}" })
  expect(st.status).toBe(200)
  expect(st.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(await st.json()).toEqual({ code: 0, enable: true, checked_in: false, credits: 100 })
  const cl = await o.fetch(new Request(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST", body: "{}" }))
  expect(await cl.json()).toEqual({ code: 0, credits: 100 })
  expect(f.seen.map((r) => r.path)).toEqual(["/trae/api/v2/ug/checkin_credits/status", "/trae/api/v2/ug/checkin_credits/claim"])
  for (const r of f.seen) {
    expect(r.method).toBe("POST")
    expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
    expect(r.headers.get("x-device-id")).toBe("1234567890123456789")
  }
})

// Trae CN's IDE (3.3.104, out/main.js eb()/fb()) posts the check-in with
// {req_source: 1} and only the JWT and the device's headers; the chat's
// own (x-uid, x-app-id, x-ide-token …) aren't among them
test("the check-in is sent as Trae CN's IDE sends it", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: false, credits: 100 }))
  f.route("POST /trae/api/v2/ug/checkin_credits/claim", () => json({ code: 0 }))
  const o = await fetcher()
  await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/claim", { method: "POST" })
  expect(f.seen.length).toBe(2)
  for (const r of f.seen) {
    expect(r.json).toEqual({ req_source: 1 })
    const names = [...r.headers.keys()].filter((k) => k === "authorization" || k.startsWith("x-")).sort()
    expect(names).toEqual(["authorization", "x-app-version", "x-device-brand", "x-device-id", "x-device-type", "x-os-version"])
    expect(r.headers.get("content-type")).toBe("application/json")
  }
})

test("a token Trae turns away marks the sign-in", async () => {
  f = fakeTrae()
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 1001, enable: false, checked_in: false, message: "not able to authenticate you" }))
  const o = await fetcher()
  const st = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  expect(st.headers.get("x-magpie-sign-in")).toBe("expired")
  expect((await st.json()).code).toBe(1001)
})

test("a token near its end is renewed first", async () => {
  f = fakeTrae()
  f.route("POST /cloudide/api/v3/trae/oauth/ExchangeToken", () => json({ Result: { Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: Date.now() + 86400_000 } }))
  f.route("POST /trae/api/v2/ug/checkin_credits/status", () => json({ code: 0, enable: true, checked_in: true, credits: 100 }))
  const saved = []
  const o = await fetcher(signedIn({ expires: Date.now() + 30_000 }), { auth: { set: async (x) => saved.push(x) } })
  const st = await o.fetch(f.origin + "/trae/api/v2/ug/checkin_credits/status", { method: "POST", body: "{}" })
  expect(st.headers.get("x-magpie-sign-in")).toBe("renewed")
  expect(f.seen.at(-1).headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-2")
  expect(saved[0].body.access).toBe("jwt-2")
})

test("other hosts' pages and other paths aren't sent as a page", async () => {
  f = fakeTrae()
  const o = await fetcher()
  const r = await o.fetch(f.origin + "/cloudide/whatever", { method: "POST", body: "{}" })
  expect(r.status).toBe(400) // not a chat: refused, nothing sent
  expect(f.seen).toEqual([])
})
