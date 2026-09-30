// ZCode's GLM Coding Plan, as an OpenCode provider plugin.
//
// ZCode (zcode.z.ai) signs in to a Z.ai account, or a BigModel (智谱,
// bigmodel.cn) one, through a flow zcode.z.ai opens and is polled for. With
// the account's sign-in it finds or makes the coding plan key it uses (the
// key named zcode-api-key in the account's default project) and sends the
// models' requests, Anthropic's Messages, to the plan's endpoint:
// api.z.ai/api/anthropic or open.bigmodel.cn/api/anthropic.
//
// An account with no plan of its own may have a seat on a team's plan (a
// project of type 2, and its zcode-team-api-key), or ZCode's free Start
// Plan, served by zcode.z.ai itself to ZCode's own session token (a JWT
// that can't be refreshed: when it runs out, sign in again).
//
// The sign-in is kept as OpenCode keeps an OAuth one: `access` is the key,
// `refresh` the rest of it as JSON (site, base, key, jwt, team project,
// plan, device id), `accountId` the account's email.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "zcode"
const ZCODE = "https://zcode.z.ai"
const ZAI_API = "https://api.z.ai"
const BIGMODEL_API = "https://bigmodel.cn" // BigModel's business API, where ZCode asks it
const ZAI_BASE = "https://api.z.ai/api/anthropic"
const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic"
const START_BASE = ZCODE + "/api/v1/zcode-plan/anthropic"
const APP_VERSION = "3.14.3" // the ZCode whose sign-in this makes
const UA = "ZCode/" + APP_VERSION

// ZCode's models before its config is read; the Start Plan has all but GLM-5.3.
const MODELS = [
  { id: "GLM-5.3", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.3-Flash", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.2", context: 1_000_000, output: 128_000, efforts: ["none", "high", "max"] },
  { id: "GLM-5-Turbo", context: 200_000, output: 64_000, efforts: ["none", "high"] },
]
const START_MODELS = MODELS.filter((m) => m.id !== "GLM-5.3")
const OUTPUT = 131_072 // when ZCode's config names none

const SITES = {
  zai: { name: "Z.ai", api: ZAI_API, base: ZAI_BASE, subscribe: "z.ai/subscribe" },
  bigmodel: { name: "BigModel", api: BIGMODEL_API, base: BIGMODEL_BASE, subscribe: "bigmodel.cn/glm-coding" },
}
const siteOf = (s) => (s === "bigmodel" ? "bigmodel" : "zai")

const platform = () => `${process.platform}-${process.arch}` // darwin-arm64, win32-x64, linux-x64, as ZCode names them
const uuid = () => crypto.randomUUID()
const anyDevice = uuid() // X-Device-Mid for calls made signed out (the model list)
const first = (...ss) => ss.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? ""

class ZError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// call asks one of Z.ai's JSON endpoints, which wrap what they say in
// {code, msg, data}: a code of 0 or 200 is a success. zcode.z.ai is told
// the machine's id (X-Device-Mid), as ZCode tells it.
async function call(method, url, { auth, body, headers, device, signal } = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA }
  if (auth) h.Authorization = auth
  if (url.startsWith(ZCODE + "/")) h["X-Device-Mid"] = device || anyDevice
  Object.assign(h, headers ?? {})
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal })
  const text = await res.text()
  let env
  try {
    env = JSON.parse(text)
  } catch {}
  const code = env?.code == null ? "" : String(env.code)
  if (!res.ok) {
    if (env?.msg) throw new ZError(code && code !== "0" ? `${env.msg} (${res.status}, code ${code})` : `${env.msg} (${res.status})`, res.status)
    throw new ZError(`${res.status} ${res.statusText}`.trim(), res.status)
  }
  if (!env || typeof env !== "object") throw new ZError("not JSON", res.status)
  if (code && code !== "0" && code !== "200") throw new ZError(env.msg || `error ${code}`, res.status)
  return env.data ?? null
}

