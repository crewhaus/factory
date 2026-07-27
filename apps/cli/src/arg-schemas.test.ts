import { describe, expect, test } from "bun:test";
import { parseArgs } from "@crewhaus/infra-utils";
import * as SCHEMAS from "./arg-schemas";

/**
 * Exhaustive sweep over every CLI arg schema.
 *
 * `parseArgs` rebuilds its flag-token map on every call, so handing it an empty
 * argv runs all of a schema's structural checks without parsing anything. That
 * is what makes this sweep possible at all — and it is why the schemas were
 * moved out of index.ts, which self-executes at import and therefore cannot be
 * imported by a test. Before the move the only way to reach a schema was to
 * spawn the CLI for the one subcommand that consumes it, and roughly a third of
 * the subcommands are never spawned by any test, so a malformed schema in one
 * of those shipped green and first failed on a user.
 *
 * Deliberately NOT a regex scan of index.ts: biome wraps a flag entry once it
 * passes 100 columns, at which point an entry-matching regex silently stops
 * matching and that schema is skipped with a green test. Asserting on the real
 * objects cannot drift that way.
 */
describe("CLI arg schemas", () => {
  const entries = Object.entries(SCHEMAS);

  test("the sweep covers every schema module", () => {
    // guard: module emptied or renamed → every row below would assert nothing
    expect(entries.length).toBeGreaterThanOrEqual(70);
  });

  test.each(entries)("%s is a schema parseArgs accepts", (_name, schema) => {
    expect(() => parseArgs([], schema)).not.toThrow();
  });

  test.each(entries)("%s declares a help flag", (_name, schema) => {
    expect(schema.flags.some((f) => f.name === "help")).toBe(true);
  });
});
