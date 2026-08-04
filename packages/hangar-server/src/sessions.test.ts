import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedbackRecord, logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});
function boot(opts: Parameters<typeof bootTestServer>[0] = {}): TestServer {
  const t = bootTestServer(opts);
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { status, body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  expect(status).toBe(201);
  return (body["entry"] as { id: string }).id;
}

/** Byte-level snapshot of every file under a dir (recursive). */
function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.set(p, readFileSync(p, "latin1"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("non-eviction invariant", () => {
  test("browsing every sessions route repeatedly deletes nothing — expired-mtime files stay byte-identical", async () => {
    const t = boot({ now: () => NOW });
    const expiredId = "sess_00000000000000ee";
    const dir = makeFixtureHarness(join(t.harnessesRoot, "ttl"), {
      specName: "ttl",
      sessions: [
        {
          id: expiredId,
          updatedAt: iso(NOW - 400 * DAY),
          // 400 days old — FAR past the session store's default 30-day TTL:
          // SessionStore.list() would unlink these on sight.
          mtimeMs: NOW - 400 * DAY,
          log: [
            logLine("user_message", { content: "old question" }),
            logLine("assistant_message", { content: "old answer" }),
          ],
        },
        {
          id: "sess_00000000000000ff",
          updatedAt: iso(NOW - 1 * DAY),
          log: [logLine("user_message", { content: "fresh" })],
        },
      ],
      sessionIndex: {
        sess_00000000000000dd: {
          schemaVersion: 1,
          sessionId: "sess_00000000000000dd",
          turnCount: 3,
          outcome: "long gone",
          summarizedAt: iso(NOW - 90 * DAY),
        },
      },
    });
    const id = await register(t, dir);
    const stateDir = join(dir, ".crewhaus");
    const before = snapshotDir(stateDir);
    expect([...before.keys()].some((p) => p.includes(expiredId))).toBe(true);

    for (let pass = 0; pass < 3; pass++) {
      expect((await t.api(`/api/h/${id}/sessions`)).status).toBe(200);
      expect((await t.api(`/api/h/${id}/sessions/${expiredId}`)).status).toBe(200);
      expect((await t.api(`/api/h/${id}/sessions/${expiredId}?raw=1`)).status).toBe(200);
      expect((await t.api(`/api/h/${id}/sessions/sess_00000000000000dd`)).status).toBe(200);
      expect((await t.api(`/api/h/${id}/costs`)).status).toBe(200);
      expect((await t.api("/api/harnesses?hydrate=1")).status).toBe(200);
      expect((await t.api(`/api/h/${id}`)).status).toBe(200);
    }

    const after = snapshotDir(stateDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      expect(after.get(path)).toBe(bytes);
    }
  });
});

describe("session listing", () => {
  test("live rows newest-first with age, evicted ids fall through from the durable index", async () => {
    const t = boot({ now: () => NOW });
    const dir = makeFixtureHarness(join(t.harnessesRoot, "list"), {
      specName: "list",
      sessions: [
        { id: "sess_000000000000000a", updatedAt: iso(NOW - 2 * DAY), lastTurnIndex: 4 },
        { id: "sess_000000000000000b", updatedAt: iso(NOW - 1 * DAY), lastTurnIndex: 1 },
      ],
      sessionIndex: {
        sess_000000000000000c: {
          schemaVersion: 1,
          sessionId: "sess_000000000000000c",
          turnCount: 7,
          outcome: "evicted long ago",
          summarizedAt: iso(NOW - 60 * DAY),
        },
        // A live id also present in the index must NOT duplicate.
        sess_000000000000000b: { schemaVersion: 1, sessionId: "sess_000000000000000b" },
      },
    });
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/sessions`);
    expect(status).toBe(200);
    const root = body["sessionRoot"] as Record<string, unknown>;
    expect(root["overrideActive"]).toBe(false);
    const rows = body["sessions"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => `${r["id"]}:${r["evicted"]}`)).toEqual([
      "sess_000000000000000b:false",
      "sess_000000000000000a:false",
      "sess_000000000000000c:true",
    ]);
    const live = rows[0] as Record<string, unknown>;
    expect(live["lastTurnIndex"]).toBe(1);
    expect(live["updatedAt"]).toBe(iso(NOW - 1 * DAY));
    const evicted = rows[2] as Record<string, unknown>;
    expect((evicted["summary"] as Record<string, unknown>)["outcome"]).toBe("evicted long ago");
  });

  test("CREWHAUS_SESSION_DIR override in the harness .env is honored (relative to the harness dir) and flagged", async () => {
    const t = boot({ now: () => NOW });
    const dir = makeFixtureHarness(join(t.harnessesRoot, "override"), {
      specName: "override",
      envLines: ["CREWHAUS_SESSION_DIR=custom-sessions"],
    });
    const custom = join(dir, "custom-sessions");
    mkdirSync(custom, { recursive: true });
    writeFileSync(
      join(custom, "sess_00000000000000cc.json"),
      JSON.stringify({
        id: "sess_00000000000000cc",
        createdAt: iso(NOW - DAY),
        updatedAt: iso(NOW - DAY),
        name: "relocated",
        target: "cli",
        model: "m",
        lastTurnIndex: 1,
      }),
    );
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/sessions`);
    const root = body["sessionRoot"] as Record<string, unknown>;
    expect(root["overrideActive"]).toBe(true);
    expect(root["overrideIgnored"]).toBe(false);
    expect(root["root"]).toBe(custom);
    const rows = body["sessions"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["id"])).toEqual(["sess_00000000000000cc"]);
  });

  test("an override that escapes the harness dir is IGNORED (falls back, flagged)", async () => {
    const t = boot({ now: () => NOW });
    const outside = join(t.workspace, "outside-sessions");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sess_0000000000000099.json"), "{}");
    const dir = makeFixtureHarness(join(t.harnessesRoot, "escape"), {
      specName: "escape",
      envLines: [`CREWHAUS_SESSION_DIR=${outside}`],
      sessions: [{ id: "sess_0000000000000011", updatedAt: iso(NOW - DAY) }],
    });
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/sessions`);
    const root = body["sessionRoot"] as Record<string, unknown>;
    expect(root["overrideActive"]).toBe(false);
    expect(root["overrideIgnored"]).toBe(true);
    const rows = body["sessions"] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["id"])).toEqual(["sess_0000000000000011"]);
  });
});

describe("transcript envelope", () => {
  test("turns, tool pairs with isError, metadata gutter, unknown kinds tallied, torn lines skipped", async () => {
    const t = boot({ now: () => NOW });
    const sess = "sess_00000000000000ab";
    const dir = makeFixtureHarness(join(t.harnessesRoot, "transcript"), {
      specName: "transcript",
      sessions: [
        {
          id: sess,
          updatedAt: iso(NOW - DAY),
          log: [
            logLine("user_message", { content: "what is the weather" }),
            logLine("assistant_message", {
              content: [
                { type: "text", text: "let me check" },
                { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "weather" } },
              ],
            }),
            logLine("user_message", {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu_1",
                  content: [{ type: "text", text: "sunny, 22C" }],
                  is_error: false,
                },
              ],
            }),
            logLine("assistant_message", {
              content: [
                { type: "tool_use", id: "tu_2", name: "fs_read", input: { path: "/nope" } },
              ],
            }),
            logLine("user_message", {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu_2",
                  content: "ENOENT",
                  is_error: true,
                },
              ],
            }),
            logLine("assistant_message", { content: "it is sunny" }),
            logLine("user_message", { content: "thanks", synthetic: true }),
            logLine("cost_accrual", { provider: "anthropic", modelId: "m", costUsdMicros: 42 }),
            logLine("model_route", { chosen: "m", reason: "static" }),
            logLine("user_feedback", feedbackRecord(sess, 1, "up", iso(NOW - DAY))),
            logLine("compaction", { dropped: 3 }),
            logLine("permission", { tool: "fs_read", decision: "allow" }),
            logLine("recovery", { attempt: 1 }),
            logLine("model_meta", { context: 200000 }),
            logLine("error", { message: "transient" }),
            '{"kind":"assistant_message","payload":{"content":"torn', // torn line
          ],
        },
      ],
    });
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/sessions/${sess}`);
    expect(status).toBe(200);

    const turns = body["turns"] as Array<Record<string, unknown>>;
    expect(turns.map((x) => `${x["role"]}: ${x["text"]}`)).toEqual([
      "user: what is the weather",
      "assistant: let me check",
      "assistant: it is sunny",
    ]);

    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools.length).toBe(2);
    expect(tools[0]).toMatchObject({
      toolUseId: "tu_1",
      name: "web_search",
      input: { query: "weather" },
      isError: false,
      result: [{ type: "text", text: "sunny, 22C" }],
    });
    expect(tools[1]).toMatchObject({ toolUseId: "tu_2", name: "fs_read", isError: true });

    const gutter = body["gutter"] as Array<Record<string, unknown>>;
    expect(gutter.map((g) => g["kind"])).toEqual([
      "cost_accrual",
      "model_route",
      "user_feedback",
      "compaction",
      "permission",
      "recovery",
    ]);
    expect(body["otherKinds"]).toEqual({ model_meta: 1, error: 1 });
    expect(body["tornCount"]).toBe(1);
    expect(body["evicted"]).toBe(false);
  });

  test("raw escape hatch returns capped raw lines; evicted ids return the durable summary; unknown 404s", async () => {
    const t = boot({ now: () => NOW });
    const sess = "sess_00000000000000ba";
    const dir = makeFixtureHarness(join(t.harnessesRoot, "raw"), {
      specName: "raw",
      sessions: [
        { id: sess, updatedAt: iso(NOW - DAY), log: [logLine("user_message", { content: "hi" })] },
      ],
      sessionIndex: {
        sess_00000000000000bd: {
          schemaVersion: 1,
          sessionId: "sess_00000000000000bd",
          outcome: "archived",
          summarizedAt: iso(NOW - 40 * DAY),
        },
      },
    });
    const id = await register(t, dir);

    const raw = await t.api(`/api/h/${id}/sessions/${sess}?raw=1`);
    expect(raw.status).toBe(200);
    expect((raw.body["raw"] as string[]).length).toBe(1);
    expect((raw.body["raw"] as string[])[0]).toContain("user_message");

    const evicted = await t.api(`/api/h/${id}/sessions/sess_00000000000000bd`);
    expect(evicted.status).toBe(200);
    expect(evicted.body["evicted"]).toBe(true);
    expect((evicted.body["summary"] as Record<string, unknown>)["outcome"]).toBe("archived");

    expect((await t.api(`/api/h/${id}/sessions/sess_00000000000000fe`)).status).toBe(404);
    expect((await t.api(`/api/h/${id}/sessions/not-a-session-id`)).status).toBe(400);
  });
});
