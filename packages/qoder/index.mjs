// Qoder's subscription (qoder.com) as an OpenCode provider plugin.
//
// Qoder is signed in to the way its desktop client is: a PKCE device flow
// (qoder.com's page, then a poll of openapi.qoder.sh for the device token),
// whose device token is traded for the job token the model calls use. The
// job token is refreshed with its refresh token before it runs out; Qoder
// spends a refresh token once, so the new pair is saved straight away.
//
// Qoder's models are served on the API its client talks to, api3.qoder.sh's
// agent_chat_generation SSE, signed with the client's COSY envelope and sent
// in its body codec. The fetch here takes the chat completion OpenCode sends,
// writes it as Qoder's request, and turns Qoder's reply back into one; tool
// calls Qoder writes as XML in its text are lifted out as tool calls.
//
// The protocol (endpoints, COSY envelope, body codec, device flow) is ported
// from magpie's internal/qoder, which ported it from CLIProxyAPI's qoder
// support (https://github.com/ufec/CLIProxyAPI, MIT).
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID, constants } from "node:crypto"

const ID = "qoder"
const CLIENT_ID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa"
const DEVICE_HOST = "https://qoder.com"
const OPENAPI = "https://openapi.qoder.sh"
const API = "https://api3.qoder.sh"
const REDIRECT = "qoder-app://"
const CHAT_URL = API + "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
const MODELS_URL = API + "/algo/api/v2/model/list?Encode=1"
const COSY_VERSION = "1.1.49"
const SIGN_IN_TIMEOUT = 15 * 60 * 1000
const REFRESH_LEAD = 5 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const CHAT = "@ai-sdk/openai-compatible"

// Qoder's embedded 1024-bit RSA key (from the client's cosy source): it wraps
// the per-request AES key of the COSY Authorization header.
const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

const QODER_SYS = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user."

const hexID = () => randomUUID().replaceAll("-", "")

// ---- the COSY envelope --------------------------------------------------------

// machineOS names the machine as Qoder's desktop clients do.
function machineOS() {
  const arch = { x64: "x86_64", ia32: "x86", arm64: "aarch64" }[process.arch] ?? process.arch
  return arch + "_" + process.platform
}

// userBlob is the account as the envelope carries it: AES-128-CBC under a
// fresh key that is its own IV, the key wrapped with Qoder's RSA key.
function userBlob(u) {
  const raw = JSON.stringify({ uid: u.uid, aid: "", name: u.name ?? "", email: u.email ?? "", security_oauth_token: u.access })
  const key = Buffer.from(hexID().slice(0, 16))
  const c = createCipheriv("aes-128-cbc", key, key)
  const info = Buffer.concat([c.update(raw, "utf8"), c.final()]).toString("base64")
  const wrapped = publicEncrypt({ key: RSA_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString("base64")
  return { info, key: wrapped }
}

// cosyHeaders signs a call to url whose body, in its wire form, is body.
function cosyHeaders(url, u, body, ts = Math.floor(Date.now() / 1000)) {
  if (!u?.machineId) throw new Error("Qoder: the account has no machine id; sign in again")
  const blob = userBlob(u)
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: hexID(), info: blob.info, cosyVersion: COSY_VERSION, ideVersion: "" }),
  ).toString("base64")
  let path = new URL(url).pathname
  if (path.startsWith("/algo")) path = path.slice(5)
  const sig = createHash("md5").update(`${payload}\n${blob.key}\n${ts}\n${body}\n${path}`).digest("hex")
  const m = u.machineId
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": "app",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientIp": m,
    "Cosy-ClientType": "10",
    "Cosy-Data-Policy": "disagree",
    "Cosy-Date": String(ts),
    "Cosy-Key": blob.key,
    "Cosy-MachineId": m,
    "Cosy-MachineToken": m,
    "Cosy-MachineType": "5",
    "Cosy-MachineOS": machineOS(),
    "Cosy-Scene": "app",
    "Cosy-User": u.uid,
    "Cosy-Version": COSY_VERSION,
    "Login-Version": "v2",
  }
}

// ---- the body codec -----------------------------------------------------------

// Base64 through the client's shuffled alphabet ('$' pads), then the first
// and last thirds swapped.
const ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"

function segmentEncode(bytes) {
  let s = ""
  let acc = 0
  let nb = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff
    nb += 8
    while (nb >= 6) {
      nb -= 6
      s += ALPHABET[(acc >> nb) & 63]
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63]
  while (s.length % 4) s += "$"
  return s
}

