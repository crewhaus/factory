import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setRollBytesForTest,
  append,
  controlPaths,
  harnessLedger,
  retainedSegments,
} from "@crewhaus/control-records";
import { _setKnowledgeRetentionSeamsForTest } from "./knowledge-retention";
import { formatEnforcementReport, runRetentionPurge, runRetentionSweep } from "./retention";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-retention-"));
  // One line per segment.
  _setRollBytesForTest(1);
});
afterEach(() => {
  _setRollBytesForTest(undefined);
  _setKnowledgeRetentionSeamsForTest(undefined);
  rmSync(root, { recursive: true, force: true });
});

const ledger = () => harnessLedger(root, { dir: controlPaths(root).knowledgeUsageDir });
function usage(...daysAgo: readonly number[]): void {
  for (const days of daysAgo) append(ledger(), { v: 1, at: at(days), run: `run_${days}` });
}
function segments(): readonly number[] {
  const kept = retainedSegments(ledger());
  if (!kept.ok) throw new Error(kept.reason);
  return kept.segs;
}
const markersFile = (): string => join(root, controlPaths(root).knowledgeBackendsFile);
function markers(...daysAgo: readonly number[]): void {
  mkdirSync(join(root, ".crewhaus", "run", "knowledge"), { recursive: true });
  writeFileSync(
    markersFile(),
    daysAgo.map((d) => `${JSON.stringify({ v: 1, at: at(d), tier: `t${d}` })}\n`).join(""),
    { mode: 0o600 },
  );
}
const tiers = (): string[] =>
  readFileSync(markersFile(), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => String((JSON.parse(line) as { tier?: unknown }).tier ?? "?"));
const sweep = (dryRun = false) => runRetentionSweep({ rootDir: root, dryRun, now: () => NOW });
function policy(value: unknown): void {
  mkdirSync(join(root, ".crewhaus"), { recursive: true });
  writeFileSync(join(root, ".crewhaus", "retention.json"), JSON.stringify(value));
}

describe("the sweep ages out usage segments", () => {
  test("a segment past 13 months goes, oldest first; one inside the window stays", async () => {
    usage(800, 400, 396.5, 395, 2);
    expect(segments()).toEqual([1, 2, 3, 4, 5]);
    const report = await sweep();
    expect(report.knowledge).toEqual({
      maxAgeDays: 396,
      usageSegments: [1, 2, 3],
      backendMarkers: 0,
      skipped: [],
    });
    expect(segments()).toEqual([4, 5]);
    // The files are gone, and the watermark says which were.
    const files = readdirSync(join(root, controlPaths(root).knowledgeUsageDir)).sort();
    expect(files).toEqual(["000004.jsonl", "000005.jsonl", "watermark.json"]);
    // Again: nothing more to remove.
    expect((await sweep()).knowledge?.usageSegments).toEqual([]);
  });

  test("the newest segment is never removed, however old", async () => {
    usage(900, 800);
    expect((await sweep()).knowledge?.usageSegments).toEqual([1]);
    expect(segments()).toEqual([2]);
  });

  test("a segment inside the window stops it: what is newer is not looked past", async () => {
    usage(800, 10, 700, 5);
    expect((await sweep()).knowledge?.usageSegments).toEqual([1]);
    expect(segments()).toEqual([2, 3, 4]);
  });

  test("a segment whose times cannot be read is kept", async () => {
    usage(800, 700, 5);
    writeFileSync(join(root, controlPaths(root).knowledgeUsageDir, "000001.jsonl"), "not json\n");
    expect((await sweep()).knowledge?.usageSegments).toEqual([]);
    expect(segments()).toEqual([1, 2, 3]);
  });

  test("the window is the policy's", async () => {
    policy({ knowledge: { usageMaxAgeDays: 7 } });
    usage(30, 8, 6, 1);
    const report = await sweep();
    expect(report.knowledge?.maxAgeDays).toBe(7);
    expect(report.knowledge?.usageSegments).toEqual([1, 2]);
  });
});

