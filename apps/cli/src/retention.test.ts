import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, openAuditLog, verify } from "@crewhaus/audit-log";
import { DEFAULT_TTL_DAYS, createSessionStore } from "@crewhaus/session-store";
import {
  AUDIT_CHAIN_EXCLUSION_REASON,
  DEFAULT_SESSION_MAX_AGE_DAYS,
  InvalidRetentionDateError,
  LOCAL_TENANT,
  RetentionConfigError,
  loadRetentionConfig,
  openHarnessRecordStore,
  parseRetentionDate,
  runRetentionExport,
  runRetentionPurge,
  runRetentionSweep,
} from "./retention";

const MS_PER_DAY = 86_400_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-retention-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sessionsDir(): string {
  return join(root, ".crewhaus", "sessions");
}

function auditDir(): string {
  return join(root, ".crewhaus", "audit");
}

/** Create a real session via session-store, then backdate its mtime. */
async function makeSession(id: string, ageDays: number, withEvents = false): Promise<void> {
  const store = createSessionStore({ rootDir: sessionsDir() });
  await store.create({ id, name: "t", target: "cli", model: "m" });
  if (withEvents) {
    writeFileSync(join(sessionsDir(), `${id}.jsonl`), '{"kind":"turn"}\n');
  }
  const old = new Date(Date.now() - ageDays * MS_PER_DAY);
  utimesSync(join(sessionsDir(), `${id}.json`), old, old);
}

/** Append one record per day label (ascending, all in the past) so the audit
 *  store rotates real day files whose chain spans them. */
async function seedAuditDays(days: ReadonlyArray<string>): Promise<void> {
  let current = days[0] as string;
  const log = await openAuditLog({ rootDir: auditDir(), day: () => current });
  for (const d of days) {
    current = d;
    await log.append({ kind: "policy_decision", payload: { day: d } });
  }
}

function writeConfig(cfg: unknown): void {
  mkdirSync(join(root, ".crewhaus"), { recursive: true });
  writeFileSync(join(root, ".crewhaus", "retention.json"), JSON.stringify(cfg));
}

async function readTodayRecords(): Promise<AuditRecord[]> {
  const log = await openAuditLog({ rootDir: auditDir() });
  const records: AuditRecord[] = [];
  for await (const r of log.read()) records.push(r);
  return records;
}

describe("parseRetentionDate", () => {
  test("accepts bare ISO dates and datetimes", () => {
    expect(parseRetentionDate("--since", "2026-07-01")).toBe(Date.parse("2026-07-01"));
    expect(parseRetentionDate("--before", "2026-07-01T12:00:00Z")).toBe(
      Date.parse("2026-07-01T12:00:00Z"),
    );
  });

  test("an unparseable value throws with the flag name", () => {
    expect(() => parseRetentionDate("--before", "not-a-date")).toThrow(InvalidRetentionDateError);
    expect(() => parseRetentionDate("--before", "not-a-date")).toThrow(/--before "not-a-date"/);
  });
});

describe("loadRetentionConfig", () => {
  test("missing file → session-store's 30-day TTL, no pins, no windows", async () => {
    const cfg = await loadRetentionConfig(root);
    expect(cfg).toEqual({ sessionMaxAgeDays: 30, pins: [], auditWindows: [], fromFile: false });
  });

  test("the engine's default TTL cannot drift from session-store's DEFAULT_TTL_DAYS", () => {
    // data-retention-engine keeps its own 30-day constant (no session-store
    // dependency); this pin catches either side changing unilaterally.
    expect(DEFAULT_SESSION_MAX_AGE_DAYS).toBe(DEFAULT_TTL_DAYS);
  });

  test("parses maxAgeDays, pins, and ISO-dated windows; drops expired windows", async () => {
    const future = new Date(Date.now() + 5 * MS_PER_DAY).toISOString();
    const past = new Date(Date.now() - 5 * MS_PER_DAY).toISOString();
    writeConfig({
      version: 1,
      sessions: { maxAgeDays: 7 },
      pins: ["sess_aaaaaaaaaaaaaaaa"],
      auditWindows: [
        { frameworkId: "soc2", controlId: "CC6.1", expiresAt: future },
        { frameworkId: "soc2", controlId: "CC7.2", expiresAt: past },
      ],
    });
    const cfg = await loadRetentionConfig(root);
    expect(cfg.sessionMaxAgeDays).toBe(7);
    expect(cfg.pins).toEqual(["sess_aaaaaaaaaaaaaaaa"]);
    expect(cfg.auditWindows).toHaveLength(1);
    expect(cfg.auditWindows[0]?.controlId).toBe("CC6.1");
    expect(cfg.fromFile).toBe(true);
  });

  test("malformed JSON / bad maxAgeDays / bad pin all throw RetentionConfigError", async () => {
    writeConfig({ sessions: { maxAgeDays: -1 } });
    await expect(loadRetentionConfig(root)).rejects.toThrow(RetentionConfigError);
    writeConfig({ pins: ["not-a-session-id"] });
    await expect(loadRetentionConfig(root)).rejects.toThrow(/not a session id/);
    writeFileSync(join(root, ".crewhaus", "retention.json"), "{nope");
    await expect(loadRetentionConfig(root)).rejects.toThrow(/malformed JSON/);
  });
});

