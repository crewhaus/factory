/**
 * The Advisor snapshot Home keeps per harness: written by its sweep, read back whole and
 * capped by Home and by `crewhaus inbox`. A snapshot keeps ids, severities, screens,
 * actions and evidence times, never the Advisor's prose or an operator's reasons; a body
 * that is not a snapshot reads as no snapshot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_INDEX_DIR, writeIndexRecord } from "@crewhaus/control-records";
import type { AdvisorItem } from "@crewhaus/harness-advice/advisor";
import { NOW, iso, tempRoot } from "./__test__/fleet";
import {
  advisorSnapshotRecord,
  advisorSnapshotRel,
  parseAdvisorSnapshot,
  readAdvisorSnapshot,
  withAdvisorSnapshots,
} from "./advisor-snapshot";

const HRN = "hrn_0123456789abcdef";
const OTHER = "hrn_fedcba9876543210";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const PROSE = "the operator wrote this reason";

function finding(id: string, over: Partial<AdvisorItem> = {}): AdvisorItem {
  return {
    id,
    severity: "warn",
    title: `${PROSE} title`,
    detail: `${PROSE} detail`,
    explain: `${PROSE} explain`,
    guidance: `${PROSE} guidance`,
    screen: "spec",
    source: "spec",
    action: { kind: "link", label: "Open spec", cliTwin: null, jobKind: null },
    status: "open",
    dismissal: { reason: PROSE, by: "max", at: iso(NOW) },
    lastAction: { comment: PROSE, by: "max", at: iso(NOW), jobId: null },
    evidenceAt: iso(NOW - 1000),
    ...over,
  };
}

describe("the Advisor snapshot", () => {
  test("round-trips ids, severities, actions and evidence times, and drops every word of prose", () => {
    const { root, cleanup } = tempRoot();
    cleanups.push(cleanup);
    const record = advisorSnapshotRecord(iso(NOW), [
      finding("spec-issue-0123456789ab"),
      finding("budget-absent", { evidenceAt: undefined, severity: "suggestion" }),
    ]);
    expect(JSON.stringify(record)).not.toContain(PROSE);
    const written = writeIndexRecord(root, advisorSnapshotRel(HRN), record);
    expect(written.ok).toBe(true);
    const read = readAdvisorSnapshot(root, HRN);
    expect(read?.at).toBe(iso(NOW));
    expect(read?.items.map((f) => `${f.id}:${f.severity}:${f.evidenceAt ?? "-"}`)).toEqual([
      `spec-issue-0123456789ab:warn:${iso(NOW - 1000)}`,
      "budget-absent:suggestion:-",
    ]);
    expect(read?.items[0]?.action).toEqual({
      kind: "link",
      label: "Open spec",
      cliTwin: null,
      jobKind: null,
    });
  });

  test("a harness never checked, or a file that is not a snapshot, has none", () => {
    const { root, cleanup } = tempRoot();
    cleanups.push(cleanup);
    expect(readAdvisorSnapshot(root, HRN)).toBeUndefined();
    const at = join(root, CACHE_INDEX_DIR, advisorSnapshotRel(HRN));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, "[1,2,3]\n");
    expect(readAdvisorSnapshot(root, HRN)).toBeUndefined();
    expect(parseAdvisorSnapshot({ v: 2, at: iso(NOW), items: [] })).toBeUndefined();
    expect(parseAdvisorSnapshot({ v: 1, at: iso(NOW), items: "x" })).toBeUndefined();
  });

  test("a row that is not a finding is left out; the others stay", () => {
    const good = advisorSnapshotRecord(iso(NOW), [finding("evals-none")]).items[0];
    const parsed = parseAdvisorSnapshot({
      v: 1,
      at: iso(NOW),
      items: [good, { id: 3 }, { ...good, severity: "loud" }, { ...good, action: { kind: "x" } }],
    });
    expect(parsed?.items.map((f) => f.id)).toEqual(["evals-none"]);
  });

  test("the facts port answers each harness's own snapshot by its id", () => {
    const { root, cleanup } = tempRoot();
    cleanups.push(cleanup);
    writeIndexRecord(
      root,
      advisorSnapshotRel(HRN),
      advisorSnapshotRecord(iso(NOW), [finding("evals-none")]),
    );
    const ids = new Map([
      ["/h/a", HRN],
      ["/h/b", OTHER],
    ]);
    const facts = withAdvisorSnapshots(
      { envVars: () => ({}), envNameSource: () => undefined },
      root,
      (dir) => ids.get(dir),
    );
    expect(facts.advisorSnapshot?.("/h/a")?.items.map((f) => f.id)).toEqual(["evals-none"]);
    expect(facts.advisorSnapshot?.("/h/b")).toBeUndefined();
    expect(facts.advisorSnapshot?.("/h/unregistered")).toBeUndefined();
  });
});
