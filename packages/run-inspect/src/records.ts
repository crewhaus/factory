/**
 * The joins every fold shares, over a loaded run: which lines are the run's, its stamp,
 * its spans, its tool calls and the checks on each, its model calls, its cost, an
 * operator's wake, and an approval's later outcome. Pure: nothing here reads a file
 * or a clock.
 */
import { extractFeedbackRecords } from "@crewhaus/feedback-distill";
import { executionGaps } from "./exec";
import type { SessionLine } from "./lines";
import type { DecisionEntry, LoadedRun } from "./load";
import {
  type ApprovalLater,
  COST_NOT_RECORDED_WORDS,
  COST_NOT_TRACKED_WORDS,
  COST_UNKNOWN_WORDS,
  type CostView,
  type InspectGap,
  type Provenance,
  type ReconstructionRule,
  type RevisionsView,
  type TriggerView,
  WAKE_NOT_RECORDED,
  type WakeView,
  flatText,
  notRecorded,
  ownValue,
  reconstructed,
  recorded,
} from "./model";

export type Rec = Readonly<Record<string, unknown>>;

export function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A closed code or a name as a title may hold it: anything else reads `unknown`. */
const CODE_RE = /^[A-Za-z0-9_.:@#/-]{1,128}$/;
export function code(value: unknown): string {
  return typeof value === "string" && CODE_RE.test(value) ? value : "unknown";
}

export function payloadOf(line: SessionLine): Rec {
  return rec(line.payload) ?? {};
}

/**
 * The text of a message's content: the string, or its text blocks joined. Thinking and
 * redacted-thinking blocks are never read, and nor is anything that is not text.
 */
export function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const b = rec(block);
    if (b?.["type"] === "text" && typeof b["text"] === "string") texts.push(b["text"]);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** The tool_use blocks of an assistant message: id and name only. */
export function toolUsesOf(content: unknown): ReadonlyArray<{ id: string; name: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const block of content) {
    const b = rec(block);
    if (b?.["type"] === "tool_use" && typeof b["id"] === "string") {
      out.push({ id: b["id"], name: code(b["name"]) });
    }
  }
  return out;
}

/** A user message a person or a caller sent: not synthetic, not only tool results. */
export function isTurnStart(line: SessionLine): boolean {
  if (line.kind !== "user_message") return false;
  const payload = payloadOf(line);
  if (payload["synthetic"] === true) return false;
  const content = payload["content"];
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  const types = content.map((block) => rec(block)?.["type"]);
  return types.includes("text") && !types.includes("tool_result");
}

export function isoOf(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : "";
}

/** How the run's lines are attributed to it. */
export type Attribution =
  | { readonly state: "recorded" }
  | { readonly state: "reconstructed"; readonly rule: ReconstructionRule };

/** A value with the run's attribution. */
export function attributed<T>(
  attribution: Attribution,
  value: T,
  refs: readonly string[],
): Provenance<T> {
  return attribution.state === "recorded"
    ? recorded(value, refs)
    : reconstructed(value, attribution.rule, refs);
}

export type SpanInfo = {
  readonly id: string;
  readonly lineId: string;
  readonly parent?: string;
  readonly kind: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
  readonly toolUseId?: string;
  readonly call?: number;
  readonly turn?: { readonly run: number; readonly session: number };
  readonly attempt?: { readonly index: number; readonly cause?: string };
  readonly failureClass?: string;
};

export type ToolCall = {
  readonly span?: string;
  readonly use: SessionLine;
  /** A second `tool_use` line of the same call: the approved input that ran instead. */
  readonly ran?: SessionLine;
  readonly result?: SessionLine;
  readonly toolUseId: string;
  readonly name: string;
  readonly call?: number;
};

export type VerdictInfo = {
  readonly line: SessionLine;
  readonly payload: Rec;
  readonly gate: string;
  readonly outcome: string;
  /** The tool call it judged, joined by span, then by the call's ordinal. */
  readonly tool?: ToolCall;
};