function swapThirds(s) {
  const t = Math.floor(s.length / 3)
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s
}

const encodeBody = (text) => swapThirds(segmentEncode(Buffer.from(text, "utf8")))

function decodeBody(wire) {
  const s = swapThirds(wire)
  const out = []
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== "$").map((c) => ALPHABET.indexOf(c))
    let x = 0
    for (const v of vals) x = x * 64 + v
    const n = Math.floor((6 * vals.length) / 8)
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255)
  }
  return Buffer.from(out).toString("utf8")
}

// ---- sign-in ------------------------------------------------------------------

const b64url = (buf) => buf.toString("base64url")

async function openapi(path, { method = "GET", token, body, query } = {}) {
  const url = new URL(OPENAPI + path)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  const headers = { Accept: "application/json" }
  if (body) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

// expiresAt is when a job token Qoder gave with expires_in (milliseconds)
// runs out; a day when it said none.
const expiresAt = (jt) => Date.now() + (jt.expires_in > 0 ? jt.expires_in : DAY)

async function deviceSignIn() {
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const nonce = randomUUID()
  const machineId = randomUUID()
  const q = new URLSearchParams({ challenge, challenge_method: "S256", nonce, machine_id: machineId, client_id: CLIENT_ID, redirect_uri: REDIRECT })
  const until = Date.now() + SIGN_IN_TIMEOUT
  return {
    url: `${DEVICE_HOST}/device/selectAccounts?${q}`,
    instructions: "Sign in to Qoder in the browser and authorize this device",
    method: "auto",
    async callback() {
      let dt
      for (;;) {
        if (Date.now() > until) throw new Error("Qoder: the sign-in timed out; start again")
        try {
          const r = await openapi("/api/v1/deviceToken/poll", { query: { nonce, verifier, challenge_method: "S256" } })
          if (r.status === 200 && String(r.json?.token ?? "").trim()) {
            dt = r.json
            break
          }
        } catch {} // a hiccup: ask again
        await new Promise((r) => setTimeout(r, 2000))
      }
      const jr = await openapi("/api/v1/me/jobToken", { method: "POST", token: dt.token, body: { clientId: CLIENT_ID } })
      if (jr.status !== 200) throw new Error(`Qoder job token: status ${jr.status}: ${jr.text.trim().slice(0, 300)}`)
      if (!String(jr.json?.token ?? "").trim()) throw new Error("Qoder job token: empty token in response")
      let email = ""
      let name = ""
      try {
        const ui = await openapi("/api/v1/userinfo", { token: dt.token })
        if (ui.status >= 200 && ui.status < 300) [email, name] = [ui.json?.email ?? "", ui.json?.name ?? ""]
      } catch {}
      return {
        type: "success",
        access: jr.json.token,
        refresh: jr.json.refresh_token ?? "",
        expires: expiresAt(jr.json),
        accountId: email || dt.user_id,
        uid: dt.user_id,
        email,
        name,
        machineId,
        deviceToken: dt.token,
        deviceRefresh: dt.refresh_token ?? "",
      }
    },
  }
}

class SignInGone extends Error {}

// refreshJob trades the job token's refresh token for a new pair; the old
// one is spent.
async function refreshJob(refresh) {
  if (!String(refresh ?? "").trim()) throw new SignInGone("Qoder: the sign-in lapsed; sign in again")
  const r = await openapi("/api/v1/jobToken/refresh", { method: "POST", body: { refresh_token: refresh } })
  if (r.status === 401 || r.status === 403) throw new SignInGone("Qoder: the sign-in has expired — sign in again")
  if (r.status !== 200) throw new Error(`Qoder job token refresh: status ${r.status}`)
  if (!String(r.json?.token ?? "").trim() || !String(r.json?.refresh_token ?? "").trim())
    throw new Error("Qoder job token refresh: incomplete token pair")
  return r.json
}

// ---- models -------------------------------------------------------------------

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
const EFF5 = ["low", "medium", "high", "xhigh", "max"]

// Qoder's list when the account's can't be asked (as it was on 2026-09-30).
const MODELS = [
  { id: "ultimate", name: "Ultimate", context: 1_000_000, efforts: EFF5 },
  { id: "performance", name: "Performance", context: 1_000_000, efforts: EFF5 },
  { id: "efficient", name: "Efficient", context: 200_000 },
  { id: "smodel", name: "Sonus", context: 180_000, efforts: EFF5 },
  { id: "cmodel", name: "Cantus", context: 180_000, efforts: EFF5 },
  { id: "qmodel_38max", name: "Qwen3.8-Max", context: 180_000, efforts: ["low", "medium", "xhigh"] },
  { id: "qfmodel", name: "Qwen3.8-Flash", context: 180_000, efforts: ["low", "medium", "xhigh"] },
  { id: "qmodel_latest", name: "Qwen3.7-Max", context: 1_000_000 },
  { id: "qmodel", name: "Qwen3.7-Plus", context: 1_000_000 },
  { id: "kmodel_latest", name: "Kimi-K3", context: 180_000, efforts: ["low", "high", "max"] },
  { id: "kmodel", name: "Kimi-K2.8-Preview", efforts: ["low", "high", "max"] },
  { id: "gmodel", name: "GLM-5.3", context: 180_000, efforts: ["low", "high", "max"] },
  { id: "gfmodel", name: "GLM-5.3-Flash", context: 1_000_000, efforts: ["high", "max"] },
  { id: "dmodel", name: "DeepSeek-V4-Pro", context: 1_000_000, efforts: ["high", "max"] },
  { id: "dfmodel", name: "DeepSeek-Flash", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "mmodel", name: "MiniMax-M3", context: 180_000 },
].map((m) => ({ images: true, ...m }))

// freeOf reads whether the listing marks a model free, as Qoder's client
// reads it (internal/qoder/models.go): is_free true, or a price_factor (the
// credits a request costs, as a multiple) of 0, either in snake or camel case.
function freeOf(raw) {
  const is = raw.is_free ?? raw.isFree
  const price = raw.price_factor ?? raw.priceFactor
  return is === true || (typeof price === "number" && price === 0)
}

// modelInfo reads one entry of the listing's "chat" array: its efforts and
// default from thinking_config (is_reasoning alone when it has none).
function modelInfo(raw) {
  const m = {
    key: raw.key,
    source: raw.source ?? "",
    name: raw.display_name || raw.key,
    images: !!raw.is_vl,
    context: raw.max_input_tokens || 0,
    thinks: !!raw.is_reasoning,
    alwaysThinks: false,
    efforts: Array.isArray(raw.reasoning_efforts) ? [...raw.reasoning_efforts] : [],
    defaultEffort: "",
    free: freeOf(raw),
    config: raw,
  }
  const tc = raw.thinking_config
  if (tc && typeof tc === "object") {
    m.thinks = tc.enabled != null
    m.alwaysThinks = m.thinks && tc.disabled == null
    m.efforts = []
    if (m.thinks) {
      for (const [name, e] of Object.entries(tc.enabled.efforts ?? {})) {
        m.efforts.push(name)
        if (e?.is_default) m.defaultEffort = name
      }
      const rank = (s) => (EFFORT_ORDER.includes(s) ? EFFORT_ORDER.indexOf(s) : EFFORT_ORDER.length)
      m.efforts.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    }
  }
  return m
}

// modelInfos is the listing's enabled chat models an agent can pick: "auto"
// and "default" route inside Qoder and aren't one model.
function modelInfos(listing) {
  return (listing?.chat ?? [])
    .filter((m) => m?.enable && !["", "auto", "default"].includes(String(m.key ?? "").trim()))
    .map(modelInfo)
}

async function fetchListing(cred) {
  const res = await fetch(MODELS_URL, { headers: cosyHeaders(MODELS_URL, cred, ""), signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`Qoder models: HTTP ${res.status}: ${text.trim().slice(0, 512)}`)
  return JSON.parse(text)
}

function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(m.efforts?.length ? { reasoning: true, variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])) } : {}),
    tool_call: true,
  }
}

