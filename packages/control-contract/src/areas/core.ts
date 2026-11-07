/**
 * The core's own area module, first in `AREA_MODULES`. Every list the control
 * core declares lives here or in `../operations/`; every exported vocabulary is
 * composed from the modules, so the core and an area add entries the same way.
 */
import { ACCESS_OPERATIONS } from "../operations/access.js";
import { AUTH_OPERATIONS } from "../operations/auth.js";
import { COMMAND_OPERATIONS } from "../operations/commands.js";
import { CONTROL_OPERATIONS } from "../operations/controls.js";
import { DECISION_OPERATIONS } from "../operations/decisions.js";
import { DEPLOYMENT_OPERATIONS } from "../operations/deployments.js";
import { EVENT_OPERATIONS } from "../operations/events.js";
import { HARNESS_OPERATIONS } from "../operations/harnesses.js";
import { META_OPERATIONS } from "../operations/meta.js";
import { RULE_OPERATIONS } from "../operations/rules.js";
import { RUN_OPERATIONS } from "../operations/runs.js";
import { TWINS } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

/**
 * The reasons an operator can give for superseding a decision. The rest of the
 * `supersede` list is what the system records on its own, and no request can claim one.
 */
export const OPERATOR_SUPERSEDE_REASONS = deepFreeze([
  "decided-in-error",
  "policy-changed",
  "other",
] as const);

const ULID = "ulid";
const HEX16 = "hex16";

