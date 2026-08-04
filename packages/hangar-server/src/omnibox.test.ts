/**
 * HM-189 — the ⌘K index.
 *
 * Three properties are load-bearing and each is asserted here: the index is
 * built LAZILY (nothing before the first query), it is INCREMENTAL (a second
 * query re-walks nothing), and it is a READ (browsing a harness with expired
 * sessions deletes nothing — the invariant `SessionStore.list()` breaks).
 * Plus the scoring, which an operator has to be able to predict, and the
 * action proposals, which must never be executable from the search route.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import {
  type IndexHarness,
  type OmniEntry,
  buildHarnessEntries,
  createOmniIndex,
  harnessIndexToken,
  matchActions,
  rankEntries,
  scoreMatch,
} from "./omnibox";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const DAY = 86_400_000;

const entry = (over: Partial<OmniEntry>): OmniEntry => ({
  kind: "harness",
  id: "x",
  title: "x",
  subtitle: "",
  href: "#/",
  harnessId: null,
  ...over,
});

describe("scoreMatch", () => {
  test("exact beats prefix beats word-start beats substring beats subsequence", () => {
    const scores = [
      scoreMatch("polymarket", "polymarket"),
      scoreMatch("polymarket-trader", "poly"),
      scoreMatch("my-poly-bot", "poly"),
      scoreMatch("apolyx", "poly"),
      scoreMatch("p-o-l-y", "poly"),
    ];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((s) => s > 0)).toBe(true);
  });

  test("case-insensitive, and a non-match is 0", () => {
    expect(scoreMatch("Polymarket", "poly")).toBeGreaterThan(0);
    expect(scoreMatch("polymarket", "zebra")).toBe(0);
    expect(scoreMatch("anything", "")).toBe(0);
  });

  test("a shorter title outranks a longer one at the same match class", () => {
    expect(scoreMatch("cli", "cli")).toBeGreaterThan(scoreMatch("cli-extended-example", "cli"));
  });

  test("a regex metacharacter in the query is matched literally, not compiled", () => {
    expect(scoreMatch("a.b", "a.b")).toBe(1000);
    expect(() => scoreMatch("anything", "(")).not.toThrow();
    expect(scoreMatch("axb", "a.b")).toBe(0);
  });
});

describe("rankEntries", () => {
  test("ranks by score, then kind order, then title — stable across identical queries", () => {
    const entries = [
      entry({ kind: "session", id: "s", title: "poly-session" }),
      entry({ kind: "harness", id: "h", title: "poly-session" }),
      entry({ kind: "wiki", id: "w", title: "unrelated" }),
    ];
    const first = rankEntries(entries, "poly-session");
    const second = rankEntries(entries, "poly-session");
    expect(first.map((e) => e.id)).toEqual(["h", "s"]);
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
  });

  test("the subtitle is never matched, so a long path cannot outrank a title", () => {
    const entries = [
      entry({ id: "byPath", title: "unrelated", subtitle: "/home/op/polymarket" }),
      entry({ id: "byTitle", title: "polymarket" }),
    ];
    expect(rankEntries(entries, "polymarket").map((e) => e.id)).toEqual(["byTitle"]);
  });

  test("the limit is respected", () => {
    const many = Array.from({ length: 50 }, (_v, i) => entry({ id: `e${i}`, title: `poly${i}` }));
    expect(rankEntries(many, "poly", 5)).toHaveLength(5);
  });
});

describe("matchActions", () => {
  const harnesses = [
    { id: "hrn_1", specName: "polymarket-trader", dir: "/h/poly" },
    { id: "hrn_2", specName: "support-bot", dir: "/h/support" },
  ];

  test("a `<verb> <harness>` query proposes the matching harnesses, with a CLI twin", () => {
    const actions = matchActions("start poly", harnesses);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.route).toBe("procStart");
    expect(actions[0]?.params).toEqual({ id: "hrn_1" });
    expect(actions[0]?.cliTwin).toContain("crewhaus daemon start");
    // Every action must be confirmed before it runs — the search route
    // executes nothing.
    expect(actions.every((a) => a.confirm === true)).toBe(true);
  });

  test("a bare verb, an unknown verb, and a verb-shaped harness name propose nothing", () => {
    expect(matchActions("start", harnesses)).toEqual([]);
    expect(matchActions("delete poly", harnesses)).toEqual([]);
    // "restart-tests" typed as one word is a search, not an instruction.
    expect(matchActions("restart-tests", harnesses)).toEqual([]);
    expect(matchActions("start nothing-like-this", harnesses)).toEqual([]);
  });

  test("every supported verb maps to a real process route", () => {
    for (const verb of ["start", "stop", "restart", "drain"]) {
      const actions = matchActions(`${verb} support`, harnesses);
      expect(`${verb}:${actions[0]?.route ?? ""}`).toMatch(/proc/i);
    }
  });
});

describe("buildHarnessEntries", () => {
  test("indexes names and ids across the stores, never opening a transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-omni-"));
    try {
      const dir = join(root, "indexed");
      makeFixtureHarness(dir, {
        specName: "indexed",
        sessions: [{ id: "sess_00000000000000aa" }],
        wikiArticles: { "how-to-deploy": "# How to deploy\n" },
        memories: { indexed: [{ id: "m1", text: "a fact" }] },
        evalIndex: [
          { runId: "run_00000000000000aa", datasetName: "smoke", passRate: 1, ts: "2026-08-01" },
        ],
      });
      const harness: IndexHarness = {
        id: "hrn_00000000000000a1",
        specName: "indexed",
        dir,
        groups: ["prod"],
        tags: ["canary"],
      };
      const entries = buildHarnessEntries(harness);
      const kinds = new Set(entries.map((e) => e.kind));
      for (const kind of ["harness", "group", "tag", "session", "wiki", "fact", "eval-run"]) {
        expect(`${kind}:${kinds.has(kind as OmniEntry["kind"])}`).toBe(`${kind}:true`);
      }
      // Deep links are console routes, and the harness id is in them.
      const session = entries.find((e) => e.kind === "session");
      expect(session?.href).toBe("#/h/hrn_00000000000000a1/sessions/sess_00000000000000aa");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createOmniIndex", () => {
  const harness: IndexHarness = {
    id: "hrn_1",
    specName: "polymarket",
    dir: "/does/not/matter",
    groups: [],
    tags: [],
  };

  test("builds nothing until the first query, then memoizes against the token", () => {
    let builds = 0;
    let token = "t0";
    const index = createOmniIndex({
      build: (h) => {
        builds += 1;
        return [entry({ id: h.id, title: h.specName, harnessId: h.id })];
      },
      token: () => token,
    });
    expect(index.size()).toBe(0);
    expect(builds).toBe(0);

    // An empty query must not build either — a focused-but-empty ⌘K box is
    // the most common state there is.
    index.search("", [harness]);
    expect(builds).toBe(0);

    const first = index.search("poly", [harness]);
    expect(builds).toBe(1);
    expect(first.indexed).toBe(1);
    expect(first.entries).toHaveLength(1);

    const second = index.search("poly", [harness]);
    expect(builds).toBe(1);
    expect(second.indexed).toBe(0);

    // The token moving (a session landed) rebuilds exactly that harness.
    token = "t1";
    const third = index.search("poly", [harness]);
    expect(builds).toBe(2);
    expect(third.indexed).toBe(1);
  });

  test("forget drops a harness's entries", () => {
    const index = createOmniIndex({
      build: (h) => [entry({ id: h.id, title: h.specName })],
      token: () => "t",
    });
    index.search("poly", [harness]);
    expect(index.size()).toBe(1);
    index.forget("hrn_1");
    expect(index.size()).toBe(0);
  });

  test("harnessIndexToken changes when an indexed store changes", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-omni-token-"));
    try {
      const dir = join(root, "h");
      makeFixtureHarness(dir, { specName: "h" });
      const before = harnessIndexToken(dir);
      writeFileSync(join(dir, ".crewhaus", "approvals.jsonl"), "{}\n");
      expect(harnessIndexToken(dir)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GET /api/search", () => {
  test("finds a harness by name and proposes an action, and boots without indexing", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "searchable");
      makeFixtureHarness(dir, {
        specName: "polymarket-trader",
        sessions: [{ id: "sess_00000000000000aa" }],
        wikiArticles: { "how-to-deploy": "# How to deploy\n" },
      });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;

      // An empty query costs nothing — the proof that boot is not paying.
      const empty = await t.api("/api/search?q=");
      expect(empty.body["entries"]).toEqual([]);
      expect(empty.body["size"]).toBe(0);

      const hit = await t.api("/api/search?q=polymarket");
      expect(hit.status).toBe(200);
      const entries = hit.body["entries"] as OmniEntry[];
      expect(entries[0]?.kind).toBe("harness");
      expect(entries[0]?.harnessId).toBe(id);
      expect(hit.body["indexed"]).toBe(1);

      const wiki = await t.api("/api/search?q=deploy");
      expect((wiki.body["entries"] as OmniEntry[]).some((e) => e.kind === "wiki")).toBe(true);
      // Cached: the second query indexed nothing.
      expect(wiki.body["indexed"]).toBe(0);

      const action = await t.api("/api/search?q=start%20polymarket");
      const actions = action.body["actions"] as Array<{ confirm: boolean; route: string }>;
      expect(actions[0]?.route).toBe("procStart");
      expect(actions[0]?.confirm).toBe(true);
      // The search route PROPOSED it and did nothing: the daemon is stopped.
      expect((await t.api(`/api/h/${id}/proc`)).body["state"]).toBe("stopped");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("indexing a harness with expired sessions deletes nothing", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "aged");
      makeFixtureHarness(dir, {
        specName: "aged",
        sessions: [{ id: "sess_00000000000000ab", mtimeMs: NOW - 400 * DAY }],
      });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const hit = await t.api("/api/search?q=sess_00000000000000ab");
      expect((hit.body["entries"] as OmniEntry[])[0]?.kind).toBe("session");
      const sessions = await t.api(`/api/h/${id}/sessions`);
      expect((sessions.body["sessions"] as Array<{ id: string }>).map((s) => s.id)).toContain(
        "sess_00000000000000ab",
      );
    } finally {
      await t.stop();
    }
  }, 20_000);
});
