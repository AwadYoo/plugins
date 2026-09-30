// Xiaomi MiMo, as the MiMo desktop app signs in to it: a Xiaomi account
// signed in on account.xiaomi.com's long-poll page (a QR code for the
// Xiaomi phone app, or the password), whose passToken signs it on at the
// MiMo server, which answers with session cookies. Model requests are
// chat completions at the server's /route, carrying those cookies.
import { randomBytes } from "node:crypto"

const ID = "mimo-app"
const HOSTS = {
  SGP: "https://mimo-server-sgp.xiaomimimo.com/api",
  RU: "https://mimo-server-ru.xiaomimimo.com/api",
  IN: "https://mimo-server-in.xiaomimimo.com/api",
}
const REGION = "SGP"
const ACCOUNT = "https://account.xiaomi.com"
const APP_VERSION = "26.929.292248"
const SOURCE = "mimocode-cli-free"
const UA = "miNative PC/Normal Windows_NT/10.0.26100 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0"
const RENEW_AFTER = 24 * 60 * 60 * 1000 // the app signs on again after a day
const SIGN_IN_LIFE = 10 * 60 * 1000

const MODEL = { release_date: "2026-07-01", attachment: true, tool_call: true, limit: { context: 1_000_000, output: 128_000 }, modalities: { input: ["text", "image"], output: ["text"] } }
const MODELS = {
  "mimo-pro": { name: "MiMo Pro", ...MODEL },
  "mimo-flash": { name: "MiMo Flash", ...MODEL },
}

const baseOf = (region) => HOSTS[String(region ?? "").trim().toUpperCase()] ?? ""
const deviceId = () => "pc_" + randomBytes(16).toString("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// the account server's JSON comes after a "&&&START&&&" guard
function accountJSON(text) {
  try {
    return JSON.parse(text.trim().replace(/^&&&START&&&/, ""))
  } catch {
    return null
  }
}

// ---- a cookie jar, enough for the sign-on's redirects -----------------------

class Jar {
  constructor() {
    this.cookies = []
  }
  put(c) {
    this.cookies = this.cookies.filter((o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path))
    if (!c.gone) this.cookies.push(c)
  }
  seed(url, name, value) {
    this.put({ name, value, domain: new URL(url).hostname.toLowerCase(), hostOnly: false, path: "/", secure: false })
  }
  take(res, url) {
    const u = new URL(url)
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";")
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: u.hostname.toLowerCase(), hostOnly: true, secure: false }
      const dir = u.pathname.lastIndexOf("/")
      c.path = dir > 0 ? u.pathname.slice(0, dir) : "/"
      for (const a of attrs) {
        const i = a.indexOf("=")
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase()
        const v = i < 0 ? "" : a.slice(i + 1).trim()
        if (k === "domain" && v) {
          const d = v.replace(/^\./, "").toLowerCase()
          if (c.domain === d || c.domain.endsWith("." + d)) Object.assign(c, { domain: d, hostOnly: false })
        } else if (k === "path" && v.startsWith("/")) c.path = v
        else if (k === "secure") c.secure = true
        else if (k === "max-age" && Number(v) <= 0) c.gone = true
        else if (k === "expires" && Date.parse(v) <= Date.now()) c.gone = true
      }
      this.put(c)
    }
  }
  for(url) {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    return this.cookies.filter((c) => {
      if (c.secure && u.protocol !== "https:") return false
      if (c.hostOnly ? host !== c.domain : host !== c.domain && !host.endsWith("." + c.domain)) return false
      return u.pathname === c.path || u.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/") || c.path === "/"
    })
  }
  header(url) {
    return this.for(url).map((c) => `${c.name}=${c.value}`).join("; ")
  }
}

// ---- the session ------------------------------------------------------------

class Lapsed extends Error {}

const appHeaders = () => ({ "User-Agent": UA, "X-Client-Version": APP_VERSION })