export type RunIndex = {
  readonly loaded: LoadedRun;
  /** The run's lines, in file order. */
  readonly lines: readonly SessionLine[];
  readonly attribution: Attribution;
  readonly stamp?: { readonly line: SessionLine; readonly payload: Rec };
  readonly rootSpan?: string;
  readonly spans: ReadonlyMap<string, SpanInfo>;
  /** Span ids lines name that no `span_closed` closes, with the first line naming each. */
  readonly unfinished: ReadonlyMap<string, string>;
  /** `payload.kind` of each compaction line, by its span. */
  readonly compactionKind: ReadonlyMap<string, string>;
  readonly tools: readonly ToolCall[];
  /** Each tool call by the `tool_use` line that opened it. */
  readonly toolByUse: ReadonlyMap<SessionLine, ToolCall>;
  readonly verdicts: readonly VerdictInfo[];
  readonly manifests: readonly SessionLine[];
  /** The session turn of each line, when it can be told. */
  readonly turnOf: (line: SessionLine) => Provenance<number> | undefined;
  readonly gaps: readonly InspectGap[];
};

function spanInfoOf(line: SessionLine): SpanInfo | undefined {
  const p = payloadOf(line);
  const id = str(p["span"]) ?? line.span;
  if (id === undefined) return undefined;
  const turn = rec(p["turn"]);
  const attempt = rec(p["attempt"]);
  const turnRun = num(turn?.["run"]);
  const turnSession = num(turn?.["session"]);
  const index = num(attempt?.["index"]);
  return {
    id,
    lineId: line.id,
    ...(str(p["parent"]) !== undefined ? { parent: str(p["parent"]) as string } : {}),
    kind: code(p["kind"]),
    ...(str(p["status"]) !== undefined ? { status: code(p["status"]) } : {}),
    ...(str(p["startedAt"]) !== undefined
      ? { startedAt: flatText(str(p["startedAt"]) as string) }
      : {}),
    ...(num(p["durationMs"]) !== undefined ? { durationMs: num(p["durationMs"]) as number } : {}),
    ...(str(p["toolUseId"]) !== undefined ? { toolUseId: str(p["toolUseId"]) as string } : {}),
    ...(num(p["call"]) !== undefined ? { call: num(p["call"]) as number } : {}),
    ...(turnRun !== undefined && turnSession !== undefined
      ? { turn: { run: turnRun, session: turnSession } }
      : {}),
    ...(index !== undefined
      ? {
          attempt: {
            index,
            ...(str(attempt?.["cause"]) !== undefined ? { cause: code(attempt?.["cause"]) } : {}),
          },
        }
      : {}),
    ...(str(p["failureClass"]) !== undefined ? { failureClass: code(p["failureClass"]) } : {}),
  };
}

/** The lines that are the run's: by their `run` stamp, by the run's byte window, or all. */
export function runLinesOf(loaded: LoadedRun): SessionLine[] {
  switch (loaded.mode) {
    case "stamped":
      return loaded.lines.filter((line) => line.run === loaded.run);
    case "records-off": {
      const { from, to } = loaded.window;
      return loaded.lines.filter(
        (line) => line.run === undefined && line.off >= from && (to === undefined || line.off < to),
      );
    }
    case "legacy":
      return [...loaded.lines];
    case "unread":
      return [];
  }
}

function attributionOf(loaded: LoadedRun): Attribution {
  return loaded.mode === "records-off"
    ? { state: "reconstructed", rule: "records-off-by-run-row" }
    : { state: "recorded" };
}