function runtimeModel(m) {
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: API, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.efforts?.length,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries((m.efforts ?? []).map((e) => [e, { reasoningEffort: e }])),
    // magpie's own: served at no cost to the plan's credits
    free: !!m.free,
  }
}

// ---- the request --------------------------------------------------------------

const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

function fitEffort(want, levels) {
  if (want === "ultra" && !levels.includes(want)) want = "max"
  if (!levels.length || levels.includes(want)) return want
  const at = EFFORT_RANK.indexOf(want)
  if (at < 0) return want
  let best = want
  let dist = EFFORT_RANK.length
  for (const l of levels) {
    const i = EFFORT_RANK.indexOf(l)
    if (i < 0 || l === "none") continue
    const d = Math.abs(i - at)
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d]
  }
  return best
}

// effortFor is whether to think and at which of the model's efforts ("" for
// none): asked for none, a model that always thinks thinks at its lowest;
// asked for nothing, or a level Qoder doesn't name, at its own default.
function effortFor(asked, m) {
  let want = String(asked ?? "").toLowerCase()
  if (!EFFORT_RANK.includes(want)) want = ""
  if (!m.thinks || (want === "none" && !m.alwaysThinks)) return [false, ""]
  if (!m.efforts.length) return [true, ""]
  if (want === "") return [true, m.defaultEffort]
  if (want === "none") return [true, m.efforts[0]]
  return [true, fitEffort(want, m.efforts)]
}

