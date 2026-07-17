import { describe, expect, test } from "bun:test";
/**
 * Loop contract 0.4 (Batch B, G42) — projection goldens: one spec per IR
 * variant, driven end-to-end (`parseSpec` → `lower` → `projectLoop`) and
 * pinned byte-for-byte against `__fixtures__/loop-projections.golden.json`.
 *
 * The golden file is the WIRE CONTRACT record for the compiler-worker's
 * `POST /loop` endpoint and the studio's /builder renderer — regenerate it
 * ONLY on a deliberate contract change (rerun `projectLoop` over
 * `LOOP_PROJECTION_SPECS` and review the diff), never to paper over drift.
 */
import { readFileSync } from "node:fs";
import { NO_BUDGET_WARNING, SEGMENT_ORDER, projectLoop } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { LOOP_PROJECTION_SPECS } from "./__fixtures__/loop-projection-specs";
import { lower } from "./index";

const GOLDENS = JSON.parse(
  readFileSync(new URL("./__fixtures__/loop-projections.golden.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("projectLoop — goldens for every IR variant", () => {
  test("the golden file covers exactly the spec set", () => {
    expect(Object.keys(GOLDENS).sort()).toEqual(Object.keys(LOOP_PROJECTION_SPECS).sort());
  });

  for (const [name, yaml] of Object.entries(LOOP_PROJECTION_SPECS)) {
    test(`${name} projection matches its golden byte-for-byte`, () => {
      const projection = projectLoop(lower(parseSpec(yaml)));
      // Round-trip through JSON: the golden is the WIRE shape, so anything
      // that doesn't survive serialization must not be in the projection.
      expect(JSON.parse(JSON.stringify(projection))).toEqual(GOLDENS[name]);
    });
  }
});

describe("projectLoop — structural invariants over the goldens", () => {
  test("every ring carries all seven segments in canonical order", () => {
    for (const yaml of Object.values(LOOP_PROJECTION_SPECS)) {
      const projection = projectLoop(lower(parseSpec(yaml)));
      if (projection.kind !== "ring") continue;
      expect(projection.canvas).toBeUndefined();
      expect(projection.ring?.segments.map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    }
  });

  test("every canvas node mini carries all seven segments in canonical order", () => {
    for (const yaml of Object.values(LOOP_PROJECTION_SPECS)) {
      const projection = projectLoop(lower(parseSpec(yaml)));
      if (projection.kind !== "canvas") continue;
      expect(projection.ring).toBeUndefined();
      for (const node of projection.canvas?.nodes ?? []) {
        expect(node.mini.map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
      }
    }
  });

  test("a defaults-only cli spec gets the NO_BUDGET warning and default-on continuity", () => {
    const projection = projectLoop(
      lower(parseSpec("name: c\ntarget: cli\nagent:\n  model: m\n  instructions: i")),
    );
    expect(projection.warnings).toEqual([NO_BUDGET_WARNING]);
    const update = projection.ring?.segments.find((s) => s.id === "update");
    // 0.3.0 default-on continuity is REAL runtime behaviour, so the IR-side
    // projection lights update (unlike the raw-spec studio projection).
    expect(update?.active).toBe(true);
    expect(update?.keys).toEqual(["continuity"]);
    expect(update?.summary).toBe("continuity (proof: ladder)");
  });

  test("judge gates light the evaluate mini and shape the edges", () => {
    const projection = projectLoop(lower(parseSpec(LOOP_PROJECTION_SPECS["workflow"] ?? "")));
    if (projection.kind !== "canvas") throw new Error("expected canvas");
    const gate = projection.canvas?.nodes.find((n) => n.id === "gate");
    const evaluate = gate?.mini.find((s) => s.id === "evaluate");
    expect(evaluate?.active).toBe(true);
    expect(evaluate?.keys).toEqual(["judge"]);
    expect(projection.canvas?.edges).toEqual([
      { from: "draft", to: "gate" },
      { from: "gate", to: "publish", label: "pass", conditional: true },
      { from: "gate", to: "draft", label: "retry ≤ 2", conditional: true },
    ]);
  });
});