/** Group tool_use and tool_result lines into calls: by span, else by id and position. */
function toolCallsOf(lines: readonly SessionLine[], spans: ReadonlyMap<string, SpanInfo>) {
  const calls: Array<{
    span?: string;
    use: SessionLine;
    ran?: SessionLine;
    result?: SessionLine;
    toolUseId: string;
    name: string;
    call?: number;
  }> = [];
  const bySpan = new Map<string, (typeof calls)[number]>();
  for (const line of lines) {
    if (line.kind === "tool_use") {
      const p = payloadOf(line);
      const toolUseId = str(p["id"]) ?? "";
      if (line.span !== undefined) {
        const existing = bySpan.get(line.span);
        if (existing !== undefined) {
          existing.ran = line;
          continue;
        }
      }
      const call = line.span !== undefined ? spans.get(line.span)?.call : undefined;
      const entry = {
        ...(line.span !== undefined ? { span: line.span } : {}),
        use: line,
        toolUseId,
        name: code(p["name"]),
        ...(call !== undefined ? { call } : {}),
      };
      calls.push(entry);
      if (line.span !== undefined) bySpan.set(line.span, entry);
    } else if (line.kind === "tool_result") {
      const id = str(payloadOf(line)["toolUseId"]);
      let target = line.span !== undefined ? bySpan.get(line.span) : undefined;
      if (target === undefined) {
        for (let i = calls.length - 1; i >= 0; i--) {
          const candidate = calls[i];
          if (
            candidate !== undefined &&
            candidate.result === undefined &&
            candidate.toolUseId === id &&
            candidate.use.off < line.off &&
            (line.span === undefined || candidate.span === undefined)
          ) {
            target = candidate;
            break;
          }
        }
      }
      if (target !== undefined && target.result === undefined) target.result = line;
    }
  }
  return calls as ToolCall[];
}

/** Build the shared index of a loaded run. */
export function indexRun(loaded: LoadedRun): RunIndex {
  const lines = runLinesOf(loaded);
  const attribution = attributionOf(loaded);
  const stampLine =
    loaded.mode === "stamped"
      ? lines.find((line) => line.kind === "run_stamp" && payloadOf(line)["run"] === loaded.run)
      : undefined;
  const stamp =
    stampLine !== undefined ? { line: stampLine, payload: payloadOf(stampLine) } : undefined;

  const spans = new Map<string, SpanInfo>();
  const compactionKind = new Map<string, string>();
  for (const line of lines) {
    if (line.kind === "span_closed") {
      const info = spanInfoOf(line);
      if (info !== undefined && !spans.has(info.id)) spans.set(info.id, info);
    } else if (line.kind === "compaction" && line.span !== undefined) {
      const kind = str(payloadOf(line)["kind"]);
      if (kind !== undefined) compactionKind.set(line.span, kind);
    }
  }
  const rootSpan = stamp?.line.span ?? [...spans.values()].find((span) => span.kind === "run")?.id;
  const unfinished = new Map<string, string>();
  for (const line of lines) {
    const named = line.kind === "span_closed" ? undefined : line.span;
    if (named !== undefined && !spans.has(named) && !unfinished.has(named)) {
      unfinished.set(named, line.id);
    }
  }

  const tools = toolCallsOf(lines, spans);
  const toolBySpan = new Map<string, ToolCall>();
  const toolByCall = new Map<number, ToolCall>();
  const toolByUse = new Map<SessionLine, ToolCall>();
  for (const tool of tools) {
    toolByUse.set(tool.use, tool);
    if (tool.span !== undefined) toolBySpan.set(tool.span, tool);
    if (tool.call !== undefined && !toolByCall.has(tool.call)) toolByCall.set(tool.call, tool);
  }
  const verdicts: VerdictInfo[] = [];
  for (const line of lines) {
    if (line.kind !== "verdict") continue;
    const payload = payloadOf(line);
    const on = rec(payload["on"]);
    const span = str(payload["span"]) ?? line.span;
    let tool = span !== undefined ? toolBySpan.get(span) : undefined;
    if (tool === undefined && on?.["kind"] === "tool") {
      const call = num(on["call"]);
      if (call !== undefined) tool = toolByCall.get(call);
    }
    verdicts.push({
      line,
      payload,
      gate: code(payload["gate"]),
      outcome: code(payload["outcome"]),
      ...(tool !== undefined ? { tool } : {}),
    });
  }
  const manifests = lines.filter((line) => line.kind === "context_manifest");

  const turnOf = turnMapping(loaded, lines, spans, attribution);
  const index: RunIndex = {
    loaded,
    lines,
    attribution,
    ...(stamp !== undefined ? { stamp } : {}),
    ...(rootSpan !== undefined ? { rootSpan } : {}),
    spans,
    unfinished,
    compactionKind,
    tools,
    toolByUse,
    verdicts,
    manifests,
    turnOf,
    gaps: [],
  };
  return { ...index, gaps: gapsOf(index) };
}

/**
 * The session turn of a line: from its span's recorded turn, walking up to the turn;
 * else, when the whole session was read, counted by the user messages before it.
 */
