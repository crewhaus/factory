import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type OperationEnv, checkOperations, unusedTwinVocabulary } from "./__test__/checkers.js";
import type { OperationRow } from "./areas/types.js";
import {
  CLI_VERBS,
  COMMAND_KINDS,
  CORE_MODULE,
  OPERATIONS,
  PATH_PARAMS,
  PERMISSIONS,
  QUALIFIERS,
  TWIN_PLACEHOLDERS,
  isPathParam,
  mintId,
  mintRunId,
} from "./index.js";
import { SCHEMAS } from "./schemas/index.js";

const ENV: OperationEnv = {
  permissions: PERMISSIONS,
  qualifiers: QUALIFIERS,
  schemas: SCHEMAS,
  commandKinds: Object.values(COMMAND_KINDS),
  cliVerbs: CLI_VERBS,
  placeholders: TWIN_PLACEHOLDERS,
};

const byId = new Map(OPERATIONS.map((op) => [op.id, op]));
const row = (id: string) => byId.get(id) as OperationRow;

describe("the table holds together", () => {
  test("no rule is broken", () => {
    expect(checkOperations(OPERATIONS, ENV)).toEqual([]);
    expect(OPERATIONS.length).toBeGreaterThanOrEqual(59);
  });

  test("the core has exactly 59 rows, and rollback is not one of them", () => {
    expect(CORE_MODULE.operations).toHaveLength(59);
    expect(byId.has("deployments.rollback")).toBe(false);
  });

  test("every twin verb and placeholder is used", () => {
    expect(unusedTwinVocabulary(OPERATIONS, ENV, ["grant", "deny"])).toEqual([]);
  });

  test("a verb-slot {choice} counts for both verbs, or neither", () => {
    const withoutChoice = OPERATIONS.filter((op) => op.id !== "decisions.resolve");
    expect(unusedTwinVocabulary(withoutChoice, ENV, ["grant", "deny"])).toEqual([
      "approvals grant",
      "approvals deny",
      "{choice}",
    ]);
  });
});

/** Run the checker with one row replaced and report what it found. */
function plant(id: string, change: Partial<OperationRow>, env: Partial<OperationEnv> = {}) {
  const rows = OPERATIONS.map((op) => (op.id === id ? { ...op, ...change } : op));
  return checkOperations(rows, { ...ENV, ...env });
}

