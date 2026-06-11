import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, recomputeRecordHash } from "@crewhaus/audit-log";
import {
  type AuditRecordSource,
  BUILT_IN_CONTROLS,
  ComplianceControlsError,
  HIPAA_CONTROLS,
  ISO27001_CONTROLS,
  SOC2_CONTROLS,
  _canonicalDigestForTest,
  _matchesAnyForTest,
  _matchesForTest,
  _signDigestForTest,
  createComplianceCollector,
  verifyBundle,
} from "./index";

function makeRecord(
  partial: Pick<AuditRecord, "kind" | "payload"> & Partial<AuditRecord>,
): AuditRecord {
  return {
    ts: partial.ts ?? Date.now(),
    version: 1,
    seq: partial.seq ?? 0,
    kind: partial.kind,
    payload: partial.payload,
    prevHash: partial.prevHash ?? "GENESIS",
    hash: partial.hash ?? `hash-${Math.random()}`,
  };
}

// Build a properly hash-chained, valid sequence (seq 0,1,…; prevHash links;
// real hashes) — collect() now verifies the chain, so its evidence must be
// genuine. The first record links to GENESIS.
function chainOf(partials: ReadonlyArray<Pick<AuditRecord, "kind" | "payload">>): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prevHash = "GENESIS";
  partials.forEach((p, seq) => {
    const base = {
      ts: 1000 + seq,
      version: 1 as const,
      kind: p.kind,
      seq,
      payload: p.payload,
      prevHash,
    };
    const hash = recomputeRecordHash({ ...base, hash: "" });
    out.push({ ...base, hash });
    prevHash = hash;
  });
  return out;
}

function source(records: ReadonlyArray<AuditRecord>): AuditRecordSource {
  return {
    async *read() {
      for (const r of records) yield r;
    },
  };
}

describe("Built-in framework definitions", () => {
  test("SOC2 controls cover CC6.x + CC7.x families", () => {
    const ids = SOC2_CONTROLS.map((c) => c.controlId);
    expect(ids).toContain("CC6.1");
    expect(ids).toContain("CC6.7");
    expect(ids).toContain("CC7.2");
    expect(ids).toContain("CC7.3");
  });

  test("ISO27001 covers A.12.4", () => {
    const ids = ISO27001_CONTROLS.map((c) => c.controlId);
    expect(ids).toContain("A.12.4");
  });

  test("HIPAA covers 164.312(b)", () => {
    const ids = HIPAA_CONTROLS.map((c) => c.controlId);
    expect(ids).toContain("164.312(b)");
  });

  test("BUILT_IN_CONTROLS aggregates all frameworks", () => {
    const frameworks = new Set(BUILT_IN_CONTROLS.map((c) => c.frameworkId));
    expect(frameworks.has("soc2")).toBe(true);
    expect(frameworks.has("iso27001")).toBe(true);
    expect(frameworks.has("hipaa")).toBe(true);
  });
});