// ---- the account's plan ----------------------------------------------------------

const rootOf = (base) => {
  try {
    const u = new URL(base)
    return `${u.protocol}//${u.host}`
  } catch {
    return ZAI_API
  }
}
const isTeam = (s) => !!(s.org && s.project)

// plan names the coding plan a key has, "" for none.
async function plan(s) {
  const subs = (await call("GET", rootOf(s.base) + "/api/biz/subscription/list", { auth: s.key })) ?? []
  return (Array.isArray(subs) ? subs : []).find((x) => String(x.status).toUpperCase() === "VALID")?.productName ?? ""
}

function jwtExpiry(jwt) {
  const p = String(jwt ?? "").split(".")
  if (p.length !== 3) return 0
  try {
    const claims = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8"))
    return Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : 0
  } catch {
    return 0
  }
}
const jwtExpired = (jwt) => {
  const t = jwtExpiry(jwt)
  return t > 0 && Date.now() > t
}
const EXPIRED = "ZCode's sign-in has expired; sign in again"

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

// startPlan is the Start Plan the account has now ({name, until}), as
// ZCode reads its balance: an "active" plan past its end is over.
async function startPlan(jwt, device) {
  if (!jwt) throw new Error("not signed in to ZCode")
  if (jwtExpired(jwt)) throw new Error(EXPIRED)
  const b = (await call("GET", `${ZCODE}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, { auth: "Bearer " + jwt, device })) ?? {}
  const now = num(b.server_time) > 0 ? num(b.server_time) : Date.now() / 1000
  const isStart = (x) => x.includes("start-plan") || x.includes("start plan")
  for (const p of b.plans ?? []) {
    if (String(p.status ?? "").trim().toLowerCase() !== "active") continue
    const end = num(p.ends_at)
    if (end > 0 && end <= now) continue
    const id = String(p.plan_id ?? "").trim().toLowerCase()
    const n = String(p.name ?? "").trim().toLowerCase()
    if ((id || n) && !isStart(id) && !isStart(n)) continue
    return { name: first(p.name, "Start Plan"), until: end > 0 ? end * 1000 : 0 }
  }
  return null
}

// onStart says whether an account's requests go to the Start Plan: when it
// has ZCode's token and no coding plan key, or a key whose account has no
// coding plan. Asked again after 10 minutes (a minute when unsure).
const routes = new Map()
async function onStart(s) {
  if (!s.jwt || isTeam(s)) return false // a team's seat is on the team's plan
  if (!s.key) return true
  const id = s.key + "\0" + s.jwt
  const r = routes.get(id)
  if (r && Date.now() - r.at < r.ttl) return r.start
  let start = false
  let sure = false
  try {
    start = !(await plan(s))
    sure = true
  } catch {
    try {
      if (await startPlan(s.jwt, s.device)) start = sure = true
    } catch {}
  }
  routes.set(id, { start, at: Date.now(), ttl: sure ? 600_000 : 60_000 })
  return start
}

// ---- keys ------------------------------------------------------------------------

function teamHeaders(base, org, project) {
  return {
    "Bigmodel-Organization": org,
    "Bigmodel-Project": project,
    "Set-Language": base.includes("bigmodel.cn") ? "zh" : "en",
    "Accept-Language": "en-US,en",
  }
}

const keysURL = (root, org, project) =>
  `${root}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`

// projectKey finds the project's key named want.name (of want.keyType, when
// given), makes it when it isn't there and reads its secret: `<id>.<secret>`.
async function projectKey(site, keys, auth, headers, want) {
  const name = SITES[site].name
  let list
  try {
    list = (await call("GET", keys, { auth, headers })) ?? []
  } catch (e) {
    throw new Error(`${name} API keys: ${e.message}`)
  }
  const typed = "keyType" in want
  let id = ""
  for (const k of Array.isArray(list) ? list : []) {
    if (k.name === want.name && (!typed || String(k.keyType) === String(want.keyType)) && first(k.apiKey)) id = first(k.apiKey)
  }
  if (!id) {
    try {
      id = first((await call("POST", keys, { auth, headers, body: want }))?.apiKey)
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`)
    }
  }
  let secret = ""
  if (id) {
    try {
      secret = first((await call("GET", `${keys}/copy/${encodeURIComponent(id)}`, { auth, headers }))?.secretKey)
    } catch (e) {
      throw new Error(`${name} API key: ${e.message}`)
    }
  }
  if (id && !secret && typed) return id // a team's key with no secret goes as it is
  if (!id || !secret) throw new Error(`${name} gave no API key`)
  return `${id}.${secret}`
}

