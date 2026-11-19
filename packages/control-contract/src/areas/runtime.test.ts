import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import type { z } from "zod";
import { walkFieldNames } from "../__test__/checkers.js";
import { ASSESSMENT, EXAMPLES } from "../__test__/runtime.examples.js";
import {
  CAPABILITY_NAMES,
  CLI_VERBS,
  COMMAND_KINDS,
  CURSOR_SOURCES,
  EVENT_TAXONOMY,
  MACHINES,
  OPERATIONS,
  RUNTIME_MODULE,
  TWIN_PLACEHOLDERS,
  WORK_EVENTS,
  WORK_LOG_KEYS,
  WORK_STATES,
  canTransition,
  mintId,
  parseTwin,
  renderTwin,
} from "../index.js";
import { SCHEMAS } from "../schemas/index.js";
import { WORK_SCHEMAS } from "../schemas/runtime-work.js";
import { RUNTIME_SCHEMAS } from "../schemas/runtime.js";
import { AREA_MODULES } from "./index.js";

const HRN = "hrn_0123456789abcdef";
const WORK_ROWS = OPERATIONS.filter((op) => op.id.startsWith("work."));

describe("the runtime area's work half", () => {
  test("composes into the build, after the areas before it", () => {
    expect(AREA_MODULES).toContain(RUNTIME_MODULE);
    expect(WORK_ROWS.map((op) => op.id)).toEqual([
      "work.list",
      "work.feed",
      "work.get",
      "work.create",
      "work.update",
      "work.accept",
      "work.decline",
      "work.reopen",
      "work.cancel",
      "work.rank",
      "work.start",
      "work.adopt",
    ]);
    expect(CAPABILITY_NAMES).toContain("work.items");
    expect(CURSOR_SOURCES).toContain("work");
    expect([...RUNTIME_MODULE.rawExclusions]).toEqual([".crewhaus/run/control/work/items/"]);
  });

  test("no log key and no schema field is a name the masker hides", () => {
    for (const key of WORK_LOG_KEYS)
      expect(`${key}: ${isCredentialKey(key)}`).toBe(`${key}: false`);
    let fields = 0;
    for (const [id, schema] of Object.entries(RUNTIME_SCHEMAS)) {
      walkFieldNames(schema as z.ZodTypeAny, (name, path) => {
        fields++;
        expect(`${id}.${path}: ${isCredentialKey(name)}`).toBe(`${id}.${path}: false`);
      });
    }
    expect(fields).toBeGreaterThan(60);
  });

  test("the work machine reaches every state, and lists each state's self-transition", () => {
    const machine = MACHINES.work;
    expect([...machine.states]).toEqual([...WORK_STATES]);
    expect([...machine.entry]).toEqual(["proposed", "open"]);
    expect([...machine.terminal]).toEqual([]);
    // An `updated`, `linked`, `ranked` or `delivered` line leaves the state where it was.
    for (const state of WORK_STATES) expect(canTransition("work", state, state)).toBe(true);
    expect(canTransition("work", "proposed", "open")).toBe(true);
    expect(canTransition("work", "proposed", "closed")).toBe(true);
    expect(canTransition("work", "open", "closed")).toBe(true);
    expect(canTransition("work", "closed", "open")).toBe(true);
    // A closed item reopens to `open`, never back to a proposal.
    expect(canTransition("work", "closed", "proposed")).toBe(false);
    expect(canTransition("work", "open", "proposed")).toBe(false);
  });

  test("every operation has a permission, its schemas, and a twin or the reason it has none", () => {
    for (const op of WORK_ROWS) {
      expect(op.permission.length).toBeGreaterThan(0);
      expect(SCHEMAS[op.request]).toBeDefined();
      expect(SCHEMAS[op.response]).toBeDefined();
      expect(op.cliTwin !== null || (op.noTwinReason?.length ?? 0) > 0).toBe(true);
      if (op.receipt !== "none") expect(Object.hasOwn(COMMAND_KINDS, op.id)).toBe(true);
    }
    const perm = Object.fromEntries(WORK_ROWS.map((op) => [op.id, op.permission]));
    expect(perm["work.cancel"]).toBe("h.control");
    expect(perm["work.list"]).toBe("h.read");
    for (const id of ["work.accept", "work.decline", "work.reopen", "work.rank"]) {
      expect(WORK_ROWS.find((op) => op.id === id)?.qualifiers).toContain("human-only");
    }
    expect(CLI_VERBS.work).toContain("rank");
  });

  test("free text a person writes is classified at api when a tool reads it back", () => {
    const bound = WORK_ROWS.flatMap((op) =>
      Object.entries(op.modelBound ?? {}).map(
        ([field, decl]) => `${op.id}.${field} ${JSON.stringify(decl)}`,
      ),
    );
    const write = `{"origin":"api","at":"write"}`;
    expect(bound).toEqual([
      `work.create.title ${write}`,
      `work.create.goal ${write}`,
      `work.create.acceptance ${write}`,
      `work.create.assessment ${write}`,
      `work.update.title ${write}`,
      `work.update.goal ${write}`,
      `work.update.acceptance ${write}`,
      `work.update.assessment ${write}`,
      `work.update.note ${write}`,
      `work.decline.note ${write}`,
    ]);
    const create = OPERATIONS.find((op) => op.id === "runs.create");
    expect(create?.modelBound?.["work"]).toEqual({ origin: "api", at: "write" });
  });

  test("the work events carry ids and states only", () => {
    for (const event of WORK_EVENTS) {
      expect(EVENT_TAXONOMY[`work.${event}` as keyof typeof EVENT_TAXONOMY]?.sensitivity).toBe(
        "internal",
      );
    }
  });
});