function imageBlock(p) {
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url
  return url ? { type: "image_url", image_url: { url } } : null
}

function blocksOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  const out = []
  for (const p of content ?? []) {
    if (p?.type === "text" && p.text != null) out.push({ type: "text", text: p.text })
    else if (p?.type === "image_url") {
      const b = imageBlock(p)
      if (b) out.push(b)
    }
  }
  return out
}

const textOf = (c) => (typeof c === "string" ? c : blocksOf(c).filter((b) => b.type === "text").map((b) => b.text).join(""))

// qoderMessages is the chat's turns as Qoder takes them: text and image
// blocks, an assistant's tool calls as tool_calls, results as tool turns by
// tool_call_id. A tool turn holds text only, so the images a tool returned
// follow in a user turn — the start of the user's own when one comes next.
function qoderMessages(msgs) {
  const out = []
  const names = {}
  let seen = []
  const showSeen = () => {
    if (seen.length) out.push({ role: "user", content: seen })
    seen = []
  }
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role !== "user" && m.role !== "tool") showSeen()
    if (m.role === "tool") {
      let txt = textOf(m.content)
      const ims = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url").map(imageBlock).filter(Boolean) : []
      if (ims.length) {
        let of = "tool call " + m.tool_call_id
        const name = names[m.tool_call_id] || m.name
        if (name) of = `${name} (${of})`
        seen.push({ type: "text", text: `[From the result of ${of}:]` }, ...ims)
        const note = ims.length === 1 ? "[The tool returned an image; it follows in the next message.]" : `[The tool returned ${ims.length} images; they follow in the next message.]`
        txt = txt.trim() ? txt + "\n\n" + note : txt + note
      }
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: txt })
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        const id = c.id || "call_" + hexID()
        names[id] = c.function?.name
        const args = c.function?.arguments
        return { id, type: "function", function: { name: c.function?.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } }
      })
      out.push({ role: "assistant", content: textOf(m.content), tool_calls: calls })
      continue
    }
    let blocks = blocksOf(m.content)
    if (m.role === "assistant") blocks = blocks.filter((b) => b.type === "text")
    if (!blocks.length) continue
    if (m.role === "user" && seen.length) [blocks, seen] = [[...seen, ...blocks], []]
    out.push({ role: m.role, content: blocks })
  }
  showSeen()
  return out
}

// qoderBody is the plaintext agent_chat_generation takes for a chat
// completion request, for model m.
function qoderBody(chat, m) {
  const system = (chat.messages ?? []).filter((x) => x.role === "system" || x.role === "developer").map((x) => textOf(x.content)).filter(Boolean).join("\n\n")
  const tools = chat.tool_choice !== "none" ? (chat.tools ?? []).filter((t) => t?.type === "function" && t.function?.name) : []
  let sysText = system ? QODER_SYS + "\n\n" + system : QODER_SYS
  if (chat.tool_choice === "required" && tools.length) sysText += "\nYou must call an available function in this response."
  const sys = { type: "text", text: sysText }
  const [thinking, effort] = effortFor(chat.reasoning_effort, m)
  const params = { enable_thinking: thinking, max_tokens: chat.max_completion_tokens || chat.max_tokens || 32000 }
  if (effort) params.reasoning_effort = effort
  if (m.context > 0) params.context_length = m.context
  const body = {
    parameters: params,
    business: { product: "app", version: COSY_VERSION, type: "agent", id: hexID(), name: "magpie session", begin_at: Date.now(), stage: "start" },
    agent_id: "agent_common",
    task_id: "common",
    session_type: "app",
    model_config: m.config,
    system: [sys],
    messages: [{ role: "system", content: [sys] }, ...qoderMessages(chat.messages ?? [])],
  }
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} } },
    }))
  return body
}

