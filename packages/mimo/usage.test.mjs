// auth.usage tells what magpie's built-in MiMo account shows
// (internal/provider/mimo_usage.go), against the MiMo server's replies as
// its tests give them (mimo_test.go).
import { afterEach, expect, test } from "bun:test"
import { MimoAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const BASE = "https://mimo-server-sgp.xiaomimimo.com/api"
const SELF = { code: 0, data: { current: { planCode: "mimo_pro_m", title: "MiMo 高阶", planTier: 3, status: "ACTIVE", renewalMode: "MONTHLY", endTime: "2026-11-01T00:00:00", source: "ORDER_SUB" } } }
const USAGE = { code: 0, data: { percent: 70, resetDate: "2026-10-05" } }

const account = (expires = Date.now() + 3_600_000) => ({
  type: "oauth",
  refresh: JSON.stringify({ userId: "42", passToken: "pt", deviceId: "pc_1", region: "SGP", base: BASE }),
  access: JSON.stringify({ serviceToken: "st-1", userId: "42" }),
  expires,
  accountId: "42",
})

async function plugin(auth, serve) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    return serve(u.pathname, new Headers(init.headers))
  }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await MimoAuthPlugin({ client })
  return { usage: () => hooks.auth.usage(async () => auth), seen }
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

test("the plan, its end and renewal, and the week's allowance", async () => {
  const p = await plugin(account(), (path, h) => {
    expect(h.get("Cookie")).toBe("serviceToken=st-1; userId=42")
    expect(h.get("X-Client-Version")).toBeTruthy()
    return path === "/api/user/usage" ? json(USAGE) : json(SELF)
  })
  expect(await p.usage()).toEqual({
    plan: "MiMo 高阶",
    until: "2026-10-31T16:00:00.000Z", // 2026-11-01 00:00 in UTC+8
    renew: "auto",
    windows: [{ name: "7 days", used: 30, span: 604800, resetsAt: "2026-10-04T16:00:00.000Z" }],
    signIn: "kept",
  })
  expect(p.seen).toEqual(["/api/user/xiaomi/subscription/self", "/api/user/usage"])
})

test("no plan is the free offer, with no allowance shown", async () => {
  const p = await plugin(account(), (path) => (path === "/api/user/usage" ? json({ code: 0, data: { percent: 100, resetDate: null } }) : json({ code: 0, data: { current: null } })))
  expect(await p.usage()).toEqual({ plan: "Free", signIn: "kept" })
})

test("a plan named by its tier, else its code; a one-time plan doesn't renew", async () => {
  const sub = (current) => async () => {
    const p = await plugin(account(), (path) => (path === "/api/user/usage" ? json({ code: 0, data: {} }) : json({ code: 0, data: { current } })))
    return p.usage()
  }
  expect(await sub({ title: " ", planTier: 4, renewalMode: "ONE_TIME", endTime: "2026-11-01 08:30:00" })()).toEqual({ plan: "Ultra", until: "2026-11-01T00:30:00.000Z", renew: "off", signIn: "kept" })
  expect(await sub({ planTier: 9, planCode: "mimo_x" })()).toEqual({ plan: "mimo_x", signIn: "kept" })
  expect(await sub({})()).toEqual({ plan: "MiMo", signIn: "kept" })
})

test("the allowance unread leaves the plan alone; a refused sign-in says so", async () => {
  let p = await plugin(account(), (path) => (path === "/api/user/usage" ? json({ code: 500, msg: "busy" }) : json(SELF)))
  expect(await p.usage()).toEqual({ plan: "MiMo 高阶", until: "2026-10-31T16:00:00.000Z", renew: "auto", signIn: "kept" })

  // the session turned away, and the passToken no longer signs it on
  p = await plugin(account(), (path) => {
    if (path === "/api/user/xiaomi/subscription/self") return new Response("", { status: 401 })
    if (path === "/api/user/xiaomi/me") return new Response("<html>sign in</html>", { status: 200 })
    return new Response("", { status: 404 })
  })
  expect(await p.usage()).toEqual({ error: "42: the Xiaomi MiMo sign-in has expired — sign in again", signIn: "expired" })
})

