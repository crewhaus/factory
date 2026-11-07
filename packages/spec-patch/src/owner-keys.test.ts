/**
 * The owner-keys table (#514): what it derives, what it refuses, and the control
 * that keeps a root-anchored row from reaching a node or a role of the same name.
 */
import { describe, expect, test } from "bun:test";
import { Spec, parseSpec } from "@crewhaus/spec";
import type { ZodObject, ZodOptional, ZodRawShape } from "zod";
import {
  DELTA_090_KEYS,
  HUMAN_OWNED_PATHS,
  OPTIMIZER_REFUSED_LEAVES,
  OPTIMIZER_REFUSED_ROOTS,
  SpecPatchError,
  applySpecEdits,
  humanOwnedReason,
  isCredentialKey,
  isOptimizable,
  validatePatch,
} from "./index";

const TARGETS = Spec.options.map((option) => option.shape.target.value) as Spec["target"][];
const INTENT = DELTA_090_KEYS.find((key) => key.pattern.join(".") === "intent");

const CLI_SPEC = `# keep this header
name: owner-keys-fixture
target: cli
agent:
  model: claude-opus-4-7 # and this note
  instructions: Help.
`;

describe("the intent block's field names", () => {
  test("none of them masks to [redacted], read off the schema rather than a list here", () => {
    const first = Spec.options[0] as unknown as ZodObject<ZodRawShape>;
    const block = first.shape["intent"] as ZodOptional<ZodObject<ZodRawShape>>;
    const fields = Object.keys(block.unwrap().shape);
    expect(fields.slice().sort()).toEqual(["excludes", "outcomes", "purpose", "serves"]);
    expect(isCredentialKey("intent")).toBe(false);
    for (const field of fields) expect(isCredentialKey(field), field).toBe(false);
  });
});

describe("the lists derive from the table", () => {
  test("HUMAN_OWNED_PATHS ends with every row: pattern, reason and root", () => {
    const tail = HUMAN_OWNED_PATHS.slice(-DELTA_090_KEYS.length);
    expect(tail).toEqual(
      DELTA_090_KEYS.map((key) => ({
        pattern: key.pattern,
        reason: key.reason,
        ...(key.root === true ? { root: true as const } : {}),
      })),
    );
  });

  test("OPTIMIZER_REFUSED_ROOTS holds exactly the refused root rows", () => {
    expect(OPTIMIZER_REFUSED_ROOTS).toEqual(
      DELTA_090_KEYS.filter((key) => key.refused && key.root === true).map((key) => key.pattern),
    );
    expect(OPTIMIZER_REFUSED_ROOTS).toEqual([["intent"]]);
    expect(Object.isFrozen(OPTIMIZER_REFUSED_ROOTS)).toBe(true);
  });

  test("OPTIMIZER_REFUSED_LEAVES keeps its rows and gains no root row", () => {
    expect(OPTIMIZER_REFUSED_LEAVES).toEqual([
      ["model_pool", "learning", "seed"],
      ["provability", "level"],
      ["provability", "on_fail"],
    ]);
  });

  test("a row appears once in each list that takes it", () => {
    const named = (rows: ReadonlyArray<ReadonlyArray<string>>): number =>
      rows.filter((pattern) => pattern.join(".") === "intent").length;
    expect(named(HUMAN_OWNED_PATHS.map((row) => row.pattern))).toBe(1);
    expect(named(OPTIMIZER_REFUSED_ROOTS)).toBe(1);
    expect(named(OPTIMIZER_REFUSED_LEAVES)).toBe(0);
  });
});

