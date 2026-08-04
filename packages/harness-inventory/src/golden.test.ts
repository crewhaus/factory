/**
 * Golden-output tests over a synthesized on-disk fleet.
 *
 * Unlike the unit tests (which stub every reader seam), these wire the seams
 * to the REAL store libraries — `@crewhaus/spec-registry`'s file-backed
 * registry and `@crewhaus/eval-report`'s run-index/baseline readers — exactly
 * the way the `crewhaus fleet` command layer does, and snapshot the full
 * inventory rows, rendered tables, health rollup, and bulk-run report. Any
 * behavior drift in the lifted core (tolerant reads included: torn JSONL
 * lines skipped, absent state dirs → absent fields, schema-drifted specs
 * scraped leniently, name collisions surfaced as duplicate rows) shows up as
 * a golden diff here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaselineEntry,
  type RunIndexEntry,
  readBaselines,
  readRunIndexLatest,
  setBaseline,
} from "@crewhaus/eval-report";
import { buildFeedbackRecord } from "@crewhaus/feedback-distill";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import {
  type BuildInventoryDeps,
  type EvalHealthReader,
  type HarnessHealth,
  type HarnessInventory,
  buildFleetInventory,
  buildHarnessHealth,
  formatBulkReport,
  formatHealth,
  formatInventory,
  runFleetBulk,
} from "./inventory";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-harness-inventory-golden-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A valid feedback JSONL line for (session, turn). */
function fbLine(turn: number, thumbs: "up" | "down"): string {
  return JSON.stringify(
    buildFeedbackRecord({
      id: `fb_${turn}_${thumbs}`,
      sessionId: "sess_00112233aabbccdd",
      turnNumber: turn,
      ts: "2026-07-01T00:00:00.000Z",
      source: "cli",
      thumbs,
    }),
  );
}

/** A complete run-index entry (typed against the real reader's shape). */
function runEntry(runId: string, passRate: number, ts: string): RunIndexEntry {
  return {
    runId,
    specName: "alpha",
    specHash: "1111",
    datasetName: "smoke",
    datasetHash: "2222",
    passRate,
    meanScore: passRate,
    sampleCount: 4,
    ts,
    outDir: `/fleet-fixture/runs/${runId}`,
  };
}

/**
 * Seed the fixture fleet:
 *
 *   alpha/       full state — registered spec (v1,v2; prod→v1), eval history
 *                with a TORN index line and a baseline pinned to the old
 *                (better) run, 2 sessions + a decoy, re-rated feedback with a
 *                torn line, one open + one resolved incident, audit dir.
 *   drift/       schema-drifted spec a strict parser would reject; lenient
 *                scrape still yields name/target. No state dirs at all.
 *   nested/beta/ workflow spec, empty state (absent-file → absent-field).
 *   twin-blue/ + twin-gold/  name-collision pair: both specs claim `twin`.
 */
