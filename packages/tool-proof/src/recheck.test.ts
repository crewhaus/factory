/**
 * `recheckProof`: a stored builtin proof checked again by the builtin
 * checker before it backs a claim (design §6.4). A rejection is a verdict;
 * a check that stopped is not, and a sandbox checker's artifact is not
 * re-run.
 */
import { describe, expect, test } from "bun:test";
import type { CheckResult, ProofChecker } from "@crewhaus/proof-checker";
import { createBuiltinChecker } from "@crewhaus/proof-checker";
import type { ProofArtifact } from "@crewhaus/provability";
import { proofRecheck, recheckProof } from "./index";
import { MEETINGS, NOW } from "./test-helpers";

const stored = (patch: Partial<ProofArtifact> = {}): ProofArtifact => ({
  version: 1,
  id: "prf_0123456789abcdef",
  checker: "builtin",
  claim: MEETINGS.claim,
  statement: MEETINGS.statement,
  proof: MEETINGS.proof,
  ok: true,
  assumptions: [],
  axioms: [],
  output: "proved",
  outputDigest: "sha256:0",
  checkedAt: NOW.toISOString(),
  ...patch,
});

/** A builtin that answers `result` and counts its calls. */
function scripted(result: Partial<CheckResult>): ProofChecker & { calls: number } {
  const builtin = createBuiltinChecker();
  const checker = {
    ...builtin,
    calls: 0,
    available: () => builtin.available(),
    check: async (): Promise<CheckResult> => {
      checker.calls += 1;
      return {
        ok: false,
        checker: "builtin",
        assumptions: [],
        axioms: [],
        output: "",
        durationMs: 1,
        ...result,
      };
    },
  };
  return checker;
}

describe("recheckProof", () => {
  test("the stored statement and proof are checked again: accepted, or rejected", async () => {
    expect(await recheckProof(stored(), { timeoutMs: 10_000 })).toEqual({
      ok: true,
      assumptions: [],
      axioms: [],
    });
    // The file rewritten to a statement the checker refutes.
    expect(
      await recheckProof(stored({ statement: MEETINGS.falseStatement }), { timeoutMs: 10_000 }),
    ).toEqual({ ok: false });
    // A proof that does not prove the statement is a rejection too.
    expect(
      await recheckProof(stored({ proof: '[{"id":"1","stmt":"true","by":"eval"}]' }), {
        timeoutMs: 10_000,
      }),
    ).toEqual({ ok: false });
    // The bound function reads the same.
    expect(await proofRecheck({ timeoutMs: 10_000 })(stored())).toMatchObject({ ok: true });
  });

  test("a check that stopped is no verdict: out of time, cancelled, the checker failing", async () => {
    for (const reason of [
      "the check ran out of time; shrink the proof or raise timeout_ms",
      "step 3 (eval): the check ran out of time; shrink the proof or raise timeout_ms",
      "the check was cancelled",
      "the check ran out of time waiting for a free checker thread (4 other checks were running); nothing was checked, so try again",
      "internal checker error: worker exited",
    ]) {
      const checker = scripted({ reason });
      expect([reason, await recheckProof(stored(), { timeoutMs: 1, checker })]).toEqual([
        reason,
        undefined,
      ]);
      expect(checker.calls).toBe(1);
    }
    // An aborted turn re-checks nothing.
    const checker = scripted({ ok: true });
    const stop = new AbortController();
    stop.abort();
    expect(await recheckProof(stored(), { timeoutMs: 1, checker, signal: stop.signal })).toBe(
      undefined,
    );
    expect(checker.calls).toBe(0);
  });

  test("a sandbox checker's artifact is not re-run", async () => {
    const checker = scripted({ ok: false, reason: "refuted" });
    for (const id of ["smt", "lean4", "my-plugin"]) {
      expect(await recheckProof(stored({ checker: id }), { timeoutMs: 1, checker })).toBe(
        undefined,
      );
    }
    expect(checker.calls).toBe(0);
  });
});
