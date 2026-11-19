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
 * of the sessions whose runs failed with no structured cause: the sessions of the newest
 * such runs only, at most {@link FAILURE_SESSIONS_MAX} of them and
 * {@link FAILURE_READ_BYTES} in all, each file once however many names reach it, and at
 * most 200 failures clustered. Past a cap the section says `truncated`. When they cannot
 * be read the runs group by class alone, and the item says so.
 */
import { SESSION_ID_RE, isId } from "@crewhaus/control-contract";
import { NON_FAILURE_CLASSES, clusterFailures } from "@crewhaus/harness-advice/failure-clusters";
import { containedSessionRoot } from "@crewhaus/session-store";
import { type CauseFacts, causeOf } from "../causes";
import { digestPrefix } from "../ids";
import { msOf } from "../items";
import { type AttentionReader, READ_CAPS, SESSION_CAPS } from "../read";
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

/** At most this many session logs are read for failure messages per harness, newest first. */
export const FAILURE_SESSIONS_MAX = 50;

/** At most this many bytes of session logs are read for failure messages per harness. */
export const FAILURE_READ_BYTES = READ_CAPS.maxBytes;

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

/**
 * The sessions whose failed runs carry no structured cause, the newest runs' first, at
 * most {@link FAILURE_SESSIONS_MAX}: their messages group them. `capped` when more were
 * left out.
 */
function messageSessions(model: AttentionModel): { sessions: string[]; capped: boolean } {
  const rows = Object.values(model.runs)
    .filter(
      (row) =>
        row.state === "failed" &&
        row.session !== undefined &&
        !STRUCTURED.has(row.failureClass ?? "unknown"),
    )
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
  const out = new Set<string>();
  let capped = false;
  for (const row of rows) {
    if (out.has(row.session as string)) continue;
    if (out.size >= FAILURE_SESSIONS_MAX) {
      capped = true;
      break;
    }
    out.add(row.session as string);
  }
  return { sessions: [...out], capped };
}

/** The size a stamp records, or 0 when it records none. */
function sizeOf(stamp: string): number {
  const size = Number(stamp.split(":")[0]);
  return Number.isFinite(size) && size > 0 ? size : 0;
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
  const { sessions, capped } = messageSessions(model);
  if (sessions.length === 0) {
    if (prev !== undefined && prev.stamp === "none") return prev;
    return { stamp: "none", facts: [] };
  }
  const root = containedSessionRoot(dir, facts.envVars(dir));
  if (root === undefined) {
    if (prev?.unreadable === true && prev.stamp === "unreachable") return prev;
    return { stamp: "unreachable", facts: [], unreadable: true };
  }
  const stamps = sessions.map((s) => reader.stamp(root, `${s}.jsonl`));
  const stamp = digestPrefix([root, ...sessions.map((s, i) => `${s}=${stamps[i]}`)].join("\n"), 32);
  if (prev !== undefined && prev.stamp === stamp) return prev;
  const records: {
    source: "run_failed";
    class: string;
    message: string;
    sessionId: string;
    ts?: number;
  }[] = [];
  let unreadable = false;
  let truncated = capped;
  let budget = FAILURE_READ_BYTES;
  const seen = new Set<string>();
  for (const [i, session] of sessions.entries()) {
    const rel = `${session}.jsonl`;
    // A file reached by more than one name is read once.
    const identity = reader.identity?.(root, rel);
    if (identity !== undefined) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const maxBytes = Math.min(SESSION_CAPS.maxBytes, budget);
    budget -= Math.min(sizeOf(stamps[i] ?? ""), maxBytes);
    const read = reader.tail(root, rel, { ...SESSION_CAPS, maxBytes });
    if (read.state === "refused") unreadable = true;
    if (read.state !== "read") continue;
    if (read.truncated && maxBytes < SESSION_CAPS.maxBytes) truncated = true;
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
    ...(truncated || records.length > FAILURES_MAX ? { truncated: true as const } : {}),
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
