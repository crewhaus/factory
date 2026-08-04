/**
 * The synthesized-proposal read.
 *
 * The regression this pins (F-4): `watchmeSynthesized` spread
 * `readBase(…, "no synthesized proposal has been written yet", …)` and then
 * re-set `note:` in the SAME object literal, so the empty-state sentence was
 * dead and the note read identically whether or not a proposal existed —
 * the console's empty state (`empty(synthesized, …)` in memory-fabric.js)
 * had nothing true to render.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

async function harness(name: string, proposals: Readonly<Record<string, string>>) {
  const t = bootTestServer();
  servers.push(t);
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), { specName: name });
  const stamps = Object.keys(proposals);
  if (stamps.length > 0) {
    const synthDir = join(dir, ".crewhaus", "watchme", "synthesized");
    mkdirSync(synthDir, { recursive: true });
    for (const stamp of stamps) {
      writeFileSync(join(synthDir, `${stamp}.yaml`), proposals[stamp] as string);
    }
  }
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  const id = (body["entry"] as { id: string }).id;
  return (await t.api(`/api/h/${id}/memory/watchme/synthesized`)).body;
}

describe("GET /memory/watchme/synthesized", () => {
  test("with no proposal the note says the store is empty, not that reading is advisory", async () => {
    const body = await harness("empty", {});
    expect(body["present"]).toBe(false);
    expect(body["proposals"]).toEqual([]);
    expect(body["note"]).toBe("no synthesized proposal has been written yet");
    expect(body["verb"]).toBe("crewhaus watchme synthesize");
  });

  test("with a proposal the note is the advisory sentence — the two states differ", async () => {
    const emptyBody = await harness("empty2", {});
    const fullBody = await harness("full", {
      "20260803T000000": ["name: full", "target: cli", "agent:", "  max_tokens: 9000"].join("\n"),
    });
    expect(fullBody["present"]).toBe(true);
    expect((fullBody["proposals"] as unknown[]).length).toBe(1);
    expect(String(fullBody["note"])).toContain("advisory only");
    expect(fullBody["note"]).not.toBe(emptyBody["note"]);
  });
});
