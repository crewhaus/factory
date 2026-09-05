/**
 * Loop contract 0.4 (Batch F, item 2) — `crewhaus sessions tail [<session>]`.
 *
 * Follows a session's append-only event log (`.crewhaus/sessions/<id>.jsonl`,
 * the `{ ts, version, kind, payload }` transcript `@crewhaus/event-log` writes)
 * and pretty-prints each turn as it lands — a `tail -f` for a running agent,
 * and the per-turn view `crewhaus dev` points you at. The formatting +
 * line-diffing + session-selection are factored out here as pure functions so
 * they are unit-testable without a live agent or real fs watches; the CLI
 * wrapper wires the file read + the follow poll loop behind these seams.
 */

/** One parsed session-log line. `kind` is the event-log EventKind; `payload`
 *  stays `unknown` — each renderer branches on the kinds it knows. */
export type SessionLogEvent = {
  readonly ts?: number;
  readonly kind?: string;
  readonly payload?: unknown;
};

export type FormatSessionEventOptions = {
  /** Prefix each line with the event's UTC HH:MM:SS. Default true. */
  readonly withTime?: boolean;
  /** Truncate rendered text/inputs to this many chars. Default 200. */
  readonly maxChars?: number;
  /**
   * 0.6.0 (design §8.2) — when true, render ONLY the conversational
   * transcript (the 0.5.x behaviour): the route / cost / eval / stage lines
   * below are skipped. Default false: a hybrid turn shows its shape — which
   * candidate served, what it cost, how the judge graded it, which stage ran.
   */
  readonly transcriptOnly?: boolean;
};

const DEFAULT_MAX_CHARS = 200;

/** `$0.0042` from microdollars; sub-cent spend keeps four decimals. */
export function formatUsdMicros(micros: unknown): string {
  if (typeof micros !== "number" || !Number.isFinite(micros)) return "$?";
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * A string payload field rendered into a transcript line: whitespace
 * collapsed and capped at `maxChars` via {@link truncate}, exactly like the
 * transcript text is. Every routing-line field goes through this — `requested`
 * is the user's `/model …` text (attacker-controlled on channel shapes) and
 * `reason` / `cause` carry provider error text, so an un-truncated field could
 * embed a newline and print what looks like a second, forged transcript line.
 */
function field(v: unknown, maxChars: number): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const t = truncate(s, maxChars);
  return t.length > 0 ? t : undefined;
}

/** `model[profile]` when the line names a profile, else the bare model. */
function modelWithProfile(payload: Record<string, unknown>, maxChars: number): string {
  const model = field(payload["model"], maxChars) ?? field(payload["modelId"], maxChars) ?? "?";
  const profile = field(payload["profile"], maxChars);
  return profile !== undefined ? `${model}[${profile}]` : model;
}

/**
 * 0.6.0 (design §8.2) — render the durable routing / cost / eval / stage
 * lines the session JSONL now carries, one indented line each, so `sessions
 * tail` shows the shape of a hybrid turn beside its transcript. Every field
 * is duck-typed and optional (0.5.x lines carry fewer of them); a payload
 * that names nothing renderable still yields a line naming the kind. Every
 * string field is passed through {@link field} (one line, capped at
 * `maxChars`) — the same discipline the transcript lines follow.
 */
