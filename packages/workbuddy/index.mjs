// OpenCode provider plugins for WorkBuddy's plans, Tencent's two builds of
// WorkBuddy (CodeBuddy's desktop agent):
//   - workbuddy:    the China build, copilot.tencent.com
//   - workbuddy-ai: the international build, www.workbuddy.ai
// A WorkBuddy account signs in in the browser (Tencent's page, polled for
// the token as WorkBuddy's desktop app does) or is taken from WorkBuddy
// desktop's own sign-in. Its chats are chat completions at <endpoint>/v2,
// streamed only, with WorkBuddy's headers: a request whose User-Agent isn't
// WorkBuddy/<version> is refused (error 10085).

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const APP_VERSION = "2.0.0" // the version WorkBuddy's sign-in page is opened with
const UA_VERSION = "5.5.6" // WorkBuddy/<this> is the User-Agent the API takes
const POLL_MS = 1000
const SIGN_IN_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000 // a token this close to its end is refreshed

// [id, name, context, efforts]
const CN_MODELS = [
  ["auto", "Auto", 168000],
  ["hy4-preview-f", "Hy4 preview", 1000000, ["high"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["hy3-x", "Hy3-X", 192000, ["low", "high"]],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["glm-5.1", "GLM-5.1", 200000],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000],
  ["minimax-m3", "MiniMax-M3", 512000],
  ["kimi-k3-1", "Kimi-K3", 1000000, ["low", "high", "xhigh"]],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", 1000000, ["none", "high", "xhigh"]],
]

const AI_MODELS = [
  ["default-model", "Default", 176000],
  ["fast-model", "Fast", 200000],
  ["balanced-model", "Balanced", 256000],
  ["primary-model", "Primary", 272000],
  ["deep-model", "Deep", 176000],
  ["gpt-5.5", "GPT-5.5", 1000000],
  ["gpt-5.4", "GPT-5.4", 272000],
  ["gpt-5.3-codex", "GPT-5.3-Codex", 272000],
  ["gemini-3.1-pro", "Gemini-3.1-Pro", 400000],
  ["gemini-3.5-flash", "Gemini-3.5-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["kimi-k3", "Kimi-K3", 1000000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["minimax-m3", "MiniMax-M3", 512000],
]

const SITES = {
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    endpoint: "https://copilot.tencent.com",
    authID: "workbuddy-desktop",
    platform: "workbuddy",
    ai: false,
    models: CN_MODELS,
  },
  "workbuddy-ai": {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    endpoint: "https://www.workbuddy.ai",
    authID: "workbuddy-desktop-ai",
    platform: "workbuddy-ai",
    ai: true,
    models: AI_MODELS,
  },
}

const NPM = "@ai-sdk/openai-compatible"
const hex = () => randomBytes(16).toString("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (site) => site.endpoint + "/v2"

// ---- WorkBuddy's API ------------------------------------------------------

class WBError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

// call makes a request of WorkBuddy's plugin API, which answers
// {code, msg, data}; a code but 0 is an error.
async function call(site, method, path, headers = {}, body) {
  const res = await fetch(site.endpoint + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "WorkBuddy/" + UA_VERSION,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || res.statusText
    throw new WBError(`${site.name}: ${why} (HTTP ${res.status}${env.code ? ", code " + env.code : ""})`, env.code, res.status)
  }
  if (env.code) throw new WBError(`${site.name}: ${env.msg || "error"} (${env.code})`, env.code, res.status)
  return env.data
}

function domainOf(site, a) {
  return a.domain || new URL(api(site)).host
}

// merge takes a token WorkBuddy gave (sign-in or refresh) into the
// stored sign-in, times given as at-ms or in-seconds.
function merge(a, got) {
  const now = Date.now()
  const out = { ...a, access: got.accessToken }
  if (got.refreshToken) out.refresh = got.refreshToken
  if (got.domain) out.domain = got.domain
  if (got.tokenType) out.tokenType = got.tokenType
  if (got.expiresAt > 0) out.expires = got.expiresAt
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = got.refreshExpiresAt
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + got.refreshExpiresIn * 1000
  return out
}

function stale(a) {
  return !!a.expires && Date.now() >= a.expires - EARLY_MS
}

// fresh is the sign-in with an access token that isn't about to end:
// refreshed (and saved) when it is. A refresh that fails, or a refresh
// token that has ended, leaves the access token there is.
async function fresh(site, client, a) {
  if (!stale(a)) return a
  const refreshable = a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt)
  if (!refreshable) {
    if (a.access) return a
    throw new Error(`this ${site.name} account is signed out; sign in again`)
  }
  try {
    const got = await call(site, "POST", "/v2/plugin/auth/token/refresh", {
      "X-Refresh-Token": a.refresh,
      "X-Auth-Refresh-Source": "plugin",
      "X-Domain": domainOf(site, a),
    }, {})
    if (!got?.accessToken) throw new Error(`${site.name} gave no refreshed token`)
    const next = merge(a, got)
    await client?.auth?.set?.({ path: { id: site.id }, body: next })
    return next
  } catch (e) {
    if (a.access) return a
    throw new Error(`${site.name} token refresh: ${e?.message ?? e}`)
  }
}

// sign sets on headers what WorkBuddy's desktop app sends with a chat.
function sign(site, a, headers) {
  headers.set("Authorization", "Bearer " + a.access)
  headers.set("X-User-Id", a.uid ?? "")
  headers.set("X-Domain", domainOf(site, a))
  headers.set("X-Product", "SaaS")
  headers.set("X-IDE-Type", "WorkBuddy")
  headers.set("User-Agent", "WorkBuddy/" + UA_VERSION)
  if (!site.ai) return
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("X-Agent-Intent", "craft")
  headers.set("X-Agent-Type", "main")
  headers.set("X-IDE-Name", "WorkBuddy")
  headers.set("X-IDE-Version", UA_VERSION)
  const conv = hex()
  if (!headers.has("X-Conversation-ID")) headers.set("X-Conversation-ID", conv)
  if (!headers.has("X-Conversation-Request-ID")) headers.set("X-Conversation-Request-ID", conv)
  const msg = hex()
  headers.set("X-Conversation-Message-ID", msg)
  headers.set("X-Request-ID", msg)
}

// withSystem gives a chat that doesn't open with a system message
// WorkBuddy's default one, as its app does.
function withSystem(body) {
  if (typeof body !== "string") return body
  try {
    const b = JSON.parse(body)
    if (!Array.isArray(b?.messages) || !b.messages.length || b.messages[0]?.role === "system") return body
    b.messages.unshift({ role: "system", content: "You are a helpful assistant." })
    return JSON.stringify(b)
  } catch {
    return body
  }
}

// ---- signing in -------------------------------------------------------------

// poll asks path until WorkBuddy answers with data, retrying the codes
// that mean "not yet".
async function poll(site, path, headers, retry, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${site.name} sign-in timed out`)
    try {
      const data = await call(site, "GET", path, headers)
      if (data && Object.keys(data).length) return data
    } catch (e) {
      if (!(retry.includes(e.code) || e.status === 408 || e.status === 429)) throw e
    }
    await sleep(POLL_MS)
  }
}

async function browserSignIn(site) {
  const state = await call(site, "POST", `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, {
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  }, {})
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} gave no sign-in page`)
  const url = new URL(state.authUrl)
  if (url.protocol !== "https:") throw new Error(`${site.name}'s sign-in page isn't https`)
  url.searchParams.set("version", APP_VERSION)
  url.searchParams.set("loginSessionId", hex())
  return {
    url: url.toString(),
    instructions: `Sign in to ${site.name} in the browser; this finishes by itself.`,
    method: "auto",
    async callback() {
      try {
        const deadline = Date.now() + SIGN_IN_MS
        const q = encodeURIComponent(state.state)
        const token = await poll(site, `/v2/plugin/auth/token?state=${q}`, {}, [11217], deadline)
        if (!token.accessToken) return { type: "failed" }
        let a = merge({}, token)
        const who = await poll(site, `/v2/plugin/login/account?state=${q}`, {
          Authorization: "Bearer " + a.access,
          "X-Domain": domainOf(site, a),
          "X-No-User-Id": "true",
          "X-No-Enterprise-Id": "true",
        }, [12151], deadline)
        a.uid = who.uid ?? ""
        return success(site, a, who.nickname || who.phoneNumber || who.uid)
      } catch {
        return { type: "failed" }
      }
    },
  }
}

function success(site, a, name) {
  return {
    type: "success",
    refresh: a.refresh ?? "",
    access: a.access,
    expires: a.expires ?? 0,
    accountId: name || site.name,
    uid: a.uid ?? "",
    domain: a.domain ?? "",
    ...(a.refreshExpiresAt ? { refreshExpiresAt: a.refreshExpiresAt } : {}),
    ...(a.tokenType ? { tokenType: a.tokenType } : {}),
  }
}

// desktopFile is where WorkBuddy's desktop app keeps its sign-in.
function desktopFile(site) {
  const home = homedir()
  const base =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension")
  return join(base, "Data", "Public", "auth", site.authID + ".info")
}

// readDesktop is WorkBuddy desktop's sign-in as the app keeps it now, null
// for none (or tokens the app keeps encrypted, which can't be read).
function readDesktop(site) {
  try {
    const f = JSON.parse(readFileSync(desktopFile(site), "utf8"))
    const t = f?.auth ?? {}
    if (typeof t.accessToken !== "string" || !t.accessToken || !f?.account?.uid) return null
    const now = Date.now()
    const acct = f.account
    return {
      access: t.accessToken,
      refresh: typeof t.refreshToken === "string" ? t.refreshToken : "",
      expires: t.expiresAt > 0 ? t.expiresAt : t.expiresIn > 0 ? now + t.expiresIn * 1000 : 0,
      refreshExpiresAt: t.refreshExpiresAt > 0 ? t.refreshExpiresAt : t.refreshExpiresIn > 0 ? now + t.refreshExpiresIn * 1000 : 0,
      domain: typeof t.domain === "string" ? t.domain : "",
      tokenType: typeof t.tokenType === "string" ? t.tokenType : "",
      uid: acct.uid,
      name: acct.nickname || acct.phoneNumber || acct.uid,
    }
  } catch {
    return null
  }
}

// desktopSignIn uses the account WorkBuddy desktop is signed in to: nothing
// is copied (a copied refresh token would be the app's and the plugin's
// both, and the first to use it would sign the other out); its file is
// read each time, as the app keeps it.
function desktopSignIn(site) {
  return {
    url: "",
    instructions: `Uses the account ${site.name} desktop is signed in to.`,
    method: "auto",
    async callback() {
      const d = readDesktop(site)
      if (!d) return { type: "failed" }
      return { type: "success", refresh: "", access: "", expires: 0, source: "desktop", accountId: d.name || site.name, uid: d.uid }
    },
  }
}

// desktopHeld is what a desktop sign-in was renewed to here, by site and
// account: kept in memory only, never written where the app keeps it.
const desktopHeld = new Map()

// current is the sign-in a stored auth names, fresh: WorkBuddy desktop's,
// read where it keeps it, or one kept here.
async function current(site, client, auth) {
  if (auth?.source !== "desktop") return fresh(site, client, auth)
  const d = readDesktop(site)
  if (!d) throw new Error(`${site.name} desktop isn't signed in`)
  const k = site.id + "|" + d.uid
  const h = desktopHeld.get(k)
  const a = await fresh(site, null, h && h.expires >= d.expires ? h : d)
  desktopHeld.set(k, a)
  return a
}