function turnMapping(
  loaded: LoadedRun,
  lines: readonly SessionLine[],
  spans: ReadonlyMap<string, SpanInfo>,
  attribution: Attribution,
): (line: SessionLine) => Provenance<number> | undefined {
  const counted = new Map<string, number>();
  if (loaded.readFrom === 0) {
    let turn = 0;
    for (const line of loaded.lines) {
      if (isTurnStart(line)) turn += 1;
      if (turn > 0) counted.set(line.id, turn);
    }
  }
  return (line) => {
    let span = line.span;
    for (let hops = 0; span !== undefined && hops < 64; hops++) {
      const info = spans.get(span);
      if (info === undefined) break;
      if (info.turn !== undefined) {
        return attributed(attribution, info.turn.session, [info.lineId]);
      }
      span = info.parent;
    }
    if (line.kind === "context_manifest") {
      const turn = num(rec(payloadOf(line)["turn"])?.["session"]);
      if (turn !== undefined) return attributed(attribution, turn, [line.id]);
    }
    const n = counted.get(line.id);
    return n !== undefined ? reconstructed(n, "legacy-turn-by-user-message", [line.id]) : undefined;
  };
}

/** The run's cost lines: per-call lines and role-bearing roll-ups, never a role-less total. */
export function costLinesOf(lines: readonly SessionLine[]): SessionLine[] {
  return lines.filter((line) => {
    if (line.kind !== "cost_accrual") return false;
    const p = payloadOf(line);
    return !(p["summary"] === true && p["role"] === undefined);
  });
}

function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (micros > 0 && dollars < 0.01) return "under $0.01";
  return `$${dollars.toFixed(2)}`;
}

/**
 * Sum cost lines. Any line marked unpriced makes the total unknown; so does a line that
 * records no amount (or one that is not a number), and a line that reports tokens, costs
 * nothing and does not say whether it was priced. Never $0 for any of them.
 */
export function costFold(
  lines: readonly SessionLine[],
  attribution: Attribution,
): Provenance<CostView> | undefined {
  const cost = costLinesOf(lines);
  if (cost.length === 0) return undefined;
  const refs = cost.map((line) => line.id);
  let total = 0;
  let zeroWithTokens = false;
  let noAmount = false;
  for (const line of cost) {
    const p = payloadOf(line);
    if (p["unpriced"] === true) {
      return recorded(
        { usdMicros: null, lines: cost.length, unknown: "unpriced", words: COST_UNKNOWN_WORDS },
        refs,
      );
    }
    const micros = num(p["costUsdMicros"]);
    if (micros === undefined) {
      noAmount = true;
      continue;
    }
    const tokens = (num(p["inputTokens"]) ?? 0) + (num(p["outputTokens"]) ?? 0);
    if (micros === 0 && tokens > 0 && !Object.hasOwn(p, "unpriced")) zeroWithTokens = true;
    total += micros;
  }
  if (noAmount) {
    return {
      state: "not-recorded",
      refs,
      gap: { reason: "not-recorded" },
      value: {
        usdMicros: null,
        lines: cost.length,
        unknown: "not-recorded",
        words: COST_NOT_RECORDED_WORDS,
      },
    };
  }
  if (zeroWithTokens) {
    return reconstructed(
      {
        usdMicros: null,
        lines: cost.length,
        unknown: "zero-cost-with-tokens",
        words: COST_UNKNOWN_WORDS,
      },
      "zero-cost-with-tokens",
      refs,
    );
  }
  return attributed(attribution, { usdMicros: total, lines: cost.length, words: usd(total) }, refs);
}

/** The run's cost, or why it is not known. */
export function runCost(index: RunIndex): Provenance<CostView> {
  const folded = costFold(index.lines, index.attribution);
  if (folded !== undefined) return folded;
  const recording = rec(index.stamp?.payload["recording"]);
  if (recording?.["costTracking"] === false) {
    return {
      ...notRecorded<CostView>({ reason: "cost-off", remedy: "CREWHAUS_COST_TRACKING" }),
      value: { usdMicros: null, lines: 0, words: COST_NOT_TRACKED_WORDS },
    };
  }
  const modelCalls = index.lines.filter(
    (line) => line.kind === "model_meta" || line.kind === "context_manifest",
  ).length;
  if (modelCalls === 0 && index.stamp !== undefined) {
    return recorded({ usdMicros: 0, lines: 0, words: usd(0) }, [index.stamp.line.id]);
  }
  return {
    ...notRecorded<CostView>({ reason: "not-recorded" }),
    value: { usdMicros: null, lines: 0, words: "Cost not recorded" },
  };
}