describe("each rule sees its own planted defect", () => {
  test("a duplicate id", () => {
    expect(checkOperations([...OPERATIONS, row("me.get")], ENV)).toContain(
      "duplicate operation id: me.get",
    );
  });
  test("a duplicate route", () => {
    const copy = { ...row("me.get"), id: "me.copy" };
    expect(checkOperations([...OPERATIONS, copy], ENV)).toContain(
      "duplicate route: GET /api/v1/me",
    );
  });
  test("a wildcard collision", () => {
    const literal = {
      ...row("harnesses.get"),
      id: "harnesses.fleet",
      path: "/api/v1/harnesses/fleet",
    };
    expect(checkOperations([...OPERATIONS, literal], ENV)).toContain(
      "route collision: GET /api/v1/harnesses/{h} and /api/v1/harnesses/fleet",
    );
  });
  test("a three-segment {ref} colliding with a longer literal path", () => {
    const literal = {
      ...row("decisions.get"),
      id: "decisions.odd",
      path: "/api/v1/decisions/a/b/c",
    };
    expect(checkOperations([...OPERATIONS, literal], ENV)).toContain(
      "route collision: GET /api/v1/decisions/{ref} and /api/v1/decisions/a/b/c",
    );
  });
  test("an undeclared param", () => {
    expect(plant("me.get", { path: "/api/v1/me/{who}" })).toContain(
      "me.get: undeclared param {who}",
    );
  });
  test("an unknown permission", () => {
    expect(plant("me.get", { permission: "h.nope" })).toEqual([
      "me.get: unknown permission h.nope",
    ]);
  });
  test("an unknown qualifier", () => {
    expect(plant("me.get", { qualifiers: ["nope" as never] })).toEqual([
      "me.get: unknown qualifier nope",
    ]);
  });
  test("a GET with a receipt", () => {
    expect(plant("me.get", { receipt: "harness", idempotency: "accepted" })).toContain(
      "me.get: a GET has a receipt",
    );
  });
  test("receipt without idempotency, and the reverse", () => {
    expect(plant("controls.pause", { idempotency: "none" })).toContain(
      "controls.pause: receipt and idempotency disagree",
    );
    expect(plant("me.get", { idempotency: "accepted" })).toContain(
      "me.get: receipt and idempotency disagree",
    );
  });
  test("a non-GET with no receipt and no reason", () => {
    const { noReceiptReason: _, ...rest } = row("auth.session");
    const rows = OPERATIONS.map((op) => (op.id === "auth.session" ? rest : op));
    expect(checkOperations(rows, ENV)).toEqual(["auth.session: no receipt and no reason"]);
  });
  test("a schema id that does not exist", () => {
    expect(plant("me.get", { response: "nope" })).toContain("me.get: no schema nope");
    expect(plant("me.get", { request: "nope" })).toContain("me.get: no schema nope");
  });
  test("a non-strict request", () => {
    const schemas = { ...SCHEMAS, looseBody: z.object({}).passthrough() };
    expect(plant("controls.resume", { request: "looseBody" }, { schemas })).toEqual([
      "controls.resume: request is not strict",
    ]);
  });
  test("a secret field not in the request", () => {
    expect(plant("auth.session", { secretFields: ["code"] })).toEqual([
      "auth.session: secret field code not in request",
    ]);
  });
  test("a modelBound key not in the request, and one that is", () => {
    const none = { none: true, reason: "never reaches a model" } as const;
    expect(plant("runs.create", { modelBound: { story: none } })).toEqual([
      "runs.create: modelBound story not in request",
    ]);
    expect(plant("runs.create", { modelBound: { input: none } })).toEqual([]);
  });
  test("a twin and its reason disagree", () => {
    expect(plant("me.get", { noTwinReason: undefined as never })).toContain(
      "me.get: a twin and its reason disagree",
    );
    expect(plant("harnesses.list", { noTwinReason: "both" })).toEqual([
      "harnesses.list: a twin and its reason disagree",
    ]);
  });
  test("a twin outside the vocabulary", () => {
    expect(plant("harnesses.list", { cliTwin: { argv: ["harness", "scan"] } })).toEqual([
      'harnesses.list: twin verb "harness scan" is not in CLI_VERBS',
    ]);
    expect(plant("harnesses.list", { cliTwin: { argv: ["nope", "list"] } })).toEqual([
      'harnesses.list: twin noun "nope" is not in CLI_VERBS',
    ]);
    expect(plant("harnesses.get", { cliTwin: { argv: ["harness", "show", "{who}"] } })).toEqual([
      "harnesses.get: twin placeholder {who} is not declared",
    ]);
  });
  test("a receipted row with no command kind, and a kind with no row", () => {
    const commandKinds = ENV.commandKinds.filter((kind) => kind.id !== "controls.pause");
    expect(checkOperations(OPERATIONS, { ...ENV, commandKinds })).toEqual([
      "controls.pause: receipted with no command kind",
    ]);
    const extra = { ...(COMMAND_KINDS as Record<string, never>)["controls.pause"], id: "nope" };
    expect(
      checkOperations(OPERATIONS, { ...ENV, commandKinds: [...ENV.commandKinds, extra as never] }),
    ).toEqual(["nope: a kind with no row"]);
  });
  test("a command kind on a row with no receipt", () => {
    const kind = { ...ENV.commandKinds[0], id: "me.get", permission: "authenticated" } as never;
    expect(
      checkOperations(OPERATIONS, { ...ENV, commandKinds: [...ENV.commandKinds, kind] }),
    ).toEqual(["me.get: a command kind with no receipt"]);
  });
  test("a kind whose permission or twin differs from its row", () => {
    const change = (patch: object) =>
      ENV.commandKinds.map((kind) => (kind.id === "controls.drain" ? { ...kind, ...patch } : kind));
    expect(
      checkOperations(OPERATIONS, { ...ENV, commandKinds: change({ permission: "h.deploy" }) }),
    ).toEqual(["controls.drain: kind permission differs"]);
    expect(
      checkOperations(OPERATIONS, { ...ENV, commandKinds: change({ cliTwin: null }) }),
    ).toEqual(["controls.drain: kind twin differs"]);
  });
  test("an external effect on a row that does not require idempotency", () => {
    const commandKinds = ENV.commandKinds.map((kind) =>
      kind.id === "controls.drain" ? { ...kind, effect: "external" as const } : kind,
    );
    expect(checkOperations(OPERATIONS, { ...ENV, commandKinds })).toEqual([
      "controls.drain: an external effect does not require idempotency",
    ]);
  });
  test("issued without seal, and seal without issued", () => {
    expect(plant("auth.signOut", { response: "sessionIssued" })).toEqual([
      "auth.signOut: issued and seal disagree",
    ]);
    expect(plant("auth.refresh", { response: "signedOut" })).toEqual([
      "auth.refresh: issued and seal disagree",
    ]);
  });
});

