/**
 * @crewhaus/tool-routing — reading and steering model routing, experiments
 * and observational learning, as deterministic tools.
 *
 * Four tools over three stores. `RouteControl` inspects and steers the
 * learned-routing scoreboard. `ExperimentLedger` assigns keys to spec-version
 * variants and folds their outcomes. `FlywheelStatus` reports what the
 * self-improvement loop has left on disk. `WatchmeReport` reads the
 * observational-learning ledger and how much of it has reached routing.
 *
 * Five properties hold across the package.
 *
 *   1. THE REAL STORES. The scoreboard fold is `@crewhaus/routing-store`'s,
 *      the watch-me ledger is `@crewhaus/watchme-store`'s, the experiment
 *      hash and ledger are `@crewhaus/canary-controller`'s, and every
 *      statistic is `@crewhaus/tool-math`'s kernel. Nothing here parses
 *      `arms.jsonl`, re-derives a lane prefix, re-implements the
 *      repeat-measurement dedupe or writes a fourth Wilson interval. A
 *      near-duplicate rule that disagrees with the package it duplicates is
 *      the failure this architecture exists to avoid, and it shipped live
 *      last wave.
 *   2. EVERY RATE CARRIES ITS INTERVAL. An arm with three observations is not
 *      a better arm than one with three hundred, and a point estimate says it
 *      is. Proportions leave here as Wilson intervals; the one continuous
 *      mean the scoreboard holds leaves with a normal-approximation interval
 *      and a note saying it is not a Wilson one; and the comparison between
 *      experiment versions is a Mann-Whitney rank test, Bonferroni-corrected
 *      for the number of pairs, never a difference of means.
 *   3. COULD NOT DETERMINE IS NOT NO. A scoreboard that could not be read is
 *      not an empty scoreboard. A freeze marker that will not parse is not an
 *      absent freeze marker — and that one is not hypothetical: every caller
 *      of `readRouteFreeze` that omits its `onMalformed` callback reads a
 *      corrupt kill switch as "not frozen", `promoteLanes`'s own internal
 *      call included. This package reads it WITH the callback and refuses to
 *      fold or compact under a marker it could not understand.
 *   4. STEERING SAYS WHAT IT CHANGED, AND OFFERS THE SAME SELECTION AS A
 *      PREVIEW. `RouteControl` is `destructive` and `dryRun` defaults to
 *      TRUE. Its promotion preview is `promoteLanes`'s own `dryRun`, which
 *      runs the identical fold and writes nothing — not a parallel preview
 *      beside it.
 *   5. WHAT THIS BUILD CANNOT DO, IT SAYS. Four things around these
 *      operations need packages this one does not depend on: the promotion's
 *      eval gate (`@crewhaus/eval-report` + `@crewhaus/eval-ops`), the
 *      optimizer write-back stamp (`@crewhaus/spec-patch`), whether a ratings
 *      dataset is registered (`@crewhaus/dataset-registry`), and the
 *      acceptance verdict inside a flywheel run's eval artifacts. Each is
 *      named where it would have appeared, with the command that does it, and
 *      the operations that depend on one are refused rather than
 *      approximated.
 */

import { constants, accessSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  clearRouteFreeze,
  openScoreboard,
  promoteLanes,
  writeRouteFreeze,
} from "@crewhaus/routing-store";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  DEFAULT_EXPERIMENTS_DIR,
  EXPERIMENT_LEDGER_SUFFIX,
  type ExperimentOutcomeRecord,
  SERVING_BOUNDARY_NOTE,
  appendExperimentOutcomes,
  experimentRelPaths,
  foldLedger,
  ledgerTargets,
  listExperiments,
  readExperimentAssignment,
  readExperimentOutcomes,
  safeExperimentName,
  selectExperimentVariant,
  splitStatus,
} from "./lib/experiments";
import {
  CONVENTIONAL_DATASET,
  CONVENTIONAL_GRADERS,
  FLYWHEEL_RELDIR,
  KNOWN_WORKFLOWS,
  RUN_VERDICT_UNAVAILABLE,
  STATE_JSON_NOTE,
  WORKFLOWS_RELDIR,
  WRITE_BACK_HEADER_UNAVAILABLE,
  datasetPrecedence,
  listDir,
  listRuns,
  probeDir,
  probeFile,
} from "./lib/flywheel";
import {
  type Loaded,
  compareStrings,
  contain,
  containExistingDir,
  containWritePaths,
  instant,
  isPlainObject,
  iso,
  json,
  refusal,
  renderPath,
  sample,
} from "./lib/result";
import {
  ARM_LOSS_FLAG,
  ARM_RANK_TEST_UNAVAILABLE,
  PROMOTE_GATE_UNAVAILABLE,
  QUALITY_LANE_PREFIX,
  RESET_UNAVAILABLE,
  ROUTING_READ_RELPATHS,
  ROUTING_TOUCHED_RELPATHS,
  SHADOW_LANE_PREFIX,
  STATE_RELDIR,
  armViews,
  armsDroppedByCompaction,
  droppedArmView,
  loadArms,
  probeFreeze,
  probePriors,
  shadowSides,
} from "./lib/routing";
import {
  WATCHME_MODEL_SURFACE_UNAVAILABLE,
  WATCHME_READ_RELPATHS,
  countLines,
  fedRoutingKeyStrings,
  parseFedKey,
  readWatchme,
  rollupAggregates,
  rollupObservations,
  tallyWindows,
  turnId,
} from "./lib/watchme";
import type { SafePath } from "./paths";

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

/** Default cap on list-shaped fields in a result. The reader is a model. */
const DEFAULT_LIMIT = 50;

/** A ledger past this is not something to fold into one tool result. */
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;

/**
 * A watch-me ledger past this is not something to fold into one tool result
 * either. The store reads the whole file into memory; refusing up front is
 * the only honest bound a reader can put on that.
 */
const MAX_WATCHME_BYTES = 64 * 1024 * 1024;

const dirField = z
  .string()
  .optional()
  .describe("the harness directory (default: the working directory)");

const dryRunField = z
  .boolean()
  .optional()
  .describe(
    "report what WOULD happen and change nothing. Defaults to TRUE: this tool takes an explicit dryRun:false to act.",
  );

const limitField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(`cap the rows returned in list-shaped fields (default ${DEFAULT_LIMIT})`);

/**
 * Resolve the harness directory and the state directory under it, containing
 * every path the caller's choice of `dir` implies.
 *
 * `relPaths` are the names UNDER the state directory that the call will open
 * or write — including the `.tmp` names a write-then-rename lands on. They go
 * through the same `resolveSafe` the directory did, because a symlink at a
 * leaf sends the operation to the link's target and a dangling one is created
 * by the write itself.
 */
type Rooted = {
  readonly dirRel: string;
  readonly stateRoot: string;
  readonly stateRel: string;
  /** The contained state directory, for containing further leaves under it. */
  readonly state: SafePath;
};

