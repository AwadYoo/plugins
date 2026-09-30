// A request's failures, as magpie's built-in ZCode account answered them
// (internal/provider/zcode.go zcodeProvider): the plan's 401 goes on as it
// came, saying X-Magpie-Sign-In: kept, as the built-in never marked a
// ZCode account lapsed; a Start Plan sign-in past its end fails in
// errZCodeExpired's words.
import { afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin } = await import("./index.mjs"))
})
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"

async function send(auth, reply) {
  globalThis.fetch = async () => reply()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  return opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", body: "{}" })
}

const key = { type: "api", key: "one.secret", metadata: { site: "zai" } }

test("the plan's 401 goes on as it came, the account kept", async () => {
  const res = await send(key, () => Response.json({ error: { message: "token expired or incorrect" } }, { status: 401 }))
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(await res.json()).toEqual({ error: { message: "token expired or incorrect" } })
})

test("other answers go as they came", async () => {
  for (const status of [200, 429]) {
    const res = await send(key, () => new Response("x", { status }))
    expect(res.status).toBe(status)
    expect(res.headers.get("X-Magpie-Sign-In")).toBeNull()
  }
})

test("a Start Plan sign-in past its end fails as errZCodeExpired", async () => {
  const s = { site: "zai", jwt: jwt(Math.floor(Date.now() / 1000) - 60) }
  const auth = { type: "oauth", access: s.jwt, refresh: JSON.stringify(s), expires: 0 }
  await expect(send(auth, () => new Response(""))).rejects.toThrow("ZCode's sign-in has expired; sign in to ZCode again (or add the account again in magpie)")
})
