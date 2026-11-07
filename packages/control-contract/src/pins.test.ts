import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { unwrap } from "./__test__/checkers.js";
import { ALL_EXAMPLES, EXAMPLES, RECEIPT, SEAL } from "./__test__/schema-examples.js";
import {
  API_PREFIX,
  CORE_MODULE,
  EMPTY_REASONS,
  ERROR_CODES,
  EVENT_TAXONOMY,
  EVENT_TAXONOMY_VERSION,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_VALUE_RE,
  IDEMPOTENT_REPLAYED_HEADER,
  OPERATIONS,
  OPERATOR_SUPERSEDE_REASONS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PERMISSIONS,
  PERMISSION_DECLS,
  PERMISSION_SCOPE,
  PROTOCOL_HEADER,
  PROTOCOL_ID,
  RECEIPT_VIA,
  ROLES,
  ROLE_PERMISSIONS,
  SYSTEM_SUPERSEDE_REASONS,
  isErrorCode,
  isEventType,
  isPermission,
  mintId,
} from "./index.js";
import {
  CORE_SCHEMAS,
  SCHEMAS,
  capabilityDescriptor,
  harnessCapabilities,
} from "./schemas/index.js";

const HRN = "hrn_0123456789abcdef";

/*
 * These pins read the core's own module, not the composed exports, so an area adding
 * its entries disturbs none of them. `areas.test.ts` holds each export to the union of
 * the modules, and `simulated-area.test.ts` adds an area and runs this file against it.
 */

const CORE_PERMISSIONS = new Set<string>(CORE_MODULE.permissions.map((decl) => decl.id));
const coreHeld = (role: (typeof ROLES)[number]) =>
  ROLE_PERMISSIONS[role].filter((id) => CORE_PERMISSIONS.has(id));

describe("the role matrix", () => {
  const VIEWER = ["home.read", "self.preferences", "h.read", "h.read.content"];
  const OPERATOR = ["h.control", "h.run.submit", "h.eval.run", "h.job.run", "h.decision.resolve"];
  const MAINTAINER = [
    "h.registry.edit",
    "h.spec.edit",
    "h.quality.edit",
    "h.data.write",
    "h.feedback.write",
    "h.memory.write",
    "h.secrets.write",
    "h.settings.write",
    "h.deploy",
    "h.connection.manage",
    "h.access.view",
    "home.registry.manage",
  ];
  const OWNER = [
    "h.spec.edit.security",
    "h.files.raw",
    "h.registry.admin",
    "h.retention.manage",
    "h.standing-rule.manage",
    "h.retire",
    "home.settings.manage",
    "home.access.manage",
  ];

  test("each role holds everything below it, cumulative from each floor", () => {
    expect([...ROLES]).toEqual(["viewer", "operator", "maintainer", "owner"]);
    expect(coreHeld("viewer")).toEqual(VIEWER as never);
    expect(coreHeld("operator")).toEqual([...VIEWER, ...OPERATOR] as never);
    expect(coreHeld("maintainer")).toEqual([...VIEWER, ...OPERATOR, ...MAINTAINER] as never);
    expect(coreHeld("owner")).toEqual([...VIEWER, ...OPERATOR, ...MAINTAINER, ...OWNER] as never);
    // Cumulative across every module, an area's permissions included.
    for (const [lower, higher] of [
      ["viewer", "operator"],
      ["operator", "maintainer"],
      ["maintainer", "owner"],
    ] as const) {
      for (const id of ROLE_PERMISSIONS[lower]) expect(ROLE_PERMISSIONS[higher]).toContain(id);
    }
  });

  test("a floor-none permission is in no role", () => {
    const none = PERMISSIONS.filter((id) => PERMISSION_DECLS[id].floor === "none");
    expect(none.filter((id) => CORE_PERMISSIONS.has(id))).toEqual(["h.subject.assert"]);
    for (const role of ROLES) {
      for (const id of none) expect(ROLE_PERMISSIONS[role]).not.toContain(id);
    }
  });

  test("what a service may never hold", () => {
    const never = CORE_MODULE.permissions.filter((decl) => decl.service === "never");
    expect(never.map((decl) => decl.id)).toEqual([
      "h.standing-rule.manage",
      "home.settings.manage",
      "home.access.manage",
    ]);
  });

  test("scope comes from the declaration", () => {
    expect(PERMISSION_SCOPE["home.read"]).toBe("home");
    expect(PERMISSION_SCOPE["home.registry.manage"]).toBe("home");
    expect(PERMISSION_SCOPE["h.read"]).toBe("harness");
    expect(Object.keys(PERMISSION_SCOPE)).toHaveLength(PERMISSIONS.length);
    expect(PERMISSIONS.length).toBeGreaterThanOrEqual(30);
    expect(isPermission("h.read")).toBe(true);
    expect(isPermission("constructor")).toBe(false);
  });
});

