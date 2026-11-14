/**
 * `permissions.delegation` (#514): the delegation ceiling. Absent, the IR carries no
 * `delegation` key and nothing moves; present, it lowers to `{maxDays}` on every shape
 * that has `permissions:`, moves the policy revision, and moves no emitted byte, since
 * no bundle reads it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { policyRevision } from "@crewhaus/ir/policy";
import { parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY } from "./__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "./absent-corpus";
import { compile, lower } from "./index";

const RULES = "permissions:\n  rules: []\n";
const CEILING = "permissions:\n  rules: []\n  delegation:\n    max_days: 20\n";
const opts = { today: CORPUS_TODAY };

function permissionsOf(yaml: string): Record<string, unknown> | undefined {
  return (lower(parseSpec(yaml), opts) as unknown as { permissions?: Record<string, unknown> })
    .permissions;
}

describe("the block", () => {
  const cli = ABSENT_CORPUS.cli;
  test("max_days is a whole number from 1 to 90; nothing else is a key", () => {
    for (const bad of ["0", "91", "1.5", '"30"']) {
      expect(() =>
        parseSpec(`${cli}permissions:\n  delegation:\n    max_days: ${bad}\n`),
      ).toThrow();
    }
    expect(() => parseSpec(`${cli}permissions:\n  delegation:\n    merge: {}\n`)).toThrow();
    expect(() => parseSpec(`${cli}permissions:\n  delegation:\n    max_days: 90\n`)).not.toThrow();
    expect(() => parseSpec(`${cli}permissions:\n  delegation: {}\n`)).not.toThrow();
  });
});

describe("absent and present", () => {
  test("absent: the IR's permissions carry no delegation key", () => {
    expect(permissionsOf(ABSENT_CORPUS.cli)).not.toHaveProperty("delegation");
    expect(permissionsOf(`${ABSENT_CORPUS.cli}${RULES}`)).not.toHaveProperty("delegation");
  });

  test("present: the golden, key order included; an empty block takes the default", () => {
    const golden = readFileSync(
      new URL("./__fixtures__/delta-090/delegation.present.ir.json", import.meta.url),
      "utf8",
    );
    const permissions = permissionsOf(
      `${ABSENT_CORPUS.cli}permissions:\n  mode: default\n  rules:\n    - type: alwaysAllow\n      pattern: Read\n  delegation:\n    max_days: 20\n`,
    );
    // JSON text, not deep equality: a reordered key moves the golden.
    expect(`${JSON.stringify(permissions, null, 2)}\n`).toBe(golden);
    expect(
      permissionsOf(`${ABSENT_CORPUS.cli}permissions:\n  delegation: {}\n`)?.["delegation"],
    ).toEqual({
      maxDays: 30,
    });
  });

  test("every shape with permissions emits the same files with and without the ceiling", () => {
    let shapes = 0;
    for (const [target, yaml] of Object.entries(ABSENT_CORPUS)) {
      let declared: string;
      try {
        parseSpec(`${yaml}${CEILING}`);
        declared = `${yaml}${CEILING}`;
      } catch {
        // A shape with no `permissions:` refuses the block, as it refuses the rules.
        expect(() => parseSpec(`${yaml}${RULES}`)).toThrow();
        continue;
      }
      shapes += 1;
      const without = compile(`${yaml}${RULES}`, opts);
      const withCeiling = compile(declared, opts);
      expect([target, withCeiling.files]).toEqual([target, without.files]);
      expect([target, withCeiling.warnings]).toEqual([target, without.warnings]);
      const ir = lower(parseSpec(declared), opts);
      const bare = lower(parseSpec(`${yaml}${RULES}`), opts);
      expect([target, policyRevision(ir) === policyRevision(bare)]).toEqual([target, false]);
      expect(
        (ir as unknown as { permissions: { delegation?: unknown } }).permissions.delegation,
      ).toEqual({
        maxDays: 20,
      });
    }
    expect(shapes).toBeGreaterThanOrEqual(10);
  }, 20_000); // Compiles every shape twice.
});