describe("rows, pinned", () => {
  test("permissions where the cell is not a member", () => {
    const expected: Readonly<Record<string, string>> = {
      "meta.discover": "public",
      "me.get": "authenticated",
      "refs.resolve": "authenticated",
      "events.fleet": "home.read",
      "events.harness": "h.read",
      "access.scopedTokens.mint": "authenticated",
      "auth.refresh": "authenticated",
      "auth.signOut": "authenticated",
      "auth.challenge": "public",
      "auth.session": "public",
      "auth.exchange": "public",
      "auth.acceptInvite": "public",
    };
    for (const [id, permission] of Object.entries(expected)) {
      expect(`${id} ${row(id).permission}`).toBe(`${id} ${permission}`);
    }
    for (const op of OPERATIONS) {
      if (op.id.startsWith("access.") && op.id !== "access.scopedTokens.mint") {
        expect(`${op.id} ${op.permission}`).toBe(`${op.id} home.access.manage`);
      }
    }
  });

  test("the reasons a mutating row has no receipt", () => {
    const reasons = OPERATIONS.filter((op) => op.method !== "GET" && op.receipt === "none").map(
      (op) => [op.id, op.noReceiptReason],
    );
    expect(reasons).toEqual([
      ["access.scopedTokens.mint", "stateless"],
      ["auth.session", "authentication, not a command"],
      ["auth.exchange", "authentication, not a command"],
      ["auth.refresh", "authentication, not a command"],
      ["auth.signOut", "authentication, not a command"],
    ]);
  });

  test("workspace receipts", () => {
    expect(OPERATIONS.filter((op) => op.receipt === "workspace").map((op) => op.id)).toEqual([
      "access.invites.create",
      "access.grants.create",
      "access.tokens.mint",
      "access.links.create",
      "access.invites.revoke",
      "access.grants.revoke",
      "access.tokens.revoke",
      "access.links.revoke",
      "access.devices.revoke",
      "auth.acceptInvite",
    ]);
    expect(row("runs.create").idempotency).toBe("required-for-services");
  });

  test("qualifiers", () => {
    const withQualifier = (qualifier: string) =>
      OPERATIONS.filter((op) => (op.qualifiers as readonly string[]).includes(qualifier))
        .map((op) => op.id)
        .sort();
    const expected: Readonly<Record<string, readonly string[]>> = {
      filtered: ["decisions.list", "events.fleet", "harnesses.list"],
      "content-fields": ["decisions.get", "decisions.list", "runs.events"],
      class: ["decisions.resolve"],
      "maintainer-or-above": ["decisions.supersede"],
      "subject-assert": ["runs.create"],
      "creating-service": ["runs.cancel", "runs.get", "runs.list", "runs.resume"],
      "human-only": ["deployments.activate", "rules.create", "rules.revoke"],
      self: [
        "access.devices.list",
        "access.devices.revoke",
        "access.links.list",
        "access.links.revoke",
        "access.tokens.list",
        "access.tokens.revoke",
        "auth.refresh",
        "auth.signOut",
      ],
      "service-delegation": ["access.scopedTokens.mint"],
      "view-target": ["refs.resolve"],
      "workspace-target": ["commands.get"],
    };
    expect(Object.keys(expected).sort()).toEqual([...QUALIFIERS].sort());
    for (const [qualifier, ids] of Object.entries(expected)) {
      expect(withQualifier(qualifier)).toEqual([...ids]);
    }
  });

  test("streams and secret fields", () => {
    expect(OPERATIONS.filter((op) => op.stream === "sse").map((op) => op.id)).toEqual([
      "runs.events",
      "events.fleet",
      "events.harness",
    ]);
    expect(OPERATIONS.filter((op) => op.secretFields !== undefined).map((op) => op.id)).toEqual([
      "auth.exchange",
      "auth.acceptInvite",
    ]);
    expect(row("auth.exchange").secretFields).toEqual(["code"]);
    expect(row("auth.acceptInvite").secretFields).toEqual(["code"]);
  });

  test("no core row declares modelBound yet", () => {
    expect(CORE_MODULE.operations.filter((op) => "modelBound" in op)).toEqual([]);
  });

  test("twins, every non-null one", () => {
    const twins = OPERATIONS.filter((op) => op.cliTwin !== null).map((op) => [
      op.id,
      op.cliTwin?.argv.join(" "),
    ]);
    expect(twins).toEqual([
      ["harnesses.list", "harness list"],
      ["harnesses.get", "harness show {hrn}"],
      ["controls.drain", "daemon drain {hrn}"],
      ["controls.stop", "daemon stop {hrn}"],
      ["controls.start", "daemon start {hrn}"],
      ["controls.restart", "daemon restart {hrn}"],
      ["decisions.get", "approvals show {appr} --dir {dir}"],
      ["decisions.resolve", "approvals {choice} {appr} --dir {dir}"],
    ]);
    expect(row("runs.resume").cliTwin).toBeNull();
    expect(row("runs.resume").noTwinReason).toContain("cli session");
  });

  test("idempotent command kinds", () => {
    const idempotent = Object.values(COMMAND_KINDS)
      .filter((kind) => kind.idempotent)
      .map((kind) => kind.id)
      .sort();
    expect(idempotent).toEqual(
      [
        "controls.pause",
        "controls.resume",
        "controls.disable",
        "controls.enable",
        "controls.drain",
        "controls.stop",
        "runs.cancel",
        "decisions.resolve",
        "rules.revoke",
        "access.invites.revoke",
        "access.grants.revoke",
        "access.tokens.revoke",
        "access.links.revoke",
        "access.devices.revoke",
      ].sort(),
    );
    const receipted = CORE_MODULE.operations.filter((op) => op.receipt !== "none");
    expect(receipted).toHaveLength(27);
    expect(CORE_MODULE.commandKinds).toHaveLength(27);
    expect(CORE_MODULE.commandKinds.every((kind) => kind.effect === "local")).toBe(true);
  });

  test("request and response bodies", () => {
    expect(row("controls.pause").request).toBe("pauseRequest");
    expect(row("controls.retire").response).toBe("retireResponse");
    expect(row("runs.create").response).toBe("runCreated");
    expect(row("decisions.resolve").response).toBe("decisionResolved");
    expect(row("decisions.supersede").response).toBe("decisionResolved");
    expect(row("auth.exchange").request).toBe("authExchangeRequest");
    expect(row("access.invites.create").response).toBe("inviteIssued");
    expect(row("access.tokens.mint").response).toBe("tokenIssued");
    expect(row("auth.signOut").response).toBe("signedOut");
    const accepted = OPERATIONS.filter((op) => op.response === "commandAccepted").length;
    expect(accepted).toBeGreaterThanOrEqual(15);
  });
});

