/**
 * 0.6.0 §10.1 — the TrustOrigin MIRROR BRIDGE.
 *
 * `@crewhaus/run-context` deliberately re-declares the `TrustOrigin` union as
 * a string literal (it carries the metadata and must not depend on this
 * package, which owns the policy). Until 0.6.0 the two unions were kept
 * equal by hand and by a doctor grep; this file makes the equality a
 * COMPILE-TIME fact — `tsc -b` fails here the moment one union gains a
 * member the other lacks — and a runtime fact: the classifier's derived
 * `TRUST_ORIGINS` list is exhaustive over the policy table, so a hand-written
 * origin array anywhere else is one edit too many.
 *
 * With this bridge in place the next origin is a two-site change (this
 * package's union + policy row, and the run-context mirror) plus the egress
 * matrix row the `Record` type already forces; the doctor list and AGENTS.md
 * stay documentation.
 */
import { describe, expect, test } from "bun:test";
import type { TrustOrigin as RunContextTrustOrigin } from "@crewhaus/run-context";
import { TRUST_ORIGINS, type TrustOrigin, defaultBoundarySeverity } from "./index";

/** `true` iff `A` and `B` are the same set of literals (mutual assignability). */
type SetEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The bridge itself: a type-level assertion `tsc -b` checks. If either union
// drifts, `SetEqual<…>` is `false` and this literal no longer typechecks.
const CLASSIFIER_MIRRORS_RUN_CONTEXT: SetEqual<TrustOrigin, RunContextTrustOrigin> = true;

describe("TrustOrigin mirror bridge (boundary-classifier ↔ run-context)", () => {
  test("the two unions are set-equal (compile-time bridge holds at runtime too)", () => {
    expect(CLASSIFIER_MIRRORS_RUN_CONTEXT).toBe(true);
  });

  test("TRUST_ORIGINS is derived from the policy table, in declaration order, and exhaustive", () => {
    // Exhaustiveness at the type level: assigning every member of the union
    // to a `Record<TrustOrigin, true>` literal fails to compile if one is
    // missing, and `Object.keys` of that record must equal the derived list.
    const exhaustive: Record<TrustOrigin, true> = {
      user: true,
      mcp: true,
      subagent: true,
      channel: true,
      federation: true,
      skill: true,
      compaction: true,
      tool: true,
      chain: true,
      memory: true,
      consult: true,
    };
    expect([...TRUST_ORIGINS].sort()).toEqual(Object.keys(exhaustive).sort());
    // Declaration order is the table's order — "user" first, the newest last.
    expect(TRUST_ORIGINS[0]).toBe("user");
    expect(TRUST_ORIGINS[TRUST_ORIGINS.length - 1]).toBe("consult");
  });

  test("consult sits at the block tier, like skill and memory (design §10.1)", () => {
    expect(defaultBoundarySeverity("consult")).toBe("block");
    expect(defaultBoundarySeverity("skill")).toBe("block");
    expect(defaultBoundarySeverity("memory")).toBe("block");
    expect(defaultBoundarySeverity("user")).toBe("pass");
  });
});