describe("the work twins", () => {
  const wi = mintId("wi");
  const params = {
    hrn: HRN,
    wi,
    belowWi: mintId("wi"),
    declineReason: "duplicate",
    correctionScope: "similar",
    workSource: "continuity-goal:goal-0003",
  };

  test("every new placeholder round-trips through renderTwin and parseTwin", () => {
    let checked = 0;
    for (const op of WORK_ROWS) {
      if (op.cliTwin === null) continue;
      const rendered = renderTwin(op.cliTwin, params);
      if (!("argv" in rendered)) throw new Error(`${op.id}: ${JSON.stringify(rendered)}`);
      const parsed = parseTwin(op.cliTwin, rendered.argv);
      for (const [name, value] of Object.entries(parsed?.params ?? {})) {
        expect(value).toBe((params as Record<string, string>)[name] as string);
      }
      checked++;
    }
    expect(checked).toBe(11);
    for (const token of [
      "{wi}",
      "{belowWi}",
      "{declineReason}",
      "{correctionScope}",
      "{workSource}",
    ]) {
      expect(Object.hasOwn(TWIN_PLACEHOLDERS, token)).toBe(true);
    }
  });

  test("{workSource} refuses a Thredz task and an issue: the CLI cannot adopt them", () => {
    const adopt = WORK_ROWS.find((op) => op.id === "work.adopt")?.cliTwin;
    if (adopt === null || adopt === undefined) throw new Error("no adopt twin");
    for (const workSource of ["thredz-task:abc", "github-issue:acme/app#4"]) {
      expect(renderTwin(adopt, { ...params, workSource })).toEqual({ invalid: ["workSource"] });
    }
  });
});

describe("the work schemas", () => {
  const parse = (id: string, value: unknown) =>
    (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;

  test("every example parses", () => {
    for (const [id, value] of Object.entries(EXAMPLES)) {
      expect(`${id}: ${parse(id, value)}`).toBe(`${id}: true`);
    }
    expect(Object.keys(EXAMPLES).sort()).toEqual(Object.keys(WORK_SCHEMAS).sort());
  });

  test("runs.create takes a work item, its ref or one to create, and never a proposal", () => {
    const wi = mintId("wi");
    expect(parse("runCreateRequest", { input: "x", work: wi })).toBe(true);
    expect(parse("runCreateRequest", { input: "x", work: `${HRN}/work/${wi}` })).toBe(true);
    expect(parse("runCreateRequest", { input: "x", work: { title: "Fix it", kind: "fix" } })).toBe(
      true,
    );
    expect(
      parse("runCreateRequest", {
        input: "x",
        work: { title: "Fix it", kind: "fix", propose: true },
      }),
    ).toBe(false);
    expect(parse("runCreateRequest", { input: "x", work: mintId("cmd") })).toBe(false);
    expect(parse("runCreateRequest", { input: "x", work: { title: "", kind: "fix" } })).toBe(false);
  });

  test("requests refuse what they must", () => {
    expect(parse("workCreateRequest", { title: "x".repeat(201), kind: "fix" })).toBe(false);
    expect(parse("workCreateRequest", { title: "x", kind: "chore" })).toBe(false);
    expect(parse("workCreateRequest", { title: "x", kind: "fix", priority: 5 })).toBe(false);
    expect(parse("workCreateRequest", { title: "x", kind: "fix", extra: 1 })).toBe(false);
    expect(
      parse("workCreateRequest", {
        title: "x",
        kind: "fix",
        acceptance: Array.from({ length: 21 }, () => "y"),
      }),
    ).toBe(false);
    expect(parse("workUpdateRequest", { note: "no revision" })).toBe(false);
    expect(parse("workDeclineRequest", { reason: "because" })).toBe(false);
    expect(parse("workRankRequest", { below: mintId("wi"), scope: "everything" })).toBe(false);
    expect(parse("workAdoptRequest", { source: "continuity-goal:goal-0001" })).toBe(true);
    expect(parse("workAdoptRequest", { source: "thredz-task:t_1" })).toBe(true);
    expect(parse("workAdoptRequest", { source: "github-issue:acme/app#12" })).toBe(true);
    expect(parse("workAdoptRequest", { source: "file:/etc/passwd" })).toBe(false);
    expect(parse("workAssessment", { ...ASSESSMENT, cost: 4 })).toBe(false);
    expect(
      parse("workEvidence", {
        label: "certain",
        kind: "user-report",
        note: "x",
        ingestedAt: "now",
      }),
    ).toBe(false);
  });
});