function gapsOf(index: RunIndex): InspectGap[] {
  const { loaded, stamp } = index;
  const gaps: InspectGap[] = [...loaded.gaps];
  if (loaded.mode === "legacy") {
    gaps.push({ reason: "before-0.9", remedy: "crewhaus compile" });
  } else if (loaded.mode === "records-off") {
    gaps.push({ reason: "records-off", remedy: "CREWHAUS_RUN_STAMPS" });
  }
  const recording = rec(stamp?.payload["recording"]);
  if (recording?.["advisorEvents"] === false) {
    gaps.push({ reason: "advisor-off", remedy: "CREWHAUS_ADVISOR_EVENTS" });
  }
  if (recording?.["costTracking"] === false && costLinesOf(index.lines).length === 0) {
    gaps.push({ reason: "cost-off", remedy: "CREWHAUS_COST_TRACKING" });
  }
  if (executionOf(index) === undefined) {
    gaps.push({ reason: "not-supervised", remedy: "crewhaus daemon start" });
  } else {
    gaps.push(...executionGaps(loaded.executionEvents));
  }
  for (const [, from] of index.unfinished) gaps.push({ reason: "unfinished", from });
  return gaps;
}

/** The supervised execution the run belongs to, from its stamp or its rows. */
export function executionOf(index: RunIndex): string | undefined {
  const fromStamp = str(index.stamp?.payload["execution"]);
  if (fromStamp !== undefined) return code(fromStamp);
  for (const row of index.loaded.rows) {
    const execution = str(row["execution"]);
    if (execution !== undefined) return code(execution);
  }
  return undefined;
}

const TRIGGER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  cli: "Started from the command line",
  heartbeat: "A scheduled check (heartbeat)",
  schedule: "Started on a schedule",
  queue: "Started from a queue",
  api: "Started through the API",
  channel: "Started by a channel message",
  managed: "Started as a managed run",
  "approval-resume": "Resumed after an approval",
  resume: "Resumed",
  retry: "Started as a retry",
  eval: "An eval sample",
  rehearsal: "A rehearsal",
});

/** What started the run, from its stamp, else its rows. */
export function triggerOf(index: RunIndex): Provenance<TriggerView> {
  const fromStamp = rec(index.stamp?.payload["trigger"]);
  const fromRow = rec(index.loaded.rows.at(-1)?.["trigger"] ?? index.loaded.rows[0]?.["trigger"]);
  const trigger = fromStamp ?? fromRow;
  if (trigger === undefined) {
    return {
      ...notRecorded<TriggerView>({ reason: "not-recorded" }),
      value: { kind: "unknown", words: "What started this run was not recorded", synthetic: false },
    };
  }
  const kind = code(trigger["kind"]);
  const source = rec(trigger["source"]);
  const platform = str(source?.["platform"]);
  const words =
    kind === "channel" && platform !== undefined
      ? `Started by a ${code(platform)} message`
      : (ownValue(TRIGGER_WORDS, kind) ?? `Started by ${kind}`);
  const view: TriggerView = {
    kind,
    words,
    ...(str(trigger["lane"]) !== undefined ? { lane: code(trigger["lane"]) } : {}),
    ...(str(trigger["via"]) !== undefined ? { via: code(trigger["via"]) } : {}),
    ...(platform !== undefined ? { platform: code(platform) } : {}),
    synthetic: trigger["synthetic"] === true,
  };
  if (fromStamp !== undefined && index.stamp !== undefined) {
    return recorded(view, [index.stamp.line.id]);
  }
  return reconstructed(view, "records-off-by-run-row", []);
}

