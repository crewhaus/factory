/**
 * The structured editor covers the whole schema: for every target the compiler
 * knows, every node the form's walk enters is classified exactly once, as a
 * control or as a node for the JSON pane with a reason, and nothing throws.
 * Run twice: over the narrowed schema, and over what Home serves, the same
 * document after the masker, where every credential-named setting is a JSON
 * node that says why. The per-target counts are pinned, so a schema change that
 * silently drops controls fails here.
 */
import { describe, expect, test } from "bun:test";
import { specJsonSchema } from "@crewhaus/spec";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { maskDeep } from "./mask";
import { classifyPath, narrowSchema } from "./spec-edit";

type FormNode = {
  segments: string[];
  kind: string;
  why?: string;
  security: boolean;
  tier: string | null;
  children?: FormNode[];
};
type Counts = {
  visited: number;
  classified: number;
  controls: number;
  json: number;
  groups: number;
};
type SchemaForm = {
  CONTROL_KINDS: readonly string[];
  formModel(
    schema: unknown,
    effective: unknown,
    trust: unknown,
  ): {
    groups: FormNode[];
    counts: Counts;
    why: string | null;
  };
  flatten(groups: FormNode[]): FormNode[];
};

const loadForm = async (): Promise<SchemaForm> =>
  (await import(
    new URL("../../hangar-ui/assets/js/ui/schema-form.js", import.meta.url).href
  )) as SchemaForm;

const WHOLE = specJsonSchema() as Record<string, unknown>;
const TARGETS = Object.keys(WHOLE["definitions"] as Record<string, unknown>).filter(
  (name) => name !== "CrewhausSpec",
);

/** Controls and JSON nodes per target, measured on this schema (the raw run). */
const PINNED: Readonly<Record<string, readonly [controls: number, json: number]>> = {
  cli: [169, 21],
  workflow: [35, 11],
  channel: [181, 22],
  graph: [36, 11],
  managed: [156, 18],
  pipeline: [70, 7],
  crew: [83, 15],
  research: [112, 17],
  batch: [87, 15],
  voice: [26, 6],
  browser: [81, 11],
  eval: [15, 3],
  onchain: [26, 9],
  "onchain-game": [44, 6],
};

describe("the settings form covers every target's schema", () => {
  test("the schema's targets are the fourteen this test pins", () => {
    // `definitions` also holds the root union, `CrewhausSpec`.
    expect(Object.keys(WHOLE["definitions"] as object)).toHaveLength(15);
    expect([...TARGETS].sort()).toEqual(Object.keys(PINNED).sort());
  });

  test("every node is classified once, every JSON node says why, and the counts hold", async () => {
    const form = await loadForm();
    let credentialNamed = 0;
    for (const target of TARGETS) {
      const narrowed = narrowSchema(WHOLE, target);
      expect(`${target} ${narrowed.narrowed}`).toBe(`${target} true`);
      for (const run of ["raw", "masked"] as const) {
        // The masked run is the body the console is served: schema and rows, masked together.
        const served =
          run === "raw"
            ? { schema: narrowed.schema, effective: [] }
            : (maskDeep({ schema: narrowed.schema, effective: [] }) as {
                schema: unknown;
                effective: unknown[];
              });
        const model = form.formModel(served.schema, served.effective, []);
        const where = `${target} (${run})`;
        expect(`${where} ${model.why}`).toBe(`${where} null`);
        expect(`${where} ${model.counts.visited}`).toBe(`${where} ${model.counts.classified}`);
        const nodes = form.flatten(model.groups);
        // Every node the walk entered is in the tree, once.
        expect(`${where} ${nodes.length}`).toBe(`${where} ${model.counts.visited}`);
        for (const node of nodes) {
          const known = [...form.CONTROL_KINDS, "group", "json"].includes(node.kind);
          expect(`${where} ${node.segments.join(".")} ${known}`).toBe(
            `${where} ${node.segments.join(".")} true`,
          );
          if (node.kind === "json") {
            expect(`${where} ${node.segments.join(".")} ${(node.why ?? "") !== ""}`).toBe(
              `${where} ${node.segments.join(".")} true`,
            );
          }
          const last = node.segments[node.segments.length - 1] ?? "";
          if (run === "masked" && isCredentialKey(last)) {
            credentialNamed += 1;
            expect(`${where} ${node.segments.join(".")} ${node.kind}`).toBe(
              `${where} ${node.segments.join(".")} json`,
            );
            expect(String(node.why)).toContain("secret");
          }
        }
        if (run === "raw") {
          const [controls, json] = PINNED[target] as readonly [number, number];
          expect(`${target} ${model.counts.controls}/${model.counts.json}`).toBe(
            `${target} ${controls}/${json}`,
          );
        }
      }
    }
    // The masked run met credential-named settings, so its rule was exercised.
    expect(credentialNamed).toBeGreaterThan(0);
  }, 20_000); // slow by construction: fourteen schemas, each walked twice

  test("the cli schema's landmarks get the control they should", async () => {
    const form = await loadForm();
    const model = form.formModel(
      narrowSchema(WHOLE, "cli").schema,
      [],
      [classifyPath("cli", ["permissions"])],
    );
    const at = (path: string) =>
      form.flatten(model.groups).find((n) => n.segments.join(".") === path) as FormNode;
    expect(at("name").kind).toBe("text");
    expect(at("permissions.mode").kind).toBe("select");
    // A reference into `models`' record, which is a record itself.
    expect(at("tool_config").kind).toBe("json");
    expect(at("permissions").kind).toBe("group");
    expect(at("permissions").security).toBe(true);
    expect(at("permissions").tier).toBe("human-owned");
    // No trust row for it: no tier is guessed.
    expect(at("permissions.mode").tier).toBeNull();
  });
});
