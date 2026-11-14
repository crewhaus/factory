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

/** The core's own rows. Pins read these, so an area's rows never disturb them. */
const CORE: readonly OperationRow[] = CORE_MODULE.operations;
const coreRow = (id: string) => CORE.find((op) => op.id === id) as OperationRow;

/** Every core row: id, method, path, permission, receipt, request, response. */
const CORE_ROWS = [
  ["meta.discover", "GET", "/api/v1", "public", "none", "noBody", "discovery"],
  ["me.get", "GET", "/api/v1/me", "authenticated", "none", "noBody", "me"],
  ["refs.resolve", "GET", "/api/v1/refs/{ref}", "authenticated", "none", "noBody", "refResolved"],
  ["harnesses.list", "GET", "/api/v1/harnesses", "home.read", "none", "listQuery", "harnessList"],
  ["harnesses.get", "GET", "/api/v1/harnesses/{h}", "h.read", "none", "noBody", "harnessOverview"],
  [
    "harnesses.capabilities",
    "GET",
    "/api/v1/harnesses/{h}/capabilities",
    "h.read",
    "none",
    "noBody",
    "harnessCapabilities",
  ],
  [
    "harnesses.health",
    "GET",
    "/api/v1/harnesses/{h}/health",
    "h.read",
    "none",
    "noBody",
    "harnessHealth",
  ],
  [
    "deployments.list",
    "GET",
    "/api/v1/harnesses/{h}/deployments",
    "h.read",
    "none",
    "listQuery",
    "deploymentList",
  ],
  [
    "deployments.get",
    "GET",
    "/api/v1/harnesses/{h}/deployments/{dep}",
    "h.read",
    "none",
    "noBody",
    "deployment",
  ],
  [
    "deployments.activate",
    "POST",
    "/api/v1/harnesses/{h}/deployments",
    "h.deploy",
    "harness",
    "deploymentActivateRequest",
    "commandAccepted",
  ],
  [
    "controls.pause",
    "POST",
    "/api/v1/harnesses/{h}/controls/pause",
    "h.control",
    "harness",
    "pauseRequest",
    "commandAccepted",
  ],
  [
    "controls.resume",
    "POST",
    "/api/v1/harnesses/{h}/controls/resume",
    "h.control",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.drain",
    "POST",
    "/api/v1/harnesses/{h}/controls/drain",
    "h.control",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.stop",
    "POST",
    "/api/v1/harnesses/{h}/controls/stop",
    "h.control",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.start",
    "POST",
    "/api/v1/harnesses/{h}/controls/start",
    "h.control",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.restart",
    "POST",
    "/api/v1/harnesses/{h}/controls/restart",
    "h.control",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.disable",
    "POST",
    "/api/v1/harnesses/{h}/controls/disable",
    "h.deploy",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.enable",
    "POST",
    "/api/v1/harnesses/{h}/controls/enable",
    "h.deploy",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "controls.retire",
    "POST",
    "/api/v1/harnesses/{h}/controls/retire",
    "h.retire",
    "harness",
    "retireRequest",
    "retireResponse",
  ],
  ["runs.list", "GET", "/api/v1/harnesses/{h}/runs", "h.read", "none", "listQuery", "runList"],
  ["runs.get", "GET", "/api/v1/runs/{run}", "h.read", "none", "noBody", "run"],
  [
    "runs.create",
    "POST",
    "/api/v1/harnesses/{h}/runs",
    "h.run.submit",
    "harness",
    "runCreateRequest",
    "runCreated",
  ],
  [
    "runs.cancel",
    "POST",
    "/api/v1/runs/{run}/cancel",
    "h.control",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "runs.resume",
    "POST",
    "/api/v1/runs/{run}/resume",
    "h.run.submit",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "runs.result",
    "GET",
    "/api/v1/runs/{run}/result",
    "h.read.content",
    "none",
    "noBody",
    "runResult",
  ],
  [
    "runs.events",
    "GET",
    "/api/v1/runs/{run}/events",
    "h.read",
    "none",
    "streamQuery",
    "eventFrame",
  ],
  ["decisions.list", "GET", "/api/v1/decisions", "home.read", "none", "listQuery", "decisionList"],
  ["decisions.get", "GET", "/api/v1/decisions/{ref}", "h.read", "none", "noBody", "decision"],
  [
    "decisions.resolve",
    "POST",
    "/api/v1/decisions/{ref}/resolve",
    "h.decision.resolve",
    "harness",
    "decisionResolveRequest",
    "decisionResolved",
  ],
  [
    "decisions.supersede",
    "POST",
    "/api/v1/decisions/{ref}/supersede",
    "h.decision.resolve",
    "harness",
    "decisionSupersedeRequest",
    "decisionResolved",
  ],
  [
    "rules.list",
    "GET",
    "/api/v1/harnesses/{h}/standing-rules",
    "h.read",
    "none",
    "listQuery",
    "ruleList",
  ],
  [
    "rules.create",
    "POST",
    "/api/v1/harnesses/{h}/standing-rules",
    "h.standing-rule.manage",
    "harness",
    "ruleCreateRequest",
    "commandAccepted",
  ],
  [
    "rules.revoke",
    "POST",
    "/api/v1/harnesses/{h}/standing-rules/{rule}/revoke",
    "h.standing-rule.manage",
    "harness",
    "emptyRequest",
    "commandAccepted",
  ],
  ["commands.get", "GET", "/api/v1/commands/{cmd}", "h.read", "none", "noBody", "commandReceipt"],
  [
    "commands.list",
    "GET",
    "/api/v1/harnesses/{h}/commands",
    "h.read",
    "none",
    "listQuery",
    "commandList",
  ],
  ["events.fleet", "GET", "/api/v1/events", "home.read", "none", "streamQuery", "eventFrame"],
  [
    "events.harness",
    "GET",
    "/api/v1/harnesses/{h}/events",
    "h.read",
    "none",
    "streamQuery",
    "eventFrame",
  ],
  [
    "access.members.list",
    "GET",
    "/api/v1/access/members",
    "home.access.manage",
    "none",
    "listQuery",
    "memberList",
  ],
  [
    "access.invites.list",
    "GET",
    "/api/v1/access/invites",
    "home.access.manage",
    "none",
    "listQuery",
    "inviteList",
  ],
  [
    "access.grants.list",
    "GET",
    "/api/v1/access/grants",
    "home.access.manage",
    "none",
    "listQuery",
    "grantList",
  ],
  [
    "access.tokens.list",
    "GET",
    "/api/v1/access/tokens",
    "home.access.manage",
    "none",
    "listQuery",
    "tokenList",
  ],
  [
    "access.links.list",
    "GET",
    "/api/v1/access/links",
    "home.access.manage",
    "none",
    "listQuery",
    "linkList",
  ],
  [
    "access.devices.list",
    "GET",
    "/api/v1/access/devices",
    "home.access.manage",
    "none",
    "listQuery",
    "deviceList",
  ],
  [
    "access.invites.create",
    "POST",
    "/api/v1/access/invites",
    "home.access.manage",
    "workspace",
    "inviteCreateRequest",
    "inviteIssued",
  ],
  [
    "access.grants.create",
    "POST",
    "/api/v1/access/grants",
    "home.access.manage",
    "workspace",
    "grantCreateRequest",
    "commandAccepted",
  ],
  [
    "access.tokens.mint",
    "POST",
    "/api/v1/access/tokens",
    "home.access.manage",
    "workspace",
    "tokenMintRequest",
    "tokenIssued",
  ],
  [
    "access.links.create",
    "POST",
    "/api/v1/access/links",
    "home.access.manage",
    "workspace",
    "linkCreateRequest",
    "commandAccepted",
  ],
  [
    "access.invites.revoke",
    "POST",
    "/api/v1/access/invites/{inv}/revoke",
    "home.access.manage",
    "workspace",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "access.grants.revoke",
    "POST",
    "/api/v1/access/grants/{grt}/revoke",
    "home.access.manage",
    "workspace",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "access.tokens.revoke",
    "POST",
    "/api/v1/access/tokens/{crd}/revoke",
    "home.access.manage",
    "workspace",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "access.links.revoke",
    "POST",
    "/api/v1/access/links/{lnk}/revoke",
    "home.access.manage",
    "workspace",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "access.devices.revoke",
    "POST",
    "/api/v1/access/devices/{dev}/revoke",
    "home.access.manage",
    "workspace",
    "emptyRequest",
    "commandAccepted",
  ],
  [
    "access.scopedTokens.mint",
    "POST",
    "/api/v1/access/scoped-tokens",
    "authenticated",
    "none",
    "scopedTokenMintRequest",
    "tokenIssued",
  ],
  ["auth.challenge", "GET", "/api/v1/auth/challenge", "public", "none", "noBody", "authChallenge"],
  [
    "auth.session",
    "POST",
    "/api/v1/auth/session",
    "public",
    "none",
    "authSessionRequest",
    "sessionIssued",
  ],
  [
    "auth.exchange",
    "POST",
    "/api/v1/auth/exchange",
    "public",
    "none",
    "authExchangeRequest",
    "sessionIssued",
  ],
  [
    "auth.acceptInvite",
    "POST",
    "/api/v1/auth/accept-invite",
    "public",
    "workspace",
    "authAcceptInviteRequest",
    "inviteAccepted",
  ],
  [
    "auth.refresh",
    "POST",
    "/api/v1/auth/refresh",
    "authenticated",
    "none",
    "authRefreshRequest",
    "sessionIssued",
  ],
  [
    "auth.signOut",
    "POST",
    "/api/v1/auth/sign-out",
    "authenticated",
    "none",
    "emptyRequest",
    "signedOut",
  ],
] as const;

