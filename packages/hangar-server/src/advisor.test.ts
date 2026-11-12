/**
 * The Advisor (M5): the pure ranking, and the feed → act/dismiss/reopen →
 * trend/report/issue loops driven end-to-end over a fixture harness.
 *
 * The populated item shapes are covered HERE, against a fixture this area
 * controls — the shared contract fixture asserts the advisor arrays only as
 * arrays, because an optimally-running harness has an empty feed by design.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { acceptInvite, signInFromBootLink } from "./__test__/browser";
import {
  ADVISOR_JOB_ARGV,
  ARM_SAMPLE_FLOOR,
  type AdvisorInputs,
  REPORT_KINDS,
  deriveAdvisorItems,
} from "./advisor";
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
  evalHealth: { state: "healthy", note: "at baseline" },
  evalRuns: 3,
  evalsUnreadable: false,
  baselinePinned: true,
  offers: {
    eval: {
      offered: true,
      shapeOk: true,
      note: null,
      verb: "crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml",
    },
    optimize: {
      offered: true,
      shapeOk: true,
      note: null,
      verb: "crewhaus optimize crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml",
    },
  },
  openIncidents: 0,
  procState: "running",
  pendingApprovals: 0,
  budget: { declaredUsd: 10, spentUsd: 1 },
  adviceProposals: 0,
  overdueDreams: [],
  // 0.6.0 §8.3 — the routing axis, clean: no pool, no routed turns, no
  // auxiliary spend, no sunset in the roster, no unserved pin.
  routing: null,
  routeStats: { decisions: 0, escalations: 0 },
  roleSpend: { totalUsdMicros: 0, byRole: {} },
  sunsets: [],
  unservedPins: [],
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
      evalHealth: { state: "regressed", note: "0.4 < 0.7 baseline" },
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

  test("a workspace finding explains what Start anyway does; other areas keep the boot text", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      preflight: {
        items: [
          {
            id: "workspace.holds-home",
            area: "workspace",
            level: "blocking",
            message: "this harness's directory holds the home directory",
          },
          { id: "bundle.stale", area: "bundle", level: "blocking", message: "recompile" },
        ],
      },
    });
    const workspace = items.find((i) => i.id === "preflight-workspace.holds-home");
    expect(workspace?.explain).toContain("Start anyway runs it");
    expect(workspace?.explain).not.toContain("exit on boot");
    const bundle = items.find((i) => i.id === "preflight-bundle.stale");
    expect(bundle?.explain).toContain("exit on boot");
  });

  test("a regression below baseline proposes the optimize loop", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      evalHealth: { state: "regressed", note: "0.4 < 0.7 baseline" },
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

  test("a job that cannot run here becomes a link carrying the reason, never a job", () => {
    const compile = "crewhaus compile crewhaus.yaml --with-eval-harness";
    const note = "Checks for this harness type run inside its compiled test bundle.";
    const none = deriveAdvisorItems({
      ...CLEAN,
      evalRuns: 0,
      baselinePinned: false,
      offers: {
        ...CLEAN.offers,
        eval: { offered: false, shapeOk: false, note, verb: compile },
      },
    });
    expect(none[0]?.id).toBe("evals-none");
    expect(none[0]?.action).toEqual({
      kind: "link",
      label: "Open evals",
      cliTwin: compile,
      jobKind: null,
    });
    expect(none[0]?.guidance).toBe(note);

    const optimizeNote = "No checks yet: add eval/graders.yaml.";
    const regressed = deriveAdvisorItems({
      ...CLEAN,
      evalHealth: { state: "regressed", note: "0.4 < 0.7 baseline" },
      offers: {
        ...CLEAN.offers,
        optimize: { offered: false, shapeOk: true, note: optimizeNote, verb: null },
      },
    });
    expect(regressed[0]?.id).toBe("eval-below-baseline");
    expect(regressed[0]?.action?.kind).toBe("link");
    expect(regressed[0]?.action?.jobKind).toBeNull();
    expect(regressed[0]?.guidance).toBe(optimizeNote);
  });

  test("not measured is not a regression", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      evalHealth: { state: "not_measured", note: "the latest run measured nothing" },
    });
    expect(items.map((i) => i.id)).not.toContain("eval-below-baseline");
  });

  test("an unreadable history is not an empty one, so neither ladder rung fires", () => {
    const none = deriveAdvisorItems({
      ...CLEAN,
      evalRuns: 0,
      baselinePinned: false,
      evalsUnreadable: true,
    });
    expect(none.map((i) => i.id)).not.toContain("evals-none");
    const unpinned = deriveAdvisorItems({
      ...CLEAN,
      baselinePinned: false,
      evalsUnreadable: true,
    });
    expect(unpinned.map((i) => i.id)).not.toContain("evals-no-baseline");
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
  const dir = makeFixtureHarness(join(t.harnessesRoot, "advised"), {
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
  // The quick action can only queue what the harness can run.
  mkdirSync(join(dir, "eval"), { recursive: true });
  writeFileSync(join(dir, "eval", "dataset.jsonl"), '{"id":"a","input":"x"}\n');
  writeFileSync(join(dir, "eval", "graders.yaml"), "graders: []\n");
  return dir;
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

// ---------------------------------------------------------------------------
// 0.6.0 §8.3 — the hybrid-routing items
// ---------------------------------------------------------------------------

const arm = (band: string, model: string, meanReward: number, n: number) => ({
  band,
  model,
  n,
  meanReward,
  shadow: band.startsWith("shadow:"),
});

describe("an issue that asks for a job this harness cannot run", () => {
  test("answers 409 with the reason before anything is written", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "issues"), { specName: "issues" });
      const { body } = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (body["entry"] as { id: string }).id;
      for (const kind of ["eval", "optimize"]) {
        const refused = await t.api(`/api/h/${id}/advisor/issues`, {
          method: "POST",
          body: JSON.stringify({ title: "answers drift", kind }),
        });
        expect(refused.status).toBe(409);
        expect(String(refused.body["error"])).toContain("No test cases yet");
      }
      expect(existsSync(join(dir, ".crewhaus", "advisor", "issues.jsonl"))).toBe(false);
      // A note queues nothing, so it needs nothing.
      const note = await t.api(`/api/h/${id}/advisor/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "answers drift", kind: "note" }),
      });
      expect(note.status).toBe(200);
    } finally {
      await t.stop();
    }
  });
});

describe("deriveAdvisorItems — routing (0.6.0 §8.3)", () => {
  test("policy-flip-ready fires only when EVERY live arm has cleared the sample floor", () => {
    const ready = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "heuristic",
        candidates: 2,
        arms: [arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR), arm("easy", "b", 0.85, ARM_SAMPLE_FLOOR)],
      },
    });
    expect(ready.map((i) => i.id)).toContain("policy-flip-ready");
    expect(ready.find((i) => i.id === "policy-flip-ready")?.action?.jobKind).toBe("route-propose");

    // One arm short: the claim is a coin toss, so no item.
    const thin = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "heuristic",
        candidates: 2,
        arms: [arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR), arm("easy", "b", 0.85, 3)],
      },
    });
    expect(thin.map((i) => i.id)).not.toContain("policy-flip-ready");

    // Already learned: nothing to flip.
    const learned = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "learned",
        candidates: 2,
        arms: [arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR), arm("easy", "b", 0.85, ARM_SAMPLE_FLOOR)],
      },
    });
    expect(learned.map((i) => i.id)).not.toContain("policy-flip-ready");

    // A spec with pools at more than one host reads `mixed`, and one of them
    // is already learned: proposing "flip the policy" would be advice for a
    // flip that has happened.
    const mixed = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "mixed",
        candidates: 4,
        learnedAnywhere: true,
        arms: [arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR), arm("easy", "b", 0.85, ARM_SAMPLE_FLOOR)],
      },
    });
    expect(mixed.map((i) => i.id)).not.toContain("policy-flip-ready");
  });

  test("candidate-underperforming names the worst arm in a band, once, and never the leader", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "learned",
        candidates: 3,
        arms: [
          arm("easy", "leader", 0.9, ARM_SAMPLE_FLOOR),
          arm("easy", "middling", 0.85, ARM_SAMPLE_FLOOR),
          arm("easy", "loser", 0.3, ARM_SAMPLE_FLOOR),
        ],
      },
    });
    const named = items.filter((i) => i.id.startsWith("candidate-underperforming"));
    expect(named).toHaveLength(1);
    expect(named[0]?.title).toContain("loser");
    // The roster stays human-owned: the action shows the scoreboard, it does
    // not remove a candidate.
    expect(named[0]?.action?.jobKind).toBe("route-status");
    expect(named[0]?.guidance).toContain("propose");
  });

  test("a thin or close band produces no candidate item", () => {
    const close = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "learned",
        candidates: 2,
        arms: [arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR), arm("easy", "b", 0.85, ARM_SAMPLE_FLOOR)],
      },
    });
    expect(close.filter((i) => i.id.startsWith("candidate-underperforming"))).toEqual([]);
    const thin = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "learned",
        candidates: 2,
        arms: [arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR), arm("easy", "b", 0.1, 2)],
      },
    });
    expect(thin.filter((i) => i.id.startsWith("candidate-underperforming"))).toEqual([]);
  });

  test("audition-ready fires on an observe-only lane with enough runs, and never on a live one", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "learned",
        candidates: 2,
        arms: [
          arm("easy", "a", 0.9, ARM_SAMPLE_FLOOR),
          arm("shadow:easy", "challenger", 0.95, ARM_SAMPLE_FLOOR),
        ],
      },
    });
    const audition = items.filter((i) => i.id.startsWith("audition-ready"));
    expect(audition).toHaveLength(1);
    expect(audition[0]?.title).toContain("challenger");
    expect(audition[0]?.guidance).toContain("route promote");
    // A shadow arm is never ALSO judged as an underperforming candidate.
    expect(items.filter((i) => i.id.startsWith("candidate-underperforming"))).toEqual([]);
  });

  test("escalation-rate-high fires past the ceiling and stays silent under it", () => {
    const hot = deriveAdvisorItems({
      ...CLEAN,
      routeStats: { decisions: 10, escalations: 6 },
    });
    expect(hot.map((i) => i.id)).toContain("escalation-rate-high");
    expect(hot.find((i) => i.id === "escalation-rate-high")?.severity).toBe("warn");
    expect(hot.find((i) => i.id === "escalation-rate-high")?.action?.jobKind).toBe(
      "models-explain",
    );
    const cool = deriveAdvisorItems({ ...CLEAN, routeStats: { decisions: 10, escalations: 1 } });
    expect(cool.map((i) => i.id)).not.toContain("escalation-rate-high");
    // No routed turns at all is not a 0% escalation rate — it is no signal.
    expect(deriveAdvisorItems({ ...CLEAN, routeStats: { decisions: 0, escalations: 0 } })).toEqual(
      [],
    );
  });

  test("judge-spend-dominates fires when grading outweighs answering", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      roleSpend: {
        totalUsdMicros: 10_000,
        byRole: { primary: 4_000, judge: 5_000, committee: 1_000 },
      },
    });
    const item = items.find((i) => i.id === "judge-spend-dominates");
    expect(item?.severity).toBe("warn");
    expect(item?.detail).toContain("grading rather than answering");
    expect(
      deriveAdvisorItems({
        ...CLEAN,
        roleSpend: { totalUsdMicros: 10_000, byRole: { primary: 9_000, judge: 1_000 } },
      }).map((i) => i.id),
    ).not.toContain("judge-spend-dominates");
  });

  test("sunset-in-roster warns once the date has passed and only suggests before it", () => {
    const future = deriveAdvisorItems({
      ...CLEAN,
      sunsets: [
        {
          model: "claude-3-5-haiku",
          retiresOn: "2027-01-01",
          replacement: "claude-haiku-4-5",
          past: false,
        },
      ],
    });
    expect(future[0]?.severity).toBe("suggestion");
    expect(future[0]?.action?.jobKind).toBe("models-audit");
    const past = deriveAdvisorItems({
      ...CLEAN,
      sunsets: [
        { model: "claude-3-haiku", retiresOn: "2026-04-19", replacement: null, past: true },
      ],
    });
    expect(past[0]?.severity).toBe("warn");
    expect(past[0]?.title).toContain("past its retirement date");
  });

  test("restart-to-serve-pin names the env, the version and the recompile", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      unservedPins: [
        {
          env: "prod",
          version: "1.4.0",
          detail: "the bundle this harness serves was compiled from a DIFFERENT spec than the pin",
        },
      ],
    });
    const item = items.find((i) => i.id === "restart-to-serve-pin-prod");
    expect(item?.severity).toBe("warn");
    expect(item?.detail).toContain("1.4.0");
    expect(item?.screen).toBe("deploy");
    expect(item?.action?.jobKind).toBe("compile");
  });

  test("every routing item is route-segment safe and fully explained", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      routing: {
        policy: "heuristic",
        candidates: 2,
        arms: [
          arm("easy", "claude-haiku-4-5", 0.9, ARM_SAMPLE_FLOOR),
          arm("easy", "claude-opus-5", 0.2, ARM_SAMPLE_FLOOR),
          arm("shadow:easy", "claude-sonnet-4-6", 0.8, ARM_SAMPLE_FLOOR),
        ],
      },
      routeStats: { decisions: 10, escalations: 9 },
      roleSpend: { totalUsdMicros: 100, byRole: { judge: 90, primary: 10 } },
      sunsets: [
        {
          model: "claude-3-7-sonnet",
          retiresOn: "2026-11-01",
          replacement: "claude-sonnet-4-5",
          past: false,
        },
      ],
      unservedPins: [{ env: "prod", version: "1.4.0", detail: "differs" }],
    });
    expect(items.length).toBeGreaterThanOrEqual(7);
    for (const item of items) {
      expect(item.id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
      expect(item.explain.length).toBeGreaterThan(0);
      expect(item.guidance.length).toBeGreaterThan(0);
      expect(item.screen.length).toBeGreaterThan(0);
      if (item.action?.kind === "job") expect(item.action.cliTwin).toContain("crewhaus ");
    }
  });
});

describe("the closed job vocabulary and the report kinds", () => {
  test("every routing job kind is present, and no argv element is a flag from a body", () => {
    for (const kind of ["route-status", "route-propose", "models-audit", "models-explain"]) {
      const argv = ADVISOR_JOB_ARGV[kind];
      expect(`${kind}:${argv !== undefined}`).toBe(`${kind}:true`);
      for (const token of argv ?? []) expect(token.startsWith("-")).toBe(false);
    }
    // The exact argv, pinned: PR 15 lands these verbs, and the CLI twin the
    // console shows must be the command the queue actually runs.
    expect(ADVISOR_JOB_ARGV["route-status"]).toEqual(["route", "status"]);
    expect(ADVISOR_JOB_ARGV["route-propose"]).toEqual(["route", "propose"]);
    expect(ADVISOR_JOB_ARGV["models-audit"]).toEqual(["models", "audit", "crewhaus.yaml"]);
    expect(ADVISOR_JOB_ARGV["models-explain"]).toEqual(["models", "explain", "crewhaus.yaml"]);
  });

  test("the report vocabulary gained routing and hybrid", () => {
    expect([...REPORT_KINDS]).toEqual([
      "model-usage",
      "costs",
      "usefulness",
      "optimization",
      "routing",
      "hybrid",
    ]);
  });
});

describe("the advisor's real wiring, over the routes", () => {
  type Feed = { items: Array<{ id: string; action: Record<string, unknown>; guidance: string }> };
  const COMPILE = "crewhaus compile crewhaus.yaml --with-eval-harness";

  const bare = async (t: TestServer, target?: string): Promise<{ id: string; dir: string }> => {
    const dir = makeFixtureHarness(join(t.harnessesRoot, "wired"), {
      specName: "wired",
      ...(target !== undefined ? { target } : {}),
    });
    const { body } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    return { id: (body["entry"] as { id: string }).id, dir };
  };
  const seedInputs = (dir: string): void => {
    mkdirSync(join(dir, "eval"), { recursive: true });
    writeFileSync(join(dir, "eval", "dataset.jsonl"), '{"id":"a","input":"x"}\n');
    writeFileSync(join(dir, "eval", "graders.yaml"), "graders: []\n");
  };
  const feedOf = async (t: TestServer, id: string): Promise<Feed> =>
    (await t.api(`/api/h/${id}/advisor`)).body as unknown as Feed;
  const queued = async (t: TestServer): Promise<Array<{ kind: string; argv?: string[] }>> => {
    const jobs = (await t.api("/api/jobs")).body;
    return (jobs["running"] as Array<{ kind: string }>).concat(
      jobs["pending"] as Array<{ kind: string }>,
    );
  };

  test("with no inputs, 'no eval signal' links out, and acting on it queues nothing", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const { id } = await bare(t);
      const item = (await feedOf(t, id)).items.find((i) => i.id === "evals-none");
      expect(item?.action["kind"]).toBe("link");
      expect(item?.guidance).toContain("add eval/dataset.jsonl");

      const acted = await t.api(`/api/h/${id}/advisor/evals-none/act`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(acted.status).toBe(200);
      expect(acted.body["job"]).toBeNull();
      expect(await queued(t)).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  test("with its inputs, the same item queues the eval they make possible", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const { id, dir } = await bare(t);
      seedInputs(dir);
      const item = (await feedOf(t, id)).items.find((i) => i.id === "evals-none");
      expect(item?.action).toMatchObject({ kind: "job", jobKind: "eval" });

      await t.api(`/api/h/${id}/advisor/evals-none/act`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect((await queued(t)).map((j) => j.kind)).toEqual(["eval"]);
    } finally {
      await t.stop();
    }
  });

  test("a shape that cannot run an eval links out, whatever is on disk", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const { id, dir } = await bare(t, "workflow");
      seedInputs(dir);
      const item = (await feedOf(t, id)).items.find((i) => i.id === "evals-none");
      expect(item?.action).toMatchObject({ kind: "link", cliTwin: COMPILE });
      await t.api(`/api/h/${id}/advisor/evals-none/act`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(await queued(t)).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  test("a regression with nothing to optimize against links out, and queues nothing", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = advisorHarness(t);
      rmSync(join(dir, "eval"), { recursive: true });
      const { body } = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (body["entry"] as { id: string }).id;
      const item = (await feedOf(t, id)).items.find((i) => i.id === "eval-below-baseline");
      expect(item?.action["kind"]).toBe("link");
      await t.api(`/api/h/${id}/advisor/eval-below-baseline/act`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(await queued(t)).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  test("a history nobody can read is not 'no eval signal'", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const { id, dir } = await bare(t);
      expect((await feedOf(t, id)).items.map((i) => i.id)).toContain("evals-none");
      mkdirSync(join(dir, ".crewhaus", "evals", "index.jsonl"), { recursive: true });
      expect((await feedOf(t, id)).items.map((i) => i.id)).not.toContain("evals-none");
    } finally {
      await t.stop();
    }
  });

  test("the trend's command is one this harness can run", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const channel = await bare(t, "channel");
      const trend = (await t.api(`/api/h/${channel.id}/advisor/trend`)).body;
      expect(trend["verb"]).toBe(COMPILE);
    } finally {
      await t.stop();
    }
  });

  test("the trend names no command on a command-line harness with no inputs", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const { id } = await bare(t);
      expect((await t.api(`/api/h/${id}/advisor/trend`)).body["verb"]).toBeNull();
    } finally {
      await t.stop();
    }
  });
});

describe("acting on an item needs the permission of what it queues", () => {
  test("an operator may decide an item but not queue an optimize run", async () => {
    const t = bootTestServer();
    try {
      const id = await registered(t);
      await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
      const read = loadAccessSnapshot(t.hangarRoot);
      if (read.state !== "present") throw new Error("no access records");
      const invite = await openAccess(t.hangarRoot).createInvite(
        { principal: read.snapshot.owner as string },
        { role: "operator", scope: `harness:${id}` },
      );
      if (!invite.ok) throw new Error(invite.reason);
      const operator = await acceptInvite(t.fetchRaw, invite.result.code, "Otto");
      const acted = await t.fetchRaw(`/api/h/${id}/advisor/eval-below-baseline/act`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${operator.session}`,
        },
        body: "{}",
      });
      expect(acted.status).toBe(403);
      const body = (await acted.json()) as Record<string, unknown>;
      expect([body["code"], body["needs"]]).toEqual(["forbidden", "h.quality.edit"]);
      const jobs = (await t.api("/api/jobs")).body;
      expect([...(jobs["running"] as unknown[]), ...(jobs["pending"] as unknown[])]).toEqual([]);
      // The owner acts, and the run is queued.
      const owned = await t.api(`/api/h/${id}/advisor/eval-below-baseline/act`, {
        method: "POST",
        body: "{}",
      });
      expect(owned.status).toBe(200);
    } finally {
      await t.stop();
    }
  }, 20_000);
});
