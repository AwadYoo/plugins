// Refreshing the token: one refresh at a time for an account, the new
// token saved; only MiniMax's invalid_grant (HTTP 400) signs the account
// out, any other failure keeps it.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

// store is a sign-in as magpie keeps it: read afresh by getAuth, saved by
// client.auth.set
function store(a) {
  const s = { auth: { type: "oauth", accountId: "a@example.com", ...a }, saves: [] }
  s.getAuth = async () => s.auth
  s.client = { auth: { set: async ({ path, body }) => { s.saves.push({ id: path.id, body }); s.auth = body } } }
  return s
}

const chat = (opts) => opts.fetch(opts.baseURL + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"MiniMax-M3","messages":[]}' })
const ok = () => json({ type: "message", content: [] })

test("a token about to end is refreshed first and saved", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }))
  f.route("POST /mavis/api/v1/llm/v1/messages", ok)
  const s = store({ access: "old", refresh: "r1", expires: Date.now() + 10_000 })
  const hooks = await MiniMaxCodeAuthPlugin({ client: s.client })
  const res = await chat(await hooks.auth.loader(s.getAuth))
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  const ref = f.seen.find((r) => r.path === "/oauth2/token")
  expect(ref.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1", client_id: "mcode-public", scope: "agent.default", audience: "agent-backend" })
  expect(f.seen.find((r) => r.path.endsWith("/messages")).headers.get("authorization")).toBe("Bearer new")
  expect(s.saves.length).toBe(1)
  expect(s.saves[0]).toMatchObject({ id: "minimax-code", body: { type: "oauth", access: "new", refresh: "r2", accountId: "a@example.com" } })
})

test("two requests racing refresh once; one reading the old token late joins it", async () => {
  f = fakeMiniMax()
  let refreshes = 0
  f.route("POST /oauth2/token", async () => {
    refreshes++
    await Bun.sleep(50)
    return json({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 })
  })
  f.route("POST /mavis/api/v1/llm/v1/messages", ok)
  const s = store({ access: "old", refresh: "r1", expires: Date.now() - 1 })
  const hooks = await MiniMaxCodeAuthPlugin({ client: s.client })
  const opts = await hooks.auth.loader(s.getAuth)
  const rs = await Promise.all([chat(opts), chat(opts), chat(opts)])
  for (const r of rs) expect(r.status).toBe(200)
  expect(refreshes).toBe(1)
  // a request that read the sign-in from before the save (another account
  // slot's loader, a stale read) doesn't spend the rotated token again
  const late = store({ access: "old", refresh: "r1", expires: Date.now() - 1 })
  const opts2 = await (await MiniMaxCodeAuthPlugin({ client: late.client })).auth.loader(late.getAuth)
  expect((await chat(opts2)).status).toBe(200)
  expect(refreshes).toBe(1)
  const sent = f.seen.filter((r) => r.path.endsWith("/messages")).map((r) => r.headers.get("authorization"))
  expect(sent).toEqual(Array(4).fill("Bearer new"))
})

test("each account refreshes on its own", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", async (r) => json({ access_token: "new-" + r.form.refresh_token, refresh_token: r.form.refresh_token + "'", token_type: "Bearer", expires_in: 3600 }))
  f.route("POST /mavis/api/v1/llm/v1/messages", ok)
  const a = store({ access: "a", refresh: "ra", expires: Date.now() - 1 })
  const b = store({ access: "b", refresh: "rb", expires: Date.now() - 1 })
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  await Promise.all([chat(await hooks.auth.loader(a.getAuth)), chat(await hooks.auth.loader(b.getAuth))])
  const sent = f.seen.filter((r) => r.path.endsWith("/messages")).map((r) => r.headers.get("authorization")).sort()
  expect(sent).toEqual(["Bearer new-ra", "Bearer new-rb"])
})

test("invalid_grant with HTTP 400 signs the account out", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400))
  const s = store({ access: "old", refresh: "r1", expires: Date.now() - 1 })
  const hooks = await MiniMaxCodeAuthPlugin({ client: s.client })
  const opts = await hooks.auth.loader(s.getAuth)
  const e = await chat(opts).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBe("expired")
  expect(e.message).toContain("sign in again")
  expect(s.saves.length).toBe(0)
  // the usage card says so too
  const u = await hooks.auth.usage(s.getAuth)
  expect(u.signIn).toBe("expired")
})

test("any other refresh failure keeps the account", async () => {
  for (const [status, body] of [[500, { error: "server_error" }], [401, { error: "invalid_grant" }], [400, { error: "invalid_request" }], [503, {}]]) {
    f = fakeMiniMax()
    f.route("POST /oauth2/token", () => json(body, status))
    f.route("POST /mavis/api/v1/llm/v1/messages", ok)
    // a token past its end: the request fails, the account kept
    const s = store({ access: "old", refresh: "r1", expires: Date.now() - 1 })
    const hooks = await MiniMaxCodeAuthPlugin({ client: s.client })
    const e = await chat(await hooks.auth.loader(s.getAuth)).catch((e) => e)
    expect(e.signIn).toBe("kept")
    // a token about to end but not ended yet: it is used as it is
    const t = store({ access: "still", refresh: "r1", expires: Date.now() + 30_000 })
    const res = await chat(await hooks.auth.loader(t.getAuth))
    expect(res.status).toBe(200)
    expect(f.seen.at(-1).headers.get("authorization")).toBe("Bearer still")
    f.close()
    f = null
  }
})

test("a token MiniMax turns away is refreshed once and the request sent again", async () => {
  f = fakeMiniMax()
  f.route("POST /oauth2/token", () => json({ access_token: "new", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 }))
  f.route("POST /mavis/api/v1/llm/v1/messages", (r) => (r.headers.get("authorization") === "Bearer new" ? ok() : json({ type: "error", error: { type: "authentication_error", message: "token expired" } }, 401)))
  const s = store({ access: "old", refresh: "r1", expires: Date.now() + 3600_000 })
  const hooks = await MiniMaxCodeAuthPlugin({ client: s.client })
  const res = await chat(await hooks.auth.loader(s.getAuth))
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  expect(f.seen.filter((r) => r.path.endsWith("/messages")).length).toBe(2)
  expect(s.auth.access).toBe("new")
})
