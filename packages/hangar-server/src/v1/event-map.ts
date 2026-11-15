/**
 * What a control record is as a stream event (#507, #513): one content-free envelope per
 * line, through the closed state tables control-service keeps (`MACHINE_STATE_EVENTS`,
 * `APPROVAL_LOG_EVENTS`). A line that maps to no event advances the cursor and sends
 * nothing.
 *
 * - An envelope names ids, a state and reason codes, never a row's free text, an argv or
 *   a log path. Its sensitivity is the taxonomy's, raised to `people` when the row names a
 *   person's records (`peopleProjection`).
 * - `at` is the line's own time; `ingestedAt` is when the pump wrote it, else the line's
 *   own time (a line written before pumps stamped one), else now.
 *
 * The harness stream's sources are registered here as the core's `streamSources`: an
 * area that brings its own lines adds a source with its own mapping.
 */
import { join } from "node:path";
import {
  type CursorSource,
  EVENT_TAXONOMY,
  type EventEnvelope,
  type EventSensitivity,
  type EventType,
} from "@crewhaus/control-contract";
import {
  type RecordSource,
  decisionsLedger,
  deploymentsLedger,
  runsLedger,
} from "@crewhaus/control-records";
import { APPROVAL_LOG_EVENTS, commandsLedgerOf, stateEventOf } from "@crewhaus/control-service";
import { approvalsLedger } from "@crewhaus/session-store";

/** An envelope without its cursor: the stream gives each one its `id`. */
export type EnvelopeFields = Omit<EventEnvelope, "v" | "id">;

/** One source of a harness's stream: its records in a harness, and what a line is. */
export type StreamSourceDecl = {
  readonly name: CursorSource;
  source(harnessDir: string): RecordSource;
  eventOf(record: Readonly<Record<string, unknown>>, harness: string): EnvelopeFields | undefined;
};

/** The run states a run ends in. */
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
]);

function timeOf(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** The line's own time, from the field names the ledgers use. */
function lineTime(record: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["at", "ts", "timestamp", "endedAt", "startedAt", "acceptedAt"]) {
    const at = timeOf(record[key]);
    if (at !== undefined) return at;
  }
  return undefined;
}

function sensitivityOf(type: EventType, record: Readonly<Record<string, unknown>>) {
  return record["peopleProjection"] !== undefined
    ? ("people" as EventSensitivity)
    : EVENT_TAXONOMY[type].sensitivity;
}

/** The envelope fields every event carries, from its line. */
function base(
  type: EventType,
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields {
  const at = lineTime(record) ?? new Date().toISOString();
  return {
    type,
    at,
    ingestedAt: timeOf(record["ingestedAt"]) ?? at,
    harness,
    sensitivity: sensitivityOf(type, record),
  };
}

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

/** A run ledger row, as its state's event. `trace: false` says the run has no trace. */
export function runRowEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
  options: { readonly trace?: false } = {},
): EnvelopeFields | undefined {
  const id = record["id"];
  const state = record["state"];
  const type = stateEventOf("run", state);
  if (!text(id) || type === undefined) return undefined;
  const failureClass = record["failureClass"];
  return {
    ...base(type, record, harness),
    run: id,
    payload: {
      state,
      ...(text(failureClass) ? { failureClass } : {}),
      ...(options.trace === false ? { trace: false } : {}),
    },
  };
}

/**
 * A supervisor's run ledger line for one execution: its opening line is `run.started`, a
 * line that ends it `run.succeeded` on exit 0 and `run.failed` otherwise (the ledger does
 * not say who stopped a run, so no cancel is guessed), and a patch that only names its
 * session is no event.
 */
export function executionLineEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields | undefined {
  const runId = record["runId"];
  if (!text(runId)) return undefined;
  const ended = timeOf(record["endedAt"]);
  const started = timeOf(record["startedAt"]);
  let type: EventType;
  if (ended !== undefined) type = record["exitCode"] === 0 ? "run.succeeded" : "run.failed";
  else if (started !== undefined) type = "run.started";
  else return undefined;
  const payload: Record<string, unknown> = {};
  if (typeof record["exitCode"] === "number") payload["exitCode"] = record["exitCode"];
  if (text(record["failureClass"])) payload["failureClass"] = record["failureClass"];
  if (record["forced"] === true) payload["forced"] = true;
  return { ...base(type, record, harness), run: runId, payload };
}

/** Whether a supervisor ledger line ends its execution. */
export function executionLineEnds(record: Readonly<Record<string, unknown>>): boolean {
  return timeOf(record["endedAt"]) !== undefined;
}

/** A trace line as `run.trace`, naming only its kind. */
export function traceLineEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
  run: string,
): EnvelopeFields | undefined {
  const kind = record["kind"];
  if (!text(kind)) return undefined;
  return { ...base("run.trace", record, harness), run, payload: { traceKind: kind } };
}

/** A receipt row as its state's event. */
export function commandRowEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields | undefined {
  const id = record["id"];
  const type = stateEventOf("command", record["state"]);
  if (!text(id) || type === undefined) return undefined;
  return {
    ...base(type, record, harness),
    command: id,
    payload: { state: record["state"], ...(text(record["kind"]) ? { kind: record["kind"] } : {}) },
  };
}

/** A deployment row as its state's event. */
export function deploymentRowEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields | undefined {
  const id = record["id"];
  const type = stateEventOf("deployment", record["state"]);
  if (!text(id) || type === undefined) return undefined;
  return { ...base(type, record, harness), deployment: id, payload: { state: record["state"] } };
}

/** A `dec_` decision row as its state's event. */
export function decisionRowEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields | undefined {
  const id = record["id"];
  const type = stateEventOf("decision", record["state"]);
  if (!text(id) || type === undefined) return undefined;
  return { ...base(type, record, harness), decision: id, payload: { state: record["state"] } };
}

/** A tool approval's decision-log line as its event, naming the `appr_` id only. */
export function approvalLineEvent(
  record: Readonly<Record<string, unknown>>,
  harness: string,
): EnvelopeFields | undefined {
  const id = record["decision"];
  const event = record["event"];
  if (!text(id) || !text(event) || !Object.hasOwn(APPROVAL_LOG_EVENTS, event)) return undefined;
  const type = APPROVAL_LOG_EVENTS[event as keyof typeof APPROVAL_LOG_EVENTS];
  if (type === null) return undefined;
  return { ...base(type, record, harness), decision: id };
}

/** The core's five sources of a harness's stream, each contained in the harness. */
export const CORE_STREAM_SOURCES: readonly StreamSourceDecl[] = [
  { name: "runs", source: runsLedger, eventOf: (record, h) => runRowEvent(record, h) },
  { name: "commands", source: commandsLedgerOf, eventOf: commandRowEvent },
  { name: "deployments", source: deploymentsLedger, eventOf: deploymentRowEvent },
  { name: "decisions", source: decisionsLedger, eventOf: decisionRowEvent },
  {
    name: "approvals",
    source: (dir) => approvalsLedger(join(dir, ".crewhaus", "sessions")),
    eventOf: approvalLineEvent,
  },
];
