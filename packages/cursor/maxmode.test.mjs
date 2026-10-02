// A model Cursor serves only in Max Mode is asked for in Max Mode, as the
// CLI does ("Max Mode Required: The model "gpt-5.6-luna-low" requires Max
// Mode to be enabled", ARNO on Discord), and the models Cursor's picker
// offers beyond the CLI's usable list (GLM-5.3, GLM-5.3 Flash) are listed
// and run — against a fake Cursor: its API a stand-in fetch, its agent API
// an HTTP/2 server here. Nothing reaches Cursor.
import "./nonet.mjs" // first: no request leaves this machine
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import http2 from "node:http2"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const { fields, pb, frame, usable, offered, maxRequired } = _internal

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const jwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
let n = 0
// a sign-in of its own, so no list kept for another is used
const fresh = () => ({ type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 7200 + 50_000 + ++n), refresh: "", expires: 0, accountId: "a@b.c" })

const USABLE = [
  { modelId: "gpt-5.6-luna-low", displayName: "GPT-5.6 Luna Low" },
  { modelId: "gpt-5.6-luna-high", displayName: "GPT-5.6 Luna High" },
  { modelId: "claude-opus-5-5-max", displayName: "Claude Opus 5.5 1M Max", maxMode: true },
  { modelId: "composer-2.5", displayName: "Composer 2.5" },
  { modelId: "grok-4.7-low", displayName: "Grok 4.7 Low" },
]

// Cursor's picker, as AvailableModels answers it in JSON
const PICKER = [
  {
    name: "gpt-5.6-luna",
    clientDisplayName: "GPT-5.6 Luna",
    supportsMaxMode: true,
    supportsNonMaxMode: false,
    variants: [
      { parameterValues: [{ id: "reasoning", value: "low" }], displayName: "Low", isMaxMode: true, legacySlug: "gpt-5.6-luna-low" },
      { parameterValues: [{ id: "reasoning", value: "high" }], displayName: "High", isMaxMode: true, legacySlug: "gpt-5.6-luna-high" },
    ],
  },
  { name: "composer-2.5", clientDisplayName: "Composer 2.5", supportsNonMaxMode: true, variants: [{ displayName: "", isMaxMode: false, legacySlug: "composer-2.5" }] },
  {
    name: "glm-5.3",
    clientDisplayName: "GLM-5.3",
    supportsNonMaxMode: true,
    supportsMaxMode: true,
    contextTokenLimit: 200000,
    variants: [
      { parameterValues: [{ id: "thinking", value: "true" }], displayName: "", isMaxMode: false, isDefaultNonMaxConfig: true },
      { parameterValues: [{ id: "thinking", value: "true" }], displayName: "", isMaxMode: true, isDefaultMaxConfig: true },
    ],
  },
  { name: "glm-5.3-flash", clientDisplayName: "GLM-5.3 Flash", supportsNonMaxMode: true },
  { name: "secret-model", clientDisplayName: "Secret", isHidden: true },
  { name: "tab-only", clientDisplayName: "Tab", onlySupportsCmdK: true },
  { name: "claude-4.5-haiku", clientDisplayName: "Haiku 4.5" },
]

// the agent API: each Run's model noted; one asked for without Max Mode
// that only has it is refused as Cursor refuses it
let server, base
const runs = []
const maxOnly = new Set(["gpt-5.6-luna-low", "gpt-5.6-luna-high", "secret-max"])
const str = (fs, num) => fs.find((f) => f.num === num)?.data?.toString() ?? ""
const num = (fs, k) => fs.find((f) => f.num === k)?.n ?? 0
beforeAll(async () => {
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buf = Buffer.alloc(0)
    let answered = false
    stream.on("data", (c) => {
      buf = Buffer.concat([buf, c])
      if (answered || buf.length < 5 || buf.length < 5 + buf.readUInt32BE(1)) return
      answered = true
      const rr = fields(fields(buf.subarray(5, 5 + buf.readUInt32BE(1))).find((f) => f.num === 1).data)
      const details = fields(rr.find((f) => f.num === 3).data)
      const requested = fields(rr.find((f) => f.num === 9).data)
      const run = {
        model: str(details, 1),
        detailsMax: num(details, 7),
        requested: str(requested, 1),
        requestedMax: num(requested, 2),
        params: requested.filter((f) => f.num === 3).map((f) => fields(f.data)).map((p) => [str(p, 1), str(p, 2)]),
      }
      runs.push(run)
      const end = (body) => {
        const b = Buffer.from(JSON.stringify(body))
        const head = Buffer.alloc(5)
        head[0] = 2
        head.writeUInt32BE(b.length, 1)
        stream.end(Buffer.concat([head, b]))
      }
      if (maxOnly.has(run.model) && !run.detailsMax) {
        const detail = `The model "${run.model}" requires Max Mode to be enabled. Please enable Max Mode and try again.`
        return end({ error: { code: "failed_precondition", message: "Error", details: [{ debug: { error: "ERROR_MAX_MODE_REQUIRED", details: { title: "Max Mode Required", detail } } }] } })
      }
      const update = (k, body) => frame(pb().bytes(1, pb().bytes(k, body)).done())
      stream.write(update(1, pb().str(1, "hi").done()))
      stream.write(update(14, pb().varint(1, 10).varint(2, 1).done()))
      end({})
    })
    stream.on("error", () => {})
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server.close())

function fakeAPI({ picker = PICKER, pickerDown = false } = {}) {
  const asked = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    asked.push(u)
    if (u === "https://api2.cursor.sh/aiserver.v1.ServerConfigService/GetServerConfig") return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u === "https://api2.cursor.sh/agent.v1.AgentService/GetUsableModels") return Response.json({ models: USABLE })
    if (u === "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels") {
      if (pickerDown) return new Response("down", { status: 503 })
      expect(JSON.parse(init.body)).toEqual({ useModelParameters: true, doNotUseMarkdown: true })
      return Response.json({ models: picker })
    }
    throw new Error("the test asked " + u)
  }
  return asked
}