// teamKey is a team seat's key when the sign-in kept none.
const teamKeys = new Map()
async function teamKey(s) {
  if (s.key) return s.key
  const id = [s.token, s.org, s.project].join("\0")
  const got = teamKeys.get(id)
  if (got && (!got.err || Date.now() - got.at < 60_000)) {
    if (got.err) throw got.err
    return got.key
  }
  const site = s.base.includes("bigmodel.cn") ? "bigmodel" : "zai"
  try {
    const key = await projectKey(site, keysURL(SITES[site].api, s.org, s.project), s.token, teamHeaders(s.base, s.org, s.project), { name: "zcode-team-api-key", keyType: 2 })
    teamKeys.set(id, { key, at: Date.now() })
    return key
  } catch (e) {
    const err = new Error(`ZCode's team plan: ${e.message} — sign in again`)
    teamKeys.set(id, { err, at: Date.now() })
    throw err
  }
}

// ---- signing in ------------------------------------------------------------------

// bizAuth is the Authorization a sign-in gives the business API: Z.ai's
// token exchanged for a business one, as a Bearer; BigModel's goes bare.
async function bizAuth(site, token) {
  if (site === "bigmodel") return token
  let biz
  try {
    biz = await call("POST", ZAI_API + "/api/auth/z/login", { body: { token } })
  } catch (e) {
    throw new Error(`Z.ai sign-in: ${e.message}`)
  }
  if (!biz?.access_token) throw new Error("Z.ai sign-in: no token")
  return "Bearer " + biz.access_token
}

// mintKey is the account's own coding plan key, in its default project
// ("默认机构" / "默认项目", else the first), and the plan it has.
async function mintKey(site, root, auth, info) {
  let org = ""
  let proj = ""
  for (const o of info?.organizations ?? []) {
    const ps = (o.projects ?? []).filter((p) => p.projectId && String(p.projectType) !== "2")
    if (!o.organizationId || !ps.length) continue
    const def = (ps.find((p) => String(p.projectName ?? "").includes("默认项目")) ?? ps[0]).projectId
    const named = String(o.organizationName ?? "").includes("默认机构")
    if (!org || named) {
      org = o.organizationId
      proj = def
      if (named) break
    }
  }
  if (!org) throw new Error(`this ${SITES[site].name} account has no project for an API key`)
  const key = await projectKey(site, keysURL(root, org, proj), auth, undefined, { name: "zcode-api-key" })
  const s = { key, base: SITES[site].base }
  try {
    return { s, plan: await plan(s) }
  } catch (e) {
    throw new Error(`GLM Coding Plan: ${e.message}`)
  }
}