describe("HarnessRecordStore — enumeration", () => {
  test("sessions are records keyed on file mtime; audit day files on end-of-day UTC", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40, true);
    await seedAuditDays(["2020-01-01"]);
    const store = await openHarnessRecordStore({ rootDir: root });

    expect(store.sessions).toHaveLength(1);
    const s = store.sessions[0];
    expect(s?.record.id).toBe("session:sess_aaaaaaaaaaaaaaaa");
    expect(s?.record.kind).toBe("session");
    expect(s?.record.tenantId).toBe(LOCAL_TENANT);
    expect(s?.eventLogPath).toContain("sess_aaaaaaaaaaaaaaaa.jsonl");
    // mtime-keyed, ~40 days old.
    const ageDays = (Date.now() - (s?.record.createdAt as number)) / MS_PER_DAY;
    expect(ageDays).toBeGreaterThan(39.9);
    expect(ageDays).toBeLessThan(40.1);

    expect(store.auditDays).toHaveLength(1);
    const a = store.auditDays[0];
    expect(a?.record.id).toBe("audit:2020-01-01");
    expect(a?.record.kind).toBe("audit");
    // End of the UTC day, so a day file never expires before its newest record.
    expect(a?.record.createdAt).toBe(Date.UTC(2020, 0, 1) + MS_PER_DAY - 1);
    // _chain-tail.json is internal — neither a record nor a skipped finding.
    expect(store.skipped).toEqual([]);
  });

  test("safe by default: unknown layouts are skipped with reasons, never records", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 1);
    // Foreign/dubious entries in the sessions dir:
    writeFileSync(join(sessionsDir(), "notes.json"), "{}"); // non-sess_ name
    writeFileSync(join(sessionsDir(), "sess_bbbbbbbbbbbbbbbb.json.tmp"), "{}"); // atomic-write leftover
    writeFileSync(join(sessionsDir(), "sess_cccccccccccccccc.jsonl"), ""); // orphaned event log
    // Foreign entries in the audit dir:
    await seedAuditDays(["2026-01-01"]);
    writeFileSync(join(auditDir(), "README.txt"), "hi");
    writeFileSync(join(auditDir(), "2026-13-40.jsonl"), ""); // regex-shaped but not a date

    const store = await openHarnessRecordStore({ rootDir: root });
    expect(store.sessions.map((s) => s.sessionId)).toEqual(["sess_aaaaaaaaaaaaaaaa"]);
    expect(store.auditDays.map((a) => a.day)).toEqual(["2026-01-01"]);
    const reasons = store.skipped.map((s) => s.reason).join("\n");
    expect(store.skipped).toHaveLength(5);
    expect(reasons).toContain("expected sess_<16 hex>.json");
    expect(reasons).toContain("orphaned session event log");
    expect(reasons).toContain(".tmp");
    expect(reasons).toContain("expected YYYY-MM-DD.jsonl");
    expect(reasons).toContain('unparseable day label "2026-13-40"');
  });
});

