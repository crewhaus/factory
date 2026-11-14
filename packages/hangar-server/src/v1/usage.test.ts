/**
 * When a token was last used, over HTTP: noted at authentication in a separate, throttled
 * record, served on the token list, and never written into the access ledgers or the
 * access revision.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;

beforeAll(async () => {
  home = await v1Home();
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

/** The access ledgers' names, written apart from the package that owns them. */
const LEDGERS = ["principals", "grants", "credentials", "invites", "links", "governed"];

function accessBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...LEDGERS.map((k) => `${k}.jsonl`), "revision.json"]) {
    const file = join(root, "access", name);
    out[name] = existsSync(file) ? readFileSync(file, "utf8") : "";
  }
  return out;
}

/** The usage record's writes settle off the request's path: wait until it is there. */
async function usageOf(root: string, credential: string): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const file = join(root, "access", "usage.json");
    if (existsSync(file)) {
      const at = (
        JSON.parse(readFileSync(file, "utf8")) as { credentials?: Record<string, string> }
      ).credentials?.[credential];
      if (at !== undefined) return at;
    }
    await Bun.sleep(10);
  }
  return undefined;
}

describe("lastUsedAt", () => {
  test("a service token's authenticated request shows on the token list, and a minute writes once", async () => {
    const svc = await home.service("reporter", [], { permissions: ["home.read"] });
    const before = accessBytes(home.t.hangarRoot);
    const first = await home.call("GET", "/api/v1/harnesses", { secret: svc.secret });
    expect(first.status).toBe(200);
    const at = await usageOf(home.t.hangarRoot, svc.credential);
    expect(typeof at).toBe("string");
    const usageFile = join(home.t.hangarRoot, "access", "usage.json");
    const written = readFileSync(usageFile, "utf8");
    const second = await home.call("GET", "/api/v1/harnesses", { secret: svc.secret });
    expect(second.status).toBe(200);
    await Bun.sleep(50);
    // Inside the minute nothing is written again.
    expect(readFileSync(usageFile, "utf8")).toBe(written);
    const list = await home.call("GET", "/api/v1/access/tokens");
    const row = (list.body["items"] as Record<string, unknown>[]).find(
      (t) => t["id"] === svc.credential,
    );
    expect(row?.["lastUsedAt"]).toBe(at);
    // The access ledgers and the revision are byte-identical.
    expect(accessBytes(home.t.hangarRoot)).toEqual(before);
  });
});