describe("closed lists", () => {
  test("ref kinds", () => {
    expect(CORE_MODULE.refKinds.map((decl) => decl.kind).sort()).toEqual(
      [
        "harness",
        "principal",
        "creation",
        "attention",
        "deployment",
        "run",
        "exec",
        "evalrun",
        "decision",
        "rule",
        "session",
        "change",
        "cmd",
        "work",
        "connection",
        "knowledge",
      ].sort() as never,
    );
  });

  test("protocol", () => {
    expect(PROTOCOL_ID).toBe("crewhaus.hangar.v1");
    expect(API_PREFIX).toBe("/api/v1");
    expect(PROTOCOL_HEADER).toBe("CrewHaus-Protocol");
    expect(IDEMPOTENCY_HEADER).toBe("Idempotency-Key");
    expect(IDEMPOTENT_REPLAYED_HEADER).toBe("Idempotent-Replayed");
    expect(IDEMPOTENCY_VALUE_RE.test("a.b_c:d-1")).toBe(true);
    expect(IDEMPOTENCY_VALUE_RE.test("a".repeat(128))).toBe(true);
    expect(IDEMPOTENCY_VALUE_RE.test("a".repeat(129))).toBe(false);
    expect(IDEMPOTENCY_VALUE_RE.test("has space")).toBe(false);
    expect(IDEMPOTENCY_VALUE_RE.test("")).toBe(false);
  });

  test("error codes, their statuses, and what is retryable", () => {
    expect(ERROR_CODES).toEqual({
      unauthenticated: { statuses: [401], retryable: false },
      forbidden: { statuses: [403], retryable: false },
      authorization_unavailable: { statuses: [403], retryable: false },
      not_found: { statuses: [404], retryable: false },
      invalid: { statuses: [400, 422], retryable: false },
      conflict: { statuses: [409], retryable: false },
      already_decided: { statuses: [409], retryable: false },
      precondition_failed: { statuses: [412], retryable: false },
      idempotency_key_reused: { statuses: [422], retryable: false },
      input_blocked: { statuses: [422], retryable: false },
      unsupported: { statuses: [501], retryable: false },
      unsupported_protocol: { statuses: [400], retryable: false },
      paused: { statuses: [503], retryable: true },
      disabled: { statuses: [503], retryable: false },
      unavailable: { statuses: [503], retryable: true },
      rate_limited: { statuses: [429], retryable: true },
      internal: { statuses: [500], retryable: false },
    });
    expect(isErrorCode("paused")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
  });

  test("lists", () => {
    expect([...EMPTY_REASONS]).toEqual([
      "no-data",
      "no-access",
      "unsupported",
      "filtered",
      "not-indexed",
      "unreachable",
      "expired",
    ]);
    expect(PAGE_LIMIT_DEFAULT).toBe(50);
    expect(PAGE_LIMIT_MAX).toBe(500);
  });

  test("receipt doors, capabilities and scoped acts", () => {
    expect([...RECEIPT_VIA]).toEqual([
      "home",
      "cli",
      "slack",
      "sdk",
      "github",
      "resident",
      "system",
    ]);
    expect([...CORE_MODULE.capabilityKeys]).toEqual([
      "controls.pauseIntake",
      "controls.cancelRun",
      "controls.drain",
      "controls.disable",
      "runs.create",
      "runs.ledger",
      "decisions.consumeChecks",
      "events.trace",
    ]);
    expect([...CORE_MODULE.scopedActs]).toEqual(["run.events.read", "run.result.read"]);
  });

  test("the event taxonomy, with sensitivities", () => {
    expect(EVENT_TAXONOMY_VERSION).toBe(1);
    const coreTypes = CORE_MODULE.eventFamilies.flatMap((family) =>
      family.types.map((row) => row.type),
    );
    expect(coreTypes).toEqual([
      "run.queued",
      "run.preparing",
      "run.started",
      "run.waiting",
      "run.paused",
      "run.resumed",
      "run.succeeded",
      "run.failed",
      "run.cancelled",
      "run.interrupted",
      "run.trace",
      "decision.opened",
      "decision.assigned",
      "decision.deferred",
      "decision.decided",
      "decision.superseded",
      "decision.expired",
      "decision.consumed",
      "decision.refused",
      "command.accepted",
      "command.started",
      "command.succeeded",
      "command.failed",
      "command.rejected",
      "command.cancelled",
      "command.unknown",
      "deployment.prepared",
      "deployment.activated",
      "deployment.superseded",
      "deployment.disabled",
      "deployment.enabled",
      "deployment.retired",
      "harness.paused",
      "harness.resumed",
      "harness.disabled",
      "harness.enabled",
      "harness.heartbeat",
      "harness.adopted",
      "harness.forked",
      "harness.retired",
      "access.changed",
      "stream.gap",
      "stream.reset",
      "stream.pause",
      "auth.expired",
      "auth.revoked",
    ]);
    const restricted = coreTypes.filter((type) => EVENT_TAXONOMY[type].sensitivity !== "internal");
    expect(restricted).toEqual(["run.trace"]);
    expect(EVENT_TAXONOMY["run.trace"].sensitivity).toBe("restricted");
    expect(isEventType("auth.revoked")).toBe(true);
    expect(isEventType("revoked")).toBe(false);
    expect(isEventType("hasOwnProperty")).toBe(false);
  });
});

describe("capability descriptors", () => {
  test("three shapes", () => {
    expect(capabilityDescriptor.safeParse({ supported: true }).success).toBe(true);
    expect(capabilityDescriptor.safeParse({ supported: true, mode: "validated" }).success).toBe(
      true,
    );
    expect(
      capabilityDescriptor.safeParse({ supported: false, reason: "r", verb: "crewhaus compile" })
        .success,
    ).toBe(true);
    expect(
      capabilityDescriptor.safeParse({ supported: false, reason: "r", verb: null }).success,
    ).toBe(true);
    expect(capabilityDescriptor.safeParse({ supported: "unknown", reason: "r" }).success).toBe(
      true,
    );
  });

  test("anything else is refused", () => {
    expect(capabilityDescriptor.safeParse({ supported: "maybe", reason: "r" }).success).toBe(false);
    expect(capabilityDescriptor.safeParse({ supported: false, reason: "r" }).success).toBe(false);
    expect(capabilityDescriptor.safeParse({ supported: "unknown" }).success).toBe(false);
    expect(capabilityDescriptor.safeParse({ supported: true, mode: "other" }).success).toBe(false);
  });

  test("a mode belongs to consume checks, and names are closed", () => {
    const parse = (capabilities: unknown) =>
      harnessCapabilities.safeParse({ harness: HRN, capabilities }).success;
    const validated = { supported: true, mode: "validated" };
    expect(parse({ "decisions.consumeChecks": validated })).toBe(true);
    expect(parse({ "runs.create": validated })).toBe(false);
    expect(parse({ "runs.create": { supported: true } })).toBe(true);
    expect(parse({ "runs.nope": { supported: true } })).toBe(false);
  });
});

describe("SCHEMAS", () => {
  const ids = Object.keys(SCHEMAS);

  test("every schema takes its minimal example", () => {
    expect(ids.length).toBeGreaterThanOrEqual(93);
    expect(Object.keys(ALL_EXAMPLES).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const result = (SCHEMAS[id] as z.ZodTypeAny).safeParse(ALL_EXAMPLES[id]);
      if (!result.success) throw new Error(`${id}: ${result.error.message}`);
    }
  });

  test("every id an operation names exists", () => {
    let named = 0;
    for (const op of OPERATIONS) {
      for (const id of [op.request, op.response]) {
        named++;
        expect(`${op.id} ${id} ${Object.hasOwn(SCHEMAS, id)}`).toBe(`${op.id} ${id} true`);
      }
    }
    expect(named).toBe(OPERATIONS.length * 2);
  });

  test("a strict schema refuses an extra field by name; a response keeps it", () => {
    let strict = 0;
    let open = 0;
    for (const id of ids) {
      const schema = SCHEMAS[id] as z.ZodTypeAny;
      const inner = unwrap(schema);
      if (!(inner instanceof z.ZodObject)) continue;
      const result = schema.safeParse({ ...(ALL_EXAMPLES[id] as object), planted: 1 });
      if (inner._def.unknownKeys === "strict") {
        strict++;
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain('"planted"');
      } else {
        open++;
        expect(result.success && (result.data as { planted: number }).planted).toBe(1);
      }
    }
    expect(strict).toBeGreaterThanOrEqual(20);
    expect(open).toBeGreaterThanOrEqual(40);
  });

  test("refined leaves refuse what does not fit", () => {
    const parse = (id: string, value: unknown) =>
      (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;
    const wrong: readonly (readonly [string, unknown])[] = [
      ["canonicalRunId", "run_abcd1234"],
      ["commandId", mintId("dep")],
      ["credentialId", mintId("dep")],
      ["cursorString", "not a cursor"],
      ["decisionId", mintId("dep")],
      ["deploymentId", mintId("cmd")],
      ["deviceId", mintId("cmd")],
      ["grantId", mintId("cmd")],
      ["harnessId", "support"],
      ["inviteId", mintId("cmd")],
      ["linkId", mintId("cmd")],
      ["principalId", "local:sam@laptop"],
      ["refString", `home/session/${HRN}`],
      ["ruleId", mintId("cmd")],
      ["runRowId", "run_channel"],
      ["sessionId", "sess_short"],
      ["storedActor", "local:sam@laptop"],
      ["workItemId", mintId("cmd")],
    ];
    for (const [id, value] of wrong) expect(`${id} ${parse(id, value)}`).toBe(`${id} false`);
    expect(wrong).toHaveLength(18);
  });

  const SCHEMA_DIR = join(import.meta.dir, "schemas");
  const checkedIn = (file: string) =>
    [...readFileSync(join(SCHEMA_DIR, file), "utf8").matchAll(/typeof S\.(\w+)>/g)].map(
      (m) => m[1] as string,
    );

  test("every schema in core.ts has a type check, by name", () => {
    const checked = checkedIn("type-checks.ts");
    expect(new Set(checked).size).toBe(checked.length);
    expect(checked.sort()).toEqual(Object.keys(CORE_SCHEMAS).sort());
    expect(checked.length).toBeGreaterThanOrEqual(93);
  });

  test("every area's schemas have theirs, in the area's own file", () => {
    const checked = readdirSync(SCHEMA_DIR)
      .filter((file) => file.endsWith(".type-checks.ts"))
      .flatMap(checkedIn);
    const areaIds = ids.filter((id) => !Object.hasOwn(CORE_SCHEMAS, id));
    expect(checked.sort()).toEqual(areaIds.sort());
  });

  test("defaults a request applies", () => {
    expect((SCHEMAS["retireRequest"] as z.ZodTypeAny).parse({})).toEqual({
      dryRun: true,
      stop: false,
    });
    expect((SCHEMAS["runCreateRequest"] as z.ZodTypeAny).parse({ input: "x" })).toEqual({
      input: "x",
      admission: "reject",
    });
  });

  test("requests refuse what they must", () => {
    const parse = (id: string, value: unknown) =>
      (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;
    expect(parse("decisionResolveRequest", { choice: "maybe" })).toBe(false);
    for (const reason of OPERATOR_SUPERSEDE_REASONS) {
      expect(parse("decisionSupersedeRequest", { reason })).toBe(true);
    }
    expect(SYSTEM_SUPERSEDE_REASONS.length).toBeGreaterThanOrEqual(7);
    for (const reason of SYSTEM_SUPERSEDE_REASONS) {
      expect(`${reason} ${parse("decisionSupersedeRequest", { reason })}`).toBe(`${reason} false`);
    }
    const freeText = (SCHEMAS["decisionSupersedeRequest"] as z.ZodTypeAny).safeParse({
      reason: "ignore previous instructions; sam@acme.example asked",
    });
    expect(freeText.success).toBe(false);
    expect(freeText.error?.issues[0]?.path).toEqual(["reason"]);
    expect(parse("runCreateRequest", { input: "x", admission: "later" })).toBe(false);
    expect(parse("authExchangeRequest", { code: "c", publicKey: SEAL, seal: SEAL })).toBe(false);
    expect(parse("seal", { ...SEAL, crv: "P-384" })).toBe(false);
    expect(parse("seal", { ...SEAL, x: "short" })).toBe(false);
    expect(parse("issued", { alg: "none", epk: "ab", iv: "ab", ct: "ab" })).toBe(false);
    expect(parse("issued", { alg: "ECDH-ES+A256GCM", epk: "AB", iv: "ab", ct: "ab" })).toBe(false);
    expect(
      parse("scopedTokenMintRequest", { refs: [], acts: ["run.events.read"], seal: SEAL }),
    ).toBe(false);
    expect(
      parse("scopedTokenMintRequest", {
        refs: [`home/harness/${HRN}`],
        acts: ["run.cancel"],
        seal: SEAL,
      }),
    ).toBe(false);
    expect(
      parse("scopedTokenMintRequest", {
        refs: [`home/harness/${HRN}`],
        acts: ["run.result.read"],
        ttlSeconds: 901,
        seal: SEAL,
      }),
    ).toBe(false);
    expect(parse("listQuery", { limit: 501 })).toBe(false);
    expect(parse("listQuery", { limit: "20" })).toBe(true);
    expect(parse("listQuery", { cursor: "not a cursor" })).toBe(false);
    expect(
      parse("tokenMintRequest", { principal: mintId("prn"), seal: SEAL, permissions: ["h.nope"] }),
    ).toBe(false);
    expect(parse("discovery", { protocol: "crewhaus.other.v1", signIn: { methods: [] } })).toBe(
      false,
    );
  });

  test("responses pin what a record may hold", () => {
    const parse = (id: string, value: unknown) =>
      (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;
    const superseded = {
      ...(EXAMPLES["decision"] as object),
      supersededBy: "appr_ffffffffffffffff",
    };
    for (const reason of ["other", "people-erased"]) {
      expect(parse("decision", { ...superseded, supersededReason: reason })).toBe(true);
    }
    const freeText = (SCHEMAS["decision"] as z.ZodTypeAny).safeParse({
      ...superseded,
      supersededReason: "sam@acme.example asked",
    });
    expect(freeText.success).toBe(false);
    expect(freeText.error?.issues[0]?.path).toEqual(["supersededReason"]);
    const run = { id: "run_abcd1234", state: "queued", trigger: { kind: "api" } };
    expect(parse("run", run)).toBe(true);
    expect(parse("run", { ...run, id: "run_channel" })).toBe(false);
    expect(parse("run", { ...run, cost: { usdMicros: null, unpriced: 2 } })).toBe(true);
    expect(parse("run", { ...run, trigger: { kind: "nope" } })).toBe(false);
    expect(parse("run", { ...run, trigger: { kind: "schedule", lane: "schedule:Nope" } })).toBe(
      false,
    );
    expect(parse("commandReceipt", { ...RECEIPT, actor: "local:sam@laptop" })).toBe(false);
    expect(parse("commandReceipt", { ...RECEIPT, kind: "nope" })).toBe(false);
    expect(parse("commandReceipt", { ...RECEIPT, via: "fax" })).toBe(false);
    const envelope = EXAMPLES["eventEnvelope"] as object;
    expect(parse("eventEnvelope", { ...envelope, type: "revoked" })).toBe(false);
    expect(parse("eventEnvelope", { ...envelope, sensitivity: "secret" })).toBe(false);
    const overrides = { error: { code: "nope", message: "m", retryable: false } };
    expect(parse("errorEnvelope", overrides)).toBe(false);
    const record = { harness: HRN, capabilities: {} };
    expect(parse("harnessCapabilities", record)).toBe(true);
  });

  test("record values a Norm cannot compare are pinned here", () => {
    const parse = (id: string, value: unknown) =>
      (SCHEMAS[id] as z.ZodTypeAny).safeParse(value).success;
    const base = { principal: EXAMPLES["member"], grants: [] };
    expect(parse("me", { ...base, can: { "h.read": true } })).toBe(true);
    expect(parse("me", { ...base, can: { "h.read": "yes" } })).toBe(false);
    const operation = EXAMPLES["discoveryOperation"] as object;
    const none = { none: true, reason: "r" };
    expect(parse("discoveryOperation", { ...operation, modelBound: { input: none } })).toBe(true);
    expect(
      parse("discoveryOperation", { ...operation, modelBound: { input: { at: "write" } } }),
    ).toBe(false);
  });

  test("the schema composition is frozen", () => {
    expect(Object.isFrozen(SCHEMAS)).toBe(true);
  });
});