describe("HarnessRecordStore — deletion granularity", () => {
  test("deleting a session removes BOTH the .json and its .jsonl event log", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40, true);
    const store = await openHarnessRecordStore({ rootDir: root });
    expect(await store.delete("session:sess_aaaaaaaaaaaaaaaa")).toBe(true);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(false);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.jsonl"))).toBe(false);
    expect(store.deletions.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
  });

  test("audit day files are REFUSED — deleting any would break verify()'s cross-file chain", async () => {
    await seedAuditDays(["2020-01-01", "2020-01-02"]);
    const store = await openHarnessRecordStore({ rootDir: root });
    expect(await store.delete("audit:2020-01-01")).toBe(false);
    expect(existsSync(join(auditDir(), "2020-01-01.jsonl"))).toBe(true);
    expect(store.refusals[0]?.reason).toBe(AUDIT_CHAIN_EXCLUSION_REASON);
    // The refused reason is not hypothetical: actually deleting the OLDEST
    // day file leaves the survivor's first record with prevHash != GENESIS,
    // so verify() fails on the very first surviving line.
    rmSync(join(auditDir(), "2020-01-01.jsonl"));
    const result = await verify(auditDir());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("prevHash mismatch");
  });

  test("pinned sessions are refused and survive", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40);
    const store = await openHarnessRecordStore({
      rootDir: root,
      pins: ["sess_aaaaaaaaaaaaaaaa"],
    });
    expect(await store.delete("session:sess_aaaaaaaaaaaaaaaa")).toBe(false);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(store.refusals[0]?.reason).toContain("pinned");
  });

  test("dryRun records the would-delete decision without touching the disk", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40);
    const store = await openHarnessRecordStore({ rootDir: root, dryRun: true });
    expect(await store.delete("session:sess_aaaaaaaaaaaaaaaa")).toBe(true);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(store.deletions).toHaveLength(1);
  });
});

describe("runRetentionSweep", () => {
  test("dry run: reports the would-delete set, deletes nothing, appends NO evidence", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40, true);
    const report = await runRetentionSweep({ rootDir: root, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(report.evidence).toBeUndefined();
    // No audit store existed and the dry run must not create one.
    expect(existsSync(auditDir())).toBe(false);
  });

  test("real run: expired sessions deleted, fresh/pinned/audit kept — each with its reason", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40, true); // expired → deleted
    await makeSession("sess_bbbbbbbbbbbbbbbb", 1); // fresh → within retention
    await makeSession("sess_cccccccccccccccc", 40); // expired but pinned
    await seedAuditDays(["2020-01-01", "2020-01-02"]); // ancient, still kept
    writeConfig({ pins: ["sess_cccccccccccccccc"] });

    const report = await runRetentionSweep({ rootDir: root });
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(false);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.jsonl"))).toBe(false);
    expect(existsSync(join(sessionsDir(), "sess_bbbbbbbbbbbbbbbb.json"))).toBe(true);
    expect(existsSync(join(sessionsDir(), "sess_cccccccccccccccc.json"))).toBe(true);
    expect(report.keptWithinRetention).toEqual(["session:sess_bbbbbbbbbbbbbbbb"]);
    expect(report.keptPinned.map((k) => k.id)).toEqual(["session:sess_cccccccccccccccc"]);
    expect(report.keptAuditChain).toEqual(["audit:2020-01-01", "audit:2020-01-02"]);
    expect(existsSync(join(auditDir(), "2020-01-01.jsonl"))).toBe(true);
    expect(existsSync(join(auditDir(), "2020-01-02.jsonl"))).toBe(true);
  });

  test("real run appends a retention_enforcement record and the chain still verifies", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40);
    await seedAuditDays(["2020-01-01"]);
    const report = await runRetentionSweep({ rootDir: root });
    expect(report.evidence).toBeDefined();

    const records = await readTodayRecords();
    const evidence = records.at(-1) as AuditRecord;
    expect(evidence.kind).toBe("retention_enforcement");
    expect(evidence.seq).toBe(report.evidence?.seq as number);
    const payload = evidence.payload as {
      action: string;
      dryRun: boolean;
      deletedSessionIds: string[];
      counts: { deleted: number };
    };
    expect(payload.action).toBe("sweep");
    expect(payload.dryRun).toBe(false);
    expect(payload.deletedSessionIds).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(payload.counts.deleted).toBe(1);

    // Retention enforcement left the tamper-evident chain intact.
    const result = await verify(auditDir());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.anchorChecked).toBe(true);
  });

  test("an active audit window defers ALL deletion", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40);
    writeConfig({
      auditWindows: [
        {
          frameworkId: "soc2",
          controlId: "CC6.1",
          expiresAt: new Date(Date.now() + MS_PER_DAY).toISOString(),
        },
      ],
    });
    const report = await runRetentionSweep({ rootDir: root });
    expect(report.deleted).toEqual([]);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(report.keptAuditWindow).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(report.activeAuditWindows[0]?.controlId).toBe("CC6.1");
  });
});