describe("path params", () => {
  test("the set is closed, and every param a row names is in it", () => {
    expect(Object.keys(PATH_PARAMS).sort()).toEqual(
      ["cmd", "crd", "dep", "dev", "grt", "h", "inv", "lnk", "ref", "rule", "run"].sort(),
    );
    expect(isPathParam("nope", ["x"])).toBe(false);
    expect(isPathParam("constructor", ["x"])).toBe(false);
  });

  test("{h}: a harness id or a slug", () => {
    expect(isPathParam("h", ["hrn_0123456789abcdef"])).toBe(true);
    expect(isPathParam("h", ["support-assistant"])).toBe(true);
    expect(isPathParam("h", ["Support"])).toBe(false);
    expect(isPathParam("h", ["-x"])).toBe(false);
    expect(isPathParam("h", [`a${"b".repeat(64)}`])).toBe(false);
    expect(isPathParam("h", ["a", "b"])).toBe(false);
  });

  test("prefixed params take their own prefix only", () => {
    for (const prefix of ["dep", "cmd", "rule", "inv", "grt", "crd", "lnk", "dev"] as const) {
      expect(isPathParam(prefix, [mintId(prefix)])).toBe(true);
      expect(isPathParam(prefix, [mintId("prn")])).toBe(false);
    }
  });

  test("{run}: canonical only", () => {
    expect(isPathParam("run", [mintRunId()])).toBe(true);
    expect(isPathParam("run", ["run_0123456789abcdef"])).toBe(false);
    expect(isPathParam("run", ["run_abcd1234"])).toBe(false);
  });

  test("{ref}: three segments, or one bare id, a legacy hex16 included", () => {
    const hrn = "hrn_0123456789abcdef";
    expect(isPathParam("ref", [hrn, "decision", "appr_0123456789abcdef"])).toBe(true);
    expect(isPathParam("ref", ["appr_0123456789abcdef"])).toBe(true);
    expect(isPathParam("ref", ["run_0123456789abcdef"])).toBe(true);
    expect(isPathParam("ref", [mintId("dec")])).toBe(true);
    expect(isPathParam("ref", [hrn, "decision"])).toBe(false);
    expect(isPathParam("ref", ["home", "session", "sess_0123456789abcdef"])).toBe(false);
    expect(isPathParam("ref", ["run_abcd1234"])).toBe(false);
  });
});