test("two accounts signing on at once each keep their own session", async () => {
  const stale = (uid, host) => ({
    type: "oauth",
    refresh: JSON.stringify({ userId: uid, passToken: "pt-" + uid, deviceId: "d", base: `https://${host}/api` }),
    access: JSON.stringify({ serviceToken: "old-" + uid }),
    expires: 0,
    accountId: uid,
  })
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/user/xiaomi/me")) {
      await new Promise((r) => setTimeout(r, 30))
      const uid = u.host[0].toUpperCase()
      return new Response(JSON.stringify({ code: 0, data: { userId: uid } }), { headers: { "set-cookie": `serviceToken=st-${uid}; Path=/` } })
    }
    asked.push(`${u.host} ${new Headers(init.headers).get("Cookie")}`)
    return u.pathname.endsWith("/self") ? json({ code: 0, data: { current: { title: "plan of " + u.host } } }) : json(USAGE)
  }
  const hooks = await MimoAuthPlugin({ client: { auth: { set: async () => {} } } })
  const A = stale("A", "a.example"),
    B = stale("B", "b.example")
  const [a, b] = await Promise.all([hooks.auth.usage(async () => A), hooks.auth.usage(async () => B)])
  expect(a.plan).toBe("plan of a.example")
  expect(b.plan).toBe("plan of b.example")
  for (const x of asked) expect(x).toContain(x.startsWith("a.") ? "serviceToken=st-A" : "serviceToken=st-B")
})

test("a failure is the page's and the server's word", async () => {
  let p = await plugin(account(), () => json({ code: 10001, msg: "no such user" }))
  expect(await p.usage()).toEqual({ error: "Xiaomi MiMo /user/xiaomi/subscription/self: code 10001 no such user", signIn: "kept" })
  p = await plugin(account(), () => json({ message: "down" }, 503))
  expect(await p.usage()).toEqual({ error: "Xiaomi MiMo /user/xiaomi/subscription/self: down", signIn: "kept" })
})

test("the server's times", () => {
  expect(_internal.serverTime("2026-10-05")).toBe("2026-10-04T16:00:00.000Z")
  expect(_internal.serverTime("2026-10-05T12:00:00")).toBe("2026-10-05T04:00:00.000Z")
  expect(_internal.serverTime("2026-10-05T12:00:00Z")).toBe("2026-10-05T12:00:00.000Z")
  expect(_internal.serverTime("soon")).toBeUndefined()
})

