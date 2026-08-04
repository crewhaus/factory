/**
 * HM-11 — the health score.
 *
 * The arithmetic is pinned here rather than "looks about right" in a view:
 * the deductions, the caps, the dedupe between preflight and the spec's own
 * `$VAR` list, and — the property the whole item exists for — that a score
 * below 100 ALWAYS comes with the deductions that produced it, each naming
 * a real console tab.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureHarness } from "./fixture";
import {
  HEALTH_SCREENS,
  HEALTH_WEIGHTS,
  type HealthInputs,
  cadenceToMs,
  computeHealth,
  declaredBudgetUsd,
  dreamOverdue,
} from "./health";
import { bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const HOUR = 3_600_000;

const clean: HealthInputs = {
  preflight: { items: [] },
  evalHealth: { healthy: true, note: "no eval runs recorded" },
  openIncidents: 0,
  procState: "stopped",
  envRefs: [],
  specIssues: [],
  specUnreadable: false,
  budgeted: true,
  dreams: [],
};

describe("computeHealth", () => {
  test("a clean harness scores 100 with no deductions and no unknowns", () => {
    const result = computeHealth(clean);
    expect(result.score).toBe(100);
    expect(result.band).toBe("good");
    expect(result.deductions).toEqual([]);
    expect(result.unknowns).toEqual([]);
  });

  test("every deduction names a real console tab", () => {
    const result = computeHealth({
      ...clean,
      preflight: {
        items: [
          { id: "cred.anthropic", area: "credentials", level: "blocking", message: "unset" },
          { id: "channel.slack", area: "channels", level: "blocking", message: "unset" },
          { id: "mcp.stdio", area: "mcp", level: "blocking", message: "bad" },
        ],
      },
      evalHealth: { healthy: false, note: "40% below baseline 90%" },
      openIncidents: 2,
      procState: "crash-looping",
      envRefs: [{ key: "SOME_TOKEN", set: false }],
      specIssues: [{ message: "unknown key" }],
      budgeted: false,
      dreams: [{ specName: "nightly", windows: 5, neverRan: false }],
    });
    expect(result.deductions.length).toBeGreaterThan(5);
    for (const d of result.deductions) {
      expect(`${d.id}:${(HEALTH_SCREENS as readonly string[]).includes(d.screen)}`).toBe(
        `${d.id}:true`,
      );
      expect(d.points).toBeGreaterThan(0);
      expect(d.detail.length).toBeGreaterThan(0);
    }
  });

  test("a score below 100 always carries deductions summing to the gap", () => {
    const result = computeHealth({ ...clean, evalHealth: { healthy: false, note: "regressed" } });
    const total = result.deductions.reduce((n, d) => n + d.points, 0);
    expect(result.score).toBe(100 - total);
    expect(result.deductions).not.toEqual([]);
  });

  test("preflight blocking items are capped, and only `blocking` counts", () => {
    const many = Array.from({ length: 10 }, (_v, i) => ({
      id: `x${i}`,
      area: "credentials",
      level: "blocking",
      message: "m",
    }));
    const capped = computeHealth({ ...clean, preflight: { items: many } });
    const spent = capped.deductions.reduce((n, d) => n + d.points, 0);
    expect(spent).toBe(HEALTH_WEIGHTS.preflightBlockingCap);

    const warnsOnly = computeHealth({
      ...clean,
      preflight: {
        items: [
          { id: "w", area: "bundle", level: "warn", message: "stale" },
          { id: "i", area: "credentials", level: "info", message: "satisfied" },
        ],
      },
    });
    expect(warnsOnly.score).toBe(100);
  });

  test("a missing credential preflight already named is not charged twice", () => {
    const both = computeHealth({
      ...clean,
      preflight: {
        items: [
          {
            id: "cred.anthropic",
            area: "credentials",
            level: "blocking",
            message: "ANTHROPIC_API_KEY unset",
            envVar: "ANTHROPIC_API_KEY",
          },
        ],
      },
      envRefs: [{ key: "ANTHROPIC_API_KEY", set: false }],
    });
    expect(both.deductions.map((d) => d.id)).toEqual(["preflight:cred.anthropic"]);
    expect(both.score).toBe(100 - HEALTH_WEIGHTS.preflightBlocking);

    // …but a key preflight did NOT name is still charged.
    const extra = computeHealth({
      ...clean,
      preflight: {
        items: [
          {
            id: "cred.anthropic",
            area: "credentials",
            level: "blocking",
            message: "unset",
            envVar: "ANTHROPIC_API_KEY",
          },
        ],
      },
      envRefs: [
        { key: "ANTHROPIC_API_KEY", set: false },
        { key: "STRIPE_KEY", set: false },
      ],
    });
    expect(extra.deductions.map((d) => d.id).sort()).toEqual([
      "env:STRIPE_KEY",
      "preflight:cred.anthropic",
    ]);
  });

  test("crash-looping outweighs a terminal exit, and both point at Runs", () => {
    const looping = computeHealth({ ...clean, procState: "crash-looping" });
    const terminal = computeHealth({ ...clean, procState: "terminal" });
    expect(looping.score).toBeLessThan(terminal.score);
    expect(looping.deductions[0]?.screen).toBe("runs");
    expect(terminal.deductions[0]?.screen).toBe("runs");
    // A healthy running daemon costs nothing.
    expect(computeHealth({ ...clean, procState: "running" }).score).toBe(100);
  });

  test("an unbudgeted harness is only charged when a credential is actually live", () => {
    const noCreds = computeHealth({ ...clean, budgeted: false, envRefs: [] });
    expect(noCreds.deductions.map((d) => d.id)).not.toContain("budget:absent");
    const live = computeHealth({
      ...clean,
      budgeted: false,
      envRefs: [{ key: "ANTHROPIC_API_KEY", set: true }],
    });
    const budget = live.deductions.find((d) => d.id === "budget:absent");
    expect(budget?.screen).toBe("costs");
  });

  test("an unreadable spec replaces (does not add to) the per-issue charges", () => {
    const result = computeHealth({
      ...clean,
      specUnreadable: true,
      specIssues: [{ message: "never read" }],
    });
    expect(result.deductions.map((d) => d.id)).toEqual(["spec:unreadable"]);
  });

  test("dreams: > 2 windows deducts, ≤ 2 does not, unreadable cadence is an unknown", () => {
    expect(
      computeHealth({ ...clean, dreams: [{ specName: "n", windows: 2, neverRan: false }] }).score,
    ).toBe(100);
    const late = computeHealth({
      ...clean,
      dreams: [{ specName: "n", windows: 3, neverRan: false }],
    });
    expect(late.deductions[0]?.screen).toBe("schedulers");
    const neverRan = computeHealth({
      ...clean,
      dreams: [{ specName: "n", windows: null, neverRan: true }],
    });
    expect(neverRan.deductions).toHaveLength(1);
    const unknown = computeHealth({
      ...clean,
      dreams: [{ specName: "n", windows: null, neverRan: false }],
    });
    expect(unknown.deductions).toEqual([]);
    expect(unknown.unknowns[0]).toContain("no readable cadence");
  });

  test("inputs that could not be read become unknowns, never silent passes", () => {
    const result = computeHealth({ ...clean, preflight: null, evalHealth: null });
    expect(result.score).toBe(100);
    expect(result.unknowns).toHaveLength(2);
    expect(result.summary).toContain("unknown");
  });

  test("the score floors at 0 rather than going negative", () => {
    const result = computeHealth({
      preflight: {
        items: Array.from({ length: 10 }, (_v, i) => ({
          id: `p${i}`,
          area: "credentials",
          level: "blocking",
          message: "m",
        })),
      },
      evalHealth: { healthy: false, note: "regressed" },
      openIncidents: 9,
      procState: "crash-looping",
      envRefs: Array.from({ length: 9 }, (_v, i) => ({ key: `K${i}`, set: false })),
      specIssues: Array.from({ length: 9 }, () => ({ message: "bad" })),
      specUnreadable: false,
      budgeted: false,
      dreams: [{ specName: "a", windows: 9, neverRan: false }],
    });
    expect(result.score).toBe(0);
    expect(result.band).toBe("poor");
  });
});

describe("cadenceToMs / dreamOverdue / declaredBudgetUsd", () => {
  test("cadence strings the schedulers view produces", () => {
    expect(cadenceToMs("every 24h")).toBe(24 * HOUR);
    expect(cadenceToMs("every 30m")).toBe(30 * 60_000);
    expect(cadenceToMs("every 1d (deep)")).toBe(86_400_000);
    // Anything not expressed as an interval is UNKNOWN, never guessed.
    expect(cadenceToMs('cron "0 3 * * *" UTC')).toBeNull();
    expect(cadenceToMs("declared (no interval read)")).toBeNull();
    expect(cadenceToMs(null)).toBeNull();
  });

  test("dreamOverdue mirrors dream-engine's overdueOf", () => {
    const ok = { lastRunAt: new Date(NOW - 3 * HOUR).toISOString(), lastOutcome: "ok" };
    expect(dreamOverdue(HOUR, ok, NOW)).toEqual({ windows: 3, neverRan: false });
    expect(dreamOverdue(HOUR, null, NOW)).toEqual({ windows: null, neverRan: true });
    expect(dreamOverdue(HOUR, { lastRunAt: "nonsense", lastOutcome: "ok" }, NOW)).toEqual({
      windows: null,
      neverRan: true,
    });
    expect(dreamOverdue(HOUR, { ...ok, lastOutcome: "failed" }, NOW)).toEqual({
      windows: null,
      neverRan: true,
    });
    expect(dreamOverdue(null, ok, NOW)).toEqual({ windows: null, neverRan: false });
  });

  test("declaredBudgetUsd reads the ceiling from a text scan", () => {
    expect(declaredBudgetUsd("budget:\n  usd: 12.5\n  on_exceed: {action: stop}\n")).toBe(12.5);
    expect(declaredBudgetUsd("budget: { usd: 3 }\n")).toBe(3);
    expect(declaredBudgetUsd("agent:\n  model: x\n")).toBeNull();
    // A commented-out budget is not a budget.
    expect(declaredBudgetUsd("# budget:\n#   usd: 9\n")).toBeNull();
  });
});

describe("GET /api/h/:id/health and GET /api/health", () => {
  test("the route returns the score with its deductions, and the fleet route folds every live harness", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "scored");
      makeFixtureHarness(dir, {
        specName: "scored",
        // Two `$VAR`s, neither set in the fixture's .env chain, and no
        // budget block ⇒ deductions with real screens attached.
        specExtra: 'tools:\n  - name: t\n    env: "$MISSING_ONE"\n',
        envLines: [],
      });
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;

      const one = await t.api(`/api/h/${id}/health`);
      expect(one.status).toBe(200);
      const health = one.body["health"] as {
        score: number;
        band: string;
        deductions: Array<{ id: string; screen: string; points: number }>;
        summary: string;
      };
      expect(typeof health.score).toBe("number");
      expect(health.score).toBeLessThanOrEqual(100);
      expect(health.summary.length).toBeGreaterThan(0);
      if (health.score < 100) {
        expect(health.deductions.length).toBeGreaterThan(0);
        for (const d of health.deductions) {
          expect((HEALTH_SCREENS as readonly string[]).includes(d.screen)).toBe(true);
        }
      }

      const fleet = await t.api("/api/health");
      expect(fleet.status).toBe(200);
      const rows = fleet.body["harnesses"] as Array<{ id: string; health: { score: number } }>;
      expect(rows.map((r) => r.id)).toContain(id);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("open incident records deduct and point at Security", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "incidented");
      makeFixtureHarness(dir, { specName: "incidented" });
      const incidents = join(dir, ".crewhaus", "incidents");
      mkdirSync(incidents, { recursive: true });
      writeFileSync(join(incidents, "inc-1.json"), JSON.stringify({ id: "inc-1" }));
      writeFileSync(join(incidents, "inc-2.resolved.json"), JSON.stringify({ id: "inc-2" }));
      const added = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (added.body["entry"] as { id: string }).id;
      const health = (await t.api(`/api/h/${id}/health`)).body["health"] as {
        deductions: Array<{ id: string; screen: string }>;
      };
      const incident = health.deductions.find((d) => d.id.startsWith("incident:"));
      expect(incident?.screen).toBe("security");
      // The RESOLVED one is not counted.
      expect(health.deductions.filter((d) => d.id.startsWith("incident:"))).toHaveLength(1);
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("health is a read", () => {
  test("scoring a harness with expired sessions deletes nothing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "hangar-health-"));
    try {
      const dir = join(workspace, "aged");
      const old = NOW - 400 * 24 * HOUR;
      makeFixtureHarness(dir, {
        specName: "aged",
        sessions: [{ id: "sess_00000000000000aa", mtimeMs: old }],
      });
      const t = bootTestServer({ now: () => NOW });
      try {
        const added = await t.api("/api/harnesses", {
          method: "POST",
          body: JSON.stringify({ dir }),
        });
        const id = (added.body["entry"] as { id: string }).id;
        await t.api(`/api/h/${id}/health`);
        const sessions = await t.api(`/api/h/${id}/sessions`);
        expect((sessions.body["sessions"] as Array<{ id: string }>).map((s) => s.id)).toContain(
          "sess_00000000000000aa",
        );
      } finally {
        await t.stop();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