// ---- allowance ----------------------------------------------------------------

// STATUS_TEXT is Go's http.StatusText for the answers WorkBuddy gives.
const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  408: "Request Timeout", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  504: "Gateway Timeout" }

// meter asks the billing API as magpie's built-in did, its errors said
// the same: WorkBuddy's message, else its code, else the HTTP status.
async function meter(site, a, path) {
  const res = await fetch(site.endpoint + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "WorkBuddy/" + UA_VERSION,
      Authorization: "Bearer " + a.access, "X-User-Id": a.uid ?? "", "X-Domain": domainOf(site, a), "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy" },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  let env = {}
  try {
    env = JSON.parse(await res.text()) ?? {}
  } catch {}
  const code = Number.parseInt(env.code, 10) || 0
  if (!res.ok) {
    if (code) throw new Error(env.msg || `error ${code}`)
    if (env.msg) throw new Error(env.msg)
    throw new Error(STATUS_TEXT[res.status] ?? "")
  }
  if (code) throw new Error(env.msg || `error ${code}`)
  return env.data ?? null
}

// capacity is a capacity the billing API sends, as a string ("438.88")
// or now and then a number; empty is 0.
function capacity(v) {
  if (v == null || v === "") return 0
  if (typeof v === "number") return v
  const s = String(v)
  const n = Number(s)
  if (s.trim() !== s || Number.isNaN(n)) throw new Error(`strconv.ParseFloat: parsing ${JSON.stringify(s)}: invalid syntax`)
  return n
}