function formatRoutingEvent(
  kind: string,
  payload: Record<string, unknown>,
  maxChars: number,
): string | undefined {
  const f = (v: unknown): string | undefined => field(v, maxChars);
  switch (kind) {
    case "model_route": {
      const parts = [`  ⇢ route ${modelWithProfile(payload, maxChars)}`];
      const policy = f(payload["policy"]);
      if (policy !== undefined) parts.push(`policy=${policy}`);
      const band = f(payload["routeKey"]);
      if (band !== undefined) parts.push(`band=${band}`);
      const stage = f(payload["stage"]);
      if (stage !== undefined) parts.push(`stage=${stage}`);
      const rule = f(payload["ruleId"]);
      if (rule !== undefined) parts.push(`rule=${rule}`);
      if (payload["explored"] === true) parts.push("explored");
      const reason = f(payload["reason"]);
      if (reason !== undefined) parts.push(`— ${reason}`);
      return parts.join(" ");
    }
    case "model_tier_route": {
      const parts = [`  ⇢ tier ${f(payload["tier"]) ?? "?"} ${f(payload["model"]) ?? "?"}`];
      if (payload["escalated"] === true) parts.push("escalated");
      const reason = f(payload["reason"]);
      if (reason !== undefined) parts.push(`— ${reason}`);
      return parts.join(" ");
    }
    case "model_failover":
      return `  ⇢ failover ${f(payload["from"]) ?? "?"} → ${f(payload["to"]) ?? "?"}${
        f(payload["reason"]) !== undefined ? ` — ${f(payload["reason"])}` : ""
      }`;
    case "model_directive": {
      const requested = f(payload["requested"]) ?? "?";
      const resolved = f(payload["resolved"]);
      const accepted = payload["accepted"] === true ? "pinned" : "refused";
      const reason = f(payload["reason"]);
      return `  ⇢ /model ${requested}${resolved !== undefined && resolved !== requested ? ` → ${resolved}` : ""} ${accepted}${
        reason !== undefined ? ` — ${reason}` : ""
      }`;
    }
    case "cost_accrual": {
      const parts = [
        `  $ ${formatUsdMicros(payload["costUsdMicros"])} ${modelWithProfile(payload, maxChars)}`,
      ];
      const role = f(payload["role"]);
      if (role !== undefined) parts.push(`role=${role}`);
      const stage = f(payload["stage"]);
      if (stage !== undefined) parts.push(`stage=${stage}`);
      const inTok = num(payload["inputTokens"]);
      const outTok = num(payload["outputTokens"]);
      if (inTok !== undefined && outTok !== undefined) parts.push(`${inTok}→${outTok} tok`);
      if (payload["unpriced"] === true) parts.push("(unpriced)");
      return parts.join(" ");
    }
    case "model_stage": {
      const parts = [
        `  ◇ stage ${f(payload["stage"]) ?? "?"}/${f(payload["strategy"]) ?? "?"} ${modelWithProfile(payload, maxChars)}`,
      ];
      const role = f(payload["role"]);
      if (role !== undefined) parts.push(`role=${role}`);
      const outcome = f(payload["outcome"]);
      if (outcome !== undefined) parts.push(outcome);
      const cause = f(payload["cause"]);
      if (cause !== undefined) parts.push(`— ${cause}`);
      const micros = num(payload["costUsdMicros"]);
      if (micros !== undefined) parts.push(formatUsdMicros(micros));
      return parts.join(" ");
    }
    case "eval_graded":
    case "judge_verdict": {
      const verdict = f(payload["verdict"]) ?? "?";
      const score = num(payload["score"]);
      const at = kind === "judge_verdict" ? f(payload["stepOrNode"]) : undefined;
      const parts = [
        `  ⚖ ${kind === "judge_verdict" ? "judge" : "eval"}${at !== undefined ? ` ${at}` : ""} ${verdict}`,
      ];
      if (score !== undefined) parts.push(score.toFixed(2));
      const threshold = num(payload["threshold"]);
      if (threshold !== undefined) parts.push(`(bar ${threshold.toFixed(2)})`);
      const judgeModel = f(payload["judgeModel"]);
      if (judgeModel !== undefined) parts.push(`by ${judgeModel}`);
      const graded = f(payload["model"]);
      if (graded !== undefined) parts.push(`of ${graded}`);
      const escalatedTo = f(payload["escalatedTo"]);
      if (escalatedTo !== undefined) parts.push(`→ escalate ${escalatedTo}`);
      const retry = num(payload["retryIndex"]);
      if (retry !== undefined && retry > 0) parts.push(`retry ${retry}`);
      return parts.join(" ");
    }
    default:
      return undefined;
  }
}

/** The event-log kinds {@link formatRoutingEvent} renders. */
export const ROUTING_TAIL_KINDS: ReadonlySet<string> = new Set([
  "model_route",
  "model_tier_route",
  "model_failover",
  "model_directive",
  "cost_accrual",
  "model_stage",
  "eval_graded",
  "judge_verdict",
]);

/** UTC HH:MM:SS for a session event's epoch-ms `ts` (deterministic across TZs). */
export function formatSessionEventTime(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "--:--:--";
  return new Date(ts).toISOString().slice(11, 19);
}

function truncate(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Pull the human-readable text out of a session event's `content`, which is
 * either a raw string (the initial user prompt) or an array of Anthropic
 * content blocks. Only `text` blocks contribute; `tool_use` / `tool_result`
 * blocks are rendered by their own event lines, so they are skipped here.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join(" ");
}

/** Count the tool_use blocks in an assistant message's content array. */
function countToolUses(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use"
    ) {
      n += 1;
    }
  }
  return n;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return extractText(content);
  return "";
}

/**
 * Render one session-log event as a single pretty line, or `undefined` when the
 * event kind carries no user-facing content (the advisor/metrics side-channel
 * kinds — `tool_stats`, `model_meta`, `mcp_stats`, … — and the tool-result echo
 * `user_message` whose granular `tool_result` line already shows it). The
 * routing / cost / eval / stage kinds (see {@link ROUTING_TAIL_KINDS}) render
 * unless `transcriptOnly` is set. Deterministic and side-effect-free.
 */