function rootState(tool: string, dirRel: string, relPaths: ReadonlyArray<string>): Loaded<Rooted> {
  const harness = containExistingDir(tool, dirRel);
  if (!harness.ok) return harness;
  const stateRel = path.join(dirRel, STATE_RELDIR);
  const state = contain(tool, stateRel);
  if (!state.ok) return state;
  const escaped = containWritePaths(tool, state.value, relPaths);
  if (escaped !== undefined) return escaped;
  return { ok: true, value: { dirRel, stateRoot: state.value.real, stateRel, state: state.value } };
}

/** An error's message, for a refusal reason that must never be `[object Object]`. */
function message(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined) return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a file this tool is about to hand to a TOLERANT reader can actually
 * be read.
 *
 * `readExperimentOutcomes` catches its own read error and returns `[]`, which
 * is right for a crashed writer's torn last line and wrong for a ledger that
 * is a directory, or one this process has no permission for: the tally then
 * reports zero observations, which reads as "this version was never measured".
 * `accessSync` answers the question once, cheaply, without reading the file a
 * second time.
 */
function readable(
  abs: string,
): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const probe = probeFile(abs);
  if (probe.state === "not-a-file") {
    return { ok: false, why: "it is not a regular file" };
  }
  if (probe.state === "unreadable") return { ok: false, why: probe.detail };
  try {
    accessSync(abs, constants.R_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: `it could not be opened for reading (${message(err)})` };
  }
}

