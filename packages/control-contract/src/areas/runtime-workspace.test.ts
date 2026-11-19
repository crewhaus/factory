import { describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import type { z } from "zod";
import { walkFieldNames } from "../__test__/checkers.js";
import { EXAMPLES } from "../__test__/runtime-workspace.examples.js";
import {
  CAPABILITY_NAMES,
  CLI_VERBS,
  COMMAND_KINDS,
  EVENT_TAXONOMY,
  MACHINES,
  OPERATIONS,
  WORKSPACE_LOG_KEYS,
  WORK_DELIVERY_KINDS,
  WORK_PR_LOG_KEYS,
  WORK_PUBLISH_LOG_KEYS,
  canTransition,
  mintId,
  parseTwin,
  renderTwin,
} from "../index.js";
import { SCHEMAS } from "../schemas/index.js";
import { WORKSPACE_SCHEMAS } from "../schemas/runtime-workspace.js";
import { RUNTIME_MODULE } from "./runtime.js";

const HRN = "hrn_0123456789abcdef";
const ROWS = OPERATIONS.filter((op) => op.id === "work.publish" || op.id.startsWith("workspaces."));

describe("the runtime area's workspace half", () => {
  test("composes into the runtime module on its own lines", () => {
    expect(ROWS.map((op) => op.id)).toEqual(["work.publish", "workspaces.list", "workspaces.get"]);
    expect(RUNTIME_MODULE.operations.map((op) => op.id)).toContain("work.publish");
    expect(CAPABILITY_NAMES).toContain("work.workspaces");
    expect(WORK_DELIVERY_KINDS).toContain("pr");
    expect(CLI_VERBS.workspace).toEqual(["list", "show"]);
    expect(CLI_VERBS.work).toContain("publish");
  });

  test("publishing is an external command a reconciler finishes; the reads are reads", () => {
    const publish = COMMAND_KINDS["work.publish" as keyof typeof COMMAND_KINDS] as {
      effect: string;
      idempotent: boolean;
      permission: string;
    };
    expect(publish.effect).toBe("external");
    expect(publish.idempotent).toBe(false);
    expect(publish.permission).toBe("h.run.submit");
    const byId = Object.fromEntries(ROWS.map((op) => [op.id, op]));
    expect(byId["work.publish"]?.method).toBe("POST");
    expect(byId["workspaces.list"]?.method).toBe("GET");
    expect(byId["workspaces.get"]?.method).toBe("GET");
    expect(byId["workspaces.get"]?.qualifiers).toContain("content-fields");
    for (const op of ROWS) {
      expect(SCHEMAS[op.request]).toBeDefined();
      expect(SCHEMAS[op.response]).toBeDefined();
      expect(op.cliTwin).not.toBeNull();
    }
  });

  test("every machine lists each state's self-transition, and a publish ends once", () => {
    for (const name of ["workspace", "work-publish", "work-pr"] as const) {
      const machine = MACHINES[name];
      for (const state of machine.states) {
        if ((machine.terminal as readonly string[]).includes(state)) continue;
        expect(`${name}:${state}:${canTransition(name, state, state)}`).toBe(
          `${name}:${state}:true`,
        );
      }
    }
    expect(canTransition("work-publish", "started", "pushed")).toBe(true);
    expect(canTransition("work-publish", "pushed", "unknown")).toBe(true);
    expect(canTransition("work-publish", "unknown", "done")).toBe(true);
    expect(canTransition("work-publish", "unknown", "not-done")).toBe(true);
    expect(canTransition("work-publish", "done", "started")).toBe(false);
    expect(canTransition("work-publish", "failed", "done")).toBe(false);
    expect(canTransition("work-pr", "merged", "open")).toBe(false);
    expect(canTransition("work-pr", "closed", "open")).toBe(true);
    expect(canTransition("workspace", "closed", "open")).toBe(true);
  });

  test("the events carry ids, SHAs, codes and counts only", () => {
    for (const type of [
      "work.publish.started",
      "work.publish.pushed",
      "work.publish.done",
      "work.publish.failed",
      "work.publish.unknown",
      "work.outcome",
      "workspace.opened",
      "workspace.closed",
    ]) {
      expect(EVENT_TAXONOMY[type as keyof typeof EVENT_TAXONOMY]?.sensitivity).toBe("internal");
    }
  });

  test("no log key and no schema field is a name the masker hides", () => {
    for (const key of [...WORKSPACE_LOG_KEYS, ...WORK_PUBLISH_LOG_KEYS, ...WORK_PR_LOG_KEYS]) {
      expect(`${key}: ${isCredentialKey(key)}`).toBe(`${key}: false`);
    }
    let fields = 0;
    for (const [id, schema] of Object.entries(WORKSPACE_SCHEMAS)) {
      walkFieldNames(schema as z.ZodTypeAny, (name, path) => {
        fields++;
        expect(`${id}.${path}: ${isCredentialKey(name)}`).toBe(`${id}.${path}: false`);
      });
    }
    expect(fields).toBeGreaterThan(30);
  });

  test("the check logs and the managed clones are never served raw", () => {
    expect([...RUNTIME_MODULE.rawExclusions]).toContain(".crewhaus/run/control/work/checks/");
    expect([...RUNTIME_MODULE.rawExclusions]).toContain(".crewhaus/workspaces/");
  });

  test("every twin round-trips through renderTwin and parseTwin", () => {
    const params = { hrn: HRN, wi: mintId("wi") };
    for (const op of ROWS) {
      if (op.cliTwin === null) continue;
      const rendered = renderTwin(op.cliTwin, params);
      if (!("argv" in rendered)) throw new Error(`${op.id}: ${JSON.stringify(rendered)}`);
      const parsed = parseTwin(op.cliTwin, rendered.argv);
      for (const [name, value] of Object.entries(parsed?.params ?? {})) {
        expect(value).toBe((params as Record<string, string>)[name] as string);
      }
    }
  });

  test("every example parses, and every schema has one", () => {
    for (const [id, value] of Object.entries(EXAMPLES)) {
      const ok = (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;
      expect(`${id}: ${ok}`).toBe(`${id}: true`);
    }
    expect(Object.keys(EXAMPLES).sort()).toEqual(Object.keys(WORKSPACE_SCHEMAS).sort());
    // A refusal code outside the closed set is not a view a client can branch on.
    const bad = { ...EXAMPLES.workPublishView, code: "something_else" };
    expect((SCHEMAS["workPublishView"] as z.ZodTypeAny).safeParse(bad).success).toBe(false);
  });
});