describe("runRetentionPurge", () => {
  test("dry run: purge deletes NOTHING and appends NO evidence (ops-review F1)", async () => {
    // The BLOCKER regression: `retention purge --dry-run` used to run a REAL
    // purge (the flag was accepted and ignored, dryRun hardcoded false).
    writeConfig({ sessions: { maxAgeDays: 5 } });
    await makeSession("sess_aaaaaaaaaaaaaaaa", 60, true);
    await seedAuditDays(["2020-01-01"]);
    const recordsBefore = await readTodayRecords();

    const report = await runRetentionPurge({ rootDir: root, dryRun: true });
    expect(report.dryRun).toBe(true);
    // The would-delete set is reported…
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    // …but every file is intact and no evidence record was appended.
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.jsonl"))).toBe(true);
    expect(report.evidence).toBeUndefined();
    expect(await readTodayRecords()).toEqual(recordsBefore);
  });

  test("dry run with --before is also report-only", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 60);
    const report = await runRetentionPurge({
      rootDir: root,
      before: Date.now() - 30 * MS_PER_DAY,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(existsSync(auditDir())).toBe(false);
  });

  test("--before restricts the candidate set; retention rules still apply", async () => {
    writeConfig({ sessions: { maxAgeDays: 5 } });
    await makeSession("sess_aaaaaaaaaaaaaaaa", 60); // expired AND older than cutoff → deleted
    await makeSession("sess_bbbbbbbbbbbbbbbb", 10); // expired but NEWER than cutoff → kept
    const before = Date.now() - 30 * MS_PER_DAY;
    const report = await runRetentionPurge({ rootDir: root, before });
    expect(report.action).toBe("purge");
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(existsSync(join(sessionsDir(), "sess_bbbbbbbbbbbbbbbb.json"))).toBe(true);
    expect(report.keptOutsideCutoff).toEqual(["session:sess_bbbbbbbbbbbbbbbb"]);
    // Purge is audit-logged too.
    const records = await readTodayRecords();
    expect(records.at(-1)?.kind).toBe("retention_enforcement");
    expect((records.at(-1)?.payload as { action: string }).action).toBe("purge");
  });

  test("without --before it covers everything expired (sweep-equivalent), not a TTL bypass", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40); // expired → deleted
    await makeSession("sess_bbbbbbbbbbbbbbbb", 1); // within retention → kept, even for purge
    const report = await runRetentionPurge({ rootDir: root });
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(report.keptWithinRetention).toEqual(["session:sess_bbbbbbbbbbbbbbbb"]);
    expect(existsSync(join(sessionsDir(), "sess_bbbbbbbbbbbbbbbb.json"))).toBe(true);
  });
});