/** What each core command kind needs, written apart from its row. */
const CORE_KIND_PERMISSIONS = {
  "deployments.activate": "h.deploy",
  "controls.pause": "h.control",
  "controls.resume": "h.control",
  "controls.drain": "h.control",
  "controls.stop": "h.control",
  "controls.start": "h.control",
  "controls.restart": "h.control",
  "controls.disable": "h.deploy",
  "controls.enable": "h.deploy",
  "controls.retire": "h.retire",
  "runs.create": "h.run.submit",
  "runs.cancel": "h.control",
  "runs.resume": "h.run.submit",
  "decisions.resolve": "h.decision.resolve",
  "decisions.supersede": "h.decision.resolve",
  "rules.create": "h.standing-rule.manage",
  "rules.revoke": "h.standing-rule.manage",
  "access.invites.create": "home.access.manage",
  "access.grants.create": "home.access.manage",
  "access.tokens.mint": "home.access.manage",
  "access.links.create": "home.access.manage",
  "access.invites.revoke": "home.access.manage",
  "access.grants.revoke": "home.access.manage",
  "access.tokens.revoke": "home.access.manage",
  "access.links.revoke": "home.access.manage",
  "access.devices.revoke": "home.access.manage",
  "auth.acceptInvite": "public",
} as const;