/** Bytes of a file, or `null` when there is none to measure. */
function byteSize(abs: string): number | null {
  try {
    return statSync(abs).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RouteControl
// ---------------------------------------------------------------------------

const ROUTE_ACTIONS = ["status", "freeze", "unfreeze", "promote", "compact"] as const;

export const routeControl: RegisteredTool = buildTool({
  name: "RouteControl",
  operativeArgs: [{ field: "dir", kind: "path", default: "." }],
  description:
    "Inspect and steer a harness's learned model routing: the per-(routeKey, arm) reward scoreboard, the `route freeze` kill switch, and the promotion of observe-only `q:` / `shadow:` lane evidence into the live arms. Every rate it reports carries a Wilson interval and every mean carries its n, because an arm with three observations is not a better arm than one with three hundred. It REFUSES to promote or compact when the freeze marker exists (the pin is the kill switch) AND when the marker exists but cannot be parsed — a corrupt kill switch is not an absent one, and `promoteLanes`'s own freeze check reads it as absent. A real promotion additionally needs acceptUngated:true, because this tool does not resolve the eval gate `crewhaus route promote` requires. Resetting the scoreboard is deliberately not offered; use `crewhaus route reset`. dryRun defaults to true and changes nothing; the promotion preview is promoteLanes' own dryRun, running the same fold.",
  inputSchema: z.object({
    action: z
      .enum(ROUTE_ACTIONS)
      .describe(
        "status (read the arms, the freeze marker, the lanes and the priors), freeze (pin a policyVersion), unfreeze (lift the pin), promote (fold lane evidence into the live arms), compact (rewrite the store to one aggregate line per arm)",
      ),
    dir: dirField,
    policyVersion: z
      .string()
      .min(1)
      .optional()
      .describe(
        "freeze only: the `model_route.policyVersion` (pool fingerprint) to pin. See `crewhaus route explain`.",
      ),
    reason: z.string().optional().describe("freeze only: an operator note stored on the marker"),
    acceptUngated: z
      .boolean()
      .optional()
      .describe(
        "promote only: proceed although this tool resolved no eval gate. Required for a real promotion.",
      ),
    acceptArmLoss: z
      .boolean()
      .optional()
      .describe(
        "compact only: compact although it would DELETE an arm that carries judged quality but no reward observation (a promoted `q:` back-fill). That evidence cannot be restored.",
      ),
    lane: z
      .enum(["all", "live", "quality", "shadow"])
      .optional()
      .describe("status only: which routeKey namespace to report (default all)"),
    dryRun: dryRunField,
    limit: limitField,
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "RouteControl";
    const dryRun = input.dryRun ?? true;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const readOnlyAction = input.action === "status";
    const rooted = rootState(
      tool,
      input.dir ?? ".",
      readOnlyAction ? ROUTING_READ_RELPATHS : ROUTING_TOUCHED_RELPATHS,
    );
    if (!rooted.ok) return refusal(tool, rooted.code, rooted.reason);
    const { stateRoot, stateRel } = rooted.value;
    const armsPath = path.join(stateRoot, "routing", "arms.jsonl");

    // The freeze marker is read FIRST, with the callback, for every action.
    // Without the callback a truncated marker reads as "not frozen", and the
    // one operation whose purpose is changing which model serves would walk
    // straight through a pin an operator set after an incident.
    const freeze = probeFreeze(stateRoot);
    const freezeField =
      freeze.state === "frozen"
        ? {
            state: "frozen" as const,
            policyVersion: freeze.freeze.policyVersion,
            frozenAt: freeze.freeze.frozenAt,
            ...(freeze.freeze.reason !== undefined ? { reason: freeze.freeze.reason } : {}),
          }
        : freeze.state === "corrupt"
          ? { state: "corrupt" as const, detail: freeze.detail }
          : { state: "none" as const };

    if (input.action === "status") {
      const arms = loadArms(stateRoot);
      if (!arms.ok) {
        return refusal(tool, arms.code, arms.reason, { freeze: freezeField, file: armsPath });
      }
      const views = armViews(arms.value);
      const lane = input.lane ?? "all";
      const shown = lane === "all" ? views : views.filter((v) => v.lane === lane);
      const sides = shadowSides(stateRoot);
      return json({
        tool,
        status: "ok",
        dir: stateRel,
        file: armsPath,
        storeExists: existsSync(armsPath),
        freeze: freezeField,
        priors: probePriors(stateRoot),
        counts: {
          live: views.filter((v) => v.lane === "live").length,
          quality: views.filter((v) => v.lane === "quality").length,
          shadow: views.filter((v) => v.lane === "shadow").length,
        },
        lane,
        arms: sample(shown, limit),
        shadowSides: {
          // Which arm ids the shadow lane recorded on each side of an
          // audition, read off the `at` stamp by the store. `ArmStats` cannot
          // carry it, and every consumer that guesses (the arm with the most
          // observations, say) picks the INCUMBENT, because each graded turn
          // writes one observation per side.
          shadow: [...sides.shadow].sort(compareStrings),
          primary: [...sides.primary].sort(compareStrings),
          unattributed: [...sides.unattributed].sort(compareStrings),
          ...(sides.unreadable !== undefined ? { unreadable: sides.unreadable } : {}),
        },
        lanes: {
          qualityPrefix: QUALITY_LANE_PREFIX,
          shadowPrefix: SHADOW_LANE_PREFIX,
          note: "arms under these prefixes are OBSERVE-ONLY: the runtime router mints neither namespace and reads neither back, so they steer no live decision until a promotion folds them.",
        },
        notes: [ARM_RANK_TEST_UNAVAILABLE, RESET_UNAVAILABLE],
      });
    }

    if (input.action === "freeze") {
      // `writeRouteFreeze` THROWS on a version that trims to empty, and
      // `z.string().min(1)` happily admits " ". Checking the trimmed value —
      // the one the library acts on — rather than the spelling the caller
      // passed is what keeps that from leaving `execute` as a crash.
      if (input.policyVersion === undefined || input.policyVersion.trim().length === 0) {
        return refusal(
          tool,
          "bad-input",
          "freeze needs a policyVersion to pin — the `policyVersion` on a `model_route` line (`crewhaus route explain`). A freeze with no version pins nothing.",
        );
      }
      const replacing = freezeField;
      // PARSE, THEN ACT: the library stores the TRIMMED version, so that is
      // the value the preview promises and the result reports — never the
      // caller's spelling.
      const policyVersion = input.policyVersion.trim();
      if (dryRun) {
        return json({
          tool,
          status: "preview",
          action: "freeze",
          dir: stateRel,
          wouldPin: policyVersion,
          replacing,
          changed: false,
          note: "nothing was written. Re-run with dryRun:false to pin the policy.",
        });
      }
      let record: ReturnType<typeof writeRouteFreeze>;
      try {
        record = writeRouteFreeze(stateRoot, {
          policyVersion,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
      } catch (err) {
        return refusal(
          tool,
          "unreadable",
          `the freeze marker could not be written: ${message(err)}`,
        );
      }
      return json({
        tool,
        status: "ok",
        action: "freeze",
        dir: stateRel,
        changed: true,
        wrote: path.join(stateRoot, "routing", "freeze.json"),
        pinned: record,
        replaced: replacing,
        note: "while this marker exists the scoreboard is read-only: `record`, `ungraded` and `compact` are no-ops and no new observation moves an arm. It is cleared explicitly, never by a spec edit — a kill switch that disarms itself on the next edit is not a kill switch.",
      });
    }

    if (input.action === "unfreeze") {
      if (freeze.state === "none") {
        return json({
          tool,
          status: "ok",
          action: "unfreeze",
          dir: stateRel,
          changed: false,
          removed: false,
          note: "there was no freeze marker to lift.",
        });
      }
      if (dryRun) {
        return json({
          tool,
          status: "preview",
          action: "unfreeze",
          dir: stateRel,
          wouldRemove: freezeField,
          changed: false,
          note: "nothing was removed. Re-run with dryRun:false to lift the pin.",
        });
      }
      let removed: boolean;
      try {
        removed = clearRouteFreeze(stateRoot);
      } catch (err) {
        return refusal(
          tool,
          "unreadable",
          `the freeze marker could not be removed: ${message(err)}`,
        );
      }
      return json({
        tool,
        status: "ok",
        action: "unfreeze",
        dir: stateRel,
        changed: removed,
        removed,
        // A corrupt marker is removed too, but this tool cannot say what it
        // pinned — reporting the previous policyVersion as unknown is the
        // honest record of what just stopped being in force.
        lifted: freezeField,
        note:
          freeze.state === "corrupt"
            ? "the marker that was removed could not be parsed, so what it pinned is unknown. Learning resumes either way."
            : "learning resumes: new observations move arms again.",
      });
    }

    if (input.action === "compact") {
      if (freeze.state === "frozen") {
        return refusal(
          tool,
          "frozen",
          `routing is frozen at policyVersion "${freeze.freeze.policyVersion}" — compaction rewrites the arms file, which is exactly what the pin forbids. Lift it with action:"unfreeze" first.`,
          { freeze: freezeField },
        );
      }
      if (freeze.state === "corrupt") {
        return refusal(
          tool,
          "corrupt",
          `the freeze marker exists but could not be parsed (${freeze.detail}), so this tool cannot tell whether routing is pinned. A corrupt kill switch is not an absent one. Fix or remove ${path.join(stateRel, "routing", "freeze.json")} first.`,
          { freeze: freezeField },
        );
      }
      const before = loadArms(stateRoot);
      if (!before.ok) return refusal(tool, before.code, before.reason, { file: armsPath });
      const bytesBefore = byteSize(armsPath);
      if (bytesBefore === null) {
        // `compact()` would `mkdir` the routing directory and write an empty
        // file. Creating state on a harness that has never routed is a
        // surprise, not a compaction.
        return json({
          tool,
          status: "ok",
          action: "compact",
          dir: stateRel,
          file: armsPath,
          changed: false,
          arms: 0,
          note: "there is no scoreboard file here, so there is nothing to compact. Nothing was created.",
        });
      }
      // `compact()` does not keep every arm: it writes only the arms with
      // `n > 0 || ungraded > 0`. Counting `snapshot()` as "the arms before"
      // and calling the rest a line-count shrink was a PARALLEL preview that
      // disagreed with the real selection — and an arm holding a promoted
      // `q:` back-fill (n:0, ungraded:0, judged quality) is exactly what the
      // difference deletes, permanently, because its lane sources are already
      // stamped `pm:1`.
      const dropped = armsDroppedByCompaction(before.value).map(droppedArmView);
      const losing = dropped.filter((a) => a.qualityCount > 0);
      const keeping = before.value.length - dropped.length;
      if (dryRun) {
        return json({
          tool,
          status: "preview",
          action: "compact",
          dir: stateRel,
          file: armsPath,
          arms: before.value.length,
          armsKept: keeping,
          armsDropped: sample(dropped, limit),
          bytesBefore,
          changed: false,
          note:
            losing.length > 0
              ? `nothing was written. A real run rewrites the file to one aggregate line per arm — and DELETES the ${losing.length} arm(s) in armsDropped that carry judged quality but no reward observation, because compact() keeps only arms with n>0 or ungraded>0. That quality is unrecoverable (the lane lines it was promoted from are stamped as already-promoted), so a real run needs ${ARM_LOSS_FLAG}:true.`
              : "nothing was written. A real run rewrites the file to one aggregate line per arm. Every arm with an observation keeps its folded numbers; only the line count shrinks.",
        });
      }
      if (losing.length > 0 && input.acceptArmLoss !== true) {
        return refusal(
          tool,
          "refused",
          `compaction would DELETE ${losing.length} arm(s) that carry judged quality but no reward observation and no ungraded count: ${losing.map((a) => `"${renderPath(a.routeKey)}"/"${renderPath(a.model)}" (${a.qualityCount} judged observation(s))`).join(", ")}. \`Scoreboard.compact()\` writes only the arms with n>0 or ungraded>0, and the lane lines this evidence was promoted from are stamped as already-promoted, so nothing can restore it. Pass ${ARM_LOSS_FLAG}:true to compact anyway, or leave the store as it is — compaction only shrinks the file.`,
          { armsDropped: sample(dropped, limit) },
        );
      }
      try {
        openScoreboard(stateRoot).compact();
      } catch (err) {
        return refusal(
          tool,
          "unreadable",
          `the scoreboard could not be rewritten: ${message(err)}`,
          {
            file: armsPath,
          },
        );
      }
      const after = loadArms(stateRoot);
      return json({
        tool,
        status: "ok",
        action: "compact",
        dir: stateRel,
        file: armsPath,
        changed: true,
        arms: before.value.length,
        armsAfter: after.ok ? after.value.length : null,
        armsDropped: sample(dropped, limit),
        acceptedArmLoss: losing.length > 0,
        bytesBefore,
        bytesAfter: byteSize(armsPath),
        note:
          losing.length > 0
            ? `the store was rewritten to one aggregate line per arm, write-then-rename. The arms in armsDropped were DELETED, including ${losing.length} that carried judged quality — that evidence is gone and cannot be re-promoted.`
            : "the store was rewritten to one aggregate line per arm, write-then-rename. Every remaining arm's statistics are unchanged; an arm with no observations, no ungraded count and no quality is dropped and carried nothing.",
      });
    }

    // promote
    if (freeze.state === "frozen") {
      return refusal(
        tool,
        "frozen",
        `routing is frozen at policyVersion "${freeze.freeze.policyVersion}" — a promotion changes which model serves, which is what the pin forbids. Lift it with action:"unfreeze" first.`,
        { freeze: freezeField },
      );
    }
    if (freeze.state === "corrupt") {
      return refusal(
        tool,
        "corrupt",
        `the freeze marker exists but could not be parsed (${freeze.detail}), so this tool cannot tell whether routing is pinned. promoteLanes' own freeze check would read this file as ABSENT and fold anyway; refusing here is the point. Fix or remove ${path.join(stateRel, "routing", "freeze.json")} first.`,
        { freeze: freezeField },
      );
    }
    if (!dryRun && input.acceptUngated !== true) {
      return refusal(
        tool,
        "refused",
        `a real promotion needs acceptUngated:true. ${PROMOTE_GATE_UNAVAILABLE}`,
        { gate: "not resolved" },
      );
    }
    // The preview is `promoteLanes`' OWN dryRun: the identical walk over the
    // identical lines, with the write suppressed. There is no second
    // selection here that could disagree with the real one.
    //
    // The bytes are measured either side of it because `PromoteResult.lines`
    // counts what was FOLDED, and a fold is not the only thing the call
    // writes: a `q:` lane line carrying no judged quality is stamped `pm:1`
    // and folds nothing, so `lines` stays 0 while `arms.jsonl` is rewritten
    // and those lines become unpromotable for good. Reporting `changed:
    // false` for that run told the operator nothing had happened to a store
    // that had just been rewritten. The size is an OBSERVATION of the file,
    // not a second selection — a stamp only ever adds bytes.
    const bytesBeforeFold = byteSize(armsPath);
    let result: ReturnType<typeof promoteLanes>;
    try {
      result = promoteLanes(stateRoot, { dryRun });
    } catch (err) {
      return refusal(tool, "unreadable", `the fold could not be completed: ${message(err)}`, {
        file: armsPath,
      });
    }
    if (result.frozenPolicyVersion !== undefined) {
      // Defence in depth: a marker written between the probe above and this
      // call. Reported as a refusal rather than as an empty fold.
      return refusal(
        tool,
        "frozen",
        `routing became frozen at policyVersion "${result.frozenPolicyVersion}" before the fold ran; nothing was folded and nothing was written.`,
        { freeze: { state: "frozen", policyVersion: result.frozenPolicyVersion } },
      );
    }
    const bytesAfterFold = byteSize(armsPath);
    const rewritten = bytesBeforeFold !== bytesAfterFold;
    return json({
      tool,
      status: dryRun ? "preview" : "ok",
      action: "promote",
      dir: stateRel,
      file: result.path,
      changed: !dryRun && (result.lines > 0 || rewritten),
      linesFolded: result.lines,
      alreadyPromoted: result.alreadyPromoted,
      bytesBefore: bytesBeforeFold,
      bytesAfter: bytesAfterFold,
      promotions: sample(result.promotions, limit),
      gate: {
        resolved: false,
        acceptUngated: input.acceptUngated === true,
        detail: PROMOTE_GATE_UNAVAILABLE,
      },
      carryNote:
        "a `shadow:` line is carried WHOLE (it is new evidence from an arm that never served live); its `primary` side stays in the lane, because that arm already recorded the turn and its lane quality is a pairwise verdict, not an absolute score. A `q:` line folds as a quality BACK-FILL only (`n:0`), because the offline join re-observes turns the live arm already counted.",
      note: dryRun
        ? "nothing was written. This preview is promoteLanes' own dryRun over the same lines the real fold walks."
        : result.lines === 0 && rewritten
          ? "no evidence was folded, but the store WAS rewritten: lane line(s) carrying no judged quality were stamped as already-promoted, and no later promotion will revisit them."
          : "every folded source line is stamped so a second promotion cannot double-count it; the lane keeps its own history.",
    });
  },
});

// ---------------------------------------------------------------------------
// ExperimentLedger
// ---------------------------------------------------------------------------

const LEDGER_ACTIONS = ["list", "tally", "assign", "record"] as const;

export const experimentLedger: RegisteredTool = buildTool({
  name: "ExperimentLedger",
  operativeArgs: [
    { field: "dir", kind: "path" },
    { field: "experimentsDir", kind: "path" },
    { field: "name", kind: "id" },
  ],
  description:
    "Assign a stable request key to a spec-version variant, record outcomes, and fold the ledger into per-version tallies with an explicit winner or an explicit 'undecided'. The assignment hash is @crewhaus/canary-controller's own, so a two-version canary and an N-variant experiment can never disagree about which side of the split a key is on. Repeat eval measurements of the same (version, sample) are collapsed BEFORE the tally, because re-running an eval otherwise inflates n and narrows the interval enough to name a winner that does not exist. Every success rate carries a Wilson interval; the comparison between versions is a Mann-Whitney rank test over the per-observation scores, Bonferroni-corrected for the number of pairs, never a difference of means. Nothing here intercepts a live request: selection is a decision function and this is accounting. `record` writes; dryRun defaults to true.",
  inputSchema: z.object({
    action: z
      .enum(LEDGER_ACTIONS)
      .describe(
        "list (every experiment with a ledger), tally (fold one experiment's outcomes), assign (which version a request key selects), record (append one outcome)",
      ),
    name: z.string().min(1).optional().describe("the experiment name (required except for list)"),
    dir: dirField,
    experimentsDir: z
      .string()
      .optional()
      .describe(`the experiments directory (default: <dir>/${DEFAULT_EXPERIMENTS_DIR})`),
    requestKey: z
      .string()
      .min(1)
      .optional()
      .describe("assign only: the stable key (tenant id, session id, sample id) to bucket"),
    version: z.string().min(1).optional().describe("record only: the variant version to attribute"),
    outcome: z
      .enum(["success", "failure"])
      .optional()
      .describe("record only: whether the observation succeeded"),
    score: z
      .number()
      // Finite, because `readExperimentOutcomes` DROPS a non-finite score on
      // the way back in. Without this the append succeeds, the tally never
      // sees the value, and nothing tells the caller it was thrown away.
      .finite()
      .optional()
      .describe(
        "record only: a normalized 0..1 quality score. Scores are what make versions comparable with a rank test.",
      ),
    rating: z.number().finite().optional().describe("record only: a human rating on its own scale"),
    source: z
      .string()
      .optional()
      .describe(
        "record only: where the observation came from (eval, serving, cli). An n built from eval re-runs is not the same evidence as one from serving, and only `eval` records dedupe.",
      ),
    allowUnknownVersion: z
      .boolean()
      .optional()
      .describe(
        "record only: append a version the assignment manifest does not list (a typo otherwise becomes a phantom variant in every later tally)",
      ),
    dryRun: dryRunField,
    limit: limitField,
  }),
  destructive: true,
  requireJustification: true,
  execute: async (input) => {
    const tool = "ExperimentLedger";
    const dryRun = input.dryRun ?? true;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const dirRel = input.dir ?? ".";
    const harness = containExistingDir(tool, dirRel);
    if (!harness.ok) return refusal(tool, harness.code, harness.reason);
    const expRel = input.experimentsDir ?? path.join(dirRel, DEFAULT_EXPERIMENTS_DIR);
    const expDir = contain(tool, expRel);
    if (!expDir.ok) return refusal(tool, expDir.code, expDir.reason);

    if (input.action === "list") {
      const probe = probeDir(expDir.value.real);
      if (probe.state === "unreadable") {
        return refusal(
          tool,
          "unreadable",
          `"${renderPath(expRel)}" ${probe.detail} — this is not an absent experiments directory`,
        );
      }
      if (probe.state === "not-a-directory") {
        return refusal(tool, "not-a-directory", `"${renderPath(expRel)}" is not a directory`);
      }
      const names = listExperiments(expDir.value.real);
      const rows: Array<Record<string, unknown>> = [];
      const uncontained: string[] = [];
      for (const name of [...names].sort(compareStrings)) {
        // A name a DIRECTORY LISTING produced is exactly as untrusted as one a
        // caller typed: it becomes a filename this loop then opens. The
        // experiments directory was contained; its leaves were not. The name
        // ON DISK is contained too, because that is the file whose size this
        // row reports.
        const safe = safeExperimentName(name);
        if (
          !safe.ok ||
          containWritePaths(tool, expDir.value, [
            `${name}${EXPERIMENT_LEDGER_SUFFIX}`,
            ...experimentRelPaths(safe.value),
          ])
        ) {
          uncontained.push(renderPath(name));
          continue;
        }
        // A listed name is not necessarily a name this tool can ADDRESS.
        // `experimentFileName` maps anything outside [A-Za-z0-9._-] to `_` and
        // collapses a leading run of dots, so `..ramp.jsonl` and `_ramp.jsonl`
        // are two different files with one sanitized name. Reporting the row
        // for one of them with the OTHER's byte count and assignment manifest
        // is the "acted on a different spelling than the one you validated"
        // shape, one directory entry at a time — so the size comes off the
        // listed file, and the manifest is only read for a name that is
        // already its own sanitized form.
        const addressable = safe.value === name;
        const assignment = addressable
          ? readExperimentAssignment(name, expDir.value.real)
          : undefined;
        rows.push({
          name,
          ledgerBytes: byteSize(path.join(expDir.value.real, `${name}${EXPERIMENT_LEDGER_SUFFIX}`)),
          addressable,
          ...(addressable
            ? {}
            : {
                addressableAs: safe.value,
                note: `this ledger's filename is not its own sanitized form, so \`tally\`, \`record\` and \`assign\` on "${renderPath(name)}" would open "${renderPath(safe.value)}${EXPERIMENT_LEDGER_SUFFIX}" instead. Its assignment manifest was NOT read, because the manifest under the sanitized name belongs to a different experiment.`,
              }),
          assignment:
            assignment === undefined
              ? null
              : {
                  variants: assignment.variants,
                  updatedAt: assignment.updatedAt,
                  ...(assignment.env !== undefined ? { env: assignment.env } : {}),
                  split: splitStatus(assignment),
                },
        });
      }
      return json({
        tool,
        status: "ok",
        dir: expRel,
        exists: probe.state === "directory",
        experiments: sample(rows, limit),
        // Listed but not opened, rather than dropped: a ledger this tool will
        // not follow is a fact about the harness, not an absence.
        uncontained,
        note: `an experiment with an assignment manifest but no rows has been declared and never observed; one with rows and no manifest was retired (a concluded ramp REMOVES the manifest, because there is no representable "100% one version" split). ${SERVING_BOUNDARY_NOTE}`,
      });
    }

    if (input.name === undefined) {
      return refusal(tool, "bad-input", `action "${input.action}" needs an experiment name`);
    }
    // PARSE, THEN ACT. `experimentFileName` is what becomes the filename, so
    // it is what gets contained — containing the caller's spelling would be
    // validating a string nothing opens.
    const safeName = safeExperimentName(input.name);
    if (!safeName.ok) return refusal(tool, safeName.code, safeName.reason);
    const escaped = containWritePaths(tool, expDir.value, experimentRelPaths(safeName.value));
    if (escaped !== undefined) return refusal(tool, escaped.code, escaped.reason);
    const ledgerPath = path.join(expDir.value.real, `${safeName.value}.jsonl`);
    const assignmentPath = path.join(expDir.value.real, `${safeName.value}.assignment.json`);
    const assignment = readExperimentAssignment(input.name, expDir.value.real);
    // `readExperimentAssignment` returns `undefined` for an absent manifest
    // AND for one that will not parse. Those are different answers: the first
    // is a concluded ramp, the second is a file somebody broke.
    const manifest: "ok" | "absent" | "unreadable" =
      assignment !== undefined
        ? "ok"
        : probeFile(assignmentPath).state === "absent"
          ? "absent"
          : "unreadable";

    if (input.action === "assign") {
      if (input.requestKey === undefined) {
        return refusal(tool, "bad-input", "assign needs a requestKey to bucket");
      }
      if (manifest === "unreadable") {
        return refusal(
          tool,
          "corrupt",
          `the assignment manifest at ${path.join(expRel, `${safeName.value}.assignment.json`)} exists but could not be read as a split. That is not an absent manifest, and assigning past it would bucket a key against a split nobody declared.`,
        );
      }
      if (assignment === undefined) {
        return refusal(
          tool,
          "missing",
          `no assignment manifest for "${renderPath(input.name)}" at ${path.join(expRel, `${safeName.value}.assignment.json`)}. A concluded ramp removes it deliberately, so routing on a stale split is impossible — declare one with \`crewhaus deploy canary --traffic-split\` before assigning.`,
        );
      }
      let selection: ReturnType<typeof selectExperimentVariant>;
      try {
        selection = selectExperimentVariant(assignment, input.requestKey);
      } catch (err) {
        return refusal(
          tool,
          "bad-input",
          `the assignment manifest is not a valid split: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return json({
        tool,
        status: "ok",
        action: "assign",
        experiment: input.name,
        file: path.join(expRel, `${safeName.value}.assignment.json`),
        version: selection.version,
        bucket: selection.bucket,
        variantIndex: selection.index,
        variants: assignment.variants,
        ...(assignment.salt !== undefined ? { salt: assignment.salt } : {}),
        note: `the bucket is sha256(salt|requestKey) mod 100, the same hash CanaryController.route() uses, so the same key lands on the same side forever and in every process. ${SERVING_BOUNDARY_NOTE}`,
      });
    }

    if (input.action === "record") {
      if (input.version === undefined || input.outcome === undefined) {
        return refusal(tool, "bad-input", "record needs both a version and an outcome");
      }
      // The schema says `.finite()`, and the schema is advisory: `execute`
      // takes `unknown` and nothing between here and the tool call is
      // guaranteed to have run it. The check is repeated on the value that
      // would actually be written, because `readExperimentOutcomes` DROPS a
      // non-finite number on the way back in — the append would succeed and
      // the value would never reach a tally.
      for (const [field, value] of [
        ["score", input.score],
        ["rating", input.rating],
      ] as const) {
        if (value !== undefined && !Number.isFinite(value)) {
          return refusal(
            tool,
            "bad-input",
            `${field} must be a finite number (got ${String(value)}) — the ledger reader drops a non-finite one, so recording it would append a value no tally will ever see`,
          );
        }
      }
      if (manifest === "unreadable" && input.allowUnknownVersion !== true) {
        return refusal(
          tool,
          "corrupt",
          `the assignment manifest at ${path.join(expRel, `${safeName.value}.assignment.json`)} exists but could not be read as a split, so this tool cannot check the version against it. An unreadable manifest is not an absent one; pass allowUnknownVersion:true to record anyway.`,
        );
      }
      const known = assignment?.variants.map((v) => v.version) ?? null;
      if (known !== null && !known.includes(input.version) && input.allowUnknownVersion !== true) {
        return refusal(
          tool,
          "bad-input",
          `"${renderPath(input.version)}" is not one of the assignment's variants (${known.map((v) => `"${renderPath(v)}"`).join(", ")}). A mistyped version becomes a phantom variant that every later tally reports as a third arm; pass allowUnknownVersion:true if the version really is outside the split.`,
        );
      }
      const record: ExperimentOutcomeRecord = {
        ts: new Date().toISOString(),
        experiment: input.name,
        version: input.version,
        outcome: input.outcome,
        ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
        ...(input.score !== undefined ? { score: input.score } : {}),
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      };
      // `appendExperimentOutcomes` groups by `record.experiment`, so it can
      // write several ledgers from one batch. Every file it would touch is
      // contained under its SANITIZED name before anything is appended.
      const targets = ledgerTargets([record]);
      if (!targets.ok) return refusal(tool, targets.code, targets.reason);
      const targetEscape = containWritePaths(
        tool,
        expDir.value,
        targets.value.map((n) => `${n}.jsonl`),
      );
      if (targetEscape !== undefined) return refusal(tool, targetEscape.code, targetEscape.reason);
      if (dryRun) {
        return json({
          tool,
          status: "preview",
          action: "record",
          experiment: input.name,
          file: ledgerPath,
          wouldAppend: record,
          assignmentKnown: known !== null,
          changed: false,
          note: "nothing was appended. Re-run with dryRun:false to record the outcome.",
        });
      }
      const bytesBefore = byteSize(ledgerPath);
      try {
        appendExperimentOutcomes([record], expDir.value.real);
      } catch (err) {
        return refusal(tool, "unreadable", `the ledger could not be appended to: ${message(err)}`, {
          file: ledgerPath,
        });
      }
      return json({
        tool,
        status: "ok",
        action: "record",
        experiment: input.name,
        file: ledgerPath,
        changed: true,
        appended: record,
        bytesBefore,
        bytesAfter: byteSize(ledgerPath),
        assignmentKnown: known !== null,
        manifest,
        note:
          input.score === undefined
            ? "recorded. This observation carries no `score`, so it counts toward the success rate but not toward the rank test that compares versions."
            : "recorded.",
      });
    }

    // tally
    const ledgerFile = probeFile(ledgerPath);
    if (ledgerFile.state !== "absent") {
      const check = readable(ledgerPath);
      if (!check.ok) {
        return refusal(
          tool,
          "unreadable",
          `the ledger at "${renderPath(ledgerPath)}" could not be read: ${check.why}. readExperimentOutcomes tolerates a read failure by returning no records, which would report this experiment as never measured.`,
          { file: ledgerPath },
        );
      }
    }
    const bytes = byteSize(ledgerPath);
    if (bytes === null || ledgerFile.state === "absent") {
      return json({
        tool,
        status: "ok",
        action: "tally",
        experiment: input.name,
        file: ledgerPath,
        exists: false,
        records: 0,
        variants: [],
        verdict: {
          verdict: "not-comparable",
          winner: null,
          reason: "there is no ledger file for this experiment — no outcome has ever been recorded",
          comparisons: [],
        },
        note: `an absent ledger is not a tie. ${SERVING_BOUNDARY_NOTE}`,
      });
    }
    if (bytes > MAX_LEDGER_BYTES) {
      return refusal(
        tool,
        "bad-input",
        `"${renderPath(ledgerPath)}" is ${bytes} bytes, past this tool's ${MAX_LEDGER_BYTES}-byte ceiling for a single fold`,
      );
    }
    const records = readExperimentOutcomes(input.name, expDir.value.real);
    const view = foldLedger(input.name, ledgerPath, records);
    return json({
      tool,
      status: "ok",
      action: "tally",
      experiment: view.experiment,
      file: view.file,
      exists: true,
      records: view.records,
      collapsedRepeats: view.collapsedRepeats,
      dedupeNote: view.dedupeNote,
      manifest,
      assignment:
        assignment === undefined
          ? null
          : {
              variants: assignment.variants,
              updatedAt: assignment.updatedAt,
              split: splitStatus(assignment),
            },
      variants: sample(view.variants, limit),
      verdict: {
        ...view.verdict,
        comparisons: sample(view.verdict.comparisons, limit),
      },
      note: `every rate above is a Wilson interval, not a bare proportion: ${view.variants.length} version(s) folded. ${SERVING_BOUNDARY_NOTE}`,
    });
  },
});

// ---------------------------------------------------------------------------
// FlywheelStatus
// ---------------------------------------------------------------------------

export const flywheelStatus: RegisteredTool = buildTool({
  name: "FlywheelStatus",
  description:
    "Report what a harness's self-improvement loop has left on disk: the scaffolded CI workflows, the per-run artifact directories under .crewhaus/flywheel, and which dataset rungs the loop would resolve if it ran with no --dataset. It deliberately does NOT name 'the source the last run used': the top precedence rung is the --dataset FLAG, which is an argument and not a file, so no reader of a directory can know whether it was passed. It reports the rungs that are observable, flags the case where a conventional eval/dataset.jsonl would shadow distilled user ratings, and names apps/cli's resolveFlywheelData as the owner of the rule rather than carrying a second copy of it. Three facts it cannot obtain are reported as unknown with the package that holds them: whether a ratings dataset is registered, whether the optimizer's write-back landed in the spec, and the acceptance verdict inside a run's eval artifacts. Read-only.",
  inputSchema: z.object({
    dir: dirField,
    specName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "the spec's registered name, used only to name `registry:<name>-ratings`. Omitted: the ratings reference is reported as unnameable rather than guessed from the directory.",
      ),
    specDir: z
      .string()
      .optional()
      .describe(
        `the directory the spec lives in — the base for ${CONVENTIONAL_DATASET} and ${CONVENTIONAL_GRADERS} (default: <dir>)`,
      ),
    limit: limitField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const tool = "FlywheelStatus";
    const limit = input.limit ?? DEFAULT_LIMIT;
    const dirRel = input.dir ?? ".";
    const harness = containExistingDir(tool, dirRel);
    if (!harness.ok) return refusal(tool, harness.code, harness.reason);
    const stateRel = path.join(dirRel, STATE_RELDIR);
    const state = contain(tool, stateRel);
    if (!state.ok) return refusal(tool, state.code, state.reason);
    const flywheelEscape = containWritePaths(tool, state.value, [
      FLYWHEEL_RELDIR,
      `${FLYWHEEL_RELDIR}/state.json`,
    ]);
    if (flywheelEscape !== undefined) {
      return refusal(tool, flywheelEscape.code, flywheelEscape.reason);
    }
    const workflowsRel = path.join(dirRel, WORKFLOWS_RELDIR);
    const workflows = contain(tool, workflowsRel);
    if (!workflows.ok) return refusal(tool, workflows.code, workflows.reason);
    const specDirRel = input.specDir ?? dirRel;
    const specDir = contain(tool, specDirRel);
    if (!specDir.ok) return refusal(tool, specDir.code, specDir.reason);
    // The conventional data files are leaves under the spec directory, and a
    // symlink at either sends the probe somewhere else entirely.
    const dataEscape = containWritePaths(tool, specDir.value, [
      CONVENTIONAL_DATASET,
      CONVENTIONAL_GRADERS,
    ]);
    if (dataEscape !== undefined) return refusal(tool, dataEscape.code, dataEscape.reason);

    const flywheelDir = path.join(state.value.real, FLYWHEEL_RELDIR);
    // Every run directory and stage path the readdir hands back goes through
    // the SAME containment the state directory did. Containing `flywheel/`
    // and then stat'ing whatever is inside it contains nothing.
    const containedUnderState = (rel: string): boolean =>
      containWritePaths(tool, state.value, [rel]) === undefined;
    const runs = listRuns(flywheelDir, containedUnderState);
    if (!runs.ok) return refusal(tool, runs.code, runs.reason);
    const workflowEntries = listDir(workflows.value.real);
    if (!workflowEntries.ok) {
      return refusal(tool, workflowEntries.code, workflowEntries.reason);
    }
    const workflowRows = workflowEntries.value.map((name) => ({
      name,
      // A file whose name is not one the scaffolders write is still listed —
      // a renamed or hand-written workflow is not an absent one.
      scaffoldedBy: KNOWN_WORKFLOWS[name] ?? null,
    }));
    const scaffolded = workflowRows.filter((w) => w.scaffoldedBy !== null);

    return json({
      tool,
      status: "ok",
      dir: dirRel,
      flywheelDir: { path: path.join(stateRel, FLYWHEEL_RELDIR), ...probeDir(flywheelDir) },
      runs: sample(
        runs.value.runs.map((r) => ({ ...r, mtime: iso(r.mtimeMs) })),
        limit,
      ),
      uncontainedRuns: runs.value.uncontained,
      workflows: {
        dir: workflowsRel,
        entries: sample(workflowRows, limit),
        scaffoldedCount: scaffolded.length,
      },
      stateJson: {
        ...probeFile(path.join(flywheelDir, "state.json")),
        note: STATE_JSON_NOTE,
      },
      datasetPrecedence:
        input.specName === undefined
          ? {
              conventionalDataset: probeFile(
                path.join(specDir.value.real, "eval", "dataset.jsonl"),
              ),
              conventionalGraders: probeFile(path.join(specDir.value.real, "eval", "graders.yaml")),
              ratingsRef: null,
              reason:
                "no specName was given, so `registry:<specName>-ratings` cannot be named. This tool does not parse the spec to find out — that needs @crewhaus/spec.",
            }
          : datasetPrecedence(specDir.value.real, input.specName),
      unavailable: [WRITE_BACK_HEADER_UNAVAILABLE, RUN_VERDICT_UNAVAILABLE],
      note:
        runs.value.runs.length === 0
          ? "no run directories under .crewhaus/flywheel. That is what 'the loop has never run here' looks like; an absent state.json is not."
          : `${runs.value.runs.length} run director(ies) on disk. Each holds the eval artifacts for its own before/after comparison; this tool reports which stages are present and does not open them.`,
    });
  },
});

// ---------------------------------------------------------------------------
// WatchmeReport
// ---------------------------------------------------------------------------

export const watchmeReport: RegisteredTool = buildTool({
  name: "WatchmeReport",
  description:
    "Read a harness's observational-learning ledger: whether it is watching, the per-window report outcomes, the per-spec/target quality and cost roll-up, the judge verdicts, and how much of that quality has actually reached the routing scoreboard's observe-only `q:` lane. Report-window outcomes are kept apart — `model_refused_unpriced` is a configuration error that consumed its window, `model_failed` is transient and retries, and collapsing them into one failure state hides the first as the second. A state.json that exists but cannot be parsed is reported as unreadable, never as a harness that has never watched: the store falls back to its default there, which reads as the opposite of the truth. The routing half degrades explicitly — an absent or unreadable scoreboard is reported as such, never as 'no quality signal'. Every rate carries a Wilson interval. Read-only: it never runs the phase-2 judge, never synthesizes, and never feeds routing.",
  inputSchema: z.object({
    dir: dirField,
    specName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "the spec name the store uses in its window keys (default: the harness directory's own name, as the store itself defaults)",
      ),
    includeRouting: z
      .boolean()
      .optional()
      .describe(
        "also open the routing scoreboard and report the observe-only quality lane (default true)",
      ),
    limit: limitField,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const tool = "WatchmeReport";
    const limit = input.limit ?? DEFAULT_LIMIT;
    const includeRouting = input.includeRouting ?? true;
    // Only the watchme paths are a HARD requirement. The routing half is an
    // add-on: a scoreboard that cannot be contained or cannot be read makes
    // the routing field say so, and leaves the ledger report standing.
    const rooted = rootState(tool, input.dir ?? ".", WATCHME_READ_RELPATHS);
    if (!rooted.ok) return refusal(tool, rooted.code, rooted.reason);
    const { stateRoot, stateRel } = rooted.value;

    const observationsPath = path.join(stateRoot, "watchme", "observations.jsonl");
    const observationBytes = byteSize(observationsPath);
    if (observationBytes !== null && observationBytes > MAX_WATCHME_BYTES) {
      return refusal(
        tool,
        "bad-input",
        `"${renderPath(observationsPath)}" is ${observationBytes} bytes, past this tool's ${MAX_WATCHME_BYTES}-byte ceiling. The store reads the whole file into memory to fold it; run \`crewhaus watchme report\` (which compacts) rather than folding this here.`,
      );
    }
    const read = readWatchme(stateRoot, input.specName);
    if (!read.ok) return refusal(tool, read.code, read.reason);
    const { observations, aggregates, judgments, state, stateProbe, dir } = read.value;
    // The store SKIPS a line it cannot parse. A report that never mentions
    // that describes a small healthy ledger where there is a damaged one.
    const observationLines = countLines(observationsPath, MAX_WATCHME_BYTES);
    const judgmentLines = countLines(
      path.join(stateRoot, "watchme", "judgments.jsonl"),
      MAX_WATCHME_BYTES,
    );

    // Turn identity is the PARSED (sessionId, turnNumber) pair. A staged turn
    // is fed as `sessionId#turnNumber#stage`, so comparing the spelling
    // `sessionId#turnNumber` would report every hybrid turn as un-fed.
    //
    // `state` is whatever JSON `state.json` held: the store checks
    // `schemaVersion` and casts. `fedRoutingKeys` is TYPED as a string array
    // and a hand-edited number there used to reach `for (const key of …)` and
    // throw "number is not iterable" out of `execute`. The entries are taken
    // as strings, and what is not one is counted rather than crashing.
    const fedKeys = fedRoutingKeyStrings(state.fedRoutingKeys);
    const fedTurns = new Set<string>();
    let unparsedFedKeys = fedKeys.unusable;
    for (const key of fedKeys.keys) {
      const parsed = parseFedKey(key);
      if (parsed === undefined) unparsedFedKeys += 1;
      else fedTurns.add(turnId(parsed.sessionId, parsed.turnNumber));
    }
    const judgedTurns = new Set(judgments.map((j) => turnId(j.sessionId, j.turnNumber)));
    const pendingFeed = [...judgedTurns].filter((id) => !fedTurns.has(id)).length;

    const routing = includeRouting
      ? (() => {
          const contained = containWritePaths(tool, rooted.value.state, ROUTING_READ_RELPATHS);
          if (contained !== undefined) {
            return { read: false as const, reason: contained.reason };
          }
          const arms = loadArms(stateRoot);
          if (!arms.ok) {
            // "Could not read" is a different answer from "no quality
            // signal", and it is the answer that must not silently become an
            // empty table.
            return { read: false as const, reason: arms.reason };
          }
          const qualityArms = armViews(arms.value).filter((a) => a.lane === "quality");
          const sides = shadowSides(stateRoot);
          return {
            read: true as const,
            file: path.join(stateRoot, "routing", "arms.jsonl"),
            storeExists: existsSync(path.join(stateRoot, "routing", "arms.jsonl")),
            qualityLanePrefix: QUALITY_LANE_PREFIX,
            qualityArms: sample(qualityArms, limit),
            shadowLaneArms: {
              shadow: [...sides.shadow].sort(compareStrings),
              primary: [...sides.primary].sort(compareStrings),
              ...(sides.unreadable !== undefined ? { unreadable: sides.unreadable } : {}),
            },
            note: "these arms were written by `watchme report --feed-routing`. They are observe-only: the runtime router never mints or reads the `q:` namespace, so nothing here steers a live decision until a promotion folds it.",
          };
        })()
      : {
          read: false as const,
          reason: "includeRouting was false, so the scoreboard was not opened",
        };

    return json({
      tool,
      status: "ok",
      dir: stateRel,
      store: dir,
      state: {
        probe: stateProbe,
        // The values are the store's; the probe above says whether they can
        // be trusted. A torn state.json reads as `watching: false` through
        // the store, and that is not a claim this tool will make silently.
        //
        // Every read here is TOTAL, because none of these fields was
        // validated by anything: `instant()` renders a timestamp or says it
        // is not one (`new Date(1e20).toISOString()` throws), and
        // `observedSessions` is null rather than a count invented by
        // `Object.keys` over a string.
        watching: state.watching,
        startedAt: instant(state.startedAt),
        lastReportAt: instant(state.lastReportAt),
        watermark: state.watermark,
        observedSessions: isPlainObject(state.observed)
          ? Object.keys(state.observed).length
          : state.observed === undefined
            ? 0
            : null,
      },
      windows: tallyWindows(state.windows),
      observations: {
        rawSessions: observations.length,
        aggregateLines: aggregates.length,
        // Lines on disk, and how many of them are not JSON at all. A gap
        // between `lines` and what was folded is either the store's
        // last-writer-wins dedupe by sessionId or damage; `unparseable` says
        // which, instead of leaving a reader to assume the first.
        file: observationLines ?? null,
        note: "raw lines are deduplicated by sessionId (last digest wins) by the store, so a re-analyzed session counts once. `compact()` folds raw lines into aggregates, so a store normally holds some of each and both are reported.",
        fromRaw: sample(rollupObservations(observations), limit),
        fromAggregates: sample(rollupAggregates(aggregates), limit),
      },
      judgments: {
        count: judgments.length,
        file: judgmentLines ?? null,
        turns: judgedTurns.size,
        fedTurns: fedTurns.size,
        pendingFeedTurns: pendingFeed,
        unparsedFedKeys,
        ...(fedKeys.note !== undefined ? { fedRoutingKeys: fedKeys.note } : {}),
        note: "`fedTurns` is the durable dedup set `report --feed-routing` keeps, parsed back into (sessionId, turnNumber) pairs — a hybrid turn is fed once per stage, so its keys carry a third field. `pendingFeedTurns` counts judged turns no feed pass has recorded as arms yet.",
      },
      unavailable: [WATCHME_MODEL_SURFACE_UNAVAILABLE],
      routing,
    });
  },
});

export const TOOLS: ReadonlyArray<RegisteredTool> = [
  routeControl,
  experimentLedger,
  flywheelStatus,
  watchmeReport,
];