async function ask(auth, model, effort) {
  const hooks = await CursorAuthPlugin()
  const l = await hooks.auth.loader(async () => auth)
  const chat = { model, messages: [{ role: "user", content: "hello" }], ...(effort ? { reasoning_effort: effort } : {}) }
  const res = await l.fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) })
  return { status: res.status, body: await res.json() }
}

test("Cursor's Max Mode refusal is recognised", () => {
  expect(maxRequired('Max Mode Required: The model "gpt-5.6-luna-low" requires Max Mode to be enabled. Please enable M')).toBe(true)
  expect(maxRequired("MAX_MODE_REQUIRED")).toBe(true)
  expect(maxRequired("usage limit reached: slow down")).toBe(false)
})

test("the list has the picker's models the usable list lacks, and says which need Max Mode", async () => {
  fakeAPI()
  const tok = fresh().access
  const raw = await usable(tok)
  const by = Object.fromEntries(raw.map((m) => [m.id, m]))
  expect(by["gpt-5.6-luna-low"].maxMode).toBe(true) // the picker's say
  expect(by["claude-opus-5-5-max"].maxMode).toBe(true) // the usable list's own
  expect(by["composer-2.5"].maxMode).toBeUndefined()
  expect(by["grok-4.7-low"].maxMode).toBeUndefined() // in neither: as before
  expect(by["glm-5.3"]).toEqual({ id: "glm-5.3", name: "GLM-5.3", context: 200000, run: "glm-5.3", params: [{ id: "thinking", value: "true" }] })
  expect(by["glm-5.3-flash"]).toMatchObject({ id: "glm-5.3-flash", name: "GLM-5.3 Flash", run: "glm-5.3-flash", params: [] })
  for (const gone of ["secret-model", "tab-only", "claude-4.5-haiku", "gpt-5.6-luna", "composer-2.5-1"]) expect(by[gone]).toBeUndefined()
  // offered: GLM-5.3 and its Flash beside the families
  const ids = offered(raw).map((m) => m.id)
  expect(ids).toEqual(["gpt-5.6-luna", "claude-opus-5-5-max", "composer-2.5", "grok-4.7-low", "glm-5.3", "glm-5.3-flash"])
  // the provider's list, as magpie asks for it
  fakeAPI()
  const hooks = await CursorAuthPlugin()
  const listed = await hooks.provider.models({ models: {} }, { auth: fresh() })
  expect(Object.keys(listed)).toContain("glm-5.3")
  expect(Object.keys(listed)).toContain("glm-5.3-flash")
})

test("a picker Cursor can't give leaves the usable list as it was", async () => {
  fakeAPI({ pickerDown: true })
  const raw = await usable(fresh().access)
  expect(raw.map((m) => m.id)).toEqual(USABLE.map((m) => m.modelId))
  expect(raw.find((m) => m.id === "claude-opus-5-5-max").maxMode).toBe(true)
})

test("a Max Mode model is run in Max Mode, once, and a picker-only model with its parameters", async () => {
  fakeAPI()
  const auth = fresh()
  runs.length = 0
  let r = await ask(auth, "gpt-5.6-luna", "low")
  expect([r.status, r.body.error]).toEqual([200, undefined])
  expect(r.body.choices[0].message.content).toBe("hi")
  expect(runs).toEqual([{ model: "gpt-5.6-luna-low", detailsMax: 1, requested: "gpt-5.6-luna-low", requestedMax: 1, params: [] }])

  runs.length = 0
  r = await ask(auth, "glm-5.3")
  expect(r.status).toBe(200)
  expect(runs).toEqual([{ model: "glm-5.3", detailsMax: 0, requested: "glm-5.3", requestedMax: 0, params: [["thinking", "true"]] }])

  runs.length = 0
  r = await ask(auth, "composer-2.5")
  expect(r.status).toBe(200)
  expect(runs).toEqual([{ model: "composer-2.5", detailsMax: 0, requested: "composer-2.5", requestedMax: 0, params: [] }])
})

test("a model neither list says needs Max Mode is asked again in Max Mode when Cursor says so", async () => {
  // no picker: the usable list alone, which doesn't say it
  fakeAPI({ pickerDown: true })
  const auth = fresh()
  runs.length = 0
  let r = await ask(auth, "gpt-5.6-luna", "high")
  expect([r.status, r.body.error]).toEqual([200, undefined])
  expect(runs.map((x) => [x.model, x.detailsMax, x.requestedMax])).toEqual([["gpt-5.6-luna-high", 0, 0], ["gpt-5.6-luna-high", 1, 1]])
  // and from then on in Max Mode at once
  runs.length = 0
  r = await ask(auth, "gpt-5.6-luna", "high")
  expect(r.status).toBe(200)
  expect(runs.map((x) => [x.model, x.detailsMax])).toEqual([["gpt-5.6-luna-high", 1]])
})