// teamSignIn is the account's seat on a team's plan: the first team project
// whose plan is in force and gives it a seat, and that project's key.
async function teamSignIn(site, root, auth, info) {
  const base = SITES[site].base
  const ps = []
  for (const o of info?.organizations ?? [])
    for (const p of o.projects ?? []) if (o.organizationId && p.projectId && String(p.projectType) === "2") ps.push({ org: o.organizationId, project: p.projectId })
  if (!ps.length) return { err: "no team plan", none: true }
  let why = ""
  let last = ""
  for (const p of ps) {
    let d
    try {
      d = (await call("GET", root + "/api/biz/team/subscribe/product/querySubscribeDetail", { auth, headers: teamHeaders(base, p.org, p.project) })) ?? {}
    } catch (e) {
      last = e.message
      continue
    }
    const status = String(d.status ?? "").toUpperCase()
    const grant = String(d.memberGrantStatus ?? "").toUpperCase()
    if (!(d.hasSubscription !== false && status === "EFFECTIVE" && grant === "VALID")) {
      if (!why && status === "EFFECTIVE" && grant === "UNASSIGNED")
        why = `this ${SITES[site].name} account is in a team with a GLM Coding Plan but has no seat on it yet — ask the team's admin to give it one, then sign in again`
      if (!why && status === "EXPIRED") why = `the ${SITES[site].name} team's GLM Coding Plan this account is in has expired`
      continue
    }
    let key
    try {
      key = await projectKey(site, keysURL(root, p.org, p.project), auth, teamHeaders(base, p.org, p.project), { name: "zcode-team-api-key", keyType: 2 })
    } catch (e) {
      return { err: `the team's GLM Coding Plan: ${e.message}`, why: `the team's GLM Coding Plan: ${e.message}` }
    }
    return { s: { key, base, token: auth, org: p.org, project: p.project }, plan: first(d.productName, "GLM Coding Team") }
  }
  if (why) return { err: why, why }
  const err = `the team's GLM Coding Plan: ${last || "no seat on it"}`
  return { err, why: err }
}

// signedIn is what a sign-in gives: the account's coding plan key and plan;
// or, with none of its own, a seat on a team's plan; or else ZCode's token
// for its Start Plan while the account has one.
async function signedIn(site, token, jwt, device) {
  const name = SITES[site].name
  const root = SITES[site].api
  let s = null
  let err = null
  let team = ""
  try {
    const auth = await bizAuth(site, token)
    let info
    try {
      info = await call("GET", root + "/api/biz/customer/getCustomerInfo", { auth })
    } catch (e) {
      throw new Error(`${name} account: ${e.message}`)
    }
    const own = await mintKey(site, root, auth, info).catch((e) => ({ e }))
    if (own.e) err = own.e
    else if (own.plan) return { ...own.s, jwt, plan: own.plan }
    else s = own.s
    const t = await teamSignIn(site, root, auth, info)
    if (t.s) return { ...t.s, jwt, plan: t.plan }
    team = t.why ?? ""
  } catch (e) {
    err = e
  }
  let berr = null
  if (jwt) {
    try {
      const sp = await startPlan(jwt, device)
      if (sp) return { ...(err || !s?.key ? { base: SITES[site].base } : s), jwt, plan: sp.name }
    } catch (e) {
      berr = e
    }
  }
  if (team && berr) throw new Error(`${team}; ZCode's Start Plan: ${berr.message}`)
  if (team) throw new Error(team)
  if (err && berr) throw new Error(`${err.message}; ZCode's Start Plan: ${berr.message}`)
  if (err) throw err
  if (berr) throw new Error(`this ${name} account has no GLM Coding Plan, of its own or a team's, and ZCode's Start Plan could not be read: ${berr.message}`)
  throw new Error(
    `this ${name} account has no GLM Coding Plan, of its own or a team's, and ZCode's Start Plan has ended or was never started — subscribe at ${SITES[site].subscribe}, then sign in again`,
  )
}

