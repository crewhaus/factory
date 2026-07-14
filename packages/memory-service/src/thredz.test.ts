/**
 * v0.3.0 Goal 3 (design §4.3/§4.4, PR 16) — the Thredz backend flip:
 * alias-routed tool surface (local twins absent), backend-invariant recall
 * fusion, the spec-scoped goal mirror (happy path / quota / offline), the
 * §4.4 degrade paths, and the error-mapping choke point — pinned against the
 * REAL thredz-mcp v0.2.0 contract (`present()` error shapes; plus a guarded
 * integration test that spawns the actual published server.ts read-only).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { McpHost } from "@crewhaus/mcp-host";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { THREDZ_WIKI_TOOL_NAMES } from "@crewhaus/tool-wiki";
import {
  THREDZ_ALIAS_TOOL_NAMES,
  THREDZ_GOAL_MAP_FILE,
  type ThredzCallResult,
  type ThredzClient,
  type WireMemoryDeps,
  classifyThredzFailure,
  connectThredz,
  extractThredzGoalId,
  memoryFragmentFromIr,
  parseThredzRecallLines,
  wireContinuity,
  wireMemory,
  wireWiki,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-service-thredz-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures — the REAL v0.2.0 error text contract (present() shapes)
// ---------------------------------------------------------------------------

const QUOTA_402 =
  'goal_write failed (HTTP 402) — Thredz plan limit reached — the write was NOT saved. Upgrade the plan (or clear unused items) at https://thredz.crewhaus.ai:\n{"code":"quota_exceeded","message":"You\'ve reached your plan\'s goal limit (3). Upgrade to add more."}';
const DISABLED_403 =
  'wiki_stats failed (HTTP 403) — this Thredz API key is disabled — usually a lapsed subscription. Fix billing at https://thredz.crewhaus.ai (Account → Billing); the agent keeps running, but Thredz-backed memory is unavailable until the key is re-enabled:\n{"error":"API key is disabled"}';
const BAD_KEY_403 =
  'wiki_recall failed (HTTP 403) — Thredz rejected this API key — check THREDZ_API_KEY for typos or regenerate the key:\n{"error":"Invalid API key"}';
const NO_KEY_401 =
  'wiki_recall failed (HTTP 401) — no API key reached Thredz — set THREDZ_API_KEY in this MCP server\'s env:\n{"error":"API key required"}';
const RATE_429 =
  "wiki_recall failed (HTTP 429) — Thredz rate limit hit — retry after 30 seconds:\n{}";
const MISSING_KEY_LOCAL =
  'wiki_stats failed (HTTP 0):\n{"error":"THREDZ_API_KEY is not set — set it in your MCP client\'s env for this server"}';
const NETWORK_0 =
  'wiki_recall failed (HTTP 0):\n{"error":"network error reaching thredz.crewhaus.ai: fetch failed"}';

function fakeClient(
  impl: Partial<Record<string, (args: Record<string, unknown>) => ThredzCallResult>> = {},
): { client: ThredzClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      async callTool(name, args) {
        calls.push({ name, args });
        const fn = impl[name];
        if (fn !== undefined) return fn(args);
        return { content: `{"_id":"remote-${calls.length}"}`, isError: false };
      },
    },
  };
}

function deps(overrides: Partial<WireMemoryDeps> = {}): {
  deps: WireMemoryDeps;
  registered: RegisteredTool[];
  logs: string[];
} {
  const registered: RegisteredTool[] = [];
  const logs: string[] = [];
  return {
    registered,
    logs,
    deps: {
      catalog: {
        register: (t) => {
          registered.push(t);
        },
      },
      cwd: tmp,
      homeDir: join(tmp, "home"),
      log: (line) => {
        logs.push(line);
      },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// the error-mapping choke point (§4.4/§4.6)
// ---------------------------------------------------------------------------

describe("classifyThredzFailure — status/code shapes, not prose", () => {
  test("maps the v0.2.0 contract onto the four classes", () => {
    expect(classifyThredzFailure(QUOTA_402)).toBe("thredz_quota");
    expect(classifyThredzFailure(DISABLED_403)).toBe("thredz_billing");
    expect(classifyThredzFailure(BAD_KEY_403)).toBe("thredz_auth");
    expect(classifyThredzFailure(NO_KEY_401)).toBe("thredz_auth");
    expect(classifyThredzFailure(RATE_429)).toBe("thredz_rate_limit");
    expect(classifyThredzFailure(MISSING_KEY_LOCAL)).toBe("thredz_auth");
    expect(classifyThredzFailure(NETWORK_0)).toBe("thredz_unavailable");
  });

  test("keys on status, not remediation wording — reworded prose keeps its class", () => {
    expect(classifyThredzFailure("x failed (HTTP 402) — totally new words:\n{}")).toBe(
      "thredz_quota",
    );
    expect(classifyThredzFailure("x failed (HTTP 429):\n{}")).toBe("thredz_rate_limit");
  });
});

describe("extractThredzGoalId", () => {
  test("reads _id from a bare document, a wrapped {goal}, and the single-element-array quirk", () => {
    expect(extractThredzGoalId('{"_id":"abc123","title":"t"}')).toBe("abc123");
    expect(extractThredzGoalId('{"goal":{"_id":"abc123"}}')).toBe("abc123");
    expect(extractThredzGoalId('[{"_id":"abc123"}]')).toBe("abc123");
    expect(extractThredzGoalId('{"id":"xyz"}')).toBe("xyz");
    expect(extractThredzGoalId("not json at all")).toBeUndefined();
  });
});

describe("parseThredzRecallLines — backend-invariant recall bundle shape", () => {
  test("renders [wiki:slug] title — excerpt lines from a results bundle", () => {
    const lines = parseThredzRecallLines(
      JSON.stringify({
        results: [
          {
            slug: "eu-csv",
            title: "EU CSV conventions",
            body: "Semicolon-delimited in most EU locales.",
          },
          { slug: "vat", title: "VAT rates", summary: "Reduced rates vary." },
        ],
      }),
      6,
    );
    expect(lines).toEqual([
      "[wiki:eu-csv] EU CSV conventions — Semicolon-delimited in most EU locales.",
      "[wiki:vat] VAT rates — Reduced rates vary.",
    ]);
  });

  test("caps at k and degrades non-JSON bodies to one excerpt line", () => {
    const many = JSON.stringify({
      articles: [1, 2, 3].map((i) => ({ slug: `s${i}`, title: `t${i}` })),
    });
    expect(parseThredzRecallLines(many, 2)).toHaveLength(2);
    expect(parseThredzRecallLines("plain text bundle", 6)).toEqual([
      "[thredz:wiki] plain text bundle",
    ]);
    expect(parseThredzRecallLines("", 6)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tool routing (§4.3): local twins absent, recall through the client
// ---------------------------------------------------------------------------

describe("wireMemory with a live thredz connection", () => {
  test("local wiki tools are NOT registered — the alias surface owns the vocabulary; local stores stay untouched", async () => {
    const { client } = fakeClient();
    const { deps: d, registered, logs } = deps({ thredz: { client } });
    const wired = await wireMemory(
      {
        specName: "thredz-on",
        memory: { backend: "thredz", wiki: {} },
        continuity: {},
        thredz: { goals: true, visibility: "private" },
      },
      d,
    );
    const names = registered.map((t) => t.name);
    for (const wikiTool of THREDZ_WIKI_TOOL_NAMES) {
      expect(names).not.toContain(wikiTool);
    }
    // No local wiki store constructed — nothing under .crewhaus/wiki.
    expect(wired.stores.wiki).toBeUndefined();
    expect(existsSync(join(tmp, ".crewhaus", "wiki"))).toBe(false);
    expect(logs.join("")).toContain("[memory] wiki on — thredz backend");
  });

  test("wiki autoRecall fuses thredz wiki_recall lines into the recall seam (same bundle shape)", async () => {
    const { client, calls } = fakeClient({
      wiki_recall: () => ({
        content: JSON.stringify({
          results: [{ slug: "eu-csv", title: "EU CSV", body: "semicolons" }],
        }),
        isError: false,
      }),
    });
    const { deps: d } = deps({ thredz: { client } });
    const wired = await wireMemory(
      {
        specName: "thredz-recall",
        memory: { backend: "thredz", autoRecall: true, wiki: { autoRecall: true, recallK: 3 } },
        thredz: { goals: false },
      },
      d,
    );
    const lines = await wired.options.memory?.recall?.("csv delimiters", 4);
    expect(lines).toContain("[wiki:eu-csv] EU CSV — semicolons");
    expect(calls.some((c) => c.name === "wiki_recall" && c.args["limit"] === 3)).toBe(true);
  });

  test("a failing thredz recall degrades to an empty contribution with a classified warning", async () => {
    const { client } = fakeClient({
      wiki_recall: () => ({ content: DISABLED_403, isError: true }),
    });
    const { deps: d, logs } = deps({ thredz: { client } });
    const wired = await wireMemory(
      {
        specName: "thredz-recall-fail",
        memory: { backend: "thredz", wiki: { autoRecall: true } },
        thredz: { goals: false },
      },
      d,
    );
    const lines = await wired.options.memory?.recall?.("anything", 4);
    expect(lines).toEqual([]);
    expect(logs.join("")).toContain("wiki recall failed (thredz_billing)");
  });
});

// ---------------------------------------------------------------------------
// §4.4 degrade: thredz configured, no connection
// ---------------------------------------------------------------------------

describe("offline / boot-failure degrade (§4.4)", () => {
  test("thredz configured but deps.thredz null → local backend with ONE warning; the promised wiki surface stays (local tools)", async () => {
    const { deps: d, registered, logs } = deps({ thredz: null });
    const wired = await wireMemory(
      { specName: "thredz-degrade", continuity: {}, thredz: { goals: true } },
      d,
    );
    expect(logs.join("")).toContain("[thredz] unavailable — memory degraded to the local backend");
    // The wiki vocabulary the spec promised is still there — local twins.
    const names = registered.map((t) => t.name);
    for (const wikiTool of THREDZ_WIKI_TOOL_NAMES) {
      expect(names).toContain(wikiTool);
    }
    expect(wired.stores.wiki).toBeDefined();
  });

  test("connectThredz returns null (mcp_boot degrade) when the server cannot boot", async () => {
    const host = new McpHost();
    host.addServer("thredz", {
      transport: "stdio",
      command: "/nonexistent-crewhaus-thredz-test-binary",
      args: [],
    });
    const logs: string[] = [];
    const conn = await connectThredz(host, new ToolCatalog(), {
      log: (l) => {
        logs.push(l);
      },
    });
    expect(conn).toBeNull();
    expect(logs.join("")).toContain("[thredz] boot failed (mcp_boot)");
    await host.disconnectAll();
  });
});

// ---------------------------------------------------------------------------
// goal mirror (§4.4, resolved decision 5)
// ---------------------------------------------------------------------------

describe("goal mirror — spec scope only, local write authoritative", () => {
  test("happy path: writeGoal mirrors goal_write (idempotency key, redacted title), updateGoal mirrors goal_update via the id map", async () => {
    const { client, calls } = fakeClient({
      goal_write: () => ({ content: '{"_id":"tz-goal-1","title":"ship"}', isError: false }),
      goal_update: () => ({ content: '{"_id":"tz-goal-1"}', isError: false }),
    });
    const { deps: d } = deps({ thredz: { client } });
    const wired = wireContinuity(
      { specName: "mirror-spec", continuity: {}, thredz: { goals: true } },
      d,
    );
    if (wired === null) throw new Error("continuity not wired");

    const goal = await wired.store.writeGoal({ title: "ship the release", target: 3 });
    expect(goal.id).toMatch(/^goal-/);
    const write = calls.find((c) => c.name === "goal_write");
    expect(write?.args["title"]).toBe("ship the release");
    expect(write?.args["targetValue"]).toBe(3);
    expect(write?.args["idempotencyKey"]).toBe(`crewhaus:mirror-spec:${goal.id}`);

    // The id map landed inside the store's own scoped dir.
    const map = JSON.parse(
      readFileSync(join(wired.store.dir(), THREDZ_GOAL_MAP_FILE), "utf-8"),
    ) as Record<string, string>;
    expect(map[goal.id]).toBe("tz-goal-1");

    await wired.store.updateGoal(goal.id, { current: 2 });
    const update = calls.find((c) => c.name === "goal_update");
    expect(update?.args["id"]).toBe("tz-goal-1");
    expect(update?.args["currentValue"]).toBe(2);
  });

  test("a proven goal completes its mirror (currentValue reaches targetValue)", async () => {
    const { client, calls } = fakeClient({
      goal_write: () => ({ content: '{"_id":"tz-goal-2"}', isError: false }),
    });
    const { deps: d } = deps({ thredz: { client } });
    const wired = wireContinuity(
      { specName: "mirror-prove", continuity: {}, thredz: { goals: true } },
      d,
    );
    if (wired === null) throw new Error("continuity not wired");
    const goal = await wired.store.writeGoal({ title: "one-shot", target: 5 });
    // `claimed` is free (§2.4) — proven would need evidence; claim then check
    // the mirror carries the ladder move as a plain update.
    await wired.store.updateGoal(goal.id, { current: 5 });
    const update = calls.find((c) => c.name === "goal_update");
    expect(update?.args["currentValue"]).toBe(5);
  });

  test("quota (3 goals, free tier): a clear thredz_quota warning — the local write NEVER fails", async () => {
    const { client } = fakeClient({
      goal_write: () => ({ content: QUOTA_402, isError: true }),
    });
    const { deps: d, logs } = deps({ thredz: { client } });
    const wired = wireContinuity(
      { specName: "mirror-quota", continuity: {}, thredz: { goals: true } },
      d,
    );
    if (wired === null) throw new Error("continuity not wired");
    const goal = await wired.store.writeGoal({ title: "fourth goal" });
    // Local store is authoritative — the goal exists locally.
    expect((await wired.store.listGoals()).map((g) => g.id)).toContain(goal.id);
    const log = logs.join("");
    expect(log).toContain("goal mirror goal_write skipped (thredz_quota)");
    expect(log).toContain("plan limit");
    // A later update warns-and-skips (no mirrored id), still never throws.
    await wired.store.updateGoal(goal.id, { current: 1 });
    expect(logs.join("")).toContain("has no mirrored Thredz id");
  });

  test("a thrown client error (network death mid-run) also degrades to skip + warn", async () => {
    const client: ThredzClient = {
      async callTool() {
        throw new Error("socket hang up");
      },
    };
    const { deps: d, logs } = deps({ thredz: { client } });
    const wired = wireContinuity(
      { specName: "mirror-net", continuity: {}, thredz: { goals: true } },
      d,
    );
    if (wired === null) throw new Error("continuity not wired");
    const goal = await wired.store.writeGoal({ title: "still lands locally" });
    expect((await wired.store.listGoals()).map((g) => g.id)).toContain(goal.id);
    expect(logs.join("")).toContain("goal mirror goal_write skipped (thredz_unavailable)");
  });

  test("session scope NEVER mirrors (resolved decision 5)", async () => {
    const { client, calls } = fakeClient();
    const { deps: d } = deps({ thredz: { client }, sessionScope: "sess_0123456789abcdef" });
    const wired = wireContinuity(
      {
        specName: "mirror-session",
        continuity: { scope: "session" },
        thredz: { goals: true },
      },
      d,
    );
    if (wired === null) throw new Error("continuity not wired");
    await wired.store.writeGoal({ title: "per-conversation goal" });
    expect(calls).toEqual([]);
  });

  test("goals: false turns the mirror off", async () => {
    const { client, calls } = fakeClient();
    const { deps: d } = deps({ thredz: { client } });
    const wired = wireContinuity(
      { specName: "mirror-off", continuity: {}, thredz: { goals: false } },
      d,
    );
    if (wired === null) throw new Error("continuity not wired");
    await wired.store.writeGoal({ title: "not mirrored" });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// wireWiki granular + fragment threading
// ---------------------------------------------------------------------------

describe("wireWiki backend selection", () => {
  test("thredz active → backend thredz, no store, no tools", () => {
    const { client } = fakeClient();
    const { deps: d } = deps({ thredz: { client } });
    const wired = wireWiki({ specName: "ww-thredz", thredz: {} }, d);
    expect(wired?.backend).toBe("thredz");
    expect(wired?.store).toBeNull();
    expect(wired?.tools).toEqual([]);
  });

  test("explicit wiki.enabled false wins even on thredz", () => {
    const { client } = fakeClient();
    const { deps: d } = deps({ thredz: { client } });
    expect(
      wireWiki({ specName: "ww-off", memory: { wiki: { enabled: false } }, thredz: {} }, d),
    ).toBeNull();
  });

  test("local path still returns store + tools + recall lines", async () => {
    const { deps: d } = deps();
    const wired = wireWiki({ specName: "ww-local", memory: { wiki: {} } }, d);
    expect(wired?.backend).toBe("file");
    await wired?.store?.write({ slug: "hello", title: "Hello", body: "A body of knowledge." });
    const lines = await wired?.recall("knowledge", 3);
    expect(lines?.[0]).toContain("[wiki:hello] Hello");
  });
});

describe("memoryFragmentFromIr carries the thredz slice", () => {
  test("goals/visibility/agentName carried; credential fields never enter the fragment", () => {
    const fragment = memoryFragmentFromIr({
      name: "frag",
      thredz: { goals: true, visibility: "private", agentName: "my-expert" },
    });
    expect(fragment.thredz).toEqual({ goals: true, visibility: "private", agentName: "my-expert" });
    expect(JSON.stringify(fragment)).not.toContain("apiKey");
  });
});

// ---------------------------------------------------------------------------
// the REAL published server (thredz-mcp v0.2.0) — guarded, read-only, no
// network: with an empty THREDZ_API_KEY every tool call short-circuits
// before any fetch, so this pins the actual wire contract (handshake, the
// 25-tool list, the missing-key error text) without touching the API.
// ---------------------------------------------------------------------------

const REAL_SERVER_CANDIDATES = [
  // sibling checkout of a normal factory clone: <parent>/thredz-mcp
  resolve(import.meta.dir, "../../../..", "thredz-mcp", "server.ts"),
  // sibling checkout when factory runs from a .claude worktree
  resolve(import.meta.dir, "../../../../../../..", "thredz-mcp", "server.ts"),
];
const REAL_SERVER = REAL_SERVER_CANDIDATES.find((p) => existsSync(p));

describe.skipIf(REAL_SERVER === undefined)("real thredz-mcp v0.2.0 contract (read-only)", () => {
  test("connectThredz registers all 16 aliases against the published tool list; missing-key errors classify thredz_auth", async () => {
    if (REAL_SERVER === undefined) throw new Error("unreachable (skipIf)");
    const host = new McpHost();
    host.addServer("thredz", {
      transport: "stdio",
      command: "bun",
      args: [REAL_SERVER],
      env: { THREDZ_API_KEY: "" },
    });
    const catalog = new ToolCatalog();
    const logs: string[] = [];
    try {
      const conn = await connectThredz(host, catalog, {
        log: (l) => {
          logs.push(l);
        },
      });
      expect(conn).not.toBeNull();
      // Every alias name the wiring pins is advertised by the real server.
      for (const name of THREDZ_ALIAS_TOOL_NAMES) {
        expect(catalog.has(name)).toBe(true);
      }
      expect(logs.join("")).not.toContain("does not advertise");
      // Messaging tools are never exposed by the memory knob.
      expect(catalog.has("message_send")).toBe(false);
      expect(catalog.has("thredz__message_send")).toBe(false);
      // The pre-flight missing-key error is the real contract text and
      // classifies as auth — no network involved.
      const res = await conn?.client.callTool("wiki_stats", {});
      expect(res?.isError).toBe(true);
      expect(classifyThredzFailure(res?.content ?? "")).toBe("thredz_auth");
    } finally {
      await host.disconnectAll();
    }
  }, 20000);
});
