// grok-4.7 offers the built-in's reasoning levels before Grok lists any:
// magpie keeps the configured model when the models hook fails, and a
// model with no variants lost the levels the built-in had (low…xhigh).
import { expect, test } from "bun:test"
import { GrokAuthPlugin } from "./index.mjs"

test("the configured grok-4.7 carries the built-in's levels", async () => {
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = {}
  await hooks.config(cfg)
  const m = cfg.provider.grok.models["grok-4.7"]
  expect(m.reasoning).toBe(true)
  expect(Object.keys(m.variants)).toEqual(["low", "medium", "high", "xhigh"])
  expect(m.variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
})

// A token Grok refuses before its time says the sign-in is gone, as one
// past its time does, so magpie's move takes the account along untried;
// "Grok models: 401 …" stopped every Grok account's move.
test("a refused token says the sign-in has expired", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = mkdtempSync(join(tmpdir(), "grok-models-"))
  writeFileSync(join(home, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: "revoked", expires_at: "2099-01-01T00:00:00Z", email: "a@x.ai" } }))
  const [path, h, fetch0] = [process.env.PATH, process.env.HOME, globalThis.fetch]
  process.env.PATH = ""
  process.env.HOME = home
  globalThis.fetch = async () => new Response('{"error":"Invalid or expired credentials"}', { status: 401 })
  try {
    const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
    const err = await hooks.provider.models({ id: "grok", models: {} }, { auth: { type: "oauth", refresh: home } }).catch((e) => e)
    expect(err?.message).toMatch(/sign-in has expired/)
  } finally {
    ;[process.env.PATH, process.env.HOME, globalThis.fetch] = [path, h, fetch0]
  }
})