async function seedFleet(): Promise<void> {
  // --- alpha: the fully-populated harness -------------------------------
  const alpha = join(root, "alpha");
  mkdirSync(alpha, { recursive: true });
  writeFileSync(
    join(alpha, "crewhaus.yaml"),
    "name: alpha\nversion: 1\ntarget: cli\nagent:\n  model: claude-sonnet-4-5\n  instructions: help\n",
  );

  const registry = createFileBackedRegistry({ rootDir: join(alpha, ".crewhaus", "specs") });
  await registry.put("alpha", "v1", "name: alpha\n");
  await registry.put("alpha", "v2", "name: alpha\n");
  await registry.pin("alpha", "prod", "v1");

  const evalsDir = join(alpha, ".crewhaus", "evals");
  mkdirSync(evalsDir, { recursive: true });
  const oldRun = runEntry("r1", 0.9, "2026-06-01T00:00:00.000Z");
  const newRun = runEntry("r3", 0.5, "2026-07-01T00:00:00.000Z");
  // The middle line is torn mid-record (a crashed append) and must be
  // skipped without hiding the newest run that follows it.
  const torn = JSON.stringify(runEntry("r2", 0.7, "2026-06-15T00:00:00.000Z")).slice(0, 40);
  writeFileSync(
    join(evalsDir, "index.jsonl"),
    `${JSON.stringify(oldRun)}\n${torn}\n${JSON.stringify(newRun)}\n`,
  );
  const baseline: BaselineEntry = {
    specName: "alpha",
    datasetName: "smoke",
    runId: "r1",
    outDir: "/fleet-fixture/runs/r1",
    datasetHash: "2222",
  };
  setBaseline(baseline, evalsDir);

  const sessionsDir = join(alpha, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "sess_00112233aabbccdd.json"), "{}");
  writeFileSync(join(sessionsDir, "sess_ffeeddccbbaa0099.json"), "{}");
  writeFileSync(join(sessionsDir, "notes.json"), "{}"); // decoy — must not count

  const feedbackDir = join(alpha, ".crewhaus", "feedback");
  mkdirSync(feedbackDir, { recursive: true });
  // Turn 1 is re-rated (counts once), turn 2 rated once, last line torn.
  const tornFb = fbLine(3, "up").slice(0, 25);
  writeFileSync(
    join(feedbackDir, "web.jsonl"),
    `${fbLine(1, "up")}\n${fbLine(1, "down")}\n${fbLine(2, "up")}\n${tornFb}\n`,
  );

  const incidentsDir = join(alpha, ".crewhaus", "incidents");
  mkdirSync(incidentsDir, { recursive: true });
  writeFileSync(join(incidentsDir, "inc_1.json"), "{}");
  writeFileSync(join(incidentsDir, "inc_2.resolved.json"), "{}");

  mkdirSync(join(alpha, ".crewhaus", "audit"), { recursive: true });

  // --- drift: schema drift the lenient scrape must survive ---------------
  const drift = join(root, "drift");
  mkdirSync(drift, { recursive: true });
  writeFileSync(
    join(drift, "crewhaus.yaml"),
    'name: "Drifted Bot" # renamed during a migration\ntarget: channel\nunknown_block:\n  nested: [broken\n',
  );

  // --- nested/beta: a workflow harness with no state at all ---------------
  const beta = join(root, "nested", "beta");
  mkdirSync(beta, { recursive: true });
  writeFileSync(
    join(beta, "crewhaus.yaml"),
    "name: nightly\nversion: 1\ntarget: workflow\nmodel: claude-opus-4-1\n",
  );

  // --- twin-blue / twin-gold: the name-collision pair ---------------------
  for (const [dirName, model] of [
    ["twin-blue", "claude-haiku-4-5"],
    ["twin-gold", "claude-sonnet-4-5"],
  ] as const) {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      `name: twin\ntarget: cli\nagent:\n  model: ${model}\n`,
    );
  }
}

/** The REAL reader wiring — byte-for-byte what the CLI command layer injects. */
function realDeps(): BuildInventoryDeps {
  return {
    readManifest: async (specName, registryRoot) => {
      try {
        const reg = createFileBackedRegistry({ rootDir: registryRoot });
        const manifest = await reg.manifest(specName);
        if (manifest.versions.length === 0 && Object.keys(manifest.pins).length === 0) {
          return undefined;
        }
        return manifest;
      } catch {
        return undefined;
      }
    },
    readEvalIndex: (evalsDir) =>
      readRunIndexLatest(evalsDir).map((e) => ({
        datasetName: e.datasetName,
        passRate: e.passRate,
        ts: e.ts,
      })),
  };
}

/** The REAL baseline-comparison health reader the CLI wires for `fleet status`. */
const readEvalHealth: EvalHealthReader = (evalsDir) => {
  const runs = readRunIndexLatest(evalsDir);
  if (runs.length === 0) return { healthy: true, note: "no runs recorded" };
  const baselines = readBaselines(evalsDir);
  const baselineList = Object.values(baselines);
  if (baselineList.length === 0) {
    return { healthy: true, note: `${runs.length} run(s), no baseline pinned` };
  }
  let regressed = false;
  const notes: string[] = [];
  for (const b of baselineList) {
    const forKey = runs
      .filter((r) => r.specName === b.specName && r.datasetName === b.datasetName)
      .sort((x, y) => (x.ts < y.ts ? -1 : 1));
    const latest = forKey[forKey.length - 1];
    const baselineRun = runs.find((r) => r.runId === b.runId);
    if (latest === undefined || baselineRun === undefined) continue;
    if (latest.passRate < baselineRun.passRate) {
      regressed = true;
      notes.push(
        `${b.datasetName} ${(latest.passRate * 100).toFixed(0)}% < baseline ${(baselineRun.passRate * 100).toFixed(0)}%`,
      );
    }
  }
  return regressed
    ? { healthy: false, note: `below baseline: ${notes.join("; ")}` }
    : { healthy: true, note: "all baselines held" };
};