/**
 * An unscoped synthetic `user_message` an operator's wake wrote, on `lane`: exactly that
 * lane when `exact`, else that lane when one is named and any lane when none is.
 */
function isMarkerOn(line: SessionLine, lane: unknown, exact: boolean): boolean {
  if (line.kind !== "user_message" || line.run !== undefined) return false;
  const control = rec(payloadOf(line)["control"]);
  if (control?.["synthetic"] !== true) return false;
  return exact || typeof lane === "string" ? control["lane"] === lane : true;
}

/** The wake a marker records, its free text flattened onto one line. */
function wakeFromMarker(
  marker: SessionLine | undefined,
  refs: readonly string[],
): Provenance<WakeView> {
  const control = marker !== undefined ? rec(payloadOf(marker)["control"]) : undefined;
  const raw = str(control?.["reason"]);
  const reason = raw !== undefined ? flatText(raw) : undefined;
  if (marker === undefined || reason === undefined) {
    return {
      ...notRecorded<WakeView>({ reason: "not-recorded" }, refs),
      value: { reason: "", words: WAKE_NOT_RECORDED },
    };
  }
  const rawBy = str(control?.["by"]);
  const by = rawBy !== undefined ? flatText(rawBy) : undefined;
  return reconstructed(
    {
      reason,
      ...(by !== undefined ? { by } : {}),
      words: `operator wake: ${reason}${by !== undefined ? ` (by ${by})` : ""}`,
    },
    "synthetic-marker-by-position",
    [marker.id, ...refs],
  );
}

/**
 * An operator's wake: the reason and author the session log's marker records, never
 * the stamp, each flattened onto one line. For a stamped run, the marker is the last
 * unscoped synthetic `user_message` of the stamp's lane before the stamp, with no other
 * `run_stamp` between them. For a run recorded with run records off whose row says a
 * wake started it, it is the last such marker below the run's `sessionAt` and above the
 * session's previous run's (rule `synthetic-marker-by-position`).
 */
export function wakeOf(index: RunIndex): Provenance<WakeView> | undefined {
  const { loaded } = index;
  const stamp = index.stamp;
  if (stamp === undefined) {
    if (loaded.mode !== "records-off") return undefined;
    const trigger = triggerOf(index).value;
    if (trigger?.synthetic !== true) return undefined;
    const { from, previous } = loaded.window;
    const marker = [...loaded.markers, ...loaded.lines]
      .filter((line) => line.off < from && (previous === undefined || line.off >= previous))
      .filter((line) => isMarkerOn(line, trigger.lane, false))
      .sort((a, b) => a.off - b.off)
      .at(-1);
    return wakeFromMarker(marker, []);
  }
  const trigger = rec(stamp.payload["trigger"]);
  if (trigger?.["synthetic"] !== true) return undefined;
  const lane = trigger["lane"];
  const stamps = loaded.lines
    .filter((line) => line.kind === "run_stamp" && line.off < stamp.line.off)
    .map((line) => line.off);
  const marker = [...loaded.markers, ...loaded.lines]
    .filter((line) => line.off < stamp.line.off && isMarkerOn(line, lane, true))
    .filter((line) => !stamps.some((off) => off > line.off))
    .sort((a, b) => a.off - b.off)
    .at(-1);
  return wakeFromMarker(marker, [stamp.line.id]);
}

/** The id of the marker {@link wakeOf} chose for the run, when it chose one. */
export function wakeMarkerId(index: RunIndex): string | undefined {
  const wake = wakeOf(index);
  return wake?.state === "reconstructed" ? wake.refs[0] : undefined;
}

