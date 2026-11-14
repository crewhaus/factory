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

/**
 * §9.1 loop 4 — `models propose --source sunset` PRINTS the right-size gate
 * command, and `parseArgs` rejects any flag a schema does not declare. A gate
 * whose printed command dies with "unknown flag" is worse than no gate: it
 * teaches an operator the verbs are decorative.
 */
describe("the sunset gate's flags are the flags `model right-size` accepts", () => {
  test("--slot and --candidates parse, with their values", () => {
    const parsed = parseArgs(
      ["spec.yaml", "--slot", "agent.model", "--candidates", "claude-haiku-4-5,claude-sonnet-4-5"],
      SCHEMAS.MODEL_SCHEMA,
    );
    expect(parsed.flags["slot"]).toBe("agent.model");
    expect(parsed.flags["candidates"]).toBe("claude-haiku-4-5,claude-sonnet-4-5");
    expect(parsed.positional[0]).toBe("spec.yaml");
  });

  test("the whole printed gate command parses", () => {
    expect(() =>
      parseArgs(
        [
          "crewhaus.yaml",
          "--dataset",
          "eval/dataset.jsonl",
          "--graders",
          "eval/graders.yaml",
          "--slot",
          "compaction.model",
          "--candidates",
          "claude-haiku-4-5",
          "--min-cost-drop",
          "-1",
        ],
        SCHEMAS.MODEL_SCHEMA,
      ),
    ).not.toThrow();
  });
});

/**
 * The knowledge-editing verbs' printed and documented commands parse: a
 * correction, a mark, a person's wiki version, an archive, a rollback, the
 * guarded clear with its fingerprint, a trash restore and a lesson retirement.
 */
describe("the knowledge-editing verbs' flags parse", () => {
  test("memory correct, mark and forget --reason", () => {
    const correct = parseArgs(
      ["correct", "mem_0123456789abcdef", "--text", "floor 4", "--reason", "moved", "--yes"],
      SCHEMAS.MEMORY_SCHEMA,
    );
    expect([correct.flags["text"], correct.flags["reason"], correct.flags["yes"]]).toEqual([
      "floor 4",
      "moved",
      true,
    ]);
    expect(
      parseArgs(
        ["correct", "mem_x", "--text-file", "fix.txt", "--reason", "r"],
        SCHEMAS.MEMORY_SCHEMA,
      ).flags["text-file"],
    ).toBe("fix.txt");
    expect(
      parseArgs(["mark", "mem_x", "--personal"], SCHEMAS.MEMORY_SCHEMA).flags["personal"],
    ).toBe(true);
    expect(
      parseArgs(["mark", "mem_x", "--not-personal"], SCHEMAS.MEMORY_SCHEMA).flags["not-personal"],
    ).toBe(true);
    expect(
      parseArgs(["forget", "mem_x", "--reason", "stale"], SCHEMAS.MEMORY_SCHEMA).flags["reason"],
    ).toBe("stale");
  });

  test("wiki write, archive and rollback", () => {
    const write = parseArgs(
      ["write", "faq", "--body-file", "faq.md", "--expect", "0", "--title", "FAQ"],
      SCHEMAS.WIKI_SCHEMA,
    );
    expect([write.flags["body-file"], write.flags["expect"], write.flags["title"]]).toEqual([
      "faq.md",
      "0",
      "FAQ",
    ]);
    expect(
      parseArgs(["archive", "faq", "--expect", "3", "--undo"], SCHEMAS.WIKI_SCHEMA).flags["undo"],
    ).toBe(true);
    expect(
      parseArgs(["rollback", "faq", "--to", "2", "--expect", "3"], SCHEMAS.WIKI_SCHEMA).flags["to"],
    ).toBe("2");
  });

  test("state clear, trash and restore --trash", () => {
    const clear = parseArgs(
      [
        "clear",
        "--scope",
        "plans",
        "--session",
        "sess_0123456789abcdef",
        "--spec",
        "bot",
        "--yes",
        "--expect",
        "ab12",
      ],
      SCHEMAS.STATE_SCHEMA,
    );
    expect([
      clear.flags["scope"],
      clear.flags["session"],
      clear.flags["spec"],
      clear.flags["yes"],
      clear.flags["expect"],
    ]).toEqual(["plans", "sess_0123456789abcdef", "bot", true, "ab12"]);
    expect(
      parseArgs(["restore", "--trash", "2026-11-01T00-00-00"], SCHEMAS.STATE_SCHEMA).flags["trash"],
    ).toBe("2026-11-01T00-00-00");
  });

  test("state backup --include", () => {
    expect(
      parseArgs(["backup", "--include", "run/mcp-token"], SCHEMAS.STATE_SCHEMA).flags["include"],
    ).toBe("run/mcp-token");
  });

  test("lessons retire --reason", () => {
    expect(
      parseArgs(["retire", "l0123456789abcdef", "--reason", "wrong"], SCHEMAS.LESSONS_SCHEMA).flags[
        "reason"
      ],
    ).toBe("wrong");
  });
});
