// yetone/magpie#952: pi 1.0.4 through magpie got 403 "Factory: Forbidden"
// on DeepSeek (chat completions) and Claude (Messages) for "hi". The
// reporter's replays found the refused part: pi's opening sentence, whole
// (either half passes). The shapes below are pi's two requests as the
// reporter captured them: a developer message on chat completions, one
// system text block with cache_control on Messages.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages?beta=true"

const OPENING = "You are an expert coding assistant operating inside pi, a coding agent harness."
const REST = " You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents"
const PI = OPENING + REST
const ADAPTED = "You are an expert coding assistant." + REST

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    sent.push({ url: String(url), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "", premBaseHost: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const s = JSON.stringify(body)
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "pi (darwin 24.6.0; arm64)" }, body: s })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

const tools = ["read", "bash", "edit", "write"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }))

test("pi's opening sentence is cut to its first half on chat completions, the rest of its prompt kept", async () => {
  const send = await loaded()
  const b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: PI }, { role: "user", content: "hi" }], tools, stream: true })
  expect(b.messages).toEqual([{ role: "system", content: DROID_LINE }, { role: "developer", content: ADAPTED }, { role: "user", content: "hi" }])
  expect(b.tools).toEqual(tools)
  // as a system message too, and in text parts
  let c = await send(chat, { model: "kimi-k3", messages: [{ role: "system", content: PI }, { role: "user", content: "hi" }] })
  expect(c.messages[0]).toEqual({ role: "system", content: DROID_LINE + "\n" + ADAPTED })
  c = await send(chat, { model: "kimi-k3", messages: [{ role: "developer", content: [{ type: "text", text: PI }] }, { role: "user", content: "hi" }] })
  expect(c.messages[1]).toEqual({ role: "developer", content: [{ type: "text", text: ADAPTED }] })
})

test("pi's opening sentence is adapted in Messages' system block, its cache_control kept", async () => {
  const send = await loaded()
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: PI, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(b.system).toEqual([{ type: "text", text: DROID_LINE }, { type: "text", text: ADAPTED, cache_control: { type: "ephemeral" } }])
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
})

test("pi's opening sentence is adapted in Responses' instructions and input", async () => {
  const send = await loaded()
  let b = await send(responses, { model: "gpt-6.1", instructions: PI, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
  b = await send(responses, { model: "gpt-6.1", input: [{ role: "developer", content: PI }, { role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE)
  expect(b.input[0]).toEqual({ role: "developer", content: ADAPTED })
  // droid's own instructions are untouched unless the sentence is in them
  b = await send(responses, { model: "gpt-6.1", instructions: DROID_LINE + "\n" + PI, input: [{ role: "user", content: "hi" }] })
  expect(b.instructions).toBe(DROID_LINE + "\n" + ADAPTED)
})

test("the sentence quoted by the user, or only part of it, goes on as it is", async () => {
  const send = await loaded()
  const user = "Why does pi say: " + OPENING
  let b = await send(chat, { model: "kimi-k3", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: user }] })
  expect(b.messages[1]).toEqual({ role: "user", content: user })
  b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "You are an expert coding assistant operating inside pi." }], messages: [{ role: "user", content: [{ type: "text", text: user }] }] })
  expect(b.system[1].text).toBe("You are an expert coding assistant operating inside pi.")
  expect(b.messages[0].content[0].text).toBe(user)
  // mid-line in a system prompt: not pi's opening
  b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "Quote: " + OPENING }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(b.system[1].text).toBe("Quote: " + OPENING)
})

