/**
 * The integrations area as composed, its plugin rows (#522): the operations, the
 * `pgt_` grant id, the `pluginGrant` lifecycle, the command kinds, the `plugin`
 * event family, the `{plugin}` placeholder and path param, and the schemas.
 */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { type OperationEnv, checkMachine, checkOperations } from "./__test__/checkers.js";
import {
  CLI_VERBS,
  COMMAND_KINDS,
  EVENT_TAXONOMY,
  INTEGRATIONS_MODULE,
  MACHINES,
  OPERATIONS,
  PERMISSIONS,
  PERMISSION_DECLS,
  PLUGIN_EVENT_FAMILIES,
  QUALIFIERS,
  TWIN_PLACEHOLDERS,
  canTransition,
  isPathParam,
  mintId,
  parseId,
  parseTwin,
  renderTwin,
} from "./index.js";
import { SCHEMAS } from "./schemas/index.js";

const HRN = "hrn_0123456789abcdef";
const rows = OPERATIONS.filter((op) => op.id.startsWith("plugins."));
const row = (id: string) => rows.find((op) => op.id === id);
const parse = (id: string, value: unknown) =>
  (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;

describe("operations", () => {
  test("three rows, checked with every other row", () => {
    expect(rows.map((op) => [op.id, op.method, op.path, op.permission, op.receipt])).toEqual([
      ["plugins.review", "GET", "/api/v1/plugins/{plugin}/review", "home.read", "none"],
      [
        "plugins.grant",
        "PUT",
        "/api/v1/plugins/{plugin}/grant",
        "home.settings.manage",
        "workspace",
      ],
      [
        "plugins.revoke",
        "POST",
        "/api/v1/plugins/{plugin}/revoke",
        "home.settings.manage",
        "workspace",
      ],
    ]);
    const env: OperationEnv = {
      permissions: PERMISSIONS,
      qualifiers: QUALIFIERS,
      schemas: SCHEMAS,
      commandKinds: Object.values(COMMAND_KINDS),
      cliVerbs: CLI_VERBS,
      placeholders: TWIN_PLACEHOLDERS,
    };
    expect(checkOperations(OPERATIONS, env)).toEqual([]);
  });

  test("writes are human-only; the review is filtered to what the caller can see", () => {
    expect(row("plugins.review")?.qualifiers).toEqual(["filtered"]);
    expect(row("plugins.grant")?.qualifiers).toEqual(["human-only"]);
    expect(row("plugins.revoke")?.qualifiers).toEqual(["human-only"]);
    expect(PERMISSION_DECLS["home.settings.manage"]?.service).toBe("never");
  });

  test("a grant has no twin, because a twin fills one value per placeholder", () => {
    expect(row("plugins.grant")?.cliTwin).toBeNull();
    expect(row("plugins.grant")?.noTwinReason).toContain("crewhaus plugins grant <name>");
    expect(COMMAND_KINDS["plugins.grant"].cliTwin).toBeNull();
  });

  test("the review and revoke twins render with a plugin name and parse back", () => {
    for (const id of ["plugins.review", "plugins.revoke"] as const) {
      const twin = row(id)?.cliTwin;
      expect(twin).not.toBeNull();
      const rendered = renderTwin(twin as never, { plugin: "notes-pane" });
      expect("argv" in rendered).toBe(true);
      const argv = (rendered as { argv: string[] }).argv;
      expect(parseTwin(twin as never, argv)).toEqual({ params: { plugin: "notes-pane" } });
      expect("invalid" in renderTwin(twin as never, { plugin: "--all" })).toBe(true);
    }
    expect(CLI_VERBS.plugins).toEqual(["grants", "revoke"]);
  });

  test("command kinds: idempotent, local, the owner's", () => {
    for (const id of ["plugins.grant", "plugins.revoke"] as const) {
      expect(COMMAND_KINDS[id]).toMatchObject({
        permission: "home.settings.manage",
        idempotent: true,
        effect: "local",
      });
    }
  });
});

describe("ids, placeholder and path param", () => {
  test("pgt mints a ULID id that parses back", () => {
    const id = mintId("pgt");
    expect(parseId(id)).toEqual({ prefix: "pgt", body: id.slice(4), grammar: "ulid" });
  });

  test("{plugin} takes a plugin name, one segment, and nothing that reads as a flag", () => {
    const grammar = TWIN_PLACEHOLDERS["{plugin}"];
    for (const ok of ["abc", "notes-pane"]) {
      expect(grammar.test(ok)).toBe(true);
      expect(isPathParam("plugin", [ok])).toBe(true);
    }
    for (const bad of ["ab", "-x-", "Notes", "notes-", "a/b", "../x"]) {
      expect(grammar.test(bad)).toBe(false);
      expect(isPathParam("plugin", [bad])).toBe(false);
    }
    expect(isPathParam("plugin", ["notes", "pane"])).toBe(false);
  });
});

describe("the pluginGrant lifecycle", () => {
  test("is sound, and a revoked grant never comes back", () => {
    expect(checkMachine("pluginGrant", MACHINES.pluginGrant)).toEqual([]);
    expect(canTransition("pluginGrant", "granted", "granted")).toBe(true);
    expect(canTransition("pluginGrant", "granted", "revoked")).toBe(true);
    expect(canTransition("pluginGrant", "revoked", "granted")).toBe(false);
    expect(MACHINES.pluginGrant.terminal).toEqual(["revoked"]);
  });
});

describe("events", () => {
  test("the plugin family is declared, internal", () => {
    for (const type of [
      "plugin.installed",
      "plugin.granted",
      "plugin.revoked",
      "plugin.asks-for-more",
    ] as const) {
      expect(EVENT_TAXONOMY[type]).toEqual({ family: "plugin", sensitivity: "internal" });
    }
  });

  test("every family a plugin may ask for is a family in the taxonomy", () => {
    const families = new Set(Object.values(EVENT_TAXONOMY).map((row) => row.family));
    for (const family of PLUGIN_EVENT_FAMILIES) expect(families.has(family)).toBe(true);
    expect(INTEGRATIONS_MODULE.area).toBe("integrations");
  });
});

describe("schemas", () => {
  const ok = {
    harnesses: [HRN],
    panes: ["board"],
    events: ["run"],
    reads: ["run.trace"],
    net: ["https://api.example.com"],
    tools: ["Read"],
  };

  test("a grant request takes a list or all, and an optional generation", () => {
    expect(parse("pluginGrantRequest", ok)).toBe(true);
    expect(parse("pluginGrantRequest", { ...ok, harnesses: "all", expect: 2 })).toBe(true);
  });

  test("a grant request refuses what it must", () => {
    expect(parse("pluginGrantRequest", { ...ok, harnesses: ["support"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, events: ["runs"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, reads: ["secrets"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, net: ["https://api.example.com/path"] })).toBe(
      false,
    );
    expect(parse("pluginGrantRequest", { ...ok, net: ["https://*.example.com"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, tools: ["Fetch(x)"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, panes: ["../x"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, panes: ["a", "a"] })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, expect: 0 })).toBe(false);
    expect(parse("pluginGrantRequest", { ...ok, extra: 1 })).toBe(false);
    const { tools: _t, ...noTools } = ok;
    expect(parse("pluginGrantRequest", noTools)).toBe(false);
  });
});
