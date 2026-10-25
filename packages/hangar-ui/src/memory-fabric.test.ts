/**
 * Unit tests for the memory-fabric view's decisions. Everything this screen
 * DECIDES — whether a fact is past its TTL, which traffic light a folded
 * status gets, whether a wiki write came back stale or gated, whether the
 * dream lane is overdue, and (the one that must never regress) that unpriced
 * model spend is reported apart from priced spend rather than summed into it
 * — is a pure function in `views/memory-fabric.js`, so it is proven here
 * rather than in a browser. The exact file the browser loads is the file
 * under test.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as fabric from "../assets/js/views/memory-fabric.js";

const DAY = 86_400_000;

describe("ttlLabel", () => {
  test("counts down, then counts up past the TTL", () => {
    expect(fabric.ttlLabel(3 * DAY)).toBe("expires in 3d");
    expect(fabric.ttlLabel(-2 * DAY)).toBe("past TTL by 2d");
    expect(fabric.ttlLabel(2 * 3_600_000)).toBe("expires in 2h");
  });

  test("a fact with no expiry has no countdown (absence, not zero)", () => {
    expect(fabric.ttlLabel(null)).toBe(null);
    expect(fabric.ttlLabel(undefined)).toBe(null);
  });
});

describe("factTone", () => {
  test("every folded status maps to a light — and superseded is not an alarm", () => {
    expect(fabric.factTone("live")).toBe("ok");
    expect(fabric.factTone("superseded")).toBe("off");
    expect(fabric.factTone("expired")).toBe("warn");
  });
});

describe("costSummary", () => {
  test("unpriced spend is its own bucket, never folded into the total", () => {
    const summary = fabric.costSummary({
      costUsdMicros: 1500,
      unpriced: {
        models: [{ wire: "local/experiment", turns: 4 }],
        turns: 4,
        note: "these models have no pricing entry — their spend is UNKNOWN",
      },
    });
    expect(summary.priced).toBe(1500);
    expect(summary.unpricedModels).toBe(1);
    expect(summary.unpricedTurns).toBe(4);
    expect(String(summary.note)).toContain("UNKNOWN");
  });

  test("with everything priced there is no unpriced line to draw", () => {
    const summary = fabric.costSummary({ costUsdMicros: 10, unpriced: { models: [], turns: 0 } });
    expect(summary.unpricedModels).toBe(0);
    expect(summary.note).toBe(null);
  });

  test("a missing payload degrades to zeros rather than throwing", () => {
    expect(fabric.costSummary(null)).toEqual({
      priced: 0,
      unpricedModels: 0,
      unpricedTurns: 0,
      note: null,
    });
  });
});

describe("writeOutcome", () => {
  test("a stale version is a retryable STATE carrying the version that moved", () => {
    const outcome = fabric.writeOutcome({
      ok: false,
      code: "stale_article_version",
      currentVersion: 4,
      current: { version: 4, body: "what is on disk now" },
      note: "the article moved under you",
    });
    expect(outcome.kind).toBe("stale");
    expect(outcome.retryVersion).toBe(4);
    expect(outcome.currentBody).toBe("what is on disk now");
  });

  test("the local `## Sources` gate is its own kind, not a generic failure", () => {
    expect(fabric.writeOutcome({ ok: false, code: "missing_sources" }).kind).toBe("gate");
  });

  test("success and everything else", () => {
    expect(fabric.writeOutcome({ ok: true, note: "version 2 written" })).toEqual({
      kind: "ok",
      message: "version 2 written",
      retryVersion: null,
    });
    expect(
      fabric.writeOutcome({ ok: false, code: "wiki_store_refused", note: "locked" }).kind,
    ).toBe("error");
  });
});

describe("dreamTone", () => {
  test("declared + overdue + off are three distinct, labelled states", () => {
    expect(fabric.dreamTone({ declared: true, cadence: "24h", overdue: false })).toEqual({
      state: "ok",
      label: "every 24h",
    });
    expect(fabric.dreamTone({ declared: true, cadence: "24h", overdue: true }).state).toBe("warn");
    expect(fabric.dreamTone({ declared: false }).state).toBe("off");
    // The label is never empty: a colour alone is not a status.
    for (const payload of [{ declared: false }, { declared: true, overdue: true }]) {
      expect(String(fabric.dreamTone(payload).label).length).toBeGreaterThan(0);
    }
  });
});

describe("ladderStatus", () => {
  // design/0.8.0 §6.3 — under `continuity.proof: off` a step or goal reaches
  // `proven` by assertion. The server says so beside `status`; the panel used
  // to render `status` alone, so nobody-checked read as a plain green proven.
  test("a step proven by assertion is amber and says unverified, naming the refs it cited", () => {
    const shown = fabric.ladderStatus({
      status: "proven",
      statusLabel: "[proven (unverified)]",
      provenByAssertion: true,
      unverified: [
        { toolUseId: "toolu_asserted01", sessionId: "sess_00000000000000aa", recordedAt: "x" },
        { toolUseId: "toolu_asserted02", sessionId: null, recordedAt: "x" },
      ],
    });
    expect(shown.tone).toBe("warn");
    expect(shown.text).toBe("proven (unverified)");
    expect(shown.title).toContain("continuity.proof: off");
    expect(shown.title).toContain("toolu_asserted01 (sess_00000000000000aa), toolu_asserted02");
    // The flag alone is enough: a label the server left out never turns it green.
    expect(fabric.ladderStatus({ status: "proven", provenByAssertion: true })).toMatchObject({
      tone: "warn",
      text: "proven (unverified)",
    });
  });

  test("a step the event log proves stays green; every other rung keeps its light", () => {
    expect(
      fabric.ladderStatus({ status: "proven", statusLabel: "[proven]", provenByAssertion: false }),
    ).toEqual({ tone: "ok", text: "proven", title: null });
    expect(fabric.ladderStatus({ status: "claimed", statusLabel: "[claimed]" }).tone).toBe("warn");
    expect(fabric.ladderStatus({ status: "open", statusLabel: "[open]" })).toEqual({
      tone: "off",
      text: "open",
      title: null,
    });
    // A server that predates the fields reads exactly as before.
    expect(fabric.ladderStatus({ status: "in_progress" })).toEqual({
      tone: "unknown",
      text: "in_progress",
      title: null,
    });
  });

  test("steps and goals both render through it, never through the bare status", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/memory-fabric.js", import.meta.url),
    ).text();
    expect(source).not.toMatch(/dot\(ladderTone\((?:step|g)\.status\)/);
    expect(source.match(/ladderDot\((?:step|g)\)/g)?.length).toBe(2);
  });
});

describe("staleLabel", () => {
  test("says how long since the last touch, and marks the stale ones", () => {
    expect(fabric.staleLabel({ staleMs: 45 * DAY, stale: true })).toBe(
      "stale — 45d since last touch",
    );
    expect(fabric.staleLabel({ staleMs: 2 * DAY, stale: false })).toBe("2d since last touch");
    expect(fabric.staleLabel({ staleMs: 3_600_000, stale: false })).toBe("touched today");
  });

  test("an article with no timestamp gets no invented freshness", () => {
    expect(fabric.staleLabel({ staleMs: null })).toBe(null);
    expect(fabric.staleLabel(null)).toBe(null);
  });
});

describe("the view module's own hygiene", () => {
  test("it reads every M3 memory route through the generated api wrappers", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/memory-fabric.js", import.meta.url),
    ).text();
    const routes = [
      "memoryFacts",
      "memoryForget",
      "memorySweep",
      "memoryRecall",
      "memoryMigrate",
      "continuity",
      "continuityTrash",
      "continuityRestore",
      "learning",
      "knowledge",
      "knowledgeSync",
      "dreamScaffold",
      "wikiWrite",
      "wikiVersions",
      "wikiVersion",
      "wikiLinks",
      "wikiSignals",
      "wikiArchive",
      "wikiReflect",
      "watchmeAnalytics",
      "watchmeReports",
      "watchmeReport",
      "watchmeIntents",
      "watchmeToggle",
      "watchmeSynthesized",
      "watchmeApply",
      "watchmePublish",
    ];
    for (const key of routes) {
      expect(`${key}:${source.includes(`api.${key}(`)}`).toBe(`${key}:true`);
    }
  });

  test("no destructive verb is offered: the fabric has no delete affordance", async () => {
    const source = await Bun.file(
      new URL("../assets/js/views/memory-fabric.js", import.meta.url),
    ).text();
    // Button labels are what an operator reads. "Forget", "Archive" and
    // "Restore" are reversible by construction; a "Delete" here would be a
    // promise the stores cannot keep.
    expect(source.includes('text: "Delete"')).toBe(false);
    expect(source.includes("Permanently")).toBe(false);
  });
});
