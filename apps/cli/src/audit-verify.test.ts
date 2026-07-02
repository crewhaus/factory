import { describe, expect, test } from "bun:test";
import type { VerifyResult } from "@crewhaus/audit-log";
import {
  InvalidAnchorFlagError,
  buildAuditIntegrityCheck,
  resolveAnchorFlag,
  summarizeVerifyResult,
} from "./audit-verify";

const okResult = (over: Partial<Extract<VerifyResult, { ok: true }>> = {}): VerifyResult => ({
  ok: true,
  recordsChecked: 7,
  anchorChecked: true,
  externalAnchorChecked: false,
  ...over,
});

const failResult: VerifyResult = {
  ok: false,
  recordsChecked: 3,
  file: "/x/.crewhaus/audit/2026-07-01.jsonl",
  line: 4,
  reason: 'hash mismatch — expected "aa", got "bb"',
};

describe("resolveAnchorFlag", () => {
  test("absent flag resolves to undefined (no store requested)", () => {
    expect(resolveAnchorFlag(undefined)).toBeUndefined();
  });

  test("file:<path> selects the file scheme with the verbatim path", () => {
    expect(resolveAnchorFlag("file:/var/crewhaus/anchors")).toEqual({
      scheme: "file",
      path: "/var/crewhaus/anchors",
    });
    // Relative paths pass through untouched — the entry file resolves them.
    expect(resolveAnchorFlag("file:anchors")).toEqual({ scheme: "file", path: "anchors" });
  });

  test("an unknown scheme throws with the allowed list (S3 is out of scope)", () => {
    expect(() => resolveAnchorFlag("s3:bucket/prefix")).toThrow(InvalidAnchorFlagError);
    expect(() => resolveAnchorFlag("s3:bucket/prefix")).toThrow(/one of: file/);
  });

  test("a missing scheme or empty path throws", () => {
    expect(() => resolveAnchorFlag("/just/a/path")).toThrow(InvalidAnchorFlagError);
    expect(() => resolveAnchorFlag("file:")).toThrow(InvalidAnchorFlagError);
    expect(() => resolveAnchorFlag(":path")).toThrow(InvalidAnchorFlagError);
  });
});

describe("summarizeVerifyResult", () => {
  test("intact chain + on-host anchor, no store requested → exit 0 with ✓/~ lines", () => {
    const s = summarizeVerifyResult(okResult(), { anchorRequested: false });
    expect(s.exitCode).toBe(0);
    expect(s.lines[0]).toContain("✓ hash chain intact — 7 record(s)");
    expect(s.lines[1]).toContain("✓ on-host chain-tail anchor");
    expect(s.lines[2]).toContain("~ external anchor not consulted");
  });

  test("missing on-host anchor is a limitation (~), never a failure", () => {
    const s = summarizeVerifyResult(okResult({ anchorChecked: false }), {
      anchorRequested: false,
    });
    expect(s.exitCode).toBe(0);
    expect(s.lines[1]).toContain("~ on-host chain-tail anchor absent");
    expect(s.lines[1]).toContain("limitation, not tamper");
  });

  test("requested + cross-checked external anchor → exit 0 with all-✓ anchor lines", () => {
    const s = summarizeVerifyResult(okResult({ externalAnchorChecked: true }), {
      anchorRequested: true,
    });
    expect(s.exitCode).toBe(0);
    expect(s.lines[2]).toContain("✓ external anchor store agrees");
  });

  test("REQUESTED anchor that was NOT cross-checked fails (exit 1) — no silent skip", () => {
    const s = summarizeVerifyResult(okResult({ externalAnchorChecked: false }), {
      anchorRequested: true,
    });
    expect(s.exitCode).toBe(1);
    expect(s.lines[2]).toContain("✗ external anchor requested (--anchor)");
  });

  test("a tamper finding carries file:line + reason and exits 1", () => {
    const s = summarizeVerifyResult(failResult, { anchorRequested: false });
    expect(s.exitCode).toBe(1);
    expect(s.lines[0]).toContain("✗ tamper finding at /x/.crewhaus/audit/2026-07-01.jsonl:4");
    expect(s.lines[0]).toContain("hash mismatch");
    expect(s.lines[1]).toContain("3 record(s) verified cleanly before the finding");
  });
});

describe("buildAuditIntegrityCheck (doctor surface)", () => {
  test("intact chain with anchor → plain pass carrying the record count", () => {
    const c = buildAuditIntegrityCheck(okResult());
    expect(c.pass).toBe(true);
    expect(c.warn).toBeUndefined();
    expect(c.label).toContain("7 records");
  });

  test("intact chain WITHOUT the on-host anchor → pass with warn (limitation)", () => {
    const c = buildAuditIntegrityCheck(okResult({ anchorChecked: false }));
    expect(c.pass).toBe(true);
    expect(c.warn).toBe(true);
    expect(c.reason).toContain("tail truncation cannot be ruled out");
  });

  test("a broken chain fails doctor with the finding and a pointer to audit verify", () => {
    const c = buildAuditIntegrityCheck(failResult);
    expect(c.pass).toBe(false);
    expect(c.reason).toContain("hash mismatch");
    expect(c.reason).toContain("crewhaus audit verify");
  });
});
