/**
 * Run outcomes: the harness's run ledger, folded line by line into each run's newest row
 * (with the session its first row named), and the failure messages its sessions logged,
 * clustered so runs that failed the same way within one harness are one group.
 *
 * A failed run is grouped by its cause (`causeOf`). A group clears when a run of that
 * harness succeeded after every failure in it. Rate-limit failures group only while they
 * come within an hour of each other. When a harness fails on a newer spec the same way,
 * the older spec's group is superseded by the newer one.
 *
 * Failure messages are read from the contained session root, the newest part of the logs
 * of the sessions whose runs failed with no structured cause, at most 200 failures. When
 * they cannot be read the runs group by class alone, and the item says so.
 */
import { SESSION_ID_RE, isId } from "@crewhaus/control-contract";
import { NON_FAILURE_CLASSES, clusterFailures } from "@crewhaus/harness-advice/failure-clusters";
import { containedSessionRoot } from "@crewhaus/session-store";
import { type CauseFacts, causeOf } from "../causes";
import { digestPrefix } from "../ids";
import { msOf } from "../items";
import { type AttentionReader, SESSION_CAPS } from "../read";
import {
  type AttentionModel,
  type FailureSignature,
  type GroupDraft,
  type GroupRun,
  type HarnessFacts,
  RUNS_KEPT,
  type RunFact,
} from "../types";

/** At most this many failure messages are clustered per harness. */
export const FAILURES_MAX = 200;

/** Rate-limit failures this close together are one episode. */
export const PROVIDER_LIMIT_WINDOW_MS = 3_600_000;

/** The failure classes whose runs group by a structured cause, never by message. */
const STRUCTURED = new Set(["auth", "billing", "rate_limit", "crewhaus_budget", "spec"]);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Fold one run-ledger line: the newest row wins, and the first session named is kept. */
export function foldRunLine(
  state: AttentionModel,
  record: Readonly<Record<string, unknown>>,
): AttentionModel {
  const id = str(record["id"]);
  const runState = str(record["state"]);
  const at = str(record["at"]);
  if (id === undefined || runState === undefined || at === undefined) return state;
  const before = state.runs[id];
  const session = str(record["session"]) ?? before?.session;
  const deployment = str(record["deployment"]) ?? str(record["deploymentId"]) ?? before?.deployment;
  const specHash = str(record["specHash"]) ?? before?.specHash;
  const next: RunFact = {
    id,
    state: runState,
    at,
    ...(str(record["failureClass"]) !== undefined
      ? { failureClass: record["failureClass"] as string }
      : {}),
    ...(session !== undefined && SESSION_ID_RE.test(session) ? { session } : {}),
    ...(deployment !== undefined && isId("dep", deployment) ? { deployment } : {}),
    ...(specHash !== undefined ? { specHash } : {}),
  };
  if (before === undefined) {
    const ids = Object.keys(state.runs);
    if (ids.length >= RUNS_KEPT) {
      Reflect.deleteProperty(state.runs, ids[0] as string);
      state.runsTruncated = true;
    }
  }
  state.runs[id] = next;
  return state;
}

/** The sessions whose failed runs carry no structured cause: their messages group them. */
function messageSessions(model: AttentionModel): string[] {
  const out = new Set<string>();
  for (const row of Object.values(model.runs)) {
    if (row.state !== "failed" || row.session === undefined) continue;
    if (STRUCTURED.has(row.failureClass ?? "unknown")) continue;
    out.add(row.session);
  }
  return [...out].sort();
}

/**
 * The failure-message section: re-read only when the set of sessions or one of their
 * logs changed; `prev` itself when nothing did.
 */