/** Root-relative dir, "/"-normalized, so goldens are machine-independent. */
function rel(dir: string): string {
  const r = dir === root ? "." : dir.slice(root.length + 1);
  return r.split("\\").join("/");
}

function normalizeRow(r: HarnessInventory): unknown {
  return { ...r, dir: rel(r.dir) };
}

describe("golden: fleet inventory over a synthesized on-disk fleet", () => {
  test("buildFleetInventory rows (real registry + eval-index readers)", async () => {
    await seedFleet();
    const rows = await buildFleetInventory(root, realDeps());
    expect(rows.map(normalizeRow)).toEqual([
      {
        dir: "alpha",
        header: { name: "alpha", target: "cli", model: "claude-sonnet-4-5" },
        specName: "alpha",
        registry: { latestVersion: "v2", pins: { prod: "v1" } },
        // The torn r2 line is skipped; the newest surviving run wins.
        lastEval: { datasetName: "smoke", passRate: 0.5, ts: "2026-07-01T00:00:00.000Z" },
        sessionCount: 2,
        feedbackCount: 2, // turn 1 re-rated → counts once; torn line skipped
        specUnreadable: false,
      },
      {
        dir: "drift",
        // A strict parse would reject this spec; the lenient scrape still
        // yields name (unquoted, comment stripped) + target, and the unsafe
        // registry name degrades to "unregistered" instead of throwing.
        header: { name: "Drifted Bot", target: "channel" },
        specName: "Drifted Bot",
        registry: { pins: {} },
        sessionCount: 0,
        feedbackCount: 0,
        specUnreadable: false,
      },
      {
        dir: "nested/beta",
        header: { name: "nightly", target: "workflow", model: "claude-opus-4-1" },
        specName: "nightly",
        registry: { pins: {} },
        sessionCount: 0,
        feedbackCount: 0,
        specUnreadable: false,
      },
      {
        dir: "twin-blue",
        header: { name: "twin", target: "cli", model: "claude-haiku-4-5" },
        specName: "twin",
        registry: { pins: {} },
        sessionCount: 0,
        feedbackCount: 0,
        specUnreadable: false,
      },
      {
        dir: "twin-gold",
        header: { name: "twin", target: "cli", model: "claude-sonnet-4-5" },
        specName: "twin",
        registry: { pins: {} },
        sessionCount: 0,
        feedbackCount: 0,
        specUnreadable: false,
      },
    ]);
  });

  test("formatInventory renders the golden table", async () => {
    await seedFleet();
    const rows = await buildFleetInventory(root, realDeps());
    const lines = formatInventory(rows, root).map((l) => l.split(root).join("<root>"));
    expect(lines).toEqual([
      "5 harness(es) under <root>:",
      "",
      "• alpha  (alpha)",
      "    shape=cli model=claude-sonnet-4-5",
      "    registry=v2  pins: prod→v1",
      "    last eval: 50.0% pass (smoke, 2026-07-01T00:00:00.000Z)",
      "    sessions=2  feedback=2",
      "• Drifted Bot  (drift)",
      "    shape=channel model=?",
      "    registry=unregistered  pins: no pins",
      "    last eval: none recorded",
      "    sessions=0  feedback=0",
      "• nightly  (nested/beta)",
      "    shape=workflow model=claude-opus-4-1",
      "    registry=unregistered  pins: no pins",
      "    last eval: none recorded",
      "    sessions=0  feedback=0",
      "• twin  (twin-blue)",
      "    shape=cli model=claude-haiku-4-5",
      "    registry=unregistered  pins: no pins",
      "    last eval: none recorded",
      "    sessions=0  feedback=0",
      "• twin  (twin-gold)",
      "    shape=cli model=claude-sonnet-4-5",
      "    registry=unregistered  pins: no pins",
      "    last eval: none recorded",
      "    sessions=0  feedback=0",
    ]);
  });

  test("buildHarnessHealth + formatHealth render the golden rollup", async () => {
    await seedFleet();
    const rows = await buildFleetInventory(root, realDeps());
    const health: HarnessHealth[] = [];
    for (const inv of rows) health.push(await buildHarnessHealth(inv, readEvalHealth));

    expect(health.map((h) => ({ ...h, dir: rel(h.dir) }))).toEqual([
      {
        dir: "alpha",
        specName: "alpha",
        registered: true,
        pinnedEnvs: ["prod"],
        evalHealthy: false,
        evalNote: "below baseline: smoke 50% < baseline 90%",
        openIncidents: 1, // inc_2.resolved.json does not count
        hasAudit: true,
      },
      {
        dir: "drift",
        specName: "Drifted Bot",
        registered: false,
        pinnedEnvs: [],
        evalHealthy: true,
        evalNote: "no runs recorded",
        openIncidents: 0,
        hasAudit: false,
      },
      {
        dir: "nested/beta",
        specName: "nightly",
        registered: false,
        pinnedEnvs: [],
        evalHealthy: true,
        evalNote: "no runs recorded",
        openIncidents: 0,
        hasAudit: false,
      },
      {
        dir: "twin-blue",
        specName: "twin",
        registered: false,
        pinnedEnvs: [],
        evalHealthy: true,
        evalNote: "no runs recorded",
        openIncidents: 0,
        hasAudit: false,
      },
      {
        dir: "twin-gold",
        specName: "twin",
        registered: false,
        pinnedEnvs: [],
        evalHealthy: true,
        evalNote: "no runs recorded",
        openIncidents: 0,
        hasAudit: false,
      },
    ]);

    const lines = formatHealth(health, root).map((l) => l.split(root).join("<root>"));
    expect(lines).toEqual([
      "fleet health — 5 harness(es) under <root>:",
      "",
      "✗ alpha",
      "    registered  eval:attention  incidents:1  audit",
      "    eval: below baseline: smoke 50% < baseline 90%",
      "    pinned envs: prod",
      "✓ Drifted Bot",
      "    unregistered  eval:ok",
      "    eval: no runs recorded",
      "✓ nightly",
      "    unregistered  eval:ok",
      "    eval: no runs recorded",
      "✓ twin",
      "    unregistered  eval:ok",
      "    eval: no runs recorded",
      "✓ twin",
      "    unregistered  eval:ok",
      "    eval: no runs recorded",
      "",
      "summary: 1 harness(es) need attention",
    ]);
  });

  test("runFleetBulk + formatBulkReport render the golden bulk report", async () => {
    await seedFleet();
    const seen: Array<{ cwd: string; argv: readonly string[] }> = [];
    const codes = new Map<string, number>([
      ["alpha", 0],
      ["drift", 31], // EXIT_CODES.billing → classed rollup line
      ["beta", 0],
      ["twin-blue", 77], // unmapped → plain exit line, "unknown" in rollup
      ["twin-gold", 0],
    ]);
    const report = await runFleetBulk({
      root,
      subcommandTokens: ["doctor"],
      allowMutating: false,
      deps: realDeps(),
      runner: async ({ cwd, argv }) => {
        seen.push({ cwd, argv });
        const base = cwd.split("/").pop() ?? "";
        return { exitCode: codes.get(base) ?? 1, tail: base === "alpha" ? "doctor: ok" : "" };
      },
      confirm: async () => true,
    });

    // Every harness ran in its own dir with the resolved argv.
    expect(seen.map((s) => ({ cwd: rel(s.cwd), argv: [...s.argv] }))).toEqual([
      { cwd: "alpha", argv: ["doctor"] },
      { cwd: "drift", argv: ["doctor"] },
      { cwd: "nested/beta", argv: ["doctor"] },
      { cwd: "twin-blue", argv: ["doctor"] },
      { cwd: "twin-gold", argv: ["doctor"] },
    ]);

    expect(formatBulkReport(report)).toEqual([
      "fleet run: crewhaus doctor",
      "",
      "✓ alpha — exit 0",
      "    doctor: ok",
      "✗ Drifted Bot — provider account out of funding · exit 31",
      "✓ nightly — exit 0",
      "✗ twin — exit 77",
      "✓ twin — exit 0",
      "",
      "summary: 3 passed, 2 failed (billing ×1, unknown ×1), 0 skipped",
    ]);
  });
});