// session signs the account on at a MiMo server as the app's window does:
// the server's /user/xiaomi/me, asked with no session, sends the browser to
// account.xiaomi.com's serviceLogin, which (holding the passToken) sends it
// back through the server's /sts, where the session cookies are set, to
// /user/xiaomi/me again. The server's cookies are the session.
async function session(creds, base) {
  const jar = new Jar()
  for (const [k, v] of [["userId", creds.userId], ["passToken", creds.passToken], ["cUserId", creds.cUserId],
    ["deviceId", creds.deviceId], ["pass_ua", "pc"], ["uLocale", "zh_CN"]]) {
    if (v) jar.seed(ACCOUNT, k, v)
  }
  const bu = new URL(base)
  const signal = AbortSignal.timeout(30_000)
  let url = base.replace(/\/+$/, "") + "/user/xiaomi/me"
  let res
  for (let hop = 0; ; hop++) {
    if (hop > 10) throw new Error("Xiaomi MiMo sign-in: too many redirects")
    const headers = appHeaders()
    const cookie = jar.header(url)
    if (cookie) headers.Cookie = cookie
    res = await fetch(url, { headers, redirect: "manual", signal })
    jar.take(res, url)
    const loc = res.headers.get("location")
    if (res.status < 300 || res.status >= 400 || !loc) break
    await res.arrayBuffer().catch(() => {})
    const next = new URL(loc, url)
    // the server's followup is written http://; its session cookies are
    // only sent back over https
    if (next.protocol === "http:" && bu.protocol === "https:" && next.host.toLowerCase() === bu.host.toLowerCase()) next.protocol = "https:"
    url = next.href
  }
  const text = await res.text()
  let me
  try {
    me = JSON.parse(text)
  } catch {
    // Xiaomi's sign-in page, not the server's answer: the passToken no
    // longer signs the account on
    throw new Lapsed("Xiaomi MiMo: the Xiaomi sign-in has lapsed; sign in again")
  }
  if (res.status === 403 || me?.code === 403 || me?.code === 46109) {
    throw new Error("Xiaomi MiMo doesn't serve this Xiaomi account (its region isn't served here)")
  }
  if (me?.code !== 0 || !String(me?.data?.userId ?? "")) throw new Lapsed("Xiaomi MiMo: the Xiaomi sign-in has lapsed; sign in again")
  const cookies = {}
  for (const c of jar.for(bu.href)) cookies[c.name] = c.value
  if (!Object.keys(cookies).length) throw new Error("Xiaomi MiMo sign-in: the server set no session")
  return { cookies, me: me.data }
}

// cookieHeader is a session as a Cookie header, in a steady order
function cookieHeader(cookies) {
  const first = ["serviceToken", "userId", "cUserId"]
  const parts = first.filter((k) => k in cookies).map((k) => `${k}=${cookies[k]}`)
  for (const [k, v] of Object.entries(cookies)) if (!first.includes(k)) parts.push(`${k}=${v}`)
  return parts.join("; ")
}

// The sign-in is kept as OpenCode keeps an OAuth one: refresh is the
// Xiaomi account (what signs it on again), access the session's cookies,
// expires when the app would sign on again.
function toAuth(creds, cookies, issued) {
  return {
    type: "oauth",
    refresh: JSON.stringify(creds),
    access: JSON.stringify(cookies),
    expires: issued + RENEW_AFTER,
    accountId: creds.userId,
  }
}

function fromAuth(auth) {
  if (auth?.type !== "oauth") return null
  try {
    const creds = JSON.parse(auth.refresh)
    let cookies = {}
    try {
      cookies = JSON.parse(auth.access || "{}") ?? {}
    } catch {}
    if (!creds?.passToken || !creds?.userId) return null
    creds.base ||= baseOf(creds.region) || HOSTS[REGION]
    return { creds, cookies, expires: Number(auth.expires) || 0 }
  } catch {
    return null
  }
}

// ---- the sign-in ------------------------------------------------------------

// serviceOf is the sid and callback the MiMo server sends a browser with
// no session to account.xiaomi.com with
async function serviceOf(base) {
  let sid = "mimosgp"
  let callback = base.replace(/\/+$/, "") + "/sts"
  try {
    const res = await fetch(base.replace(/\/+$/, "") + "/user/xiaomi/me", { headers: appHeaders(), redirect: "manual", signal: AbortSignal.timeout(15_000) })
    await res.arrayBuffer().catch(() => {})
    const loc = res.headers.get("location")
    if (loc) {
      const q = new URL(loc, base).searchParams
      sid = q.get("sid") || sid
      callback = q.get("callback") || callback
    }
  } catch {}
  return { sid, callback }
}

async function accountGet(url, device, signal) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Cookie: `deviceId=${device}; pass_ua=pc; uLocale=zh_CN` }, signal })
  return { status: res.status, text: await res.text() }
}

async function startSignIn() {
  const base = HOSTS[REGION]
  const device = deviceId()
  const { sid, callback } = await serviceOf(base)
  const q = new URLSearchParams({
    _group: "DEFAULT",
    _qrsize: "240",
    qs: "%3Fsid%3D" + encodeURIComponent(sid) + "%26_json%3Dtrue",
    callback,
    _hasLogo: "false",
    sid,
    serviceParam: "",
    _locale: "en_US",
  })
  const { status, text } = await accountGet(`${ACCOUNT}/longPolling/loginUrl?${q}`, device, AbortSignal.timeout(20_000))
  const lp = accountJSON(text)
  if (!lp || lp.code !== 0 || !lp.loginUrl || !lp.lp) {
    throw new Error(`Xiaomi MiMo sign-in: account.xiaomi.com answered ${status} ${lp?.desc || text.trim().slice(0, 200)}`)
  }
  const life = lp.timeout > 0 ? Math.min(lp.timeout * 1000, SIGN_IN_LIFE) : SIGN_IN_LIFE
  return { url: lp.loginUrl, lp: lp.lp, device, until: Date.now() + life }
}