export function formatSessionEvent(
  ev: SessionLogEvent,
  opts: FormatSessionEventOptions = {},
): string | undefined {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  const body = ((): string | undefined => {
    switch (ev.kind) {
      case "user_message": {
        // The tool-result echo turn (content is a block array, no text) is
        // covered by tool_result lines — skip it to avoid a blank `user>`.
        const text = extractText(payload["content"]);
        if (text.trim().length === 0) return undefined;
        const tag = payload["synthetic"] === true ? "sys>" : "user>";
        return `${tag} ${truncate(text, maxChars)}`;
      }
      case "assistant_message": {
        const text = extractText(payload["content"]);
        const toolCount = countToolUses(payload["content"]);
        if (text.trim().length === 0) {
          return toolCount > 0
            ? `asst> (${toolCount} tool call${toolCount === 1 ? "" : "s"})`
            : undefined;
        }
        const suffix =
          toolCount > 0 ? ` (+${toolCount} tool call${toolCount === 1 ? "" : "s"})` : "";
        return `asst> ${truncate(text, maxChars)}${suffix}`;
      }
      case "tool_use": {
        const name = typeof payload["name"] === "string" ? (payload["name"] as string) : "tool";
        const input = payload["input"];
        const inputStr = input === undefined ? "" : truncate(JSON.stringify(input), maxChars);
        return `  ↳ ${name}(${inputStr})`;
      }
      case "tool_result": {
        const text = truncate(toolResultText(payload["content"]), maxChars);
        const isError = payload["isError"] === true;
        return `  ⤶ ${isError ? "ERROR " : ""}${text}`;
      }
      case "error": {
        const name = typeof payload["name"] === "string" ? (payload["name"] as string) : "error";
        const message =
          typeof payload["message"] === "string" ? (payload["message"] as string) : "";
        return `  ! ${name}: ${truncate(message, maxChars)}`;
      }
      case "run_failed": {
        const cls = typeof payload["class"] === "string" ? (payload["class"] as string) : "unknown";
        const message =
          typeof payload["message"] === "string" ? (payload["message"] as string) : "";
        return `  ✗ run failed [${cls}] ${truncate(message, maxChars)}`;
      }
      default:
        if (opts.transcriptOnly === true || ev.kind === undefined) return undefined;
        return formatRoutingEvent(ev.kind, payload, maxChars);
    }
  })();
  if (body === undefined) return undefined;
  return opts.withTime === false ? body : `${formatSessionEventTime(ev.ts)} ${body}`;
}

/** Tolerantly parse one JSONL line into a session event (or `undefined`). */
export function parseSessionEventLine(line: string): SessionLogEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (obj === null || typeof obj !== "object") return undefined;
    return obj as SessionLogEvent;
  } catch {
    return undefined;
  }
}

/**
 * Render every event in a raw log `text` to its pretty lines (skipping the
 * side-channel/undefined ones). Pure — used both for the initial dump and
 * (over the appended slice) for follow updates.
 */
export function renderSessionLog(text: string, opts: FormatSessionEventOptions = {}): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const ev = parseSessionEventLine(raw);
    if (ev === undefined) continue;
    const line = formatSessionEvent(ev, opts);
    if (line !== undefined) out.push(line);
  }
  return out;
}

/**
 * The follow cursor: how many source LINES of the log have already been
 * rendered. `advanceSessionTail` takes the full current text and the previous
 * cursor and returns the newly-appended rendered lines + the new cursor, so a
 * poll loop can print only what arrived since the last read. Counting source
 * lines (not rendered lines) keeps the cursor correct even when some events
 * render to nothing.
 */
export type SessionTailCursor = { readonly lineCount: number };

export function advanceSessionTail(
  text: string,
  cursor: SessionTailCursor,
  opts: FormatSessionEventOptions = {},
): { readonly lines: string[]; readonly cursor: SessionTailCursor } {
  // `split("\n")` drops the trailing element for a newline-terminated buffer
  // AND for a mid-line one: `"a\nb\n"` → `["a","b",""]` and `"a\nb"` →
  // `["a","b"]`, so `slice(0,-1)` is exactly the newline-TERMINATED lines in
  // both cases. A partially-written last line is therefore not consumed until
  // its newline lands, so the next poll re-reads and completes it. Event-log
  // always writes a trailing newline per event, so no complete event is lost.
  const consumable = text.split("\n").slice(0, -1);
  const fresh = consumable.slice(cursor.lineCount);
  const lines: string[] = [];
  for (const raw of fresh) {
    const ev = parseSessionEventLine(raw);
    if (ev === undefined) continue;
    const rendered = formatSessionEvent(ev, opts);
    if (rendered !== undefined) lines.push(rendered);
  }
  return { lines, cursor: { lineCount: cursor.lineCount + fresh.length } };
}

/**
 * Pick which session id to tail: the explicit id when given (validated by the
 * caller), else the most-recently-modified `sess_<16 hex>.jsonl` under
 * `sessionsDir`. `deps.list` returns the dir entries; `deps.mtimeMs` returns a
 * file's mtime (bigger = newer). Returns `undefined` when the dir has no
 * session logs. Injectable for tests.
 */
export function pickSessionToTail(
  explicitId: string | undefined,
  deps: {
    readonly list: () => ReadonlyArray<string>;
    readonly mtimeMs: (fileName: string) => number;
  },
): string | undefined {
  if (explicitId !== undefined) return explicitId;
  const logs = deps
    .list()
    .filter((f) => /^sess_[0-9a-f]{16}\.jsonl$/.test(f))
    .map((f) => ({ id: f.slice(0, -".jsonl".length), mtime: deps.mtimeMs(f) }))
    .sort((a, b) => b.mtime - a.mtime);
  return logs[0]?.id;
}