// the loader's fetch, as OpenCode's engine calls it
async function loaderFetch(auth, serve) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/route/chat/completions")) sent.push(typeof init.body === "string" ? init.body : init.body)
    return serve(u.pathname, init)
  }
  const hooks = await MimoAuthPlugin({ client: { auth: { set: async ({ body }) => (auth = body) } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, sent }
}

test("a chat body in bytes has mimo-auto asked as mimo-pro, as a string one does", async () => {
  const { fetch, sent } = await loaderFetch(account(), () => json({ ok: true }))
  const req = JSON.stringify({ model: "mimo-auto", messages: [] })
  await fetch(BASE + "/route/chat/completions", { method: "POST", body: new TextEncoder().encode(req) })
  await fetch(BASE + "/route/chat/completions", { method: "POST", body: Buffer.from(req) })
  expect(sent.map((b) => JSON.parse(b).model)).toEqual(["mimo-pro", "mimo-pro"])
})

test("a sign-in Xiaomi no longer takes is magpie's 502 in the built-in's words, marking the account, not a thrown fetch", async () => {
  const { fetch } = await loaderFetch(account(0), (path) => {
    if (path === "/api/user/xiaomi/me") return new Response("<html>sign in</html>", { status: 200 })
    return new Response("", { status: 401 })
  })
  const res = await fetch(BASE + "/route/chat/completions", { method: "POST", body: JSON.stringify({ model: "mimo-pro", messages: [] }) })
  expect(res.status).toBe(502)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  const b = await res.json()
  expect(b.error.message).toBe("42: the Xiaomi MiMo sign-in has expired — sign in again")
  expect(b.error.type).toBe("api_error")
})

test("the server's 401 goes through as the built-in's did: not signed on again, the account unmarked", async () => {
  const asked = []
  const { fetch } = await loaderFetch(account(), (path) => {
    asked.push(path)
    return path === "/api/user/xiaomi/me" ? json({ code: 0, data: { userId: "42" } }) : json({ error: { message: "stale" } }, 401)
  })
  const res = await fetch(BASE + "/route/chat/completions", { method: "POST", body: JSON.stringify({ model: "mimo-pro", messages: [] }) })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("stale")
  expect(asked).toEqual(["/api/route/chat/completions"])
})

test("a success takes the mark off only when the account was signed on again", async () => {
  let p = await loaderFetch(account(), () => json({ ok: true }))
  let res = await p.fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  p = await loaderFetch(account(0), (path) =>
    path === "/api/user/xiaomi/me" ? new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": "serviceToken=st-2; Path=/" } }) : json({ ok: true }),
  )
  res = await p.fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a failure after signing on again still takes the mark off, as mimoFresh did before the request", async () => {
  const p = await loaderFetch(account(0), (path) =>
    path === "/api/user/xiaomi/me" ? new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": "serviceToken=st-2; Path=/" } }) : json({ error: { message: "stale" } }, 401),
  )
  const res = await p.fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a sign-on that can't reach the server is a thrown fetch (magpie's 502) in the built-in's words, the account unmarked", async () => {
  const noSession = { ...account(0), access: "{}" }
  const { fetch } = await loaderFetch(noSession, () => {
    throw new Error("connection refused")
  })
  await expect(fetch(BASE + "/route/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/^Xiaomi MiMo sign-in: connection refused$/)
})

// the built-in's mimoFresh took the lapse mark off when it signed the
// account on again, and mimoLapse put it on; whichever came last stands
const signOn = () => new Response(JSON.stringify({ code: 0, data: { userId: "42" } }), { headers: { "set-cookie": "serviceToken=st-2; Path=/" } })

test("a read that signed the account on again says so, whatever the pages then answer", async () => {
  let p = await plugin(account(0), (path) => (path === "/api/user/xiaomi/me" ? signOn() : path === "/api/user/usage" ? json(USAGE) : json(SELF)))
  expect((await p.usage()).signIn).toBe("renewed")
  p = await plugin(account(0), (path) => (path === "/api/user/xiaomi/me" ? signOn() : json({ message: "down" }, 503)))
  expect(await p.usage()).toEqual({ error: "Xiaomi MiMo /user/xiaomi/subscription/self: down", signIn: "renewed" })
  // a stale session turned away, signed on again, then the allowance unread
  let n = 0
  p = await plugin(account(), (path) => {
    if (path === "/api/user/xiaomi/me") return signOn()
    if (path === "/api/user/xiaomi/subscription/self") return n++ ? json(SELF) : new Response("", { status: 401 })
    return json({ code: 500, msg: "busy" })
  })
  expect(await p.usage()).toEqual({ plan: "MiMo 高阶", until: "2026-10-31T16:00:00.000Z", renew: "auto", signIn: "renewed" })
})

test("the allowance's page refused after the plan's read marks the account", async () => {
  const p = await plugin(account(), (path) => {
    if (path === "/api/user/xiaomi/me") return new Response("<html>sign in</html>", { status: 200 })
    if (path === "/api/user/usage") return new Response("", { status: 401 })
    return json(SELF)
  })
  expect(await p.usage()).toEqual({ plan: "MiMo 高阶", until: "2026-10-31T16:00:00.000Z", renew: "auto", error: "42: the Xiaomi MiMo sign-in has expired — sign in again", signIn: "expired" })
})