describe("Match logic (T1)", () => {
  test("kind filter", () => {
    const r = makeRecord({ kind: "policy_decision", payload: {} });
    expect(_matchesForTest(r, { kind: "policy_decision" })).toBe(true);
    expect(_matchesForTest(r, { kind: "model_call" })).toBe(false);
  });

  test("ts range filters (inclusive lower, exclusive upper)", () => {
    const r = makeRecord({ kind: "policy_decision", payload: {}, ts: 1000 });
    expect(_matchesForTest(r, { kind: "policy_decision", tsAfter: 999 })).toBe(true);
    expect(_matchesForTest(r, { kind: "policy_decision", tsAfter: 1000 })).toBe(true);
    expect(_matchesForTest(r, { kind: "policy_decision", tsAfter: 1001 })).toBe(false);
    expect(_matchesForTest(r, { kind: "policy_decision", tsBefore: 1001 })).toBe(true);
    expect(_matchesForTest(r, { kind: "policy_decision", tsBefore: 1000 })).toBe(false);
  });

  test("payloadField filter", () => {
    const r = makeRecord({
      kind: "policy_decision",
      payload: { action: "allow", risk: 0.1 },
    });
    expect(_matchesForTest(r, { kind: "policy_decision", payloadField: "action" })).toBe(true);
    expect(_matchesForTest(r, { kind: "policy_decision", payloadField: "missing" })).toBe(false);
  });

  test("payloadFieldEquals filter", () => {
    const r = makeRecord({
      kind: "policy_decision",
      payload: { action: "allow" },
    });
    expect(
      _matchesForTest(r, {
        kind: "policy_decision",
        payloadField: "action",
        payloadFieldEquals: "allow",
      }),
    ).toBe(true);
    expect(
      _matchesForTest(r, {
        kind: "policy_decision",
        payloadField: "action",
        payloadFieldEquals: "deny",
      }),
    ).toBe(false);
  });

  test("matchesAny is OR-merged", () => {
    const r = makeRecord({ kind: "policy_decision", payload: {} });
    const queries = [{ kind: "model_call" as const }, { kind: "policy_decision" as const }];
    expect(_matchesAnyForTest(r, queries)).toBe(true);
  });

  test("matchesAny returns false for empty queries", () => {
    const r = makeRecord({ kind: "policy_decision", payload: {} });
    expect(_matchesAnyForTest(r, [])).toBe(false);
  });

  test("payloadField does not match inherited Object.prototype keys", () => {
    // Regression: `in` would walk the prototype chain so a filter targeting
    // "toString" / "constructor" spuriously matched every object payload.
    // payloadField is documented as a *top-level* (own) field.
    const r = makeRecord({ kind: "policy_decision", payload: { action: "allow" } });
    expect(_matchesForTest(r, { kind: "policy_decision", payloadField: "toString" })).toBe(false);
    expect(_matchesForTest(r, { kind: "policy_decision", payloadField: "constructor" })).toBe(
      false,
    );
    expect(_matchesForTest(r, { kind: "policy_decision", payloadField: "hasOwnProperty" })).toBe(
      false,
    );
    // An own field by the same name still matches.
    const r2 = makeRecord({
      kind: "policy_decision",
      payload: Object.assign(Object.create(null), { toString: "shadowed" }),
    });
    expect(_matchesForTest(r2, { kind: "policy_decision", payloadField: "toString" })).toBe(true);
  });
});

describe("Digest + signature helpers (T1)", () => {
  test("canonicalDigest is deterministic", () => {
    const r1 = makeRecord({ kind: "policy_decision", payload: {}, hash: "h1" });
    const r2 = makeRecord({ kind: "policy_decision", payload: {}, hash: "h2" });
    expect(_canonicalDigestForTest([r1, r2])).toBe(_canonicalDigestForTest([r1, r2]));
    expect(_canonicalDigestForTest([r1, r2])).not.toBe(_canonicalDigestForTest([r2, r1]));
  });

  test("signDigest produces a stable HMAC-SHA256", () => {
    expect(_signDigestForTest("abc", "k1")).toBe(_signDigestForTest("abc", "k1"));
    expect(_signDigestForTest("abc", "k1")).not.toBe(_signDigestForTest("abc", "k2"));
  });
});