// failure is the status and message for a Qoder failure: a refused sign-in
// asks for another, a quota is a 429.
function failure(status, text) {
  if (status < 400 || status > 599) status = 502
  let msg = String(text ?? "").trim()
  try {
    const j = JSON.parse(text)
    if (j?.message) msg = j.message
    const d = typeof j?.details === "string" ? JSON.parse(j.details) : null
    if (d?.error?.message) msg += ": " + d.error.message
  } catch {}
  msg ||= `HTTP ${status}`
  // only Qoder's 401 says the job token itself is refused; a 403 is kept as
  // what it is, as magpie marks the account lapsed on a 401
  if (status === 401 || status === 403) return { status, message: "the sign-in lapsed — sign in again" }
  if (status === 429 || msg.toLowerCase().includes("quota")) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg }
}

const errorResponse = ({ status, message }) =>
  new Response(JSON.stringify({ error: { message, type: "qoder_error", code: status } }), { status, headers: { "Content-Type": "application/json" } })

// ---- the reply ----------------------------------------------------------------

const CALL_OPEN = "\x3ctool_call\x3e"
const CALL_CLOSE = "\x3c/tool_call\x3e"
const FUNC = /\x3cfunction=([^>]+)\x3e([\s\S]*?)\x3c\/function\x3e/
const PARAM = /\x3cparameter=([^>]+)\x3e([\s\S]*?)\x3c\/parameter\x3e/g

// parseCall reads one tool-call block: JSON {name, arguments}, or the XML
// function/parameter form.
function parseCall(v) {
  try {
    const f = JSON.parse(v.trim())
    if (String(f?.name ?? "").trim() && f.arguments && typeof f.arguments === "object" && !Array.isArray(f.arguments))
      return { name: f.name.trim(), args: JSON.stringify(f.arguments) }
  } catch {}
  const m = FUNC.exec(v)
  if (!m || !m[1].trim()) return null
  const args = {}
  for (const pm of m[2].matchAll(PARAM)) {
    const key = pm[1].trim()
    if (!key) continue
    const val = pm[2].trim()
    try {
      args[key] = JSON.parse(val)
    } catch {
      args[key] = val
    }
  }
  return { name: m[1].trim(), args: JSON.stringify(args) }
}

// Splitter holds text until a whole tool-call block has come, then gives
// it as a call.
class Splitter {
  textBuf = ""
  callBuf = ""
  inCall = false
  sawTool = false
  feed(input) {
    const out = []
    while (input) {
      if (!this.inCall) {
        const comb = this.textBuf + input
        this.textBuf = ""
        const i = comb.indexOf(CALL_OPEN)
        if (i < 0) {
          let keep = 0
          for (let n = CALL_OPEN.length - 1; n > 0; n--)
            if (comb.endsWith(CALL_OPEN.slice(0, n))) {
              keep = n
              break
            }
          if (keep < comb.length) out.push({ text: comb.slice(0, comb.length - keep) })
          this.textBuf = comb.slice(comb.length - keep)
          break
        }
        if (i > 0) out.push({ text: comb.slice(0, i) })
        input = comb.slice(i + CALL_OPEN.length)
        this.inCall = true
        continue
      }
      const comb = this.callBuf + input
      this.callBuf = ""
      const j = comb.indexOf(CALL_CLOSE)
      if (j < 0) {
        this.callBuf = comb
        break
      }
      const c = parseCall(comb.slice(0, j))
      if (c) {
        this.sawTool = true
        out.push({ call: c })
      } else out.push({ text: CALL_OPEN + comb.slice(0, j) + CALL_CLOSE })
      input = comb.slice(j + CALL_CLOSE.length)
      this.inCall = false
    }
    return out
  }
  flush() {
    if (this.inCall) {
      const t = CALL_OPEN + this.callBuf
      this.inCall = false
      this.callBuf = ""
      return [{ text: t }]
    }
    if (this.textBuf) {
      const t = this.textBuf
      this.textBuf = ""
      return [{ text: t }]
    }
    return []
  }
}

async function* sseLines(body) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let n
    while ((n = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, n).trim()
      buf = buf.slice(n + 1)
    }
  }
  if (buf.trim()) yield buf.trim()
}