// compact is a count as magpie says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// usageOf is the account's credits, from its resource summary: the plan's
// credits used against what the cycle grants, as magpie's built-in said.
function usageOf(sum, plan) {
  const out = { plan: plan || (sum?.IsPaidUser ? "Pro" : "Free"), windows: [] }
  let total = 0, used = 0
  for (const p of sum?.Packages ?? []) {
    total += capacity(p?.CycleTotalCapacity)
    used += capacity(p?.CycleUsedCapacity)
  }
  if (total > 0) out.windows.push({ name: "Credits", used: (100 * used) / total, display: `${compact(used)} / ${compact(total)}` })
  return out
}

// ---- models -----------------------------------------------------------------

// variants are the reasoning levels as OpenCode gives them to the AI SDK.
function variants(efforts) {
  return Object.fromEntries((efforts ?? []).map((e) => [e, { reasoningEffort: e }]))
}

function configModels(site) {
  return Object.fromEntries(site.models.map(([id, name, context, efforts]) => [id, {
    name,
    limit: { context, output: 0 },
    tool_call: true,
    ...(efforts ? { reasoning: true, variants: variants(efforts) } : {}),
  }]))
}

function modelOf(site, provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: api(site), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
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
    variants: variants(m.efforts),
  }
}

// liveModels asks WorkBuddy's product config for the plan's models: the
// "cli" agent's list, each with its details. The CLI User-Agent picks
// WorkBuddy's config (a bare WorkBuddy/<v> gets CodeBuddy IDE's, no cli).
async function liveModels(site, a) {
  const headers = new Headers()
  sign(site, a, headers)
  headers.set("User-Agent", `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`)
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("Accept", "application/json")
  const res = await fetch(site.endpoint + "/v3/config", { headers, signal: AbortSignal.timeout(15000) })
  const env = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${site.name}'s config: HTTP ${res.status}`)
  if (env.code) throw new Error(`${site.name}'s config: ${env.msg} (${env.code})`)
  const cfg = env.data ?? {}
  const out = []
  for (const agent of cfg.agents ?? []) {
    if (agent.name !== "cli") continue
    for (const id of agent.models ?? []) {
      const d = (cfg.models ?? []).find((x) => x.id === id)
      const m = { id, name: d?.name || id }
      if (d) {
        m.context = d.maxInputTokens
        m.output = d.maxOutputTokens
        m.images = d.supportsImages === true
        const es = d.reasoning?.supportedEfforts ?? []
        if (es.length) {
          const canOff = d.reasoning?.canDisableThinking
          m.efforts = [...(!d.onlyReasoning && (canOff == null || canOff) ? ["none"] : []), ...es]
        }
      }
      out.push(m)
    }
  }
  // tell apart models the config names alike: deepseek-v4.1-flash and
  // deepseek-v4.1-flash-sg are both "Deepseek-V4.1-Flash"
  const first = new Map()
  for (const m of out) {
    const id = first.get(m.name)
    if (id === undefined) {
      first.set(m.name, m.id)
      continue
    }
    const rest = m.id.startsWith(id + "-") ? m.id.slice(id.length + 1) : ""
    m.name = `${m.name} (${rest ? rest.toUpperCase() : m.id})`
  }
  return out
}

