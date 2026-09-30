// A Go account's failures read as magpie's built-in Command Code account
// answers them (internal/gateway/commandcode.go, cmdFailure), so magpie's
// gateway moves on to the next account or member just as it did.
import { afterEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
})

// ask sends a chat completion as a Go account, /alpha/generate answering
// with reply.
async function ask(reply, stream = false) {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/generate") return reply()
    return new Response("", { status: 404 })
  }
  const auth = { type: "api", key: "go-key", metadata: { plan: "Go" } }
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream, messages: [{ role: "user", content: "hi" }] }),
  })
  return { status: res.status, message: (await res.json()).error?.message }
}

test("an empty 429 reads as Go's http.StatusText says it, which quotaWords knows", async () => {
  expect(await ask(() => new Response("", { status: 429 }))).toEqual({ status: 429, message: "Too Many Requests" })
})

test("credits out whose words aren't quotaWords' say so, as cmdFailure does", async () => {
  const r = await ask(() => Response.json({ error: { type: "payment", message: "PREMIUM_CREDITS_EXHAUSTED: Monthly limit hit" } }, { status: 403 }))
  expect(r).toEqual({ status: 402, message: "out of credits: Monthly limit hit" })
})

test("credits out already in quotaWords' words are left as they are", async () => {
  const r = await ask(() => Response.json({ error: { message: "PREMIUM_CREDITS_EXHAUSTED: 余额不足" } }, { status: 400 }))
  expect(r).toEqual({ status: 402, message: "余额不足" })
})

test("an error line before any content keeps its status", async () => {
  const line = JSON.stringify({ type: "error", error: { message: '429 {"error":{"message":"RATE_LIMITED: slow down"}}' } })
  expect(await ask(() => new Response(line + "\n"), true)).toEqual({ status: 429, message: "RATE_LIMITED: slow down" })
})