describe("createComplianceCollector (T1 + T3)", () => {
  test("requires auditSource", () => {
    expect(() =>
      createComplianceCollector({ auditSource: undefined as unknown as AuditRecordSource }),
    ).toThrow(ComplianceControlsError);
  });

  test("listControls returns built-ins by default, sorted", () => {
    const collector = createComplianceCollector({ auditSource: source([]) });
    const list = collector.listControls();
    expect(list.length).toBe(BUILT_IN_CONTROLS.length);
    // Sorted by framework first, then control.
    const frameworks = list.map((c) => c.frameworkId);
    expect([...frameworks].sort()).toEqual(frameworks);
  });

  test("listControls with frameworkId filter narrows the result", () => {
    const collector = createComplianceCollector({ auditSource: source([]) });
    const soc2 = collector.listControls({ frameworkId: "soc2" });
    expect(soc2.every((c) => c.frameworkId === "soc2")).toBe(true);
    expect(soc2.length).toBe(SOC2_CONTROLS.length);
  });

  test("registerControl adds custom controls", () => {
    const collector = createComplianceCollector({ auditSource: source([]) });
    collector.registerControl({
      frameworkId: "internal",
      controlId: "X-1",
      description: "internal control",
      evidenceQueries: [{ kind: "policy_decision" }],
    });
    expect(collector.listControls({ frameworkId: "internal" })).toHaveLength(1);
  });

  test("collect builds evidence bundle for a single control", async () => {
    const records = chainOf([
      { kind: "policy_decision", payload: { action: "allow" } },
      { kind: "model_call", payload: { model: "claude" } },
      { kind: "policy_decision", payload: { action: "deny" } },
    ]);
    const collector = createComplianceCollector({ auditSource: source(records) });
    const bundle = await collector.collect("soc2", "CC6.1", { period: "2026-Q2" });
    expect(bundle.frameworkId).toBe("soc2");
    expect(bundle.controlId).toBe("CC6.1");
    expect(bundle.recordCount).toBe(2);
    expect(bundle.records.map((r) => (r.payload as { action: string }).action)).toEqual([
      "allow",
      "deny",
    ]);
    expect(bundle.signature).toBeNull();
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("collect with signingKey produces a non-null HMAC signature", async () => {
    const records = chainOf([{ kind: "policy_decision", payload: {} }]);
    const collector = createComplianceCollector({ auditSource: source(records) });
    const bundle = await collector.collect("soc2", "CC6.1", {
      period: "2026-Q2",
      signingKey: "k1",
    });
    expect(bundle.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.signature).toBe(_signDigestForTest(bundle.digest, "k1"));
  });

  test("collect with unknown control throws", async () => {
    const collector = createComplianceCollector({ auditSource: source([]) });
    await expect(collector.collect("ghost", "X", { period: "2026-Q2" })).rejects.toThrow(
      /not registered/,
    );
  });

  test("collectAll returns one bundle per control in the framework", async () => {
    const records = chainOf([
      { kind: "policy_decision", payload: {} },
      { kind: "secrets_rotation", payload: {} },
    ]);
    const collector = createComplianceCollector({ auditSource: source(records) });
    const bundles = await collector.collectAll("soc2", { period: "2026-Q2" });
    expect(bundles.length).toBe(SOC2_CONTROLS.length);
    expect(bundles.every((b) => b.frameworkId === "soc2")).toBe(true);
  });

  // SECURITY: the collector must NOT sign tampered or incomplete evidence.
  test("collect rejects a record whose payload was rewritten (hash no longer matches)", async () => {
    const [original] = chainOf([{ kind: "policy_decision", payload: { action: "deny" } }]);
    if (original === undefined) throw new Error("fixture");
    // Attacker flips deny→allow but leaves the stored hash untouched.
    const tampered: AuditRecord = { ...original, payload: { action: "allow" } };
    const collector = createComplianceCollector({ auditSource: source([tampered]) });
    await expect(collector.collect("soc2", "CC6.1", { period: "2026-Q2" })).rejects.toThrow(
      /hash integrity/,
    );
  });

  test("collect rejects a chain with a deleted middle record (seq gap)", async () => {
    const [first, , third] = chainOf([
      { kind: "policy_decision", payload: { action: "deny" } },
      { kind: "policy_decision", payload: { action: "deny" } },
      { kind: "policy_decision", payload: { action: "allow" } },
    ]);
    if (first === undefined || third === undefined) throw new Error("fixture");
    // Drop the middle record — the survivors no longer link / are gapless.
    const collector = createComplianceCollector({ auditSource: source([first, third]) });
    await expect(collector.collect("soc2", "CC6.1", { period: "2026-Q2" })).rejects.toThrow(
      /chain (broken|has a seq gap)/,
    );
  });
});

describe("verifyBundle (evidence integrity)", () => {
  test("accepts a freshly collected + signed bundle", async () => {
    const records = chainOf([{ kind: "policy_decision", payload: { action: "deny" } }]);
    const collector = createComplianceCollector({ auditSource: source(records) });
    const bundle = await collector.collect("soc2", "CC6.1", {
      period: "2026-Q2",
      signingKey: "k1",
    });
    expect(verifyBundle(bundle, "k1")).toEqual({ ok: true });
    expect(verifyBundle(bundle)).toEqual({ ok: true });
  });

  test("rejects a bundle whose record payload was rewritten after signing", async () => {
    const records = chainOf([{ kind: "policy_decision", payload: { action: "deny" } }]);
    const collector = createComplianceCollector({ auditSource: source(records) });
    const bundle = await collector.collect("soc2", "CC6.1", {
      period: "2026-Q2",
      signingKey: "k1",
    });
    // Rewrite a payload in the written bundle, leaving digest + signature as-is.
    const [rec0] = bundle.records;
    if (rec0 === undefined) throw new Error("fixture");
    const forged = { ...bundle, records: [{ ...rec0, payload: { action: "allow" } }] };
    const result = verifyBundle(forged, "k1");
    expect(result.ok).toBe(false);
  });

  test("rejects a wrong HMAC key", async () => {
    const records = chainOf([{ kind: "policy_decision", payload: {} }]);
    const collector = createComplianceCollector({ auditSource: source(records) });
    const bundle = await collector.collect("soc2", "CC6.1", {
      period: "2026-Q2",
      signingKey: "k1",
    });
    const result = verifyBundle(bundle, "wrong-key");
    expect(result.ok).toBe(false);
  });
});

describe("writeBundle (T3 — disk persistence)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "compliance-controls-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writes bundle to <outputDir>/<framework>/<control>/<period>.json", async () => {
    const records = chainOf([{ kind: "policy_decision", payload: {} }]);
    const collector = createComplianceCollector({
      auditSource: source(records),
      outputDir: tmp,
    });
    const bundle = await collector.collect("soc2", "CC6.1", { period: "2026-Q2" });
    const path = collector.writeBundle(bundle);
    expect(path).toBe(join(tmp, "soc2", "CC6.1", "2026-Q2.json"));
    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, "utf8"));
    expect(content.recordCount).toBe(1);
    expect(content.digest).toBe(bundle.digest);
  });

  test("writeBundle refuses path-traversal in framework/control id", () => {
    const collector = createComplianceCollector({
      auditSource: source([]),
      outputDir: tmp,
    });
    const bundle = {
      frameworkId: "../etc",
      controlId: "passwd",
      description: "x",
      period: "2026",
      generatedAt: 1,
      recordCount: 0,
      records: [],
      digest: "x",
      signature: null,
    };
    expect(() => collector.writeBundle(bundle)).toThrow(/may not contain/);
  });

  test("writeBundle refuses path-traversal in the period label", () => {
    // Regression: `period` was previously interpolated into the path with no
    // validation, so a "../../.." period escaped outputDir entirely and wrote
    // the bundle to an arbitrary location on disk.
    const collector = createComplianceCollector({
      auditSource: source([]),
      outputDir: tmp,
    });
    const base = {
      frameworkId: "soc2",
      controlId: "CC6.1",
      description: "x",
      generatedAt: 1,
      recordCount: 0,
      records: [],
      digest: "x",
      signature: null,
    };
    const escapeTarget = join(tmp, "..", "pwned");
    expect(() => collector.writeBundle({ ...base, period: "../../../../pwned" })).toThrow(
      /period may not contain/,
    );
    // Absolute-path period is likewise rejected (contains a separator).
    expect(() => collector.writeBundle({ ...base, period: "/etc/passwd" })).toThrow(
      /period may not contain/,
    );
    // Backslash separator (Windows-style) is rejected too.
    expect(() => collector.writeBundle({ ...base, period: "..\\win" })).toThrow(
      /period may not contain/,
    );
    // The traversal target must never have been created.
    expect(existsSync(`${escapeTarget}.json`)).toBe(false);
  });

  test("writeBundle rejects backslash / dot-segment in framework and control ids", () => {
    const collector = createComplianceCollector({
      auditSource: source([]),
      outputDir: tmp,
    });
    const base = {
      description: "x",
      period: "2026",
      generatedAt: 1,
      recordCount: 0,
      records: [],
      digest: "x",
      signature: null,
    };
    expect(() =>
      collector.writeBundle({ ...base, frameworkId: "..\\evil", controlId: "c" }),
    ).toThrow(/frameworkId may not contain/);
    expect(() => collector.writeBundle({ ...base, frameworkId: "soc2", controlId: ".." })).toThrow(
      /controlId may not contain/,
    );
  });

  test("writeBundle still writes a legitimately-labelled period", async () => {
    const records = chainOf([{ kind: "policy_decision", payload: {} }]);
    const collector = createComplianceCollector({
      auditSource: source(records),
      outputDir: tmp,
    });
    const bundle = await collector.collect("soc2", "CC6.1", { period: "2026-Q2" });
    const path = collector.writeBundle(bundle);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(tmp, "soc2", "CC6.1", "2026-Q2.json"));
  });
});