const who = (u) => first(String(u?.email ?? "").replace(/@phone\.local$/, ""), u?.name, u?.user_id, "ZCode")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// authorize opens ZCode's sign-in flow on site; its callback polls it.
async function authorize(site, log) {
  const poll = "Bearer " + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
  const device = uuid()
  let flow
  try {
    flow = await call("POST", ZCODE + "/api/v1/oauth/cli/init", { auth: poll, body: { provider: site }, device })
  } catch (e) {
    throw new Error(`ZCode sign-in: ${e.message}`)
  }
  let u
  try {
    u = new URL(flow?.authorize_url)
  } catch {}
  if (!flow?.flow_id || u?.protocol !== "https:") throw new Error("ZCode gave no sign-in page")
  // where Z.ai or BigModel sends the browser back, as ZCode sets it (BigModel's page names it redirect)
  const back = `${ZCODE}/app/oauth/login?` + new URLSearchParams({ redirect: "zcode://oauth/callback", app_version: APP_VERSION })
  u.searchParams.set(site === "bigmodel" ? "redirect" : "redirect_uri", back)
  const interval = Math.max(Number(flow.poll_interval_sec) || 0, 1) * 1000
  const deadline = Number(flow.expires_at) > 0 ? Number(flow.expires_at) * 1000 : Date.now() + 5 * 60_000
  return {
    url: u.toString(),
    instructions: `Sign in to ${SITES[site].name} in the browser; this finishes on its own.`,
    method: "auto",
    async callback() {
      const fail = (msg) => (log(msg), { type: "failed" })
      for (;;) {
        await sleep(interval)
        if (Date.now() > deadline) return fail("the sign-in expired; start again")
        let got
        try {
          got = (await call("GET", `${ZCODE}/api/v1/oauth/cli/poll/${encodeURIComponent(flow.flow_id)}`, { auth: poll, device })) ?? {}
        } catch (e) {
          if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return fail("ZCode sign-in: " + e.message)
          continue // a hiccup: ask again
        }
        const token = site === "bigmodel" ? first(got.bigmodel?.access_token, got.bigmodel?.accessToken) : first(got.zai?.access_token)
        if (got.status === "pending" || !got.status) continue
        if (got.status === "failed") return fail(`the sign-in was declined on ${SITES[site].name}`)
        if (got.status !== "ready" || !token) return fail("ZCode sign-in: unexpected answer " + got.status)
        let s
        try {
          s = await signedIn(site, token, first(got.token), device)
        } catch (e) {
          return fail(e.message)
        }
        const state = { site, device, ...s }
        return {
          type: "success",
          refresh: JSON.stringify(state),
          access: s.key || s.jwt || "",
          // the key doesn't run out; ZCode's token, when it is all there is, does
          expires: s.key || isTeam(s) ? 0 : jwtExpiry(s.jwt),
          accountId: who(got.user),
        }
      }
    },
  }
}

// stateOf is a stored sign-in as the requests need it.
function stateOf(auth) {
  if (auth?.type === "oauth") {
    let s = {}
    try {
      s = JSON.parse(auth.refresh)
    } catch {}
    const site = siteOf(s.site)
    return { ...s, site, base: s.base || SITES[site].base, key: s.key ?? (s.jwt ? "" : auth.access), device: s.device || anyDevice }
  }
  if (auth?.type === "api") {
    const site = siteOf(auth.metadata?.site)
    return { site, base: SITES[site].base, key: String(auth.key ?? "").trim(), device: anyDevice }
  }
  return null
}

// ---- models ----------------------------------------------------------------------

// planID is ZCode's providerId for the plan served at base; a team's plan
// has the individual one's models.
const planID = (base) =>
  base.includes("/zcode-plan/")
    ? "account:zai-start-plan"
    : base.includes("bigmodel.cn")
      ? "account:bigmodel-individual-coding-plan"
      : "account:zai-individual-coding-plan"

const efforts = (vs) => [...new Set(vs.map((v) => (v === "disabled" ? "none" : v === "enabled" ? "high" : v)))]