/** What the run ran under, from its stamp. */
export function revisionsOf(index: RunIndex): Provenance<RevisionsView> {
  const stamp = index.stamp;
  const revisions = rec(stamp?.payload["revisions"]);
  if (stamp === undefined || revisions === undefined) {
    return {
      ...notRecorded<RevisionsView>({ reason: "not-recorded" }),
      value: { spec: "not recorded" },
    };
  }
  const spec = rec(revisions["spec"]);
  const settings = rec(revisions["settings"]);
  const fingerprint = str(settings?.["fingerprint"]);
  const rules = num(settings?.["rules"]);
  const pool = rec(revisions["pool"]);
  return recorded(
    {
      spec: str(spec?.["specHash"]) !== undefined ? code(spec?.["specHash"]) : "not recorded",
      ...(str(spec?.["source"]) !== undefined ? { specFrom: code(spec?.["source"]) } : {}),
      ...(str(revisions["runtime"]) !== undefined ? { runtime: code(revisions["runtime"]) } : {}),
      ...(str(revisions["deployment"]) !== undefined
        ? { deployment: code(revisions["deployment"]) }
        : {}),
      ...(fingerprint !== undefined && rules !== undefined
        ? { settings: { fingerprint: code(fingerprint), rules } }
        : {}),
      ...(str(pool?.["policyVersion"]) !== undefined
        ? { poolPolicy: code(pool?.["policyVersion"]) }
        : {}),
    },
    [stamp.line.id],
  );
}

const LATER_EVENTS: Readonly<Record<string, ApprovalLater["outcome"]>> = Object.freeze({
  expire: "expired",
  supersede: "superseded",
});

/**
 * What became of an approval verdict's approval later, from the decision log: joined
 * by the approval id in `refs.approval`, in the inspected session, and by run when the
 * line names one. The first decision, then the newest expire or supersede. A verdict
 * with no approval id, or with no matching line, has none: nothing is guessed.
 */
export function laterOutcomes(
  decisions: readonly DecisionEntry[],
  session: string,
  verdict: VerdictInfo,
): readonly ApprovalLater[] {
  if (verdict.gate !== "approval") return [];
  const approval = str(rec(verdict.payload["refs"])?.["approval"]);
  if (approval === undefined) return [];
  const run = str(verdict.payload["run"]) ?? verdict.line.run;
  const lines = decisions.filter(
    (entry) =>
      entry.line.decision === approval &&
      entry.line.sessionId === session &&
      (entry.line.runId === undefined || entry.line.runId === run),
  );
  const later: ApprovalLater[] = [];
  const decided = lines.find((entry) => entry.line.event === "decide");
  const choice = decided?.line.choice;
  if (decided !== undefined && (choice === "grant" || choice === "deny")) {
    later.push(laterOf(decided, choice === "grant" ? "granted" : "denied"));
  }
  const ended = lines
    .filter((entry) => ownValue(LATER_EVENTS, entry.line.event) !== undefined)
    .at(-1);
  const endedAs = ended !== undefined ? ownValue(LATER_EVENTS, ended.line.event) : undefined;
  if (ended !== undefined && endedAs !== undefined) later.push(laterOf(ended, endedAs));
  return later;
}

function laterOf(entry: DecisionEntry, outcome: ApprovalLater["outcome"]): ApprovalLater {
  const { line } = entry;
  return {
    id: entry.id,
    outcome,
    at: flatText(String(line.at)),
    ...(line.by !== undefined ? { by: code(line.by) } : {}),
    ...(typeof line.surface === "string" ? { surface: code(line.surface) } : {}),
    ...(line.reason !== undefined ? { reason: code(line.reason) } : {}),
  };
}

/** `user_feedback` lines that rate the answer of `span`, from every line read. */
export function correctionsFor(loaded: LoadedRun, span: string) {
  const out: Array<{
    id: string;
    at: string;
    rating?: string;
    comment?: string;
    correction?: string;
  }> = [];
  for (const line of loaded.lines) {
    if (line.kind !== "user_feedback") continue;
    const [record] = extractFeedbackRecords([{ kind: line.kind, payload: line.payload }]);
    if (record === undefined || record.targetSpanId !== span) continue;
    const rating =
      record.rating.thumbs !== undefined
        ? `thumbs ${record.rating.thumbs}`
        : record.rating.stars !== undefined
          ? `${record.rating.stars} stars`
          : record.rating.scale !== undefined
            ? `${record.rating.scale.value} of ${record.rating.scale.max}`
            : undefined;
    out.push({
      id: line.id,
      at: record.ts,
      ...(rating !== undefined ? { rating } : {}),
      ...(record.comment !== undefined ? { comment: record.comment } : {}),
      ...(record.correction !== undefined ? { correction: record.correction } : {}),
    });
  }
  return out;
}

/** "once", "twice", "3 times". */
export function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}
