/**
 * The first thing a head shows: what started the run and its status in a word, what
 * was asked, what happened (a fixed template over counts and checks, never
 * model-written), the outcome, cost, duration, revisions, the runs around it, and what
 * is missing.
 */
import { effectiveRunState } from "@crewhaus/control-contract";
import { spanDuration } from "./fold-spans";
import type { LoadedRun } from "./load";
import {
  type InspectGapReason,
  type InspectSummary,
  type Provenance,
  type RelatedRun,
  type StatusView,
  UNKNOWN_STATUS_WORD,
  notRecorded,
  reconstructed,
  recorded,
  statusWord,
} from "./model";
import {
  type RunIndex,
  attributed,
  code,
  executionOf,
  indexRun,
  isTurnStart,
  laterOutcomes,
  payloadOf,
  rec,
  revisionsOf,
  runCost,
  str,
  textOf,
  times,
  triggerOf,
  wakeOf,
} from "./records";

const SPAN_STATUS_STATE: Readonly<Record<string, string>> = Object.freeze({
  ok: "succeeded",
  error: "failed",
  aborted: "cancelled",
  parked: "waiting-for-approval",
  denied: "failed",
});

function statusOf(index: RunIndex): Provenance<StatusView> {
  const { loaded } = index;
  const newest = loaded.rows.at(-1);
  if (newest !== undefined && typeof newest["state"] === "string") {
    // A run waiting on an approval the decision log says expired has failed: the
    // control contract's reader decides that from the record's `expiredAt`.
    const waitsOn = loaded.rows
      .map((row) => row["decision"])
      .filter((id): id is string => typeof id === "string")
      .at(-1);
    const expiry =
      waitsOn !== undefined
        ? loaded.decisions.find(
            (entry) =>
              entry.line.decision === waitsOn &&
              entry.line.event === "expire" &&
              entry.line.sessionId === loaded.session &&
              (entry.line.runId === undefined || entry.line.runId === loaded.run),
          )
        : undefined;
    const effective = effectiveRunState(
      {
        state: newest["state"],
        ...(typeof newest["failureClass"] === "string"
          ? { failureClass: newest["failureClass"] }
          : {}),
        ...(typeof newest["continuedIn"] === "string"
          ? { continuedIn: newest["continuedIn"] }
          : {}),
      },
      {
        now: loaded.now,
        ...(loaded.continuation !== undefined ? { continuation: loaded.continuation } : {}),
        ...(waitsOn !== undefined && expiry !== undefined
          ? {
              decision: {
                id: waitsOn,
                createdAt: expiry.line.at,
                expiredAt: expiry.line.at,
              },
            }
          : {}),
      },
    );
    return recorded(
      {
        state: effective.state,
        word: statusWord(effective.state),
        ...(effective.failureClass !== undefined
          ? { failureClass: code(effective.failureClass) }
          : {}),
        ...(effective.continuedIn !== undefined
          ? { continuedIn: code(effective.continuedIn) }
          : {}),
      },
      expiry !== undefined && effective.computed ? [expiry.id] : [],
    );
  }
  const root = index.rootSpan !== undefined ? index.spans.get(index.rootSpan) : undefined;
  const failed = [...index.lines].reverse().find((line) => line.kind === "run_failed");
  const failureClass = failed !== undefined ? code(payloadOf(failed)["class"]) : root?.failureClass;
  const state =
    root?.status !== undefined
      ? SPAN_STATUS_STATE[root.status]
      : failed !== undefined
        ? "failed"
        : undefined;
  if (state === undefined) {
    return {
      ...notRecorded<StatusView>({ reason: "not-recorded" }),
      value: { state: "unknown", word: UNKNOWN_STATUS_WORD },
    };
  }
  return reconstructed(
    {
      state,
      word: statusWord(state),
      ...(failureClass !== undefined ? { failureClass } : {}),
    },
    "status-from-session-log",
    [...(root !== undefined ? [root.lineId] : []), ...(failed !== undefined ? [failed.id] : [])],
  );
}

