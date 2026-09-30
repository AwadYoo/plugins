// A chat is sent once, as magpie's built-in Grok account sent it
// (internal/provider/grok.go, grokSigned): Grok's 401 goes on as it came,
// and says X-Magpie-Sign-In: kept, as the built-in never marked a Grok
// account lapsed.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// a CLI home whose token is good for a day, so nothing renews it
const home = mkdtempSync(join(tmpdir(), "grok-signin-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
writeFileSync(join(home, "auth.json"), JSON.stringify({ a: { key: "tok", email: "g@x.ai", expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() } }))
const auth = { type: "oauth", refresh: home, access: "tok", expires: 0, accountId: "g@x.ai" }

async function chat(reply) {
  let sent = 0
  globalThis.fetch = async () => {
    sent++
    return reply()
  }
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", { method: "POST", body: '{"model":"grok-4.7","input":"hi"}' })
  return { res, sent }
}

test("Grok's 401 is passed on once, the account kept", async () => {
  const { res, sent } = await chat(() => Response.json({ error: "token revoked" }, { status: 401 }))
  expect(sent).toBe(1)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(await res.json()).toEqual({ error: "token revoked" })
})

test("other answers go as they came", async () => {
  for (const status of [200, 403, 429]) {
    const { res, sent } = await chat(() => new Response("x", { status }))
    expect(sent).toBe(1)
    expect(res.status).toBe(status)
    expect(res.headers.get("X-Magpie-Sign-In")).toBeNull()
  }
})
