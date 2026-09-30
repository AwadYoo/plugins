// A request Cursor fails is answered with the status and words magpie's
// built-in Cursor (internal/gateway/cursor.go, cursorFailure) gave it, so the
// gateway moves on to the next account or member as it did.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { failure } = _internal

test("an HTTP error that says nothing is worded as Go's status text", () => {
  expect(failure(402, "")).toEqual({ status: 402, message: "Payment Required" })
  expect(failure(429, "")).toEqual({ status: 429, message: "Too Many Requests" })
  expect(failure(503, "{}")).toEqual({ status: 503, message: "Service Unavailable" })
})

test("the codes and words map as the built-in's cursorStatus", () => {
  const end = (code, message) => JSON.stringify({ error: { code, message } })
  expect(failure(200, end("resource_exhausted", "slow down"))).toEqual({ status: 429, message: "usage limit reached: slow down" })
  expect(failure(200, end("unknown", "You've hit your usage limit"))).toEqual({ status: 429, message: "usage limit reached: You've hit your usage limit" })
  expect(failure(200, end("invalid_argument", "prompt is too long"))).toEqual({ status: 400, message: "input is too long for the model's context: prompt is too long" })
  expect(failure(200, end("invalid_argument", "bad"))).toEqual({ status: 400, message: "bad" })
  expect(failure(200, end("unavailable", "busy"))).toEqual({ status: 503, message: "busy" })
  expect(failure(200, end("permission_denied", "no"))).toEqual({ status: 403, message: "no" })
  expect(failure(200, end("internal", "boom"))).toEqual({ status: 502, message: "boom" })
  expect(failure(401, "")).toEqual({ status: 401, message: "Unauthorized — sign in to Cursor again" })
  expect(failure(200, end("unauthenticated", "Error"))).toEqual({ status: 401, message: "unauthenticated — sign in to Cursor again" })
})
