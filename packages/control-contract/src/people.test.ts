/**
 * The people area as composed: its ids, placeholders, path params, permissions,
 * lifecycles and rows. The package's composition tests already walk every module;
 * these hold the people module's own promises.
 */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  COMMAND_KINDS,
  MACHINES,
  OPERATIONS,
  PEOPLE_MODULE,
  PERMISSION_DECLS,
  ROLE_PERMISSIONS,
  TWIN_PLACEHOLDERS,
  canTransition,
  isPathParam,
  isRef,
  mintId,
  parseId,
  parseTwin,
  renderTwin,
} from "./index.js";
import { SCHEMAS } from "./schemas/index.js";

const placeholder = (token: string, value: string): boolean =>
  (TWIN_PLACEHOLDERS as Readonly<Record<string, RegExp>>)[token]?.test(value) ?? false;

describe("ids", () => {
  test("each people prefix mints a ULID id that parses back, and never prf_", () => {
    const prefixes = ["psn", "pcl", "pex", "per", "spc", "pgr", "ppj", "pso", "piv"] as const;
    for (const prefix of prefixes) {
      const id = mintId(prefix);
      expect(parseId(id)).toEqual({ prefix, body: id.slice(prefix.length + 1), grammar: "ulid" });
    }
    expect(PEOPLE_MODULE.grammars.map((g) => g.prefix)).toEqual([...prefixes]);
    expect(PEOPLE_MODULE.grammars.some((g) => (g.prefix as string) === "prf")).toBe(false);
  });

  test("a person is a home ref", () => {
    const psn = mintId("psn");
    expect(isRef(`home/person/${psn}`)).toBe(true);
    expect(isRef(`hrn_0123456789abcdef/person/${psn}`)).toBe(false);
    expect(isRef(`home/person/${mintId("pcl")}`)).toBe(false);
  });
});

describe("twin placeholders", () => {
  test("{psn} and {pcl} take a minted id and refuse a neighbour", () => {
    for (const [token, prefix, other] of [
      ["{psn}", "psn", "pcl"],
      ["{pcl}", "pcl", "psn"],
    ] as const) {
      const id = mintId(prefix);
      expect(placeholder(token, id)).toBe(true);
      expect(placeholder(token, mintId(other))).toBe(false);
      expect(placeholder(token, id.toUpperCase())).toBe(false);
      expect(placeholder(token, `${prefix}_${"u".repeat(26)}`)).toBe(false);
      expect(placeholder(token, `${id} --force`)).toBe(false);
    }
  });

  test("{kind}, {area} and {verdict} take their closed words and refuse a neighbour", () => {
    for (const kind of ["personal", "audience", "synthetic"]) {
      expect(placeholder("{kind}", kind)).toBe(true);
    }
    expect(placeholder("{kind}", "Personal")).toBe(false);
    expect(placeholder("{kind}", "group")).toBe(false);
    expect(placeholder("{area}", "communication")).toBe(true);
    expect(placeholder("{area}", "a")).toBe(true);
    expect(placeholder("{area}", "Communication")).toBe(false);
    expect(placeholder("{area}", "-x")).toBe(false);
    expect(placeholder("{area}", "a".repeat(41))).toBe(false);
    for (const verdict of ["keep", "reject", "reopen"]) {
      expect(placeholder("{verdict}", verdict)).toBe(true);
    }
    // Narrowing and merging need another argument, so no twin carries them.
    expect(placeholder("{verdict}", "merge")).toBe(false);
    expect(placeholder("{verdict}", "narrow")).toBe(false);
  });

  test("a note's twin renders with the id and parses back, and refuses a value on argv", () => {
    const twin = COMMAND_KINDS["people.claims.create"].cliTwin;
    expect(twin).not.toBeNull();
    const psn = mintId("psn");
    const rendered = renderTwin(twin as never, { psn, area: "communication" });
    expect(rendered).toEqual({ argv: ["people", "note", psn, "--area", "communication"] });
    expect(
      parseTwin(twin as never, ["people", "note", psn, "--area", "communication", "Short"]),
    ).toBeNull();
  });
});

describe("path params", () => {
  test("{psn} and {pcl} take their own ids only, and `keys` is neither", () => {
    expect(isPathParam("psn", [mintId("psn")])).toBe(true);
    expect(isPathParam("psn", [mintId("pcl")])).toBe(false);
    expect(isPathParam("pcl", [mintId("pcl")])).toBe(true);
    expect(isPathParam("pcl", [mintId("psn")])).toBe(false);
    expect(isPathParam("psn", ["keys"])).toBe(false);
    expect(isPathParam("psn", ["setup"])).toBe(false);
  });
});

describe("permissions", () => {
  const people = PEOPLE_MODULE.permissions;

  test("nine, each home-scoped, held by no role and by no service", () => {
    expect(people.map((decl) => decl.id)).toEqual([
      "people.space.use",
      "people.person.read",
      "people.person.write",
      "people.claim.review",
      "people.grant.manage",
      "people.export",
      "people.activity.read",
      "people.erase",
      "people.derived.read",
    ]);
    for (const decl of people) {
      expect(PERMISSION_DECLS[decl.id]).toEqual({
        id: decl.id,
        scope: "home",
        floor: "none",
        service: "never",
      });
    }
    for (const held of Object.values(ROLE_PERMISSIONS)) {
      expect(held.filter((permission) => permission.startsWith("people."))).toEqual([]);
    }
  });
});