/** "Called Read twice and Write. Asked for approval once; it expired." */
function happenedOf(index: RunIndex): string {
  const parts: string[] = [];
  const counts = new Map<string, number>();
  for (const tool of index.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  if (counts.size > 0) {
    const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ${times(n)}` : name));
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    parts.push(`Called ${list}.`);
  }
  const refused = index.verdicts.filter((v) =>
    ["deny", "block", "ask:denied", "refused", "abort"].includes(v.outcome),
  ).length;
  if (refused > 0) parts.push(`A check stopped a call ${times(refused)}.`);
  const parked = index.verdicts.filter((v) => v.gate === "approval" && v.outcome === "parked");
  if (parked.length > 0) {
    const later = parked.flatMap((verdict) =>
      laterOutcomes(index.loaded.decisions, index.loaded.session, verdict).map((l) => l.outcome),
    );
    const ended = later.filter((o) => o === "expired" || o === "superseded");
    const decided = later.filter((o) => o === "granted" || o === "denied");
    parts.push(
      `Asked for approval ${times(parked.length)}${
        ended.length > 0
          ? `; ${ended.length === 1 ? "it" : `${ended.length} of them`} ${ended.length === 1 ? ended[0] : "ended"} later`
          : decided.length > 0
            ? `; ${decided.length === 1 ? `it was ${decided[0]}` : `${decided.length} were decided`} later`
            : ""
      }.`,
    );
  }
  const consumed = index.verdicts.filter((v) => v.gate === "approval" && v.outcome === "consumed");
  if (consumed.length > 0) parts.push(`Used an approval ${times(consumed.length)}.`);
  const compactions = index.lines.filter((line) => line.kind === "compaction").length;
  if (compactions > 0) parts.push(`Compacted the conversation ${times(compactions)}.`);
  const helpers = index.lines.filter((line) => line.kind === "sub_agent_start").length;
  if (helpers > 0) parts.push(`Ran a helper ${times(helpers)}.`);
  const answers = index.lines.filter(
    (line) => line.kind === "assistant_message" && textOf(payloadOf(line)["content"]) !== undefined,
  ).length;
  if (answers > 0 && parts.length === 0) parts.push("Answered.");
  const failed = [...index.lines].reverse().find((line) => line.kind === "run_failed");
  if (failed !== undefined) parts.push(`It stopped: ${code(payloadOf(failed)["class"])}.`);
  return parts.length > 0 ? parts.join(" ") : "Nothing was recorded for this run.";
}

function childrenOf(index: RunIndex): RelatedRun[] {
  const run = index.loaded.run;
  if (run === undefined) return [];
  const out: RelatedRun[] = [];
  const seen = new Set<string>();
  for (const line of index.loaded.lines) {
    if (line.kind !== "run_stamp") continue;
    const p = payloadOf(line);
    const child = str(p["run"]);
    if (child === undefined || child === run || p["parent"] !== run || seen.has(child)) continue;
    seen.add(child);
    out.push({ run: code(child), session: index.loaded.session, via: "stamp" });
  }
  for (const line of index.lines) {
    if (line.kind !== "sub_agent_start") continue;
    const p = payloadOf(line);
    const child = str(p["childRunId"]);
    if (child === undefined || seen.has(child)) continue;
    seen.add(child);
    out.push({
      run: code(child),
      ...(str(p["childSessionId"]) !== undefined ? { session: code(p["childSessionId"]) } : {}),
      via: "helper",
      ...(str(p["name"]) !== undefined ? { name: code(p["name"]) } : {}),
    });
  }
  return out;
}

/** The summary of an indexed run. */
export function summaryOf(index: RunIndex): InspectSummary {
  const { loaded, attribution } = index;
  const trigger = triggerOf(index);
  const wake = wakeOf(index);
  const askedLine = index.lines.find(isTurnStart);
  const asked = askedLine !== undefined ? textOf(payloadOf(askedLine)["content"]) : undefined;
  const answer = [...index.lines]
    .reverse()
    .find(
      (line) =>
        line.kind === "assistant_message" && textOf(payloadOf(line)["content"]) !== undefined,
    );
  const outcome = answer !== undefined ? textOf(payloadOf(answer)["content"]) : undefined;
  const root = index.rootSpan !== undefined ? index.spans.get(index.rootSpan) : undefined;
  const stamp = index.stamp?.payload;
  const parent = str(stamp?.["parent"]) ?? str(loaded.rows[0]?.["parent"]);
  const continues = str(stamp?.["continues"]) ?? str(loaded.rows[0]?.["continues"]);
  const execution = executionOf(index);
  const gapCounts: Partial<Record<InspectGapReason, number>> = {};
  for (const gap of index.gaps)
    gapCounts[gap.reason] = (gapCounts[gap.reason] ?? 0) + (gap.count ?? 1);
  const stamps = new Map<string, Readonly<Record<string, unknown>>>();
  for (const line of loaded.lines) {
    if (line.kind === "run_stamp") {
      const p = payloadOf(line);
      const run = str(p["run"]);
      if (run !== undefined) stamps.set(run, p);
    }
  }
  return {
    subject: loaded.subject,
    title: trigger.value?.words ?? "A run",
    status: statusOf(index),
    trigger,
    ...(wake !== undefined ? { wake } : {}),
    asked:
      asked !== undefined && askedLine !== undefined
        ? attributed(attribution, asked, [askedLine.id])
        : notRecorded(),
    happened:
      index.lines.length > 0
        ? attributed(attribution, happenedOf(index), [])
        : notRecorded({
            reason: loaded.gaps.some((gap) => gap.reason === "evicted")
              ? "evicted"
              : "not-recorded",
          }),
    outcome:
      outcome !== undefined && answer !== undefined
        ? attributed(attribution, outcome, [answer.id])
        : notRecorded(),
    cost: runCost(index),
    durationMs:
      root !== undefined
        ? spanDuration(index, root)
        : notRecorded(
            index.rootSpan !== undefined ? { reason: "unfinished" } : { reason: "not-recorded" },
          ),
    ...(root?.startedAt !== undefined ? { startedAt: root.startedAt } : {}),
    revisions: revisionsOf(index),
    ...(parent !== undefined ? { parent: code(parent) } : {}),
    ...(continues !== undefined ? { continues: code(continues) } : {}),
    children: childrenOf(index),
    execution:
      execution !== undefined
        ? recorded({ id: execution }, index.stamp !== undefined ? [index.stamp.line.id] : [])
        : notRecorded({ reason: "not-supervised", remedy: "crewhaus daemon start" }),
    ...(loaded.sessionRuns.length > 0
      ? {
          runs: loaded.sessionRuns.map((run) => {
            const p = stamps.get(run);
            const kind = rec(p?.["trigger"])?.["kind"];
            const runParent = str(p?.["parent"]);
            return {
              run: code(run),
              ...(typeof kind === "string" ? { trigger: code(kind) } : {}),
              ...(runParent !== undefined ? { parent: code(runParent) } : {}),
              chosen: run === loaded.run,
            };
          }),
        }
      : {}),
    gaps: index.gaps,
    gapCounts,
  };
}

/** The summary of a loaded run. */
export function foldSummary(loaded: LoadedRun): InspectSummary {
  return summaryOf(indexRun(loaded));
}