describe("runRetentionExport", () => {
  test("copies raw files out (originals untouched), writes a manifest, appends evidence", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40, true);
    await seedAuditDays(["2020-01-01", "2020-01-02"]);
    const outDir = join(root, "export");
    const report = await runRetentionExport({ rootDir: root, outDir });

    expect(report.sessions).toEqual(["sess_aaaaaaaaaaaaaaaa"]);
    expect(report.auditDays).toEqual(["2020-01-01", "2020-01-02"]);
    expect(existsSync(join(outDir, "sessions", "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(existsSync(join(outDir, "sessions", "sess_aaaaaaaaaaaaaaaa.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "audit", "2020-01-01.jsonl"))).toBe(true);
    // Originals untouched.
    expect(existsSync(join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json"))).toBe(true);
    expect(existsSync(join(auditDir(), "2020-01-01.jsonl"))).toBe(true);

    // Complete export → chain tail included → the exported audit dir is
    // INDEPENDENTLY verifiable (the evidence record was appended to the
    // source AFTER the copy, so it is not part of the snapshot).
    expect(report.chainTailCopied).toBe(true);
    const exportedVerify = await verify(join(outDir, "audit"));
    expect(exportedVerify.ok).toBe(true);
    if (exportedVerify.ok) expect(exportedVerify.anchorChecked).toBe(true);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      sessions: string[];
      auditDays: string[];
      chainTailCopied: boolean;
    };
    expect(manifest.sessions).toEqual(["sess_aaaaaaaaaaaaaaaa"]);
    expect(manifest.auditDays).toEqual(["2020-01-01", "2020-01-02"]);
    expect(manifest.chainTailCopied).toBe(true);

    const records = await readTodayRecords();
    expect(records.at(-1)?.kind).toBe("retention_enforcement");
    expect((records.at(-1)?.payload as { action: string }).action).toBe("export");
  });

  test("--since filters both stores; a partial audit export omits the chain tail", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 60); // older than since → excluded
    await makeSession("sess_bbbbbbbbbbbbbbbb", 1); // newer → included
    await seedAuditDays(["2020-01-01", "2026-01-01"]);
    const outDir = join(root, "export");
    const since = Date.now() - 30 * MS_PER_DAY;
    const report = await runRetentionExport({ rootDir: root, outDir, since });

    expect(report.sessions).toEqual(["sess_bbbbbbbbbbbbbbbb"]);
    expect(report.auditDays).toEqual([]);
    expect(report.chainTailCopied).toBe(false);
    expect(existsSync(join(outDir, "audit", "_chain-tail.json"))).toBe(false);
  });

  test("dry run: export writes NOTHING and appends NO evidence (ops-review F1)", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40, true);
    await seedAuditDays(["2020-01-01"]);
    const recordsBefore = await readTodayRecords();
    const outDir = join(root, "export");

    const report = await runRetentionExport({ rootDir: root, outDir, dryRun: true });
    expect(report.dryRun).toBe(true);
    // The would-export set (and the chain-tail decision) is reported…
    expect(report.sessions).toEqual(["sess_aaaaaaaaaaaaaaaa"]);
    expect(report.auditDays).toEqual(["2020-01-01"]);
    expect(report.chainTailCopied).toBe(true);
    // …but nothing exists on disk: no outDir, no manifest, no copies.
    expect(existsSync(outDir)).toBe(false);
    // And no evidence was appended to the source audit log.
    expect(report.evidence).toBeUndefined();
    expect(await readTodayRecords()).toEqual(recordsBefore);
  });

  test("refuses an outDir inside a store being exported", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 1);
    await expect(
      runRetentionExport({ rootDir: root, outDir: join(sessionsDir(), "out") }),
    ).rejects.toThrow(RetentionConfigError);
  });

  test("refuses `<root>/.crewhaus` — output paths would BE the live stores (ops-review F5)", async () => {
    // The containment regression: outDir = <root>/.crewhaus resolves the
    // sessions/audit OUTPUT paths onto the live stores themselves — a
    // self-copy onto the data being exported. Both overlap directions must
    // be refused, not just "outDir inside a store".
    await makeSession("sess_aaaaaaaaaaaaaaaa", 1, true);
    await seedAuditDays(["2020-01-01"]);
    const sessionFile = join(sessionsDir(), "sess_aaaaaaaaaaaaaaaa.json");
    const before = readFileSync(sessionFile, "utf8");

    await expect(
      runRetentionExport({ rootDir: root, outDir: join(root, ".crewhaus") }),
    ).rejects.toThrow(RetentionConfigError);
    await expect(
      runRetentionExport({ rootDir: root, outDir: join(root, ".crewhaus") }),
    ).rejects.toThrow(/overlaps the live store/);
    // An output path CONTAINING a store is refused too (store inside outSub).
    await expect(
      runRetentionExport({ rootDir: root, outDir: join(root, ".crewhaus", "audit", "deep") }),
    ).rejects.toThrow(RetentionConfigError);
    // The live stores were never touched.
    expect(readFileSync(sessionFile, "utf8")).toBe(before);
    expect(existsSync(join(root, ".crewhaus", "manifest.json"))).toBe(false);
  });
});

describe("no-op runs against a bare directory (ops-review F8b)", () => {
  test("a real sweep with no .crewhaus present creates NO .crewhaus/audit", async () => {
    const report = await runRetentionSweep({ rootDir: root });
    expect(report.deleted).toEqual([]);
    expect(report.evidence).toBeUndefined();
    expect(existsSync(join(root, ".crewhaus"))).toBe(false);
  });

  test("a real purge with no .crewhaus present creates NO .crewhaus/audit", async () => {
    const report = await runRetentionPurge({ rootDir: root });
    expect(report.evidence).toBeUndefined();
    expect(existsSync(join(root, ".crewhaus"))).toBe(false);
  });

  test("a no-op sweep with sessions but no audit store appends nothing", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 1); // fresh — nothing to delete
    const report = await runRetentionSweep({ rootDir: root });
    expect(report.deleted).toEqual([]);
    expect(report.evidence).toBeUndefined();
    expect(existsSync(auditDir())).toBe(false);
  });

  test("a sweep that DELETED something is still evidenced, creating the store if needed", async () => {
    await makeSession("sess_aaaaaaaaaaaaaaaa", 40); // expired — real enforcement
    const report = await runRetentionSweep({ rootDir: root });
    expect(report.deleted.map((d) => d.id)).toEqual(["session:sess_aaaaaaaaaaaaaaaa"]);
    expect(report.evidence).toBeDefined();
    const records = await readTodayRecords();
    expect(records.at(-1)?.kind).toBe("retention_enforcement");
  });
});