// modelsOf is a plan's models in ZCode's provider config.
function modelsOf(cfg, plan) {
  const c = cfg?.config ?? {}
  const ids = []
  const on = new Set()
  const add = (id) => {
    if (!on.has(id.toLowerCase())) on.add(id.toLowerCase()), ids.push(id)
  }
  for (const r of c.providerConfigRules?.providerRules ?? []) if (r.providerId === plan) (r.builtinModelIds ?? []).forEach(add)
  const off = new Set()
  for (const r of c.modelConfigRules?.builtinProviderModelRules ?? []) {
    if (r.providerId !== plan) continue
    if (r.config?.enabled === false) off.add(String(r.modelId).toLowerCase())
    else add(r.modelId)
  }
  const out = []
  for (const id of ids) {
    if (off.has(id.toLowerCase())) continue
    const m = { id, context: 0, output: 0, efforts: [] }
    for (const r of c.modelConfigRules?.modelRules ?? []) {
      let re
      try {
        re = new RegExp(`^(?:${r.modelMatch})$`, "i")
      } catch {
        continue
      }
      if (!re.test(id)) continue
      const x = r.config ?? {}
      if (x.properties?.contextWindow > 0) m.context = x.properties.contextWindow
      if (x.optionSpecs?.maxOutputTokens?.max > 0) m.output = x.optionSpecs.maxOutputTokens.max
      if (typeof x.properties?.inputFormat?.supportsImage === "boolean") m.image = x.properties.inputFormat.supportsImage
      if (x.optionSpecs?.reasoningLevel?.values?.length) m.efforts = efforts(x.optionSpecs.reasoningLevel.values)
    }
    out.push(m)
  }
  return out
}

// localConfig is the latest provider config an installed ZCode has.
function localConfig() {
  const files = []
  const rt = join(homedir(), ".zcode", "v2", "runtime", "provider")
  const walk = (dir, depth) => {
    let es = []
    try {
      es = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (depth < 3 && e.isDirectory()) walk(join(dir, e.name), depth + 1)
      else if (depth === 3 && e.name === "zcode-builtin.json") files.push(join(dir, e.name))
    }
  }
  walk(rt, 0)
  if (process.platform === "darwin") files.push("/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json")
  let best = null
  for (const f of files) {
    try {
      if (!existsSync(f)) continue
      const b = JSON.parse(readFileSync(f, "utf8"))
      if (!best || (b.revision ?? 0) > (best.revision ?? 0)) best = b
    } catch {}
  }
  return best
}

// remoteConfig is the release of ZCode's provider config zcode.z.ai names now.
async function remoteConfig() {
  const signal = AbortSignal.timeout(8000)
  const c = await call("GET", `${ZCODE}/api/v1/client/configs?app_version=${APP_VERSION}&platform=${platform()}`, { signal })
  const url = c?.configs?.builtin_provider_config_json
  if (!String(url ?? "").startsWith("https://")) throw new Error("ZCode's configs name no provider config")
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal })
  if (!res.ok) throw new Error(`ZCode's provider config: ${res.status}`)
  return res.json()
}

// config is ZCode's provider config, the later of zcode.z.ai's and an
// installed ZCode's, kept for 10 minutes.
let cfgCache = null
async function zcodeConfig() {
  if (cfgCache && Date.now() - cfgCache.at < 600_000) return cfgCache.cfg
  let cfg = null
  try {
    cfg = await remoteConfig()
  } catch {}
  const local = localConfig()
  if (local && (!cfg || (local.revision ?? 0) > (cfg.revision ?? 0))) cfg = local
  cfgCache = { cfg, at: Date.now() }
  return cfg
}

// variants are a model's reasoning efforts as @ai-sdk/anthropic options.
const BUDGET = { minimal: 1024, low: 4096, medium: 8192, high: 16_000, max: 31_999 }
function variants(es) {
  const out = {}
  for (const e of es) out[e] = e === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled", budgetTokens: BUDGET[e] ?? 16_000 } }
  return out
}

// entry is a model as a config hook declares it.
const entry = (m) => ({
  id: m.id,
  name: m.id,
  reasoning: m.efforts.some((e) => e !== "none"),
  tool_call: true,
  attachment: !!m.image,
  modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
  limit: { context: m.context || 200_000, output: m.output || OUTPUT },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  variants: variants(m.efforts),
})

