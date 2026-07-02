import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { ReportError, type ReportVerdicts, diffReports, loadRun, renderReport } from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-report-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeSampleResult(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

function makeRunSummary(runId: string, samples: SampleResult[]): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: samples.reduce((s, x) => s + x.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir: "<tmp>",
  };
}

function persistRun(dir: string, summary: EvalRunSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
  for (const s of summary.samples) {
    const sd = join(dir, s.sampleId);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "transcript.jsonl"), "");
    writeFileSync(join(sd, "events.jsonl"), "");
    writeFileSync(join(sd, "grades.json"), JSON.stringify(s.grades));
    writeFileSync(join(sd, "meta.json"), JSON.stringify({ sampleId: s.sampleId }));
  }
}

describe("loadRun (T1)", () => {
  test("loads from filesystem path", async () => {
    const dir = newTempRoot();
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("s1", true, 1),
      makeSampleResult("s2", false, 0),
    ]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    expect(loaded.summary.samples).toHaveLength(2);
    expect(loaded.perSample["s1"]?.grades).toContain("passed");
  });

  test("rejects missing results.json", async () => {
    const dir = newTempRoot();
    await expect(loadRun(dir)).rejects.toThrow(ReportError);
  });

  test("rejects malformed results.json with a parse error", async () => {
    const dir = newTempRoot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), "{ not: valid json,, }");
    await expect(loadRun(dir)).rejects.toThrow(ReportError);
    await expect(loadRun(dir)).rejects.toThrow(/failed to parse/);
  });

  test("resolves a run_<hex> id under .crewhaus/evals/<id>", async () => {
    const root = newTempRoot();
    const runId = "run_abcdef0123456789";
    const evalsDir = join(root, ".crewhaus", "evals", runId);
    const summary = makeRunSummary(runId, [makeSampleResult("s1", true, 1)]);
    persistRun(evalsDir, summary);
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const loaded = await loadRun(runId);
      expect(loaded.summary.runId).toBe(runId);
      expect(loaded.summary.samples).toHaveLength(1);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("safeRead returns empty string for missing per-sample artifacts", async () => {
    const dir = newTempRoot();
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [makeSampleResult("s1", true, 1)]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
    // Create the sample subdir but DO NOT write any artifact files, so every
    // safeRead() hits its catch branch and falls back to "".
    mkdirSync(join(dir, "s1"), { recursive: true });
    const loaded = await loadRun(dir);
    expect(loaded.perSample["s1"]).toEqual({
      transcript: "",
      events: "",
      grades: "",
      meta: "",
    });
  });
});

describe("renderReport (T1)", () => {
  test("renders sample table + drill-down", async () => {
    const dir = newTempRoot();
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("s1", true, 1),
      makeSampleResult("s2", false, 0.3),
    ]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    const out = renderReport(loaded);
    expect(out.html).toContain("Eval run");
    expect(out.html).toContain("run_aaaa1111aaaa1111");
    expect(out.html).toContain("s1");
    expect(out.html).toContain("s2");
    expect(out.html).toContain("PASS");
    expect(out.html).toContain("FAIL");
    expect(out.html).toContain("Pass rate");
    expect(out.html).toMatch(/data-sortable/);
    expect(out.json).toContain('"runId"');
  });

  test("escapes HTML in agent output", async () => {
    const dir = newTempRoot();
    const malicious = makeSampleResult("xss", true, 1);
    const evil = { ...malicious, agentOutput: "<script>alert('pwn')</script>" };
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [evil]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    const out = renderReport(loaded);
    expect(out.html).not.toContain("<script>alert('pwn')");
    expect(out.html).toContain("&lt;script&gt;");
  });

  test("escapes a sampleId that tries to break out of the drill href attribute", async () => {
    const dir = newTempRoot();
    // A sampleId crafted to break out of href="#drill-..." and inject an attribute.
    const payloadId = 'x" onmouseover="alert(1)';
    const evil = makeSampleResult(payloadId, true, 1);
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [evil]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    const out = renderReport(loaded);
    // The raw injection must not survive into the href attribute.
    expect(out.html).not.toContain('href="#drill-x" onmouseover="alert(1)"');
    expect(out.html).not.toContain('onmouseover="alert(1)"');
    // The quote must be HTML-escaped wherever the sampleId is interpolated.
    expect(out.html).toContain("&quot; onmouseover=&quot;alert(1)");
    // The in-page anchor and its target id stay consistent (both escaped),
    // so the drill link still resolves.
    const hrefMatch = out.html.match(/href="(#drill-[^"]*)"/);
    expect(hrefMatch).not.toBeNull();
    const fragment = hrefMatch?.[1]?.slice(1); // strip leading '#'
    expect(out.html).toContain(`id="${fragment}"`);
  });
});