export function readFailuresSection(
  dir: string,
  model: AttentionModel,
  facts: HarnessFacts,
  reader: AttentionReader,
  prev: AttentionModel["failures"] | undefined,
): AttentionModel["failures"] {
  const sessions = messageSessions(model);
  if (sessions.length === 0) {
    if (prev !== undefined && prev.stamp === "none") return prev;
    return { stamp: "none", facts: [] };
  }
  const root = containedSessionRoot(dir, facts.envVars(dir));
  if (root === undefined) {
    if (prev?.unreadable === true && prev.stamp === "unreachable") return prev;
    return { stamp: "unreachable", facts: [], unreadable: true };
  }
  const stamp = digestPrefix(
    [root, ...sessions.map((s) => `${s}=${reader.stamp(root, `${s}.jsonl`)}`)].join("\n"),
    32,
  );
  if (prev !== undefined && prev.stamp === stamp) return prev;
  const records: {
    source: "run_failed";
    class: string;
    message: string;
    sessionId: string;
    ts?: number;
  }[] = [];
  let unreadable = false;
  for (const session of sessions) {
    const read = reader.tail(root, `${session}.jsonl`, SESSION_CAPS);
    if (read.state === "refused") unreadable = true;
    if (read.state !== "read") continue;
    for (const event of read.records) {
      if (event["kind"] !== "run_failed") continue;
      const payload = (
        typeof event["payload"] === "object" && event["payload"] !== null ? event["payload"] : {}
      ) as Record<string, unknown>;
      const cls = str(payload["class"]) ?? "unknown";
      if (NON_FAILURE_CLASSES.has(cls)) continue;
      records.push({
        source: "run_failed",
        class: cls,
        message: typeof payload["message"] === "string" ? payload["message"] : "",
        sessionId: session,
        ...(typeof event["ts"] === "number" ? { ts: event["ts"] } : {}),
      });
    }
  }
  const newest = records.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, FAILURES_MAX);
  const signatures: FailureSignature[] = [];
  for (const cluster of clusterFailures(newest)) {
    const signature = digestPrefix(`${cluster.class}\n${cluster.example}`, 12);
    for (const session of cluster.sessions) {
      signatures.push({ session, failureClass: cluster.class, signature });
    }
  }
  return {
    stamp,
    facts: signatures,
    ...(records.length > FAILURES_MAX ? { truncated: true as const } : {}),
    ...(unreadable ? { unreadable: true as const } : {}),
  };
}

/** The signatures of a model, by `<session>|<class>`; the first cluster wins. */
export function signaturesOf(model: AttentionModel): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const fact of model.failures.facts) {
    const key = `${fact.session}|${fact.failureClass}`;
    if (!out.has(key)) out.set(key, fact.signature);
  }
  return out;
}

const UNCLUSTERED_NOTE =
  "These runs are grouped by how they failed; their messages could not be read.";

/** The failure groups of one harness, before groups of several harnesses are merged. */
export function runGroups(model: AttentionModel, facts: CauseFacts): GroupDraft[] {
  const rows = Object.values(model.runs);
  let newestSuccess: number | undefined;
  for (const row of rows) {
    if (row.state !== "succeeded") continue;
    const at = msOf(row.at);
    if (at !== undefined && (newestSuccess === undefined || at > newestSuccess)) newestSuccess = at;
  }
  const byCause = new Map<string, { cause: ReturnType<typeof causeOf>; runs: GroupRun[] }>();
  for (const row of rows) {
    if (row.state !== "failed") continue;
    const cause = causeOf(row, facts);
    const group = byCause.get(cause.id) ?? { cause, runs: [] };
    group.runs.push({ id: row.id, at: row.at, harness: facts.harness });
    byCause.set(cause.id, group);
  }
  const out: GroupDraft[] = [];
  const specGroups: GroupDraft[] = [];
  for (const { cause, runs } of byCause.values()) {
    let kept = [...runs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (cause.kind === "provider-limit") kept = newestEpisode(kept);
    const newest = msOf(kept[0]?.at);
    const after = kept.filter(
      (run) => newestSuccess === undefined || (msOf(run.at) ?? 0) > newestSuccess,
    );
    const cleared = after.length === 0 && newestSuccess !== undefined && newest !== undefined;
    const draft: GroupDraft = {
      kind: cause.itemKind,
      cause: { id: cause.id, kind: cause.kind, label: cause.label },
      params: cause.params,
      titleTemplate: cause.titleTemplate,
      runs: cleared ? kept : after,
      ...(cleared ? { clearedAt: new Date(newestSuccess as number).toISOString() } : {}),
      ...(model.failures.unreadable === true &&
      (cause.kind === "failure-class" || cause.kind === "message")
        ? { note: UNCLUSTERED_NOTE }
        : {}),
    };
    if (cause.kind === "spec") specGroups.push(draft);
    else out.push(draft);
  }
  // A newer spec failing the same way replaces the older spec's group.
  const bySpecAge = [...specGroups].sort((a, b) =>
    (a.runs[0]?.at ?? "") < (b.runs[0]?.at ?? "") ? 1 : -1,
  );
  for (const [index, draft] of bySpecAge.entries()) {
    const older = bySpecAge[index + 1];
    out.push({
      ...draft,
      ...(index > 0 ? { superseded: true as const } : {}),
      ...(older !== undefined ? { previousKey: older.cause.id } : {}),
    });
  }
  return out;
}

/** The newest run of a list and every run that comes within the window of the next newer one. */
export function newestEpisode(runs: readonly GroupRun[]): GroupRun[] {
  const sorted = [...runs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out: GroupRun[] = [];
  let last: number | undefined;
  for (const run of sorted) {
    const at = msOf(run.at) ?? 0;
    if (last !== undefined && last - at > PROVIDER_LIMIT_WINDOW_MS) break;
    out.push(run);
    last = at;
  }
  return out;
}