// model is a model as OpenCode's provider hands it to provider.models.
function model(m, url) {
  const e = entry(m)
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.id,
    api: { id: m.id, url, npm: "@ai-sdk/anthropic" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: e.attachment,
      toolcall: true,
      input: { text: true, image: !!m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: e.variants,
  }
}

// ---- the plugin ------------------------------------------------------------------

export async function ZCodeAuthPlugin({ client }) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "zcode-auth", level: "error", message } })
    } catch {}
  }
  const oauth = (site) => ({
    type: "oauth",
    label: `ZCode: ${SITES[site].name}${site === "bigmodel" ? " (智谱)" : ""} GLM Coding Plan`,
    authorize: () => authorize(site, log),
  })
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "ZCode",
        npm: "@ai-sdk/anthropic",
        api: ZAI_BASE + "/v1",
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, entry(m)])), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      // the account's plan's models, as ZCode's config lists them now
      async models(provider, { auth } = {}) {
        const s = stateOf(auth)
        if (!s) return provider.models
        const start = await onStart(s).catch(() => false)
        const base = start ? START_BASE : s.base
        let ms = modelsOf(await zcodeConfig().catch(() => null), planID(base))
        if (!ms.length) ms = start ? START_MODELS : MODELS
        const url = s.base + "/v1"
        return Object.fromEntries(ms.map((m) => [m.id, model(m, url)]))
      },
    },
    auth: {
      provider: PROVIDER,
      async loader(getAuth, provider) {
        const s0 = stateOf(await getAuth())
        if (!s0) return {}
        const id = provider?.id ?? PROVIDER
        return {
          baseURL: s0.base + "/v1",
          apiKey: s0.key || "zcode", // the fetch below puts the real one on
          async fetch(input, init) {
            const auth = await getAuth()
            const s = stateOf(auth)
            if (!s) throw new Error("not signed in to ZCode")
            let url = input instanceof Request ? input.url : String(input)
            const opts = input instanceof Request ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init } : { ...init }
            const start = await onStart(s)
            // the request goes to the plan the account is on, wherever it was made for
            for (const b of [START_BASE, ZAI_BASE, BIGMODEL_BASE]) {
              if (url.startsWith(b)) {
                url = (start ? START_BASE : s.base) + url.slice(b.length)
                break
              }
            }
            let key = s.key
            if (isTeam(s) && !key) {
              key = await teamKey(s)
              if (auth?.type === "oauth") {
                const next = { ...auth, refresh: JSON.stringify({ ...s, key }), access: key }
                await client?.auth?.set?.({ path: { id }, body: next }).catch?.(() => {})
              }
            }
            const h = new Headers(opts.headers)
            if (start) {
              if (jwtExpired(s.jwt)) throw new Error(EXPIRED)
              key = s.jwt
              // ZCode names itself on a Start Plan request
              h.set("User-Agent", UA)
              h.set("X-ZCode-App-Version", APP_VERSION)
              h.set("X-Title", "Z Code@electron")
              h.set("HTTP-Referer", ZCODE)
              h.set("X-Platform", platform())
              h.set("X-Device-Mid", s.device)
            }
            if (!key) throw new Error("ZCode's sign-in has no key; sign in again")
            h.delete("authorization")
            h.set("x-api-key", key)
            h.set("Authorization", "Bearer " + key)
            return fetch(url, { ...opts, headers: h })
          },
        }
      },
      methods: [
        oauth("zai"),
        oauth("bigmodel"),
        {
          type: "api",
          label: "GLM Coding Plan API key",
          prompts: [
            {
              type: "select",
              key: "site",
              message: "Where is the key from?",
              options: [
                { label: "Z.ai", value: "zai", hint: "api.z.ai" },
                { label: "BigModel (智谱)", value: "bigmodel", hint: "open.bigmodel.cn" },
              ],
            },
          ],
        },
      ],
    },
  }
}