// waitPoll asks the ticket's long poll until Xiaomi says the account is in
async function waitPoll(t) {
  while (Date.now() < t.until) {
    try {
      const left = t.until - Date.now()
      const { status, text } = await accountGet(t.lp, t.device, AbortSignal.timeout(Math.min(70_000, Math.max(left, 1))))
      const p = status === 200 ? accountJSON(text) : null
      if (p?.passToken && String(p.userId ?? "")) return p
    } catch {}
    await sleep(1000)
  }
  throw new Error("the Xiaomi sign-in page expired before the sign-in finished; start it again")
}

async function signedInWith(p, device) {
  let creds = { userId: String(p.userId), cUserId: p.cUserId ?? "", passToken: p.passToken, deviceId: device, region: REGION, base: HOSTS[REGION] }
  let s
  try {
    s = await session(creds, creds.base)
  } catch (e) {
    if (e instanceof Lapsed) throw new Error("Xiaomi signed the account in, but the MiMo server didn't take it; try again")
    throw e
  }
  // an account of another region is served by that region's server
  const r = String(s.me?.region ?? "").trim().toUpperCase()
  const nb = baseOf(r)
  if (r && r !== creds.region && nb && nb !== creds.base) {
    try {
      s = await session(creds, nb)
      creds = { ...creds, region: r, base: nb }
    } catch {}
  }
  return { creds: { ...creds, userId: String(s.me?.userId ?? "") || creds.userId }, cookies: s.cookies }
}

// ---- the plugin -------------------------------------------------------------

export const MimoAuthPlugin = async ({ client }) => {
  let renewing = null

  const save = async (auth) => {
    try {
      await client?.auth?.set?.({ path: { id: ID }, body: auth })
    } catch {}
  }

  // fresh is the account with a live session, signed on again when it is
  // older than the app lets one get, or when force is set (the server
  // turned the last one away)
  const fresh = async (getAuth, force) => {
    const a = fromAuth(await getAuth())
    if (!a) throw new Error("Xiaomi MiMo: not signed in")
    if (!force && Object.keys(a.cookies).length && Date.now() < a.expires) return a
    if (!renewing) {
      renewing = (async () => {
        try {
          const s = await session(a.creds, a.creds.base)
          const issued = Date.now()
          await save(toAuth(a.creds, s.cookies, issued))
          return { creds: a.creds, cookies: s.cookies, expires: issued + RENEW_AFTER }
        } catch (e) {
          // a hiccup: the session in hand may still do
          if (!(e instanceof Lapsed) && !force && Object.keys(a.cookies).length) return a
          throw e
        }
      })().finally(() => {
        renewing = null
      })
    }
    return renewing
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Xiaomi MiMo",
        npm: "@ai-sdk/openai-compatible",
        api: HOSTS[REGION] + "/route",
        ...was,
        models: { ...MODELS, ...(was.models ?? {}) },
      }
    },
    auth: {
      provider: ID,
      loader: async (getAuth) => {
        const a = fromAuth(await getAuth())
        if (!a) return {}
        return {
          baseURL: a.creds.base.replace(/\/+$/, "") + "/route",
          apiKey: "mimo", // the engine's placeholder; the app strips it
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            const url = req ? req.url : String(input)
            let body = init.body ?? (req ? await req.text() : undefined)
            // mimo-auto, the app's default, is asked as the model it stands for
            if (typeof body === "string" && body.includes('"mimo-auto"')) {
              try {
                const j = JSON.parse(body)
                if (j?.model === "mimo-auto") body = JSON.stringify({ ...j, model: "mimo-pro" })
              } catch {}
            }
            const send = async (force) => {
              const s = await fresh(getAuth, force)
              const headers = new Headers(init.headers ?? req?.headers)
              headers.delete("authorization")
              headers.set("Cookie", cookieHeader(s.cookies))
              headers.set("X-Mimo-Source", SOURCE)
              headers.set("User-Agent", UA)
              headers.set("X-Client-Version", APP_VERSION)
              return fetch(url, { ...init, method: init.method ?? req?.method ?? "POST", headers, body })
            }
            const res = await send(false)
            // a session gone stale, or a redirect to Xiaomi's sign-in page
            const stale = res.status === 401 || (res.status === 200 && /text\/html/i.test(res.headers.get("content-type") ?? ""))
            if (!stale || (body != null && typeof body !== "string")) return res
            await res.arrayBuffer().catch(() => {})
            return send(true)
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Xiaomi account",
          authorize: async () => {
            const t = await startSignIn()
            return {
              url: t.url,
              instructions: "Sign in to your Xiaomi account on the page that opens (or scan its QR code with the Xiaomi app). The sign-in finishes here by itself.",
              method: "auto",
              callback: async () => {
                try {
                  const p = await waitPoll(t)
                  const { creds, cookies } = await signedInWith(p, t.device)
                  return { ...toAuth(creds, cookies, Date.now()), type: "success" }
                } catch {
                  return { type: "failed" }
                }
              },
            }
          },
        },
      ],
    },
  }
}