export const CORE_MODULE = {
  area: "core",
  operations: [
    ...META_OPERATIONS,
    ...HARNESS_OPERATIONS,
    ...DEPLOYMENT_OPERATIONS,
    ...CONTROL_OPERATIONS,
    ...RUN_OPERATIONS,
    ...DECISION_OPERATIONS,
    ...RULE_OPERATIONS,
    ...COMMAND_OPERATIONS,
    ...EVENT_OPERATIONS,
    ...ACCESS_OPERATIONS,
    ...AUTH_OPERATIONS,
  ],
  grammars: [
    { prefix: "dep", grammar: ULID },
    { prefix: "run", grammar: ULID },
    { prefix: "dec", grammar: ULID },
    { prefix: "rule", grammar: ULID },
    { prefix: "cmd", grammar: ULID },
    { prefix: "prn", grammar: ULID },
    { prefix: "grt", grammar: ULID },
    { prefix: "inv", grammar: ULID },
    { prefix: "crd", grammar: ULID },
    { prefix: "lnk", grammar: ULID },
    { prefix: "dev", grammar: ULID },
    // Reserved: the area that owns each object mints it.
    { prefix: "wi", grammar: ULID },
    { prefix: "con", grammar: ULID },
    { prefix: "crs", grammar: ULID },
    { prefix: "chg", grammar: ULID },
    // Derived from content by its area, so no reader may decode a time from it.
    { prefix: "att", grammar: "digest" },
    // Existing forms, minted where they are.
    { prefix: "hrn", grammar: HEX16 },
    { prefix: "sess", grammar: HEX16 },
    { prefix: "appr", grammar: HEX16 },
    { prefix: "run", grammar: HEX16 },
    { prefix: "grun", grammar: HEX16 },
  ],
  refKinds: [
    { kind: "harness", scope: "home", ids: [{ prefix: "hrn", grammar: HEX16 }] },
    { kind: "principal", scope: "home", ids: [{ prefix: "prn", grammar: ULID }] },
    { kind: "creation", scope: "home", ids: [{ prefix: "crs", grammar: ULID }] },
    { kind: "attention", scope: "home", ids: [{ prefix: "att", grammar: "digest" }] },
    { kind: "deployment", scope: "harness", ids: [{ prefix: "dep", grammar: ULID }] },
    {
      kind: "run",
      scope: "harness",
      ids: [{ prefix: "run", grammar: ULID }, { family: "hex8" }, { family: "base36" }],
    },
    { kind: "exec", scope: "harness", ids: [{ prefix: "run", grammar: HEX16 }] },
    { kind: "evalrun", scope: "harness", ids: [{ prefix: "run", grammar: HEX16 }] },
    {
      kind: "decision",
      scope: "harness",
      ids: [
        { prefix: "appr", grammar: HEX16 },
        { prefix: "dec", grammar: ULID },
      ],
    },
    { kind: "rule", scope: "harness", ids: [{ prefix: "rule", grammar: ULID }] },
    { kind: "session", scope: "harness", ids: [{ prefix: "sess", grammar: HEX16 }] },
    { kind: "change", scope: "harness", ids: [{ prefix: "chg", grammar: ULID }] },
    { kind: "cmd", scope: "either", ids: [{ prefix: "cmd", grammar: ULID }] },
    { kind: "work", scope: "either", ids: [{ prefix: "wi", grammar: ULID }] },
    { kind: "connection", scope: "either", ids: [{ prefix: "con", grammar: ULID }] },
    // The shape hangar-server accepts for one path segment, until the knowledge
    // area registers an opaque grammar.
    { kind: "knowledge", scope: "either", ids: [{ pattern: "[A-Za-z0-9_][A-Za-z0-9._-]{0,127}" }] },
  ],
  eventFamilies: [
    {
      family: "run",
      types: [
        { type: "run.queued", sensitivity: "internal" },
        { type: "run.preparing", sensitivity: "internal" },
        { type: "run.started", sensitivity: "internal" },
        { type: "run.waiting", sensitivity: "internal" },
        { type: "run.paused", sensitivity: "internal" },
        { type: "run.resumed", sensitivity: "internal" },
        { type: "run.succeeded", sensitivity: "internal" },
        { type: "run.failed", sensitivity: "internal" },
        { type: "run.cancelled", sensitivity: "internal" },
        { type: "run.interrupted", sensitivity: "internal" },
        { type: "run.trace", sensitivity: "restricted" },
      ],
    },
    {
      family: "decision",
      types: [
        { type: "decision.opened", sensitivity: "internal" },
        { type: "decision.assigned", sensitivity: "internal" },
        { type: "decision.deferred", sensitivity: "internal" },
        { type: "decision.decided", sensitivity: "internal" },
        { type: "decision.superseded", sensitivity: "internal" },
        { type: "decision.expired", sensitivity: "internal" },
        { type: "decision.consumed", sensitivity: "internal" },
        { type: "decision.refused", sensitivity: "internal" },
      ],
    },
    {
      family: "command",
      types: [
        { type: "command.accepted", sensitivity: "internal" },
        { type: "command.started", sensitivity: "internal" },
        { type: "command.succeeded", sensitivity: "internal" },
        { type: "command.failed", sensitivity: "internal" },
        { type: "command.rejected", sensitivity: "internal" },
        { type: "command.cancelled", sensitivity: "internal" },
        { type: "command.unknown", sensitivity: "internal" },
      ],
    },
    {
      family: "deployment",
      types: [
        { type: "deployment.prepared", sensitivity: "internal" },
        { type: "deployment.activated", sensitivity: "internal" },
        { type: "deployment.superseded", sensitivity: "internal" },
        { type: "deployment.disabled", sensitivity: "internal" },
        { type: "deployment.enabled", sensitivity: "internal" },
        { type: "deployment.retired", sensitivity: "internal" },
      ],
    },
    {
      family: "harness",
      types: [
        { type: "harness.paused", sensitivity: "internal" },
        { type: "harness.resumed", sensitivity: "internal" },
        { type: "harness.disabled", sensitivity: "internal" },
        { type: "harness.enabled", sensitivity: "internal" },
        { type: "harness.heartbeat", sensitivity: "internal" },
        { type: "harness.adopted", sensitivity: "internal" },
        { type: "harness.forked", sensitivity: "internal" },
        { type: "harness.retired", sensitivity: "internal" },
      ],
    },
    { family: "access", types: [{ type: "access.changed", sensitivity: "internal" }] },
    {
      family: "stream",
      types: [
        { type: "stream.gap", sensitivity: "internal" },
        { type: "stream.reset", sensitivity: "internal" },
        { type: "stream.pause", sensitivity: "internal" },
      ],
    },
    {
      family: "auth",
      types: [
        { type: "auth.expired", sensitivity: "internal" },
        { type: "auth.revoked", sensitivity: "internal" },
      ],
    },
  ],
  machines: {
    run: {
      states: [
        "queued",
        "preparing",
        "running",
        "waiting-for-approval",
        "waiting-for-input",
        "paused",
        "interrupted",
        "succeeded",
        "failed",
        "cancelled",
      ],
      // `running` is an entry too: a top-level loop nobody queued starts there.
      entry: ["queued", "running"],
      terminal: ["interrupted", "succeeded", "failed", "cancelled"],
      transitions: {
        queued: ["preparing", "running", "paused", "cancelled"],
        preparing: ["running", "failed", "cancelled", "interrupted"],
        running: [
          "waiting-for-approval",
          "waiting-for-input",
          "succeeded",
          "failed",
          "cancelled",
          "interrupted",
        ],
        // A park is durable: the process ending never interrupts it.
        "waiting-for-approval": ["preparing", "running", "succeeded", "failed", "cancelled"],
        "waiting-for-input": ["running", "cancelled", "failed"],
        paused: ["queued", "cancelled"],
        // Terminal: a retry is a new run with new authorization.
        interrupted: [],
        succeeded: [],
        failed: [],
        cancelled: [],
      },
      recoveryOwner: {
        queued: "control-core",
        preparing: "control-core",
        running: "runtime",
        "waiting-for-approval": "decision",
        "waiting-for-input": "attention",
        paused: "operator",
        interrupted: "operator",
        succeeded: "none",
        failed: "none",
        cancelled: "none",
      },
    },
    command: {
      states: ["accepted", "running", "unknown", "succeeded", "failed", "rejected", "cancelled"],
      entry: ["accepted"],
      // `unknown` is not terminal: reconciliation settles it.
      terminal: ["succeeded", "failed", "rejected", "cancelled"],
      transitions: {
        accepted: ["running", "succeeded", "failed", "unknown", "rejected", "cancelled"],
        running: ["succeeded", "failed", "unknown"],
        unknown: ["succeeded", "failed"],
        succeeded: [],
        failed: [],
        rejected: [],
        cancelled: [],
      },
      recoveryOwner: {
        accepted: "control-core",
        running: "control-core",
        unknown: "reconcile",
        succeeded: "none",
        failed: "none",
        rejected: "none",
        cancelled: "none",
      },
    },
    decision: {
      states: ["pending", "granted", "denied", "consumed", "superseded", "expired"],
      entry: ["pending"],
      terminal: ["consumed", "superseded", "expired"],
      transitions: {
        pending: ["granted", "denied", "superseded", "expired"],
        granted: ["consumed", "superseded", "expired"],
        // A deny never expires: it stands until it is superseded.
        denied: ["superseded"],
        consumed: [],
        superseded: [],
        expired: [],
      },
      recoveryOwner: {
        pending: "operator",
        granted: "runtime",
        denied: "operator",
        consumed: "none",
        superseded: "none",
        expired: "none",
      },
    },
    deployment: {
      states: ["prepared", "active", "superseded", "disabled", "retired"],
      entry: ["prepared"],
      terminal: ["retired"],
      transitions: {
        prepared: ["active"],
        active: ["superseded", "disabled"],
        superseded: ["retired"],
        disabled: ["active", "retired"],
        retired: [],
      },
      recoveryOwner: {
        prepared: "operator",
        active: "operator",
        superseded: "operator",
        disabled: "operator",
        retired: "none",
      },
    },
  },
  commandKinds: [
    {
      id: "deployments.activate",
      permission: "h.deploy",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "controls.pause",
      permission: "h.control",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "controls.resume",
      permission: "h.control",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "controls.drain",
      permission: "h.control",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.daemonDrain,
    },
    {
      id: "controls.stop",
      permission: "h.control",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.daemonStop,
    },
    {
      id: "controls.start",
      permission: "h.control",
      idempotent: false,
      effect: "local",
      cliTwin: TWINS.daemonStart,
    },
    {
      id: "controls.restart",
      permission: "h.control",
      idempotent: false,
      effect: "local",
      cliTwin: TWINS.daemonRestart,
    },
    {
      id: "controls.disable",
      permission: "h.deploy",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "controls.enable",
      permission: "h.deploy",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "controls.retire",
      permission: "h.retire",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "runs.create",
      permission: "h.run.submit",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "runs.cancel",
      permission: "h.control",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "runs.resume",
      permission: "h.run.submit",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "decisions.resolve",
      permission: "h.decision.resolve",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.approvalsChoice,
    },
    {
      id: "decisions.supersede",
      permission: "h.decision.resolve",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "rules.create",
      permission: "h.standing-rule.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "rules.revoke",
      permission: "h.standing-rule.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.invites.create",
      permission: "home.access.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.grants.create",
      permission: "home.access.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.tokens.mint",
      permission: "home.access.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.links.create",
      permission: "home.access.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.invites.revoke",
      permission: "home.access.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.grants.revoke",
      permission: "home.access.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.tokens.revoke",
      permission: "home.access.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.links.revoke",
      permission: "home.access.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "access.devices.revoke",
      permission: "home.access.manage",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "auth.acceptInvite",
      permission: "public",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
  ],
  permissions: [
    { id: "home.read", scope: "home", floor: "viewer", service: "grantable" },
    { id: "self.preferences", scope: "home", floor: "viewer", service: "grantable" },
    { id: "h.read", scope: "harness", floor: "viewer", service: "grantable" },
    { id: "h.read.content", scope: "harness", floor: "viewer", service: "grantable" },
    { id: "h.control", scope: "harness", floor: "operator", service: "grantable" },
    { id: "h.run.submit", scope: "harness", floor: "operator", service: "grantable" },
    { id: "h.eval.run", scope: "harness", floor: "operator", service: "grantable" },
    { id: "h.job.run", scope: "harness", floor: "operator", service: "grantable" },
    { id: "h.decision.resolve", scope: "harness", floor: "operator", service: "grantable" },
    { id: "h.registry.edit", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.spec.edit", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.quality.edit", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.data.write", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.feedback.write", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.memory.write", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.secrets.write", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.settings.write", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.deploy", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.connection.manage", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "h.access.view", scope: "harness", floor: "maintainer", service: "grantable" },
    { id: "home.registry.manage", scope: "home", floor: "maintainer", service: "grantable" },
    { id: "h.spec.edit.security", scope: "harness", floor: "owner", service: "grantable" },
    { id: "h.files.raw", scope: "harness", floor: "owner", service: "grantable" },
    { id: "h.registry.admin", scope: "harness", floor: "owner", service: "grantable" },
    { id: "h.retention.manage", scope: "harness", floor: "owner", service: "grantable" },
    { id: "h.standing-rule.manage", scope: "harness", floor: "owner", service: "never" },
    { id: "h.retire", scope: "harness", floor: "owner", service: "grantable" },
    { id: "home.settings.manage", scope: "home", floor: "owner", service: "never" },
    { id: "home.access.manage", scope: "home", floor: "owner", service: "never" },
    // No role implies it: only an explicit grant gives it to a service.
    { id: "h.subject.assert", scope: "harness", floor: "none", service: "grantable" },
  ],
  scopedActs: ["run.events.read", "run.result.read"],
  reasonCodes: {
    supersede: [
      ...OPERATOR_SUPERSEDE_REASONS,
      "revision-changed",
      "run-cancelled",
      "retired",
      "re-asked",
      "decider-revoked",
      "people-erased",
      "people-grant-revoked",
    ],
    evict: ["erased"],
  },
  capabilityKeys: [
    "controls.pauseIntake",
    "controls.cancelRun",
    "controls.drain",
    "controls.disable",
    "runs.create",
    "runs.ledger",
    "decisions.consumeChecks",
    "events.trace",
  ],
} as const satisfies AreaModule;
