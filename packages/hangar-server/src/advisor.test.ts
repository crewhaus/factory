/**
 * The Advisor (M5): the pure ranking, and the feed → act/dismiss/reopen →
 * trend/report/issue loops driven end-to-end over a fixture harness.
 *
 * The populated item shapes are covered HERE, against a fixture this area
 * controls — the shared contract fixture asserts the advisor arrays only as
 * arrays, because an optimally-running harness has an empty feed by design.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AdvisorInputs, deriveAdvisorItems } from "./advisor";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

/** A clean baseline every derivation test overrides one axis of. */
const CLEAN: AdvisorInputs = {
  preflight: { items: [] },
  specUnreadable: false,
  specIssues: [],
  evalHealth: { healthy: true, note: "at baseline" },
  evalRuns: 3,
  baselinePinned: true,
  openIncidents: 0,
  procState: "running",
  pendingApprovals: 0,
  budget: { declaredUsd: 10, spentUsd: 1 },
  adviceProposals: 0,
  overdueDreams: [],
};

describe("deriveAdvisorItems (pure)", () => {
  test("a clean harness derives ZERO items — optimal is a real state", () => {
    expect(deriveAdvisorItems(CLEAN)).toEqual([]);
  });

  test("severity ordering: critical first, suggestions last", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      preflight: {
        items: [
          {
            id: "credentials.anthropic",
            area: "credentials",
            level: "blocking",
            message: "no key",
          },
        ],
      },
      evalHealth: { healthy: false, note: "0.4 < 0.7 baseline" },
      adviceProposals: 2,
    });
    expect(items.map((i) => i.severity)).toEqual(["critical", "warn", "suggestion"]);
    // Every item explains itself: tooltip text, guidance and a fix screen.
    for (const item of items) {
      expect(item.explain.length).toBeGreaterThan(0);
      expect(item.guidance.length).toBeGreaterThan(0);
      expect(item.screen.length).toBeGreaterThan(0);
    }
  });

  test("item ids are route-segment safe (they ride the act/dismiss paths)", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      preflight: {
        items: [
          {
            id: "credentials.anthropic:key",
            area: "credentials",
            level: "blocking",
            message: "no key",
          },
        ],
      },
      overdueDreams: ["night watch"],
    });
    for (const item of items) {
      expect(item.id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
    }
  });

  test("a blocking credentials finding proposes the doctor job; bundle proposes compile", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      preflight: {
        items: [
          {
            id: "credentials.anthropic",
            area: "credentials",
            level: "blocking",
            message: "no key",
          },
          { id: "bundle.stale", area: "bundle", level: "blocking", message: "recompile" },
        ],
      },
    });
    expect(items.map((i) => i.action?.jobKind)).toEqual(["doctor", "compile"]);
    for (const item of items) expect(item.action?.cliTwin).toContain("crewhaus");
  });

  test("a regression below baseline proposes the optimize loop", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      evalHealth: { healthy: false, note: "0.4 < 0.7 baseline" },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("eval-below-baseline");
    expect(items[0]?.action).toMatchObject({ kind: "job", jobKind: "optimize" });
  });

  test("budget ladder: silent under 80%, warn at 80%, critical at 100%", () => {
    const at = (spentUsd: number) =>
      deriveAdvisorItems({ ...CLEAN, budget: { declaredUsd: 10, spentUsd } });
    expect(at(5)).toEqual([]);
    expect(at(8.5).map((i) => i.id)).toEqual(["budget-near-limit"]);
    expect(at(12).map((i) => i.id)).toEqual(["budget-exceeded"]);
    // …and spending with NO ceiling at all is a suggestion, not silence.
    const unbudgeted = deriveAdvisorItems({
      ...CLEAN,
      budget: { declaredUsd: null, spentUsd: 2 },
    });
    expect(unbudgeted.map((i) => i.id)).toEqual(["budget-absent"]);
  });

  test("the eval ladder: no runs → suggest a first eval; runs but no baseline → suggest pinning", () => {
    const none = deriveAdvisorItems({ ...CLEAN, evalRuns: 0, baselinePinned: false });
    expect(none.map((i) => i.id)).toEqual(["evals-none"]);
    expect(none[0]?.action?.jobKind).toBe("eval");
    const unpinned = deriveAdvisorItems({ ...CLEAN, baselinePinned: false });
    expect(unpinned.map((i) => i.id)).toEqual(["evals-no-baseline"]);
  });

  test("supervision states: crash-looping is critical, parked routes to approvals", () => {
    expect(
      deriveAdvisorItems({ ...CLEAN, procState: "crash-looping" }).map((i) => [
        i.severity,
        i.screen,
      ]),
    ).toEqual([["critical", "runs"]]);
    expect(
      deriveAdvisorItems({ ...CLEAN, procState: "parked" }).map((i) => [i.severity, i.screen]),
    ).toEqual([["warn", "approvals"]]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a fixture harness
// ---------------------------------------------------------------------------

function advisorHarness(t: TestServer): string {
  return makeFixtureHarness(join(t.harnessesRoot, "advised"), {
    specName: "advised",
    // An eval history BELOW its pinned baseline, so the feed has a warn item
    // whose quick action queues the optimize loop.
    evalIndex: [
      {
        runId: "run_00000000000000aa",
        specName: "advised",
        specHash: "h",
        datasetName: "smoke",
        datasetHash: "d",
        passRate: 0.9,
        meanScore: 0.9,
        sampleCount: 2,
        ts: iso(NOW - 3 * DAY),
        outDir: "/gone",
      },
      {
        runId: "run_00000000000000ab",
        specName: "advised",
        specHash: "h",
        datasetName: "smoke",
        datasetHash: "d",
        passRate: 0.4,
        meanScore: 0.4,
        sampleCount: 2,
        ts: iso(NOW - DAY),
        outDir: "/gone",
      },
    ],
    baselines: {
      "advised::smoke": {
        specName: "advised",
        datasetName: "smoke",
        runId: "run_00000000000000aa",
        outDir: "/gone",
        datasetHash: "d",
        ts: iso(NOW - 3 * DAY),
      },
    },
  });
}

async function registered(t: TestServer): Promise<string> {
  const dir = advisorHarness(t);
  const { status, body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  expect(status).toBe(201);
  return (body["entry"] as { id: string }).id;
}

describe("the advisor loops (feed → act/dismiss/reopen → trend/reports/issues)", () => {
  test("the whole loop, over one fixture", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const id = await registered(t);

      // -- the feed: the regression item is present, explained, actionable --
      const feed = (await t.api(`/api/h/${id}/advisor`)).body;
      expect(feed["present"]).toBe(true);
      expect(feed["optimal"]).toBe(false);
      const items = feed["items"] as Array<Record<string, unknown>>;
      const regression = items.find((i) => i["id"] === "eval-below-baseline");
      expect(regression).toBeDefined();
      expect(regression?.["severity"]).toBe("warn");
      expect(String(regression?.["explain"])).toContain("pinned as acceptable");
      expect(regression?.["action"]).toMatchObject({ kind: "job", jobKind: "optimize" });
      // The feed's guidance is the top open item's guidance.
      expect(String(feed["guidance"]).length).toBeGreaterThan(0);

      // -- act, with the operator's comment injected into the record -------
      const acted = (
        await t.api(`/api/h/${id}/advisor/eval-below-baseline/act`, {
          method: "POST",
          body: JSON.stringify({ comment: "regression traced to the new prompt" }),
        })
      ).body;
      expect(acted["acted"]).toBe(true);
      expect((acted["job"] as { kind: string }).kind).toBe("optimize");
      expect((acted["decision"] as { comment: string }).comment).toBe(
        "regression traced to the new prompt",
      );
      // The queued job is visible in the queue, and the ledger line is on disk.
      const jobs = (await t.api("/api/jobs")).body;
      expect(
        (jobs["running"] as Array<{ kind: string }>)
          .concat(jobs["pending"] as Array<{ kind: string }>)
          .some((j) => j.kind === "optimize"),
      ).toBe(true);
      const harnessDir = join(t.harnessesRoot, "advised");
      const ledger = readFileSync(
        join(harnessDir, ".crewhaus", "advisor", "decisions.jsonl"),
        "utf8",
      );
      expect(ledger).toContain("regression traced to the new prompt");

      // The item stays OPEN after acting (the signal has not cleared), but
      // now carries the acted record.
      const afterAct = (await t.api(`/api/h/${id}/advisor`)).body;
      const actedItem = (afterAct["items"] as Array<Record<string, unknown>>).find(
        (i) => i["id"] === "eval-below-baseline",
      );
      expect((actedItem?.["lastAction"] as { comment: string }).comment).toBe(
        "regression traced to the new prompt",
      );

      // -- acting on a vanished item is a typed refusal, not a 404 ----------
      const gone = await t.api(`/api/h/${id}/advisor/no-such-item/act`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(gone.status).toBe(200);
      expect(gone.body["acted"]).toBe(false);
      expect(gone.body["present"]).toBe(false);

      // -- dismiss REQUIRES a reason ----------------------------------------
      const noReason = await t.api(`/api/h/${id}/advisor/eval-below-baseline/dismiss`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(noReason.status).toBe(400);
      await t.api(`/api/h/${id}/advisor/eval-below-baseline/dismiss`, {
        method: "POST",
        body: JSON.stringify({ reason: "known dataset drift — refresh lands Friday" }),
      });
      const afterDismiss = (await t.api(`/api/h/${id}/advisor`)).body;
      expect(
        (afterDismiss["items"] as Array<Record<string, unknown>>).some(
          (i) => i["id"] === "eval-below-baseline",
        ),
      ).toBe(false);
      const dismissedRow = (afterDismiss["dismissed"] as Array<Record<string, unknown>>).find(
        (i) => i["id"] === "eval-below-baseline",
      );
      expect((dismissedRow?.["dismissal"] as { reason: string }).reason).toBe(
        "known dataset drift — refresh lands Friday",
      );

      // -- reopen supersedes the dismissal (nothing was deleted) ------------
      await t.api(`/api/h/${id}/advisor/eval-below-baseline/reopen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const afterReopen = (await t.api(`/api/h/${id}/advisor`)).body;
      expect(
        (afterReopen["items"] as Array<Record<string, unknown>>).some(
          (i) => i["id"] === "eval-below-baseline",
        ),
      ).toBe(true);
      // Both decisions survive in the ledger.
      const fullLedger = readFileSync(
        join(harnessDir, ".crewhaus", "advisor", "decisions.jsonl"),
        "utf8",
      );
      expect(fullLedger).toContain('"dismissed"');
      expect(fullLedger).toContain('"reopened"');

      // -- the trend reads the regression off durable sources ---------------
      const trend = (await t.api(`/api/h/${id}/advisor/trend`)).body;
      expect((trend["evalSeries"] as unknown[]).length).toBe(2);
      expect(String(trend["summary"])).toContain("down");
      expect((trend["decisions"] as { acted: number }).acted).toBe(1);
      expect((trend["decisions"] as { dismissed: number }).dismissed).toBe(1);

      // -- reports: generate, list, re-read ---------------------------------
      const run = (
        await t.api(`/api/h/${id}/advisor/reports`, {
          method: "POST",
          body: JSON.stringify({ kind: "model-usage" }),
        })
      ).body;
      const report = run["report"] as { reportId: string; kind: string; body: unknown };
      expect(report.kind).toBe("model-usage");
      const list = (await t.api(`/api/h/${id}/advisor/reports`)).body;
      expect(
        (list["reports"] as Array<{ reportId: string }>).some(
          (r) => r.reportId === report.reportId,
        ),
      ).toBe(true);
      const reread = (await t.api(`/api/h/${id}/advisor/reports/${report.reportId}`)).body;
      expect(reread["kind"]).toBe("model-usage");
      expect(reread["report"]).toMatchObject({ reportId: report.reportId });
      const badKind = await t.api(`/api/h/${id}/advisor/reports`, {
        method: "POST",
        body: JSON.stringify({ kind: "vibes" }),
      });
      expect(badKind.status).toBe(400);

      // -- issues: a complaint becomes an update ready to run ---------------
      const submitted = (
        await t.api(`/api/h/${id}/advisor/issues`, {
          method: "POST",
          body: JSON.stringify({
            title: "responses ramble",
            detail: "answers exceed the brief",
            kind: "optimize",
          }),
        })
      ).body;
      const issue = submitted["issue"] as { update: { ready: boolean; jobId: string | null } };
      expect(issue.update.ready).toBe(true);
      expect(issue.update.jobId).not.toBeNull();
      const issues = (await t.api(`/api/h/${id}/advisor/issues`)).body;
      expect((issues["issues"] as Array<{ title: string }>)[0]?.title).toBe("responses ramble");
      // `note` records without queueing — the update is honestly not-ready.
      const noted = (
        await t.api(`/api/h/${id}/advisor/issues`, {
          method: "POST",
          body: JSON.stringify({ title: "needs a plan", kind: "note" }),
        })
      ).body;
      expect((noted["issue"] as { update: { ready: boolean } }).update.ready).toBe(false);

      // -- the fleet board rolls it up, worst first --------------------------
      const fleet = (await t.api("/api/advisor")).body;
      const row = (fleet["harnesses"] as Array<Record<string, unknown>>).find(
        (r) => r["id"] === id,
      );
      expect(row?.["optimal"]).toBe(false);
      expect((row?.["topItem"] as { id: string }).id).toBeDefined();
      expect((fleet["totals"] as { open: number }).open).toBeGreaterThan(0);
    } finally {
      await t.stop();
    }
  }, 30_000);
});
