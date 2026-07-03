import { describe, expect, test } from "bun:test";
import { hmacValue } from "@crewhaus/pii-redactor";
import {
  type ScanUnit,
  buildPiiPolicy,
  buildPiiTuneContext,
  findCoverageGaps,
  findFalsePositives,
  renderPiiTuneLines,
} from "./pii-tune";

const SECRET = "tune-secret";
// A raw email we will assert NEVER appears in any tune output.
const EMAIL = "jane.doe@example.com";

function unit(content: string, accepted: boolean): ScanUnit {
  return { content, accepted };
}

describe("buildPiiTuneContext", () => {
  test("hashes every detected value; raw PII never survives into the aggregate", () => {
    const ctx = buildPiiTuneContext(
      [unit(`contact ${EMAIL}`, true), unit(`again ${EMAIL}`, true)],
      SECRET,
    );
    expect(ctx.totalHits).toBe(2);
    expect(ctx.byKind).toEqual({ email: 2 });
    expect(ctx.aggregates.length).toBe(1);
    const agg = ctx.aggregates[0];
    expect(agg?.kind).toBe("email");
    expect(agg?.hash).toBe(hmacValue(EMAIL, SECRET));
    expect(agg?.count).toBe(2);
    expect(agg?.acceptedCount).toBe(2);
    // NO-RAW-PII: the raw email must not appear anywhere in the serialized ctx.
    expect(JSON.stringify(ctx)).not.toContain(EMAIL);
    expect(JSON.stringify(ctx)).not.toContain("jane.doe");
  });

  test("accepted vs non-accepted occurrences are counted separately", () => {
    const ctx = buildPiiTuneContext([unit(`a ${EMAIL}`, true), unit(`b ${EMAIL}`, false)], SECRET);
    expect(ctx.aggregates[0]?.count).toBe(2);
    expect(ctx.aggregates[0]?.acceptedCount).toBe(1);
  });

  test("different values of the same kind get distinct hashes", () => {
    const ctx = buildPiiTuneContext([unit("a a@x.com and b@y.com", true)], SECRET);
    expect(ctx.aggregates.length).toBe(2);
    expect(ctx.byKind["email"]).toBe(2);
  });
});

describe("findFalsePositives", () => {
  test("flags a (kind,hash) kept in accepted outputs at/above thresholds", () => {
    const units = [unit(`x ${EMAIL}`, true), unit(`y ${EMAIL}`, true), unit(`z ${EMAIL}`, true)];
    const ctx = buildPiiTuneContext(units, SECRET);
    const fps = findFalsePositives(ctx);
    expect(fps.length).toBe(1);
    expect(fps[0]?.kind).toBe("email");
    expect(fps[0]?.hash).toBe(hmacValue(EMAIL, SECRET));
    expect(fps[0]?.acceptedCount).toBe(3);
    expect(fps[0]?.acceptedRatio).toBe(1);
    // Still no raw value.
    expect(JSON.stringify(fps)).not.toContain(EMAIL);
  });

  test("does not flag a value that was never in an accepted output", () => {
    const units = [unit(`x ${EMAIL}`, false), unit(`y ${EMAIL}`, false), unit(`z ${EMAIL}`, false)];
    const ctx = buildPiiTuneContext(units, SECRET);
    expect(findFalsePositives(ctx)).toEqual([]);
  });

  test("respects countMin (a rarely-seen value is not proposed)", () => {
    const ctx = buildPiiTuneContext([unit(`x ${EMAIL}`, true), unit(`y ${EMAIL}`, true)], SECRET);
    // count=2 < default countMin=3 → no candidate.
    expect(findFalsePositives(ctx)).toEqual([]);
    // But loosening countMin surfaces it.
    expect(findFalsePositives(ctx, { acceptedMin: 2, countMin: 2 }).length).toBe(1);
  });
});

describe("findCoverageGaps", () => {
  test("flags detector kinds that never fired over a non-trivial scan", () => {
    // 6 units, only emails present → ssn/credit_card/phone/iban never fire.
    const units = Array.from({ length: 6 }, (_, i) => unit(`u${i} ${EMAIL}`, false));
    const ctx = buildPiiTuneContext(units, SECRET);
    const gaps = findCoverageGaps(ctx);
    expect(gaps.length).toBe(1);
    expect(gaps[0]?.reason).toBe("detector-kinds-never-fired");
    expect(gaps[0]?.detail).toContain("ssn");
    expect(gaps[0]?.detail).toContain("credit_card");
    expect(gaps[0]?.detail).not.toContain("email"); // email DID fire
  });

  test("too few units → no coverage judgement", () => {
    const ctx = buildPiiTuneContext([unit(`x ${EMAIL}`, false)], SECRET);
    expect(findCoverageGaps(ctx)).toEqual([]);
  });
});

describe("buildPiiPolicy", () => {
  test("emits a v1 hashed policy carrying only { kind, hash } (no raw PII)", () => {
    const units = Array.from({ length: 3 }, (_, i) => unit(`u${i} ${EMAIL}`, true));
    const ctx = buildPiiTuneContext(units, SECRET);
    const fps = findFalsePositives(ctx);
    const policy = buildPiiPolicy(fps);
    expect(policy.version).toBe(1);
    expect(policy.allow).toEqual([{ kind: "email", hash: hmacValue(EMAIL, SECRET) }]);
    expect(JSON.stringify(policy)).not.toContain(EMAIL);
  });

  test("deterministic + sorted", () => {
    const fps = [
      { kind: "email", hash: "zzz", count: 5, acceptedCount: 5, acceptedRatio: 1 },
      { kind: "email", hash: "aaa", count: 5, acceptedCount: 5, acceptedRatio: 1 },
      { kind: "ssn", hash: "mmm", count: 5, acceptedCount: 5, acceptedRatio: 1 },
    ];
    const policy = buildPiiPolicy(fps);
    expect(policy.allow).toEqual([
      { kind: "email", hash: "aaa" },
      { kind: "email", hash: "zzz" },
      { kind: "ssn", hash: "mmm" },
    ]);
  });
});

describe("renderPiiTuneLines", () => {
  test("renders hashes + counts, never the raw value", () => {
    const units = Array.from({ length: 3 }, (_, i) => unit(`u${i} ${EMAIL}`, true));
    const ctx = buildPiiTuneContext(units, SECRET);
    const fps = findFalsePositives(ctx);
    const gaps = findCoverageGaps(ctx);
    const lines = renderPiiTuneLines(ctx, fps, gaps).join("\n");
    expect(lines).toContain(hmacValue(EMAIL, SECRET));
    expect(lines).not.toContain(EMAIL);
    expect(lines).not.toContain("jane.doe");
    expect(lines).toContain("accepted output");
  });
});
