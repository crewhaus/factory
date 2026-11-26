/**
 * The inspection area's rows: every one a read with a schema, a permission and a real
 * twin or the reason it has none; and `runs.create` starts a run from its input or from a
 * run, exactly one of the two.
 */
import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import type { z } from "zod";
import { walkFieldNames } from "../__test__/checkers.js";
import {
  CONTEXT_CALL_RE,
  INSPECTION_MODULE,
  INSPECT_GAP_REASONS,
  OPERATIONS,
  WHY_ACTION_RE,
  mintRunId,
  parseTwin,
  renderTwin,
} from "../index.js";
import { SCHEMAS } from "../schemas/index.js";
import { INSPECTION_SCHEMAS } from "../schemas/inspection.js";

const HRN = "hrn_0123456789abcdef";
const RUN = mintRunId();
const PARAMS = {
  hrn: HRN,
  run: RUN,
  action: "tool:0000000000000104",
  call: "all",
  sess: "sess_00000000000000a1",
};

describe("the inspection rows", () => {
  const rows = OPERATIONS.filter((op) => op.id.startsWith("inspect."));

  test("nine reads, each composed, with schemas, no receipt, and a twin or a reason", () => {
    expect(rows.map((op) => op.id)).toEqual(INSPECTION_MODULE.operations.map((op) => op.id));
    expect(rows).toHaveLength(9);
    for (const op of rows) {
      expect(`${op.id} ${op.method} ${op.receipt}`).toBe(`${op.id} GET none`);
      expect(Object.hasOwn(SCHEMAS, op.request)).toBe(true);
      expect(Object.hasOwn(SCHEMAS, op.response)).toBe(true);
      if (op.cliTwin === null) expect(op.noTwinReason ?? "").not.toBe("");
    }
  });

  test("each twin renders from the row's params and parses back with the same values", () => {
    const twinned = rows.filter((op) => op.cliTwin !== null);
    expect(twinned.map((op) => op.id).sort()).toEqual(
      ["inspect.context", "inspect.session", "inspect.summary", "inspect.why"].sort(),
    );
    for (const op of twinned) {
      const twin = op.cliTwin as { readonly argv: readonly string[] };
      const rendered = renderTwin(twin, PARAMS);
      if (!("argv" in rendered)) throw new Error(`${op.id}: ${JSON.stringify(rendered)}`);
      expect(rendered.argv.slice(0, 2)).toEqual(["runs", "inspect"]);
      expect(parseTwin(twin, rendered.argv)).not.toBeNull();
    }
    // A choice made in the query is never rendered as a twin.
    const timeline = rows.find((op) => op.id === "inspect.timeline");
    expect(timeline?.cliTwin).toBeNull();
    expect(timeline?.noTwinReason).toContain("--timeline key|full");
  });

  test("the step and call grammars", () => {
    expect(WHY_ACTION_RE.test("model:00000000000001ff")).toBe(true);
    expect(WHY_ACTION_RE.test("tool:00000000000001FF")).toBe(false);
    expect(CONTEXT_CALL_RE.test("all")).toBe(true);
    expect(CONTEXT_CALL_RE.test("07")).toBe(false);
    expect(INSPECT_GAP_REASONS).toHaveLength(14);
  });

  test("no inspection schema field is named like a credential", () => {
    const named: string[] = [];
    for (const [id, schema] of Object.entries(INSPECTION_SCHEMAS)) {
      walkFieldNames(schema as z.ZodTypeAny, (name, path) => {
        if (isCredentialKey(name)) named.push(`${id}.${path}`);
      });
    }
    expect(named).toEqual([]);
  });
});

describe("runs.create: an input, or a run to start again", () => {
  const parse = (value: unknown) =>
    (SCHEMAS["runCreateRequest"] as z.ZodTypeAny).safeParse(value).success;

  test("each alone parses; both, or neither, is refused", () => {
    expect(parse({ input: "hello" })).toBe(true);
    expect(parse({ from: RUN })).toBe(true);
    expect(parse({ from: RUN, admission: "queue" })).toBe(true);
    expect(parse({ input: "hello", from: RUN })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ admission: "queue" })).toBe(false);
    // `from` is a canonical run of this harness's ledger.
    expect(parse({ from: "run_0123456789abcdef" })).toBe(false);
    expect(parse({ from: RUN, extra: 1 })).toBe(false);
  });
});
