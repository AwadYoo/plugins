// A key's account is named by Devin itself (GetUserStatus, asked with the
// key), not by the devin CLI: the CLI on Windows reads its own
// credentials.toml whatever APPDATA it is run with, so it named every
// browser sign-in after its own account, and "Add another Devin account"
// replaced the first account's key with the second's (#17). Its model list
// is the CLI's own account's there too, so it isn't taken for the key's.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
const env = { ...process.env }
const tmp = mkdtempSync(join(tmpdir(), "devin-identity-"))
const bin = join(tmp, "bin")
const log = join(tmp, "cli.log")
mkdirSync(bin)

// a devin CLI signed in as a@x.dev: `auth status` reads the data folder it
// is given when FAKE_HONOURS is set, and its own (as on Windows) when not;
// `models list` lists one family, and every run is logged
writeFileSync(
  join(bin, "devin"),
  `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = auth ]; then
  if [ -n "$FAKE_HONOURS" ]; then f="$XDG_DATA_HOME/devin/credentials.toml"; else f="${tmp}/own/devin/credentials.toml"; fi
  printf 'Logged in (via Devin).\\n\\nCredentials:\\n  File:              %s\\n\\nUser:\\n  Email:             %s\\n\\nAccount:\\n  Tier:              Devin Pro\\n' "$f" "${"$"}{FAKE_EMAIL:-a@x.dev}"
  exit 0
fi
echo '{"families":[{"family_uid":"cli-only","family_label":"CLI Only","variants":[{"model_uid":"cli-only-high","label":"CLI Only High"}]}]}'
`,
)
chmodSync(join(bin, "devin"), 0o755)

beforeEach(() => {
  process.env.PATH = bin + ":" + env.PATH
  process.env.XDG_CACHE_HOME = join(tmp, "cache")
  delete process.env.FAKE_HONOURS
  delete process.env.FAKE_EMAIL
  rmSync(log, { force: true })
})
afterEach(() => {
  globalThis.fetch = real
  for (const k of ["PATH", "XDG_CACHE_HOME", "FAKE_HONOURS", "FAKE_EMAIL"]) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k])
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])

// GetUserStatus for each key: b's is B's account
const devin = (byKey) => {
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus")
    return byKey(JSON.parse(init.body).metadata.apiKey)
  }
}
const statusOf = (email, tier) =>
  Response.json({ userStatus: { name: email.split("@")[0], email, teamsTier: tier, planStatus: { planInfo: { planName: "Pro" } } } })

const unix = process.platform !== "win32"
// a script just written can take seconds to start the first time (macOS
// checks it)
const SLOW = 30_000

test.if(unix)("a second account is named as Devin names its key, not as the CLI's own account", async () => {
  devin((key) => (key === "key-b" ? statusOf("b@x.dev", "TEAMS_TIER_DEVIN_PRO") : statusOf("a@x.dev", "TEAMS_TIER_DEVIN_PRO")))
  const r = await _internal.success("key-b", "https://server.codeium.com")
  expect(r).toEqual({ type: "success", provider: "devin", key: "key-b", metadata: { email: "b@x.dev", plan: "Devin Pro" } })
  expect((await _internal.success("key-a", "https://server.codeium.com")).metadata.email).toBe("a@x.dev")
}, SLOW)

test.if(unix)("a key Devin refuses fails the sign-in, whatever the CLI says", async () => {
  devin(() => Response.json({ code: "unauthenticated", message: "invalid api key" }, { status: 401 }))
  await expect(_internal.success("key-refused", "https://server.codeium.com")).rejects.toThrow("Devin didn't take the sign-in")
}, SLOW)

test.if(unix)("when Devin can't tell, the CLI names the account only if it read the key's own folder", async () => {
  devin(() => new Response("", { status: 503 }))
  // the CLI read its own credentials.toml: not the key's account
  expect((await _internal.success("key-c", "https://server.codeium.com")).metadata).toEqual({ email: "Devin" })
  // a CLI that honours the folder answers for the key
  process.env.FAKE_HONOURS = "1"
  process.env.FAKE_EMAIL = "c@x.dev"
  expect((await _internal.success("key-c", "https://server.codeium.com")).metadata).toEqual({ email: "c@x.dev", plan: "Devin Pro" })
}, SLOW)

test.if(unix)("a CLI that reads its own account's folder isn't asked for the key's models", async () => {
  devin(() => statusOf("b@x.dev"))
  const fams = await _internal.familiesFor("key-models-b", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).toEqual(_internal.familiesOf(_internal.SNAPSHOT).map((f) => f.uid))
  expect(runs()).toEqual(["auth status"])
  // nor asked again
  await _internal.familiesFor("key-models-b", "https://server.codeium.com")
  expect(runs()).toEqual(["auth status"])
}, SLOW)

test.if(unix)("a CLI that names another account than Devin does isn't asked for the key's models", async () => {
  process.env.FAKE_HONOURS = "1"
  devin(() => statusOf("b@x.dev"))
  const fams = await _internal.familiesFor("key-models-b2", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).not.toContain("cli-only")
  expect(runs()).toEqual(["auth status"])
}, SLOW)

test.if(unix)("a CLI that answers for the key gives its list", async () => {
  process.env.FAKE_HONOURS = "1"
  process.env.FAKE_EMAIL = "b@x.dev"
  devin(() => statusOf("B@x.dev"))
  const fams = await _internal.familiesFor("key-models-ok", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).toEqual(["cli-only"])
  expect(runs()).toEqual(["auth status", "models list --format json"])
}, SLOW)

test("readsHome and tierName", () => {
  const { readsHome, tierName } = _internal
  const home = join(tmp, "h")
  expect(readsHome(`Logged in\n  File:   ${join(home, "devin", "credentials.toml")}\n`, home)).toBe(true)
  expect(readsHome(`Logged in\n  File:   ${join(tmp, "own", "devin", "credentials.toml")}\n`, home)).toBe(false)
  expect(readsHome("Logged in\n  Email: a@x.dev\n", home)).toBe(true)
  expect(tierName("TEAMS_TIER_DEVIN_PRO")).toBe("Devin Pro")
  expect(tierName("TEAMS_TIER_DEVIN_TEAMS_V2")).toBe("Devin Teams")
  expect(tierName("TEAMS_TIER_UNSPECIFIED")).toBe("")
  expect(tierName(undefined)).toBe("")
})
