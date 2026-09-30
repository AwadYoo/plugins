// An account whose sign-in Factory won't renew answers as the built-in's
// does: a 401 in the shape of the API the request was for, not a throw.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const expired = {
  type: "oauth",
  access: "tok-old",
  refresh: "r-old",
  expires: Date.now() - 1000,
  accountId: "ada",
  activeOrganizationId: "fac_A",
  region: "",
  premBaseHost: "",
}

async function loaded() {
  const seen = []
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    seen.push(u.pathname)
    if (u.pathname.endsWith("/authenticate")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    return new Response("upstream reached", { status: 500 })
  }
  let auth = { ...expired }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await FactoryAuthPlugin({ client })
  const l = await hooks.auth.loader(async () => auth)
  return { l, seen }
}

test("a refused renewal is Anthropic's 401 on /llm/a/", async () => {
  const { l, seen } = await loaded()
  const res = await l.fetch("https://api.factory.ai/api/llm/a/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-x" }) })
  expect(res.status).toBe(401)
  const b = await res.json()
  expect(b.type).toBe("error")
  expect(b.error.type).toBe("authentication_error")
  expect(b.error.message).toContain("sign in")
  expect(seen.some((p) => p.includes("/llm/"))).toBe(false)
})

test("and OpenAI's on /llm/o/", async () => {
  const { l } = await loaded()
  const res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })
  expect(res.status).toBe(401)
  const b = await res.json()
  expect(b.error.type).toBe("authentication_error")
  expect(b.error.code).toBe(null)
  expect(b.type).toBeUndefined()
})

test("a refusal says what to do after an em dash, as the built-in's Explain joins it", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "model not allowed" } }), { status: 403 })
  const auth = { ...expired, access: "tok", expires: Date.now() + 3_600_000 }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  let res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })
  expect(res.status).toBe(403)
  expect((await res.json()).error.message).toMatch(/^model not allowed — Factory refused this account the request; check that `droid`/)
  globalThis.fetch = async () => new Response("", { status: 403 })
  res = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-x" }) })
  expect((await res.json()).error.message).toMatch(/^403 Forbidden — Factory refused/)
})
