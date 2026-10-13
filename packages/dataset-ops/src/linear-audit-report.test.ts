/**
 * The audit report lists each group's sample ids in one pass.
 *
 * `renderAuditReport` checked each hit's sample id against every id its
 * (kind, field) group had listed so far: quadratic in the samples sharing a
 * kind and a field, and a dataset of a hundred thousand samples with an
 * e-mail address in each is an ordinary export. A set now answers "listed
 * already?", and the report is the same text.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges an
 * array's `includes` for the whole array, never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { type DatasetAuditReport, renderAuditReport } from "./dataset-audit";

/** Elements visited and characters copied per hit; about 1 here. */
const WORK_PER_HIT = 4;

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The renderer as it was, with each group's id list searched for each hit. */
function oldRenderAuditReport(report: DatasetAuditReport, label: string): string {
  if (report.totalHits === 0) {
    return `[dataset audit] ${label}: ${report.samplesScanned} sample(s) scanned — no PII/secret hits\n`;
  }
  const lines = [
    `[dataset audit] ${label}: ${report.samplesScanned} sample(s) scanned — ` +
      `${report.totalHits} PII/secret hit(s) across ${report.samplesWithHits} sample(s)`,
  ];
  const groups = new Map<string, { kind: string; field: string; count: number; ids: string[] }>();
  for (const h of report.hits) {
    const key = `${h.kind}\u0000${h.field}`;
    const g = groups.get(key) ?? { kind: h.kind, field: h.field, count: 0, ids: [] };
    g.count += h.count;
    if (!g.ids.includes(h.sampleId)) g.ids.push(h.sampleId);
    groups.set(key, g);
  }
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key) as { kind: string; field: string; count: number; ids: string[] };
    const shown = g.ids.slice(0, 8).join(", ");
    const elided = g.ids.length > 8 ? ` +${g.ids.length - 8} more` : "";
    lines.push(`  ${g.kind} in ${g.field}: ${g.count} hit(s) — ${shown}${elided}`);
  }
  lines.push("  (matched text is never echoed — inspect the listed samples by id)");
  return `${lines.join("\n")}\n`;
}

function report(hits: DatasetAuditReport["hits"], samples: number): DatasetAuditReport {
  return {
    samplesScanned: samples,
    samplesWithHits: new Set(hits.map((h) => h.sampleId)).size,
    totalHits: hits.reduce((sum, h) => sum + h.count, 0),
    hits,
  };
}

describe("renderAuditReport lists a group's ids in one pass", () => {
  test("thousands of samples sharing one kind and field, each hit twice", () => {
    const measured = [4_000, 8_000].map((k) => {
      const hits = Array.from({ length: 2 * k }, (_, i) => ({
        sampleId: `s${i % k}`,
        field: "input",
        kind: "email",
        count: 1,
      }));
      const r = report(hits, k);
      const run = jsWork(WORK_PER_HIT * hits.length, () => renderAuditReport(r, "L"));
      return { k, hits, r, run };
    });
    for (const { k, hits, r, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_HIT * hits.length);
      expect(run.value).toContain(
        `email in input: ${2 * k} hit(s) — s0, s1, s2, s3, s4, s5, s6, s7 +${k - 8} more`,
      );
      expect(run.value === oldRenderAuditReport(r, "L")).toBe(true);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("the same report as the old renderer on generated hits", () => {
    const next = rng(0x5eed0501);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const ids = Array.from({ length: 14 }, (_, i) => `s${i}`);
    const differ: string[] = [];
    let listed = 0;
    for (let n = 0; n < 5_000; n++) {
      const hits = Array.from({ length: Math.floor(next() * 40) }, () => ({
        sampleId: pick(ids),
        field: pick(["input", "expected", "meta.note"]),
        kind: pick(["email", "phone", "secret"]),
        count: 1 + Math.floor(next() * 3),
      }));
      const r = report(hits, ids.length);
      const old = oldRenderAuditReport(r, "L");
      listed += (old.match(/ s\d+/g) ?? []).length;
      if (renderAuditReport(r, "L") !== old) differ.push(JSON.stringify(hits));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(listed).toBeGreaterThan(50_000);
  }, 20_000);
});