describe("the table holds together", () => {
  test("no rule is broken", () => {
    expect(checkOperations(OPERATIONS, ENV)).toEqual([]);
    expect(OPERATIONS.length).toBeGreaterThanOrEqual(59);
  });

  test("the core has exactly 59 rows, and rollback is not one of them", () => {
    expect(CORE).toHaveLength(59);
    expect(CORE.some((op) => op.id === "deployments.rollback")).toBe(false);
  });

  // A kind with no row yet carries its twin itself, so its vocabulary is used.
  const cliFirst = Object.values(COMMAND_KINDS).flatMap((kind) =>
    "noRowReason" in kind && kind.noRowReason !== undefined
      ? [{ ...OPERATIONS[0], id: kind.id, cliTwin: kind.cliTwin } as OperationRow]
      : [],
  );

  test("every twin verb and placeholder is used, by a row or by a kind the CLI submits first", () => {
    expect(cliFirst.length).toBe(9);
    expect(unusedTwinVocabulary([...OPERATIONS, ...cliFirst], ENV, ["grant", "deny"])).toEqual([]);
    // Without them the quality vocabulary would be unused.
    expect(unusedTwinVocabulary(OPERATIONS, ENV, ["grant", "deny"])).toContain("{chg}");
  });

  test("a verb-slot {choice} counts for both verbs, or neither", () => {
    const withoutChoice = [...OPERATIONS, ...cliFirst].filter(
      (op) => op.id !== "decisions.resolve",
    );
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
  test("a kind the CLI submits first says why it has no row, and only then", () => {
    const pause = (COMMAND_KINDS as Record<string, never>)["controls.pause"];
    const reasoned = { ...(pause as object), id: "nope", noRowReason: "later" };
    expect(
      checkOperations(OPERATIONS, {
        ...ENV,
        commandKinds: [...ENV.commandKinds, reasoned as never],
      }),
    ).toEqual([]);
    const both = ENV.commandKinds.map((kind) =>
      kind.id === "controls.pause" ? { ...kind, noRowReason: "later" } : kind,
    );
    expect(checkOperations(OPERATIONS, { ...ENV, commandKinds: both })).toEqual([
      "controls.pause: a kind with a row gives a reason for having none",
    ]);
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
  test("every core row, cell by cell", () => {
    const actual = CORE.map((op) => [
      op.id,
      op.method,
      op.path,
      op.permission,
      op.receipt,
      op.request,
      op.response,
    ]);
    expect(actual).toEqual(CORE_ROWS.map((cells) => [...cells]));
    expect(actual).toHaveLength(59);
  });

  test("each core command kind's permission, written apart from its row", () => {
    const actual = Object.fromEntries(
      CORE_MODULE.commandKinds.map((kind) => [kind.id, kind.permission]),
    );
    expect(actual).toEqual(CORE_KIND_PERMISSIONS);
    expect(Object.keys(actual)).toHaveLength(27);
  });

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
      expect(`${id} ${coreRow(id).permission}`).toBe(`${id} ${permission}`);
    }
    for (const op of CORE) {
      if (op.id.startsWith("access.") && op.id !== "access.scopedTokens.mint") {
        expect(`${op.id} ${op.permission}`).toBe(`${op.id} home.access.manage`);
      }
    }
  });

  test("the reasons a mutating row has no receipt", () => {
    const reasons = CORE.filter((op) => op.method !== "GET" && op.receipt === "none").map((op) => [
      op.id,
      op.noReceiptReason,
    ]);
    expect(reasons).toEqual([
      ["access.scopedTokens.mint", "stateless"],
      ["auth.session", "authentication, not a command"],
      ["auth.exchange", "authentication, not a command"],
      ["auth.refresh", "authentication, not a command"],
      ["auth.signOut", "authentication, not a command"],
    ]);
  });

  test("workspace receipts", () => {
    expect(CORE.filter((op) => op.receipt === "workspace").map((op) => op.id)).toEqual([
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
    expect(coreRow("runs.create").idempotency).toBe("required-for-services");
  });

  test("qualifiers", () => {
    const withQualifier = (qualifier: string) =>
      CORE.filter((op) => (op.qualifiers as readonly string[]).includes(qualifier))
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
    expect(CORE.filter((op) => op.stream === "sse").map((op) => op.id)).toEqual([
      "runs.events",
      "events.fleet",
      "events.harness",
    ]);
    expect(CORE.filter((op) => op.secretFields !== undefined).map((op) => op.id)).toEqual([
      "auth.exchange",
      "auth.acceptInvite",
    ]);
    expect(coreRow("auth.exchange").secretFields).toEqual(["code"]);
    expect(coreRow("auth.acceptInvite").secretFields).toEqual(["code", "sessionSecret"]);
  });

  test("no core row declares modelBound yet", () => {
    expect(CORE.filter((op) => "modelBound" in op)).toEqual([]);
  });

  test("twins, every non-null one", () => {
    const twins = CORE.filter((op) => op.cliTwin !== null).map((op) => [
      op.id,
      op.cliTwin?.argv.join(" "),
    ]);
    expect(twins).toEqual([
      ["harnesses.list", "harness list"],
      ["harnesses.get", "harness show {hrn}"],
      ["deployments.list", "deploy list --harness {hrn}"],
      ["deployments.activate", "deploy activate {dep} --harness {hrn}"],
      ["controls.pause", "daemon pause {hrn}"],
      ["controls.resume", "daemon resume {hrn}"],
      ["controls.drain", "daemon drain {hrn}"],
      ["controls.stop", "daemon stop {hrn}"],
      ["controls.start", "daemon start {hrn}"],
      ["controls.restart", "daemon restart {hrn}"],
      ["controls.disable", "daemon disable {hrn}"],
      ["controls.enable", "daemon enable {hrn}"],
      ["decisions.get", "approvals show {appr} --dir {dir}"],
      ["decisions.resolve", "approvals {choice} {appr} --dir {dir}"],
      ["decisions.supersede", "approvals supersede {appr} --reason {supersedeReason} --dir {dir}"],
      ["rules.list", "approvals rules --dir {dir}"],
      ["rules.revoke", "approvals revoke {rule} --dir {dir}"],
    ]);
    expect(coreRow("rules.create").cliTwin).toBeNull();
    expect(coreRow("rules.create").noTwinReason).toContain(
      "crewhaus approvals grant <id> --always",
    );
    expect(coreRow("runs.resume").cliTwin).toBeNull();
    expect(coreRow("runs.resume").noTwinReason).toContain("cli session");
  });

  test("idempotent command kinds", () => {
    const idempotent = CORE_MODULE.commandKinds
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
    const receipted = CORE.filter((op) => op.receipt !== "none");
    expect(receipted).toHaveLength(27);
    expect(CORE_MODULE.commandKinds).toHaveLength(27);
    expect(CORE_MODULE.commandKinds.every((kind) => kind.effect === "local")).toBe(true);
  });

  test("request and response bodies", () => {
    expect(coreRow("controls.pause").request).toBe("pauseRequest");
    expect(coreRow("controls.retire").response).toBe("retireResponse");
    expect(coreRow("runs.create").response).toBe("runCreated");
    expect(coreRow("decisions.resolve").response).toBe("decisionResolved");
    expect(coreRow("decisions.supersede").response).toBe("decisionResolved");
    expect(coreRow("auth.exchange").request).toBe("authExchangeRequest");
    expect(coreRow("access.invites.create").response).toBe("inviteIssued");
    expect(coreRow("access.tokens.mint").response).toBe("tokenIssued");
    expect(coreRow("auth.signOut").response).toBe("signedOut");
    const accepted = CORE.filter((op) => op.response === "commandAccepted").length;
    expect(accepted).toBeGreaterThanOrEqual(15);
  });
});

describe("path params", () => {
  test("the set is closed, and every param a row names is in it", () => {
    expect(Object.keys(PATH_PARAMS).sort()).toEqual(
      [
        "cmd",
        "crd",
        "dep",
        "dev",
        "grt",
        "h",
        "inv",
        "lnk",
        "ref",
        "rule",
        "run",
        "psn",
        "pcl",
      ].sort(),
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
