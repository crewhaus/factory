/**
 * Containment refusals in the memory fabric must be REPORTED as refusals.
 *
 * The regression this pins (F-5): `memory/facts/<spec>` folded "refused by
 * containment" into the same branch as "the file is not there", so a
 * `memories/<spec>.jsonl` that EXISTS but symlinks out of the harness read
 * back as "no memories/<spec>.jsonl" — and then listed that very stem as one
 * of the stores this harness keeps facts under. `inspect/raw` already
 * answers with the true reason; this route now says the same thing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

describe("GET /memory/facts/:spec", () => {
  test("a store symlinked out of the harness reads as REFUSED, not as absent", async () => {
    const t = bootTestServer();
    servers.push(t);
    const outside = join(t.harnessesRoot, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "elsewhere.jsonl"),
      `${JSON.stringify({ id: "f1", text: "planted outside the harness" })}\n`,
    );
    const dir = makeFixtureHarness(join(t.harnessesRoot, "contained"), { specName: "contained" });
    const memories = join(dir, ".crewhaus", "memories");
    mkdirSync(memories, { recursive: true });
    symlinkSync(join(outside, "elsewhere.jsonl"), join(memories, "escapee.jsonl"));

    const { body: reg } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (reg["entry"] as { id: string }).id;
    const { status, body } = await t.api(`/api/h/${id}/memory/facts/escapee`);

    expect(status).toBe(200);
    expect(body["present"]).toBe(false);
    expect(body["note"]).toBe(
      "memories/escapee.jsonl resolves outside the harness directory and is not readable from here",
    );
    // Not the absence sentence — and never the planted content.
    expect(String(body["note"])).not.toContain("no memories/escapee.jsonl");
    expect(JSON.stringify(body)).not.toContain("planted outside the harness");
  });

  test("a genuinely absent store still reads as absent, naming the stems that do exist", async () => {
    const t = bootTestServer();
    servers.push(t);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "present"), {
      specName: "present",
      memories: { present: [{ id: "f1", text: "kept" }] },
    });
    const { body: reg } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (reg["entry"] as { id: string }).id;
    const { body } = await t.api(`/api/h/${id}/memory/facts/nosuch`);
    expect(body["present"]).toBe(false);
    expect(String(body["note"])).toContain("no memories/nosuch.jsonl");
    expect(body["verb"]).toBe("crewhaus memory remember");
  });
});
