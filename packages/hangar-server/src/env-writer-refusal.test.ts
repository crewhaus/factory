/**
 * How the `.env` writer's refusals reach an HTTP caller.
 *
 * The writer refuses a value one `.env` line cannot hold (a newline or a
 * NUL) and says which VARIABLE it refused, never the value. Two routes
 * depend on how that refusal surfaces, and both are pinned here through the
 * real dispatcher:
 *
 *   - `POST /api/h/:id/env` answers it as a 400 carrying the sentence;
 *   - set-across (`POST /api/credentials/set`) lists each harness under
 *     `refused` with the sentence as its reason. Any OTHER failure there —
 *     a filesystem error — reads "write failed", because a filesystem error
 *     carries a path and the route only repeats sentences it wrote itself.
 *
 * So a writer whose refusal stopped being translated would turn an
 * actionable sentence into "write failed" (and the single-harness route into
 * a 500), and one that translated EVERY error would leak filesystem text
 * into a 400. Each half has a test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

/** Built from parts: never a realistic-shaped literal in a fixture. */
const FIRST_LINE = ["first", "half", "of", "the", "value"].join("-");
const SECOND_LINE = ["second", "half", "of", "the", "value"].join("-");
const MULTI_LINE = `${FIRST_LINE}\n${SECOND_LINE}`;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

/** Register a fixture harness. With no `envLines` it has no `.env` at all. */
async function register(t: TestServer, name: string, envLines?: readonly string[]) {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    target: "channel",
    ...(envLines !== undefined ? { envLines } : {}),
  });
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return { id: (body["entry"] as { id: string }).id, dir };
}

/** The sentence the writer refuses with, byte for byte. */
const refusalFor = (variable: string): string =>
  `the value for ${variable} contains a newline — .env cannot represent that`;

describe("POST /api/h/:id/env", () => {
  test("a value with a newline is a 400 that names the variable and not the value", async () => {
    const t = boot();
    const { id, dir } = await register(t, "single", ["KEEP=untouched"]);
    const res = await t.api(`/api/h/${id}/env`, {
      method: "POST",
      body: JSON.stringify({ key: "MULTI_SECRET", value: MULTI_LINE }),
    });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe(refusalFor("MULTI_SECRET"));
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(FIRST_LINE);
    expect(text).not.toContain(SECOND_LINE);
    // Refused before any byte was written.
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("KEEP=untouched\n");
  });

  test("a NUL is refused with the same sentence", async () => {
    const t = boot();
    const { id } = await register(t, "nul", []);
    const res = await t.api(`/api/h/${id}/env`, {
      method: "POST",
      body: JSON.stringify({ key: "NUL_SECRET", value: `${FIRST_LINE}\u0000${SECOND_LINE}` }),
    });
    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe(refusalFor("NUL_SECRET"));
    expect(JSON.stringify(res.body)).not.toContain(FIRST_LINE);
  });

  test("a filesystem failure is not dressed up as a refusal", async () => {
    const t = boot();
    const { id, dir } = await register(t, "fs-fail");
    // A directory where the file should be: the write itself throws.
    mkdirSync(join(dir, ".env"));
    const res = await t.api(`/api/h/${id}/env`, {
      method: "POST",
      body: JSON.stringify({ key: "PLAIN_KEY", value: "plain-value" }),
    });
    expect(res.status).toBe(500);
    expect(res.body["error"]).toBe("internal error");
  });
});

describe("POST /api/credentials/set", () => {
  test("every harness is listed under refused, with the writer's sentence as the reason", async () => {
    const t = boot();
    const a = await register(t, "fleet-a", ["KEEP=a"]);
    const b = await register(t, "fleet-b", ["KEEP=b"]);
    const res = await t.api("/api/credentials/set", {
      method: "POST",
      body: JSON.stringify({
        key: "FLEET_SECRET",
        value: MULTI_LINE,
        harnessIds: [a.id, b.id],
        confirmName: "FLEET_SECRET",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body["written"]).toEqual([]);
    expect(res.body["refused"]).toEqual([
      { harnessId: a.id, ok: false, reason: refusalFor("FLEET_SECRET") },
      { harnessId: b.id, ok: false, reason: refusalFor("FLEET_SECRET") },
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("write failed");
    expect(text).not.toContain(FIRST_LINE);
    expect(readFileSync(join(a.dir, ".env"), "utf8")).toBe("KEEP=a\n");
    expect(readFileSync(join(b.dir, ".env"), "utf8")).toBe("KEEP=b\n");
  });

  test("a filesystem failure reads as write failed, and the other harness is still written", async () => {
    const t = boot();
    const broken = await register(t, "fleet-broken");
    const fine = await register(t, "fleet-fine");
    mkdirSync(join(broken.dir, ".env"));
    const res = await t.api("/api/credentials/set", {
      method: "POST",
      body: JSON.stringify({
        key: "FLEET_KEY",
        value: "plain-value",
        harnessIds: [broken.id, fine.id],
        confirmName: "FLEET_KEY",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body["refused"]).toEqual([
      { harnessId: broken.id, ok: false, reason: "write failed" },
    ]);
    const written = res.body["written"] as Array<Record<string, unknown>>;
    expect(written.map((row) => row["harnessId"])).toEqual([fine.id]);
    expect(readFileSync(join(fine.dir, ".env"), "utf8")).toBe("FLEET_KEY=plain-value\n");
  });
});
