/**
 * 0.6.0 (design §8.1, §14) — the additive `pin` / `models` session-metadata
 * fields must leave the Hangar session readers UNCHANGED: `listSessions`
 * builds rows from an explicit key list, so a session carrying the new fields
 * produces exactly the row a 0.5.x session produces, and the transcript
 * envelope is unaffected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-09-04T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

describe("hangar-server session readers vs 0.6.0 session fields", () => {
  test("a session with pin/models lists and renders exactly like one without", async () => {
    const t = bootTestServer({ now: () => NOW });
    servers.push(t);
    const PLAIN = "sess_00000000000000a1";
    const HYBRID = "sess_00000000000000a2";
    const log = [
      logLine("user_message", { content: "where is my order" }),
      logLine("assistant_message", { content: "On its way." }),
      logLine("model_route", {
        turnNumber: 1,
        routeKey: "easy",
        model: "claude-haiku-4-5",
        policy: "heuristic",
        reason: "no tools",
        profile: "fast",
      }),
    ];
    const dir = makeFixtureHarness(join(t.harnessesRoot, "hybrid"), {
      specName: "hybrid",
      sessions: [
        { id: PLAIN, updatedAt: iso(NOW - DAY), lastTurnIndex: 2, log },
        { id: HYBRID, updatedAt: iso(NOW - DAY), lastTurnIndex: 2, log },
      ],
    });
    // Stamp the additive fields onto the second session's metadata file.
    const hybridPath = join(dir, ".crewhaus", "sessions", `${HYBRID}.json`);
    const meta = JSON.parse(readFileSync(hybridPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      hybridPath,
      `${JSON.stringify({ ...meta, pin: "fast", models: ["claude-haiku-4-5", "claude-opus-5"] }, null, 2)}\n`,
    );

    const reg = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
    expect(reg.status).toBe(201);
    const id = (reg.body["entry"] as { id: string }).id;

    const { status, body } = await t.api(`/api/h/${id}/sessions`);
    expect(status).toBe(200);
    const rows = body["sessions"] as Array<Record<string, unknown>>;
    const plain = rows.find((r) => r["id"] === PLAIN);
    const hybrid = rows.find((r) => r["id"] === HYBRID);
    expect(plain).toBeDefined();
    expect(hybrid).toBeDefined();
    // Same key list, same values apart from the id — the reader never saw pin/models.
    const strip = (r: Record<string, unknown> | undefined) => {
      const { id: _id, ...rest } = r ?? {};
      return rest;
    };
    expect(strip(hybrid)).toEqual(strip(plain));
    expect(Object.keys(hybrid ?? {})).not.toContain("pin");
    expect(Object.keys(hybrid ?? {})).not.toContain("models");
    expect(hybrid?.["model"]).toBe(plain?.["model"]);

    // The transcript envelope is metadata-independent too.
    const detailPlain = await t.api(`/api/h/${id}/sessions/${PLAIN}`);
    const detailHybrid = await t.api(`/api/h/${id}/sessions/${HYBRID}`);
    expect(detailPlain.status).toBe(200);
    expect(detailHybrid.status).toBe(200);
    const { id: _p, ...plainBody } = detailPlain.body;
    const { id: _h, ...hybridBody } = detailHybrid.body;
    expect(hybridBody).toEqual(plainBody);
  });
});