describe("diffReports (T1)", () => {
  test("highlights pass→fail and fail→pass flips", async () => {
    const prevDir = newTempRoot();
    const nextDir = newTempRoot();
    const prev = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("a", true, 1),
      makeSampleResult("b", false, 0),
      makeSampleResult("c", true, 1),
    ]);
    const next = makeRunSummary("run_bbbb2222bbbb2222", [
      makeSampleResult("a", false, 0), // regression
      makeSampleResult("b", true, 1), // recovery
      makeSampleResult("c", true, 1), // unchanged
    ]);
    persistRun(prevDir, prev);
    persistRun(nextDir, next);
    const prevLoaded = await loadRun(prevDir);
    const nextLoaded = await loadRun(nextDir);
    const result = diffReports(prevLoaded, nextLoaded);
    expect(result.diff.regressions).toHaveLength(1);
    expect(result.diff.regressions[0]?.sampleId).toBe("a");
    expect(result.diff.recoveries).toHaveLength(1);
    expect(result.diff.recoveries[0]?.sampleId).toBe("b");
    expect(result.diff.unchanged).toBe(1);
    expect(result.html).toContain("Regressions");
    expect(result.html).toContain("Recoveries");
  });

  test("rejects mismatched sample sets", async () => {
    const prevDir = newTempRoot();
    const nextDir = newTempRoot();
    const prev = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("a", true, 1),
      makeSampleResult("b", false, 0),
    ]);
    const next = makeRunSummary("run_bbbb2222bbbb2222", [
      makeSampleResult("a", true, 1),
      makeSampleResult("c", true, 1),
    ]);
    persistRun(prevDir, prev);
    persistRun(nextDir, next);
    const prevLoaded = await loadRun(prevDir);
    const nextLoaded = await loadRun(nextDir);
    expect(() => diffReports(prevLoaded, nextLoaded)).toThrow(/dataset shape mismatch/);
  });

  test("score shifts above ε are flagged", async () => {
    const prevDir = newTempRoot();
    const nextDir = newTempRoot();
    const prev = makeRunSummary("run_aaaa1111aaaa1111", [makeSampleResult("a", true, 0.4)]);
    const next = makeRunSummary("run_bbbb2222bbbb2222", [makeSampleResult("a", true, 0.7)]);
    persistRun(prevDir, prev);
    persistRun(nextDir, next);
    const prevLoaded = await loadRun(prevDir);
    const nextLoaded = await loadRun(nextDir);
    const result = diffReports(prevLoaded, nextLoaded);
    expect(result.diff.scoreShifts).toHaveLength(1);
  });
});

// Item 7 — the failure-arbiter triage section. Verdicts arrive structurally
// (the CLI passes its RunVerdicts; this package deliberately types them as
// plain strings/records), render between the aggregate cards and the sample
// table, and are entirely absent when no verdicts are passed.
describe("renderReport triage section (item 7)", () => {
  const verdicts: ReportVerdicts = {
    counts: { bug: 2, "spec-gap": 0, noise: 1, "contract-ambiguity": 1 },
    dominantClass: "bug",
    total: 4,
    verdicts: [
      { sampleId: "s1", class: "bug", reason: "Impl violated a clear contract clause." },
      { sampleId: "s2", class: "noise", reason: "Transient infrastructure error: ETIMEDOUT" },
      { sampleId: "s3", class: "contract-ambiguity", reason: "Reference is absent" },
      { sampleId: "s4", class: "bug", reason: "Impl violated a clear contract clause." },
    ],
  };

  async function loadedFixture() {
    const dir = newTempRoot();
    const summary = makeRunSummary("run_cccc3333cccc3333", [
      makeSampleResult("s1", false, 0),
      makeSampleResult("s2", false, 0),
    ]);
    persistRun(dir, summary);
    return loadRun(dir);
  }

  test("renders counts, dominant class, and one row per verdict", async () => {
    const out = renderReport(await loadedFixture(), { verdicts });
    expect(out.html).toContain("Failure triage (4 failing)");
    expect(out.html).toContain("bug 2 · spec-gap 0 · noise 1 · contract-ambiguity 1");
    expect(out.html).toContain("dominant: bug");
    expect(out.html).toContain('class="triage-noise"');
    expect(out.html).toContain('class="triage-contract-ambiguity"');
    expect(out.html).toContain("Transient infrastructure error: ETIMEDOUT");
  });

  test("no verdicts passed → no triage section (existing callers unchanged)", async () => {
    const out = renderReport(await loadedFixture());
    expect(out.html).not.toContain("Failure triage");
    // The stylesheet always ships the triage classes; the section markup
    // (and therefore any element USING them) must be absent.
    expect(out.html).not.toContain('id="triage"');
    expect(out.html).not.toContain('class="triage-');
  });

  test("escapes verdict text and refuses a class attr for non-conforming class names", async () => {
    const hostile: ReportVerdicts = {
      counts: { '"><script>': 1 },
      dominantClass: '"><script>alert(1)</script>',
      total: 1,
      verdicts: [
        {
          sampleId: '<img src=x onerror="p()">',
          class: 'bug" onmouseover="steal()',
          reason: "<script>alert(1)</script>",
        },
      ],
    };
    const out = renderReport(await loadedFixture(), { verdicts: hostile });
    expect(out.html).not.toContain("<script>alert(1)</script>");
    expect(out.html).not.toContain('<img src=x onerror="p()">');
    // The hostile class name fails the [a-z-] whitelist → no class attribute.
    expect(out.html).not.toContain('onmouseover="steal()"');
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