// yetone/magpie#1316: after pi compacted a session, every turn on
// factory/claude-opus-5-5 was 403 "Factory: Forbidden". The reporter's
// replays found the refused part: the fixed sentence pi opens the summary
// message with (pi-coding-agent dist/core/messages.js
// COMPACTION_SUMMARY_PREFIX), whole; with it removed or reworded the same
// request was answered. pi sends the summary as a user message of one text
// part (convertToLlm), the sentence, the summary in <summary> tags, and
// BRANCH_SUMMARY_PREFIX's sentence for a branch it came back from.
const COMPACTED = "The conversation history before this point was compacted into the following summary:"
const SUMMARY = "## Goal\nFix the login redirect.\n\n## Progress\n### Done\n- [x] Read src/auth.ts\n\n## Next Steps\n1. Patch the callback\n\n<read-files>\nsrc/auth.ts\n</read-files>"
const PI_COMPACTION = COMPACTED + "\n\n<summary>\n" + SUMMARY + "\n</summary>"
const ADAPTED_COMPACTION = "Earlier conversation context is summarized below:\n\n<summary>\n" + SUMMARY + "\n</summary>"
const BRANCHED = "The following is a summary of a branch that this conversation came back from:"
const PI_BRANCH = BRANCHED + "\n\n<summary>\n" + SUMMARY + "</summary>"
const ADAPTED_BRANCH = "Summary of an earlier conversation branch:\n\n<summary>\n" + SUMMARY + "</summary>"

test("pi's compaction summary opens without its fixed sentence on Messages, the summary kept", async () => {
  const send = await loaded()
  const after = [{ role: "assistant", content: [{ type: "text", text: "Patched." }] }, { role: "user", content: [{ type: "text", text: "go on" }] }]
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: PI, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: PI_COMPACTION }] }, ...after] })
  expect(b.messages).toEqual([{ role: "user", content: [{ type: "text", text: ADAPTED_COMPACTION }] }, ...after])
  expect(JSON.stringify(b)).not.toContain(COMPACTED)
  // a string content, and a branch summary
  const c = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: PI_COMPACTION }, { role: "user", content: [{ type: "text", text: PI_BRANCH }] }] })
  expect(c.messages).toEqual([{ role: "user", content: ADAPTED_COMPACTION }, { role: "user", content: [{ type: "text", text: ADAPTED_BRANCH }] }])
})

test("pi's compaction summary opens without its fixed sentence on chat completions and Responses", async () => {
  const send = await loaded()
  let b = await send(chat, { model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: PI }, { role: "user", content: [{ type: "text", text: PI_COMPACTION }] }, { role: "user", content: "go on" }] })
  expect(b.messages.slice(1)).toEqual([{ role: "developer", content: ADAPTED }, { role: "user", content: [{ type: "text", text: ADAPTED_COMPACTION }] }, { role: "user", content: "go on" }])
  b = await send(chat, { model: "kimi-k3", messages: [{ role: "user", content: PI_BRANCH }] })
  expect(b.messages[1]).toEqual({ role: "user", content: ADAPTED_BRANCH })
  b = await send(responses, { model: "gpt-6.1", instructions: PI, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PI_COMPACTION }] }, { role: "user", content: "go on" }] })
  expect(b.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: ADAPTED_COMPACTION }] }, { role: "user", content: "go on" }])
})

test("the compaction sentence the user writes, or outside pi's whole summary, goes on as it is", async () => {
  const send = await loaded()
  for (const text of [
    "Why does pi write: " + COMPACTED, // quoted mid-text
    COMPACTED + " What does that mean?", // the sentence alone, no summary
    COMPACTED + "\n\n<summary>\n" + SUMMARY, // no closing tag: not pi's whole message
  ]) {
    const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text }] }] })
    expect(b.messages[0].content[0].text).toBe(text)
    const c = await send(chat, { model: "kimi-k3", messages: [{ role: "user", content: text }] })
    expect(c.messages[1]).toEqual({ role: "user", content: text })
  }
  // an assistant repeating the summary is not pi's message
  const b = await send(messages, { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: PI_COMPACTION }] }, { role: "user", content: "ok" }] })
  expect(b.messages[1].content[0].text).toBe(PI_COMPACTION)
})