// ---- the plugins --------------------------------------------------------------

function makePlugin(site) {
  return async ({ client }) => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[site.id] ??= {}
      const p = config.provider[site.id]
      p.name ??= site.name
      p.npm ??= NPM
      p.api ??= api(site)
      p.models = { ...configModels(site), ...(p.models ?? {}) }
    },
    provider: {
      id: site.id,
      // the account's own list, when it's signed in and WorkBuddy answers;
      // else the list above
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return provider.models
        try {
          const a = await current(site, client, auth)
          const ms = await liveModels(site, a)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, modelOf(site, provider, m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: site.id,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: api(site),
          apiKey: "",
          async fetch(input, init) {
            let a = await getAuth()
            if (a?.type !== "oauth") throw new Error(`${site.name} isn't signed in`)
            a = await current(site, client, a)
            const req = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            headers.delete("content-length")
            sign(site, a, headers)
            let body = init?.body
            if (body === undefined && req) body = await req.clone().text()
            return fetch(req ? req.url : input, { ...init, method: init?.method ?? req?.method, headers, body: withSystem(body) })
          },
        }
      },
      // the account's credits, as magpie's built-in showed them
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source)) return { error: "not signed in" }
        try {
          const a = await current(site, client, auth)
          // the meter has no /v2 prefix, on either site
          return usageOf(await meter(site, a, "/billing/meter/get-user-resource-summary"), auth.plan)
        } catch (e) {
          return { error: e?.message ?? String(e) }
        }
      },
      methods: [
        {
          type: "oauth",
          label: `${site.name} account (browser)`,
          authorize: () => browserSignIn(site),
        },
        {
          type: "oauth",
          label: `${site.name} desktop's sign-in`,
          authorize: async () => desktopSignIn(site),
        },
      ],
    },
  })
}

export const WorkBuddyAuthPlugin = makePlugin(SITES.workbuddy)
export const WorkBuddyAIAuthPlugin = makePlugin(SITES["workbuddy-ai"])

// for tests
export const _internal = { usageOf, desktopHeld }
