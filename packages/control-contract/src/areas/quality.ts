/**
 * The quality area: change records (`chg_`) for a proposed edit to a harness's
 * spec, graders or cases, checked against its eval history and adopted through a
 * decision (#519, module brief 330). Static data, like every area module: the
 * `change` lifecycle, the command kinds a change's verbs submit, the `change` and
 * `evalrun` event families and the closed vocabularies a change row uses.
 *
 * The core already reserves the `chg` id grammar and the `change` and `evalrun` ref
 * kinds, and declares every permission these commands need; this module declares
 * none of them again. The v1 operations are declared by a later change.
 */
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

/** What a change edits. */
export const CHANGE_KINDS = deepFreeze(["spec", "graders", "dataset", "mixed"] as const);

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Where a change came from. Closed: a new producer is a schema change. */
export const CHANGE_SOURCES = deepFreeze([
  "optimize",
  "flywheel",
  "advise",
  "watchme",
  "route",
  "audition",
  "sunset",
  "right-size",
  "model-scan",
  "manual",
  "guided-repair",
  "criteria-edit",
] as const);

export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** The parts of a harness a change can touch. */
export const CHANGE_SURFACES = deepFreeze([
  "prompts",
  "tools",
  "retrieval",
  "routing",
  "budgets",
  "criteria",
  "cases",
] as const);

export type ChangeSurface = (typeof CHANGE_SURFACES)[number];

/** Why a change was declined, withdrawn, rolled back or superseded. */
export const CHANGE_REASONS = deepFreeze([
  "not-worth-it",
  "wrong-direction",
  "needs-owner",
  "base-moved",
  "instrument-changed",
  "regressed",
  "slo-rollback",
  "other",
] as const);

export type ChangeReason = (typeof CHANGE_REASONS)[number];

/** The reasons a person may give on the command line (`decline`, `withdraw`). */
export const PERSON_CHANGE_REASONS = deepFreeze([
  "not-worth-it",
  "wrong-direction",
  "needs-owner",
  "other",
] as const);

/** The lifecycle states of a change. */
export const CHANGE_STATES = deepFreeze([
  "proposed",
  "checking",
  "checked",
  "failed",
  "awaiting-decision",
  "adopted",
  "activated",
  "monitoring",
  "kept",
  "rolled-back",
  "declined",
  "withdrawn",
  "superseded",
] as const);

export type ChangeState = (typeof CHANGE_STATES)[number];

/** How a check isolated the candidate from the world. */
export const CHECK_ISOLATIONS = deepFreeze(["regrade-only", "recorded-tools", "live"] as const);

/** Every quality kind is submitted by the CLI before its v1 operation exists. */
const CLI_FIRST = "submitted by the crewhaus CLI; its v1 operation is declared by a later change";

export const QUALITY_MODULE = {
  area: "quality",
  operations: [],
  refKinds: [],
  eventFamilies: [
    {
      family: "change",
      types: [
        { type: "change.proposed", sensitivity: "internal" },
        { type: "change.checking", sensitivity: "internal" },
        { type: "change.checked", sensitivity: "internal" },
        { type: "change.awaiting", sensitivity: "internal" },
        { type: "change.adopted", sensitivity: "internal" },
        { type: "change.activated", sensitivity: "internal" },
        { type: "change.kept", sensitivity: "internal" },
        { type: "change.rolled_back", sensitivity: "internal" },
        { type: "change.declined", sensitivity: "internal" },
        { type: "change.withdrawn", sensitivity: "internal" },
        { type: "change.superseded", sensitivity: "internal" },
        { type: "change.failed", sensitivity: "internal" },
      ],
    },
    {
      family: "evalrun",
      types: [{ type: "evalrun.recorded", sensitivity: "internal" }],
    },
  ],
  machines: {
    change: {
      states: [...CHANGE_STATES],
      // `adopted` is an entry only for a command-line write-back, which adopts in one step.
      entry: ["proposed", "adopted"],
      terminal: ["kept", "rolled-back", "declined", "withdrawn", "superseded"],
      transitions: {
        proposed: ["checking", "withdrawn", "superseded"],
        checking: ["checked", "failed"],
        // A check that could not run can be run again.
        failed: ["checking", "withdrawn"],
        // A pass opens a decision; an edited change goes back to proposed.
        checked: ["awaiting-decision", "proposed", "withdrawn", "declined"],
        "awaiting-decision": ["adopted", "declined", "superseded"],
        adopted: ["activated", "rolled-back"],
        activated: ["monitoring"],
        monitoring: ["kept", "rolled-back"],
        kept: [],
        "rolled-back": [],
        declined: [],
        withdrawn: [],
        superseded: [],
      },
      recoveryOwner: {
        proposed: "operator",
        checking: "operator",
        checked: "operator",
        failed: "operator",
        "awaiting-decision": "operator",
        adopted: "operator",
        activated: "operator",
        monitoring: "operator",
        kept: "none",
        "rolled-back": "none",
        declined: "none",
        withdrawn: "none",
        superseded: "none",
      },
    },
  },
  commandKinds: [
    {
      id: "quality.changes.create",
      permission: "h.quality.edit",
      idempotent: true,
      effect: "local",
      noRowReason: CLI_FIRST,
      // `changes propose --from` takes a file path, which no placeholder bounds.
      cliTwin: null,
    },
    {
      id: "quality.changes.check",
      permission: "h.quality.edit",
      // A check spends model calls and a held-out use.
      idempotent: false,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["changes", "check", "{chg}"] },
    },
    {
      id: "quality.changes.adopt",
      permission: "h.spec.edit",
      idempotent: false,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["changes", "adopt", "{chg}", "--expect", "{rev}"] },
    },
    {
      id: "quality.changes.decline",
      permission: "h.quality.edit",
      idempotent: true,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["changes", "decline", "{chg}", "--reason", "{changeReason}"] },
    },
    {
      id: "quality.changes.withdraw",
      permission: "h.quality.edit",
      idempotent: true,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["changes", "withdraw", "{chg}"] },
    },
    {
      id: "quality.changes.rollback",
      permission: "h.deploy",
      idempotent: false,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["changes", "rollback", "{chg}", "--expect", "{rev}"] },
    },
    {
      id: "quality.holdouts.create",
      permission: "h.data.write",
      idempotent: false,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["datasets", "holdout", "{dataset}", "--fraction", "{fraction}"] },
    },
    {
      id: "quality.baselines.rebaseline",
      permission: "h.quality.edit",
      idempotent: false,
      effect: "local",
      noRowReason: CLI_FIRST,
      // `eval --rebaseline` takes a spec, a dataset and a graders file by path.
      cliTwin: null,
    },
    {
      id: "quality.baselines.pin",
      permission: "h.quality.edit",
      idempotent: true,
      effect: "local",
      noRowReason: CLI_FIRST,
      cliTwin: { argv: ["eval-report", "baseline", "set", "{evalRun}"] },
    },
  ],
  permissions: [],
  reasonCodes: { change: [...CHANGE_REASONS] },
} as const satisfies AreaModule;