describe("the sweep ages out fallback markers", () => {
  test("lines past the window go; the rest, and a line whose time cannot be read, stay", async () => {
    markers(800, 500, 100, 1);
    appendFileSync(markersFile(), "a torn line\n");
    const report = await sweep();
    expect(report.knowledge).toEqual({
      maxAgeDays: 396,
      usageSegments: [],
      backendMarkers: 2,
      skipped: [],
    });
    const text = readFileSync(markersFile(), "utf8");
    expect(text.split("\n").filter((l) => l !== "")).toHaveLength(3);
    expect(text).toContain("a torn line");
    expect(text).not.toContain("t800");
    expect(statSync(markersFile()).mode & 0o777).toBe(0o600);
  });

  test("a marker appended while the file is rewritten is kept", async () => {
    markers(800, 1);
    _setKnowledgeRetentionSeamsForTest({
      afterMarkersRead: () =>
        appendFileSync(markersFile(), `${JSON.stringify({ v: 1, at: at(0), tier: "late" })}\n`),
    });
    expect((await sweep()).knowledge?.backendMarkers).toBe(1);
    expect(tiers()).toEqual(["t1", "late"]);
  });

  test("a file swapped under the rewrite is left as it is, and said so", async () => {
    markers(800, 1);
    _setKnowledgeRetentionSeamsForTest({
      afterMarkersRead: () => {
        // Moved aside, not removed: a removed file's inode can be handed straight to its
        // replacement (Linux does), and then the swap is the same file by every measure.
        renameSync(markersFile(), `${markersFile()}.old`);
        markers(1, 800);
      },
    });
    const report = await sweep();
    expect(report.knowledge?.backendMarkers).toBe(0);
    expect(report.knowledge?.skipped).toHaveLength(1);
    expect(tiers()).toEqual(["t1", "t800"]);
  });

  test("a link planted at the file is never followed", async () => {
    const outside = join(root, "..", `outside-${Date.now()}.jsonl`);
    writeFileSync(outside, `${JSON.stringify({ at: at(800) })}\n`);
    try {
      mkdirSync(join(root, ".crewhaus", "run", "knowledge"), { recursive: true });
      symlinkSync(outside, markersFile());
      expect((await sweep()).knowledge).toBeUndefined();
      expect(readFileSync(outside, "utf8")).toContain(at(800));
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("the sweep says what it did, and only where there is something", () => {
  test("a harness without either record reports nothing about them", async () => {
    const report = await sweep();
    expect("knowledge" in report).toBe(false);
    expect(formatEnforcementReport(report).join("\n")).not.toContain("knowledge usage");
    expect(existsSync(join(root, ".crewhaus", "run"))).toBe(false);
  });

  test("a dry run reports the same and writes nothing", async () => {
    usage(800, 700, 1);
    markers(800, 1);
    const before = readFileSync(markersFile(), "utf8");
    const report = await sweep(true);
    expect(report.knowledge).toEqual({
      maxAgeDays: 396,
      usageSegments: [1, 2],
      backendMarkers: 1,
      skipped: [],
    });
    expect(formatEnforcementReport(report)).toContain(
      "→ knowledge usage (kept 396d): would delete 2 usage segment(s) and 1 fallback marker(s)",
    );
    expect(segments()).toEqual([1, 2, 3]);
    expect(readFileSync(markersFile(), "utf8")).toBe(before);
    expect(existsSync(join(root, ".crewhaus", "audit"))).toBe(false);
  });

  test("a real sweep is evidenced by counts, even when no session went", async () => {
    usage(800, 1);
    markers(800, 1);
    const report = await sweep();
    expect(report.evidence).toBeDefined();
    const log = readdirSync(join(root, ".crewhaus", "audit")).find((f) => /^\d{4}-/.test(f));
    const record = JSON.parse(
      readFileSync(join(root, ".crewhaus", "audit", log ?? ""), "utf8").split("\n")[0] ?? "",
    ) as { payload: { counts: Record<string, number> } };
    expect(record.payload.counts).toMatchObject({ usageSegments: 1, backendMarkers: 1 });
  });

  test("an active audit window keeps them, and says so", async () => {
    policy({
      auditWindows: [
        { frameworkId: "soc2", controlId: "CC6.1", expiresAt: new Date(NOW + DAY).toISOString() },
      ],
    });
    usage(800, 1);
    markers(800, 1);
    const report = await sweep();
    expect(report.knowledge?.deferred).toBe(true);
    expect(segments()).toEqual([1, 2]);
    expect(tiers()).toEqual(["t800", "t1"]);
    expect(formatEnforcementReport(report)).toContain(
      "• kept the knowledge usage records — audit window active",
    );
  });

  test("purge --before narrows the window as it does for sessions", async () => {
    usage(800, 600, 1);
    const report = await runRetentionPurge({
      rootDir: root,
      before: NOW - 700 * DAY,
      now: () => NOW,
    });
    expect(report.knowledge?.usageSegments).toEqual([1]);
    expect(segments()).toEqual([2, 3]);
  });
});