// events turns Qoder's SSE into chat completion pieces: each data line's
// envelope has a "body" that is an OpenAI chunk, whose content may hold
// tool calls to lift out.
async function* events(body) {
  const a = new Splitter()
  let index = -1 // the tool call being given
  let native = -1 // the native tool call being assembled
  const flushed = function* () {
    for (const f of a.flush()) if (f.text) yield { text: f.text }
  }
  let usage
  let fr = ""
  for await (const line of sseLines(body)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    let env
    try {
      env = JSON.parse(payload)
    } catch {
      continue
    }
    const inner = typeof env?.body === "string" ? env.body : ""
    if (env?.statusCodeValue != null && env.statusCodeValue !== 200) {
      yield { error: failure(Number(env.statusCodeValue), inner || payload) }
      return
    }
    let chunk
    try {
      chunk = JSON.parse(inner)
    } catch {
      continue
    }
    const delta = chunk?.choices?.[0]?.delta ?? {}
    if (delta.reasoning_content) yield { reasoning: delta.reasoning_content }
    if (typeof delta.content === "string")
      for (const f of a.feed(delta.content)) {
        if (f.call) yield { tool: { index: ++index, id: "call_" + hexID(), name: f.call.name, args: f.call.args } }
        else if (f.text) yield { text: f.text }
      }
    // tool calls served the OpenAI way keep Qoder's id: a result answers it
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0)
      if (i !== native) {
        native = i
        yield* flushed()
        a.sawTool = true
        yield { tool: { index: ++index, id: tc.id || "call_" + hexID(), name: tc.function?.name ?? "", args: tc.function?.arguments ?? "" } }
      } else if (tc.function?.arguments) yield { args: { index, text: tc.function.arguments } }
    }
    fr = chunk?.choices?.[0]?.finish_reason ?? ""
    if (fr) {
      const u = chunk.usage
      if (u) usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) }
      break
    }
  }
  yield* flushed()
  yield { stop: a.sawTool ? "tool_calls" : fr === "length" ? "length" : "stop", usage }
}

