/**
 * 0.8.0 (design §6.3) — the default `provability.execution.allow` admits only
 * tools whose results a `checked` claim can rest on without trusting a side
 * effect: read-only, never destructive, in-process. The compiler expands the
 * category grammar offline and cannot read tool flags, so this test reads
 * every expanded entry's flags from the generated manifest. A destructive tool
 * added to `compute` or `verify` (the way `goldenUpdate` sits in `verify`)
 * therefore fails here instead of quietly becoming evidence by default.
 *
 * It also holds tool-proof's copy of the default — what the builtin proof
 * tools run under with no `provability:` block — equal to the compiler's.
 */
import { describe, expect, test } from "bun:test";
import { PROVABILITY_DEFAULT_EXECUTION_ALLOW, lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import { expandToolSelectors } from "@crewhaus/tool-categories";
import { DEFAULT_EXECUTION_SELECTORS, defaultProvabilityConfig } from "@crewhaus/tool-proof";
import { NON_CLI_TOOL_FLAGS, TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";

const FLAGS = { ...TOOL_FLAGS, ...NON_CLI_TOOL_FLAGS };

const loweredDefault = (): ReadonlyArray<string> => {
  const ir = lower(
    parseSpec(
      [
        "version: 2",
        "name: inv",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: x",
        "provability: checked",
      ].join("\n"),
    ),
  );
  const allow = (ir as { provability?: { execution: { allow: ReadonlyArray<string> } } })
    .provability?.execution.allow;
  if (allow === undefined) throw new Error("provability did not lower");
  return allow;
};

describe("the default provability.execution.allow (design §6.3)", () => {
  test("every entry is a read-only, non-destructive, in-process builtin", () => {
    const allow = loweredDefault();
    expect(allow.length).toBeGreaterThan(50);
    const offenders = allow
      .map((key) => ({ key, flags: FLAGS[key] }))
      .filter(
        ({ flags }) =>
          flags === undefined ||
          !flags.readOnly ||
          flags.destructive ||
          flags.scope !== "internal" ||
          flags.requiresSandbox ||
          flags.ioCapability !== undefined,
      )
      .map(({ key, flags }) => ({
        key,
        readOnly: flags?.readOnly,
        destructive: flags?.destructive,
        scope: flags?.scope,
      }));
    expect(offenders).toEqual([]);
  });

  test("goldenUpdate, the destructive verify tool, is excluded by name", () => {
    expect([...PROVABILITY_DEFAULT_EXECUTION_ALLOW]).toContain("-goldenUpdate");
    expect(FLAGS["goldenUpdate"]?.destructive).toBe(true);
    expect(loweredDefault()).not.toContain("goldenUpdate");
    // Without the exclusion the category would carry it in.
    expect(expandToolSelectors(["all-verify"]).tools).toContain("goldenUpdate");
  });

  test("tool-proof's copy of the default equals the compiler's", () => {
    expect([...DEFAULT_EXECUTION_SELECTORS]).toEqual([...PROVABILITY_DEFAULT_EXECUTION_ALLOW]);
    expect([...defaultProvabilityConfig().execution.allow].sort()).toEqual(
      [...loweredDefault()].sort(),
    );
  });
});