describe("lifecycles", () => {
  test("a note reaches superseded only through a person's action, and comes back from rejected only by reopening", () => {
    expect(canTransition("personClaim", "proposed", "active")).toBe(true);
    expect(canTransition("personClaim", "rejected", "active")).toBe(false);
    expect(canTransition("personClaim", "rejected", "proposed")).toBe(true);
    expect(canTransition("personClaim", "superseded", "active")).toBe(false);
    expect(canTransition("personClaim", "active", "proposed")).toBe(false);
  });

  test("a person is erased only after erasing, and never comes back", () => {
    expect(canTransition("person", "active", "erasing")).toBe(true);
    expect(canTransition("person", "active", "erased")).toBe(false);
    expect(canTransition("person", "erasing", "erased")).toBe(true);
    expect(canTransition("person", "erasing", "active")).toBe(false);
    expect(MACHINES.person.terminal).toEqual(["erased"]);
  });

  test("the note schema's states are the machine's", () => {
    const claim = SCHEMAS["personClaim"] as z.ZodObject<z.ZodRawShape>;
    const state = claim.shape["state"] as z.ZodEnum<[string, ...string[]]>;
    expect([...state.options].sort()).toEqual([...MACHINES.personClaim.states].sort());
  });
});

describe("operations", () => {
  const rows = OPERATIONS.filter((op) => op.id.startsWith("people."));

  test("seventeen rows, each receipt in the workspace ledger, each kind beside its row", () => {
    expect(rows).toHaveLength(17);
    const receipted = rows.filter((op) => op.receipt !== "none");
    expect(receipted.map((op) => op.receipt)).toEqual(Array(9).fill("workspace"));
    for (const op of receipted) {
      const kind = (COMMAND_KINDS as Readonly<Record<string, { permission: string }>>)[op.id];
      expect(kind?.permission).toBe(op.permission);
      expect(op.response).toBe("commandAccepted");
    }
    const replays = Object.values(COMMAND_KINDS)
      .filter((kind) => kind.id.startsWith("people.") && !kind.idempotent)
      .map((kind) => kind.id)
      .sort();
    expect(replays).toEqual(["people.erasure.run", "people.persons.create", "people.vault.rotate"]);
  });

  test("every field that carries a person's words is secret and kept from models", () => {
    const words: Readonly<Record<string, readonly string[]>> = {
      "people.persons.create": ["label", "who"],
      "people.persons.update": ["label", "offLimits", "allow"],
      "people.claims.create": ["area", "value", "situation"],
      "people.claims.revise": ["value", "situation"],
      "people.exports.preview": ["areas"],
      "people.exports.create": ["areas"],
      "people.erasure.run": ["confirm"],
    };
    for (const op of rows) {
      const expected = words[op.id] ?? [];
      expect(`${op.id}: ${[...(op.secretFields ?? [])].join(",")}`).toBe(
        `${op.id}: ${expected.join(",")}`,
      );
      for (const field of expected) {
        expect(op.modelBound?.[field]).toEqual({
          none: true,
          reason: "Stored sealed in the vault; no model reads it in this release.",
        });
      }
    }
  });

  test("rotating the key takes no body: a key never travels in a request", () => {
    const rotate = rows.find((op) => op.id === "people.vault.rotate");
    expect(rotate?.request).toBe("emptyRequest");
    const schema = SCHEMAS["emptyRequest"] as z.ZodTypeAny;
    expect(schema.safeParse({ kekHex: "00" }).success).toBe(false);
  });

  test("a twin is never manufactured: a switch has none, with its reason", () => {
    for (const id of [
      "people.vault.rotate",
      "people.persons.update",
      "people.exports.preview",
      "people.erasure.plan",
    ]) {
      const row = rows.find((op) => op.id === id);
      expect(row?.cliTwin).toBeNull();
      expect(row?.noTwinReason?.length ?? 0).toBeGreaterThan(10);
    }
  });

  test("requests refuse what they must", () => {
    const parse = (id: string, value: unknown) =>
      (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;
    expect(parse("claimCreateRequest", { area: "Comm", value: "x" })).toBe(false);
    expect(parse("claimCreateRequest", { area: "comm", value: "x".repeat(501) })).toBe(false);
    expect(
      parse("claimCreateRequest", { area: "comm", value: "x", purposes: ["persuasion"] }),
    ).toBe(false);
    expect(parse("claimCreateRequest", { area: "comm", value: "x", purposes: [] })).toBe(false);
    expect(parse("claimReviewRequest", { verdict: "merge", into: mintId("psn") })).toBe(false);
    expect(parse("personCreateRequest", { kind: "group", label: "x" })).toBe(false);
    expect(parse("personUpdateRequest", { expect: 0 })).toBe(false);
    expect(parse("personUpdateRequest", { expect: 1, viewers: ["local:sam@laptop"] })).toBe(false);
    expect(parse("peopleSetupRequest", { custody: "cloud" })).toBe(false);
    expect(parse("erasureRunRequest", { nonce: "1.ab" })).toBe(false);
  });
});