// answer turns Qoder's reply into the chat completion OpenAI's API gives.
// A failure before the answer keeps its status; one after it ends the
// stream with an error.
async function answer(res, chat) {
  const id = "chatcmpl-" + hexID()
  const created = Math.floor(Date.now() / 1000)
  const it = events(res.body)
  const first = await it.next()
  if (first.value?.error) return errorResponse(first.value.error)
  if (first.done) return errorResponse({ status: 502, message: "Qoder ended without an answer" })

  if (!chat.stream) {
    const msg = { role: "assistant", content: "" }
    let reasoning = ""
    const calls = []
    let stop = "stop"
    let usage
    for (let r = first; !r.done; r = await it.next()) {
      const e = r.value
      if (e.error) return errorResponse(e.error)
      if (e.text) msg.content += e.text
      if (e.reasoning) reasoning += e.reasoning
      if (e.tool) calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } })
      if (e.args) calls[calls.length - 1].function.arguments += e.args.text
      if (e.stop) [stop, usage] = [e.stop, e.usage]
    }
    if (reasoning) msg.reasoning_content = reasoning
    if (calls.length) msg.tool_calls = calls
    return Response.json({ id, object: "chat.completion", created, model: chat.model, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(usage ? { usage } : {}) })
  }

  const enc = new TextEncoder()
  const chunk = (delta, finish_reason = null, extra = {}) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  let pending = first
  let began = false
  const stream = new ReadableStream({
    async pull(ctl) {
      const r = pending ?? (await it.next())
      pending = null
      if (!began) {
        began = true
        ctl.enqueue(chunk({ role: "assistant", content: "" }))
      }
      if (r.done) {
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        return ctl.close()
      }
      const e = r.value
      if (e.text) ctl.enqueue(chunk({ content: e.text }))
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } }] }))
      else if (e.args) ctl.enqueue(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }))
      else if (e.stop) ctl.enqueue(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}))
      else if (e.error) {
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: e.error.message, code: e.error.status } })}\n\n`))
        ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

// ---- the plugin ---------------------------------------------------------------

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

// ---- usage --------------------------------------------------------------------
//
// The account's allowance as magpie's built-in Qoder account shows it
// (internal/provider/qoder_usage.go): the account pages' usage, asked with
// the device token (not the job token the chat runs on), which is rotated
// with its own refresh token once Qoder refuses it.

class UsageStatus extends Error {
  constructor(status) {
    super(`qoder usage: upstream HTTP ${status}`)
    this.status = status
  }
}

// fetchUsage is the usage envelope, {displayMode, qoderUsage}.
async function fetchUsage(deviceToken) {
  if (!String(deviceToken ?? "").trim()) throw new Error("qoder usage: missing device token")
  let res
  try {
    res = await fetch(OPENAPI + "/sash/api/v2/me/usage", {
      headers: { Accept: "application/json", Authorization: `Bearer ${deviceToken}`, "Cosy-ClientType": "10", "User-Agent": "Qoder" },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    throw new Error(`qoder usage: request failed: ${e?.message ?? e}`)
  }
  if (res.status !== 200) throw new UsageStatus(res.status)
  let env
  try {
    env = JSON.parse(await res.text())
  } catch (e) {
    throw new Error(`qoder usage: decode response: ${e?.message ?? e}`)
  }
  if (env?.displayMode !== "qoder" && env?.displayMode !== "enterprise") throw new Error("qoder usage: unknown display mode")
  if (env.displayMode === "qoder" && (env.qoderUsage === undefined || env.qoderUsage === null)) throw new Error("qoder usage: missing quota data")
  return env
}

// refreshDevice trades the device refresh token for a new pair; it rotates
// too, so the caller saves it.
async function refreshDevice(refresh) {
  if (!String(refresh ?? "").trim()) throw new Error("qoder device token refresh: missing refresh token; sign in again")
  let r
  try {
    r = await openapi("/api/v1/deviceToken/refresh", { method: "POST", body: { refresh_token: refresh } })
  } catch (e) {
    throw new Error(`qoder device token refresh: request failed: ${e?.message ?? e}`)
  }
  if (r.status !== 200) {
    const err = `qoder device token refresh: upstream HTTP ${r.status}`
    // the device token serves only the account pages (usage); chat runs on
    // the job token, so a refused one doesn't lapse the account
    if (r.status === 401 || r.status === 403)
      throw new Error(`Qoder usage is unavailable: Qoder refused the account-page sign-in (chat still works) — sign in again to see usage (${err})`)
    throw new Error(err)
  }
  const token = r.json?.token || r.json?.device_token || ""
  if (!String(token).trim() || !String(r.json?.refresh_token ?? "").trim()) throw new Error("qoder device token refresh: incomplete token pair")
  return { token, refresh: r.json.refresh_token }
}

// gfmt is a number as Go's %g writes it.
function gfmt(n) {
  const [m, e] = n.toExponential().split("e")
  const x = Number(e)
  if (x < -4 || x >= 6) return `${m}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`
  return String(n)
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i

// when is a time Qoder gives: an RFC 3339 string, else seconds or
// milliseconds, as a number or its text.
function when(v) {
  if (typeof v === "string" && RFC3339.test(v) && !isNaN(Date.parse(v))) return new Date(v).toISOString()
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN
  if (!isFinite(n) || n <= 0) return undefined
  return new Date(Math.trunc(n < 1e12 ? n * 1000 : n)).toISOString()
}

// parseUsage is the plan and each pool of credits the envelope tells.
function parseUsage(env) {
  if (env.displayMode === "enterprise") return { plan: "Enterprise" }
  const u = env.qoderUsage
  if (env.displayMode !== "qoder" || !u || typeof u !== "object" || Array.isArray(u)) return { error: "Qoder: missing quota data" }
  const field = (a, b) => (u[a] !== undefined ? u[a] : u[b])
  const out = { windows: [] }
  const plan = field("userType", "user_type")
  if (typeof plan === "string") out.plan = plan
  const until = when(field("expiresAt", "expires_at"))
  if (until) out.until = until
  const num = (v) => v === undefined || v === null || typeof v === "number"
  const str = (v) => v === undefined || v === null || typeof v === "string"
  const add = (b, name) => {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return
    if (![b.total, b.cap, b.used, b.remaining].every(num) || !str(b.name) || !str(b.unit)) return
    const total = b.total ?? b.cap
    if (total == null || total <= 0 || (b.used == null && b.remaining == null)) return
    const used = b.used != null ? b.used : total - b.remaining
    if (used < 0) return
    out.windows.push({ name: b.name || name, used: Math.min(100, (100 * used) / total), display: `${gfmt(used)} / ${gfmt(total)} ${b.unit || "credits"}` })
  }
  add(field("userQuota", "user_quota"), "Credits")
  add(field("addOnQuota", "add_on_quota"), "Add-on credits")
  add(field("orgResourcePackage", "org_resource_package"), "Shared credits")
  const dedicated = field("dedicatedResourcePackages", "dedicated_resource_packages")
  for (const b of Array.isArray(dedicated) ? dedicated : []) add(b, "Dedicated credits")
  return out
}

export async function QoderAuthPlugin({ client }) {
  // serializes checking, rotating and saving tokens: a refresh token is
  // spent once, so two refreshes would spend it twice
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  // each account's listing, the model configs a request carries
  const listings = new Map()

  // fresh is the account with a live job token, refreshed and saved near
  // its end.
  const fresh = (getAuth) =>
    locked(async () => {
      const a = await getAuth()
      if (a?.type !== "oauth" || !a.access || !a.uid) throw new SignInGone("Qoder: not signed in")
      if (a.expires - Date.now() > REFRESH_LEAD) return a
      const jt = await refreshJob(a.refresh)
      const next = { ...a, access: jt.token, refresh: jt.refresh_token, expires: expiresAt(jt) }
      await client.auth.set({ path: { id: ID }, body: next })
      return next
    })

  const models = async (cred, again = false) => {
    let l = listings.get(cred.uid)
    if (!l || again) {
      l = modelInfos(await fetchListing(cred))
      listings.set(cred.uid, l)
    }
    return l
  }

  // deviceToken is a device token newer than the one Qoder just refused:
  // the one saved since, else a rotated one, saved.
  const deviceToken = (getAuth, attempted) =>
    locked(async () => {
      const a = await getAuth()
      if (a?.deviceToken !== attempted) return a?.deviceToken
      const dt = await refreshDevice(a.deviceRefresh)
      await client.auth.set({ path: { id: ID }, body: { ...a, deviceToken: dt.token, deviceRefresh: dt.refresh } })
      return dt.token
    })

  // usage is the account's allowance, magpie's own hook
  const usage = async (getAuth) => {
    try {
      const cred = await fresh(getAuth)
      let env
      try {
        env = await fetchUsage(cred.deviceToken)
      } catch (e) {
        if (!(e instanceof UsageStatus) || (e.status !== 401 && e.status !== 403)) throw e
        env = await fetchUsage(await deviceToken(getAuth, cred.deviceToken))
      }
      return parseUsage(env)
    } catch (e) {
      return { error: e?.message ?? String(e) }
    }
  }

  const signedInError = (e) =>
    errorResponse({ status: e instanceof SignInGone ? 401 : 502, message: String(e?.message ?? e).replace(/^Qoder: /, "") })

  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        return {
          baseURL: API,
          apiKey: "qoder",
          // every chat completion written as Qoder's own request
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname))
              return errorResponse({ status: 404, message: "only chat completions are served" })
            let chat
            try {
              chat = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse({ status: 400, message: "a request that isn't JSON" })
            }
            let cred
            try {
              cred = await fresh(getAuth)
            } catch (e) {
              return signedInError(e)
            }
            let m
            try {
              m = (await models(cred)).find((x) => x.key === chat.model) ?? (await models(cred, true)).find((x) => x.key === chat.model)
            } catch (e) {
              return errorResponse({ status: 502, message: e.message })
            }
            if (!m) return errorResponse({ status: 400, message: `unknown or disabled model "${chat.model}"` })
            const wire = encodeBody(JSON.stringify(qoderBody(chat, m)))
            const headers = {
              ...cosyHeaders(CHAT_URL, cred, wire),
              Accept: "text/event-stream",
              "Cache-Control": "no-cache",
              "X-Model-Key": m.key,
              "X-Model-Source": m.source,
            }
            let res
            try {
              res = await fetch(CHAT_URL, { method: "POST", headers, body: wire, signal: init.signal })
            } catch (e) {
              return errorResponse({ status: 502, message: e.message })
            }
            if (!res.ok) return errorResponse(failure(res.status, (await res.text()).slice(0, 1 << 20)))
            return answer(res, chat)
          },
        }
      },
      methods: [{ type: "oauth", label: "Sign in with Qoder", authorize: deviceSignIn }],
      usage,
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Qoder",
        npm: CHAT,
        api: API,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    // the account's own list, as Qoder's client asks it
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "oauth") return provider.models
        try {
          const cred = await fresh(async () => auth)
          const ms = await models(cred, true)
          if (!ms.length) return provider.models
          return Object.fromEntries(
            ms.map((m) => [m.key, runtimeModel({ id: m.key, name: m.name, context: m.context, images: m.images, efforts: m.thinks ? m.efforts : [], free: m.free })]),
          )
        } catch {
          return provider.models
        }
      },
    },
  }
}

// for tests
export const _internal = { parseUsage, gfmt, when, failure, modelInfo }
