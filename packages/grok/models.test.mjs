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