describe("the optimizer is refused intent on every shape", () => {
  for (const target of TARGETS) {
    test(`${target}: validatePatch refuses the block and a field inside it, with the row's reason`, () => {
      // The refusal comes before anything reads the spec, so the target alone will do.
      const spec = { target } as Spec;
      for (const path of [["intent"], ["intent", "purpose"]]) {
        let message = "";
        try {
          validatePatch(spec, { target, path, op: "replace", value: "x" });
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toContain(INTENT?.reason as string);
        expect(message).toContain("OPTIMIZER_REFUSED_ROOTS");
        expect(message).not.toContain("OPTIMIZER_REFUSED_LEAVES");
        expect(message).not.toContain("add it to");
      }
      expect(isOptimizable(target, ["intent"])).toBe(false);
      expect(isOptimizable(target, ["intent", "serves", 0])).toBe(false);
    });
  }

  test("a remove and an add at the block are refused too", () => {
    const spec = parseSpec(CLI_SPEC);
    for (const op of ["remove", "add"] as const) {
      expect(() =>
        validatePatch(spec, { target: "cli", path: ["intent"], op, value: { purpose: "p" } }),
      ).toThrow("OPTIMIZER_REFUSED_ROOTS");
    }
  });
});

describe("a node or a role of the same name stays tunable", () => {
  const GRAPH = parseSpec(`name: g
target: graph
model: claude-opus-4-7
entry: intent
nodes:
  intent:
    instructions: Classify the ticket.
edges: []
`);

  test("validatePatch lets a graph node called intent be tuned", () => {
    expect(() =>
      validatePatch(GRAPH, {
        target: "graph",
        path: ["nodes", "intent", "instructions"],
        op: "replace",
        value: "Classify it again.",
      }),
    ).not.toThrow();
  });

  test("the matcher admits both, and neither reads as human-owned", () => {
    const node = ["nodes", "intent", "instructions"];
    const role = ["roles", "intent", "instructions"];
    expect(isOptimizable("graph", node)).toBe(true);
    expect(isOptimizable("crew", role)).toBe(true);
    expect(humanOwnedReason(node)).toBeUndefined();
    expect(humanOwnedReason(role)).toBeUndefined();
  });

  test("the root row does read the block and a field inside it as human-owned", () => {
    expect(humanOwnedReason(["intent"])).toBe(INTENT?.reason as string);
    expect(humanOwnedReason(["intent", "serves", 0])).toBe(INTENT?.reason as string);
  });
});

describe("the table's own rules", () => {
  test("it has rows, and it is frozen", () => {
    expect(DELTA_090_KEYS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DELTA_090_KEYS)).toBe(true);
    for (const key of DELTA_090_KEYS) {
      expect(Object.isFrozen(key)).toBe(true);
      expect(Object.isFrozen(key.pattern)).toBe(true);
    }
  });

  for (const key of DELTA_090_KEYS) {
    const name = key.pattern.join(".");

    test(`${name}: a one-segment pattern is root-anchored`, () => {
      if (key.pattern.length === 1) expect(key.root).toBe(true);
    });

    test(`${name}: a refused row has no wildcard yet`, () => {
      // The refused-leaf matcher compares with ===, so a "*" would match
      // nothing. The PR that teaches refusedLeafIn wildcards deletes this.
      if (key.refused) expect(key.pattern).not.toContain("*");
    });

    test(`${name}: it states a reason and a release, and does not end in a wildcard`, () => {
      expect(key.reason.length).toBeGreaterThan(10);
      expect(key.since).toBe("0.9.0");
      expect(key.pattern.at(-1)).not.toBe("*");
    });
  }
});

describe("applySpecEdits", () => {
  const EDIT = [{ path: ["intent", "purpose"], value: "Keep it fast." }];

  test("restrictToOptimizable refuses intent.purpose, naming the path", () => {
    let caught: unknown;
    try {
      applySpecEdits(CLI_SPEC, EDIT, { restrictToOptimizable: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SpecPatchError);
    expect((caught as Error).message).toContain("intent.purpose");
  });

  test("a person's edit applies, keeps the comments and parses", () => {
    const { yaml, spec, applied } = applySpecEdits(CLI_SPEC, EDIT);
    expect(applied).toBe(1);
    expect(yaml).toContain("# keep this header");
    expect(yaml).toContain("# and this note");
    expect(spec.intent?.purpose).toBe("Keep it fast.");
    expect(parseSpec(yaml).intent?.purpose).toBe("Keep it fast.");
  });
});
