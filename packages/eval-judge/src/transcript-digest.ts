/**
 * NEW-graders-3 — render a `RunResult.transcript` into the bounded text
 * digest a trajectory-judging `llm_judge` (`target: transcript`) reads.
 *
 * The transcript is the sample's event-log JSONL (`@crewhaus/event-log`
 * events: `{ ts, version, kind, payload }`). The digest renders the
 * conversational + tool trajectory kinds — `user_message`,
 * `assistant_message`, `tool_use`, `tool_result`, `error`, `run_failed` —
 * one line-block per event, and skips every non-conversational kind
 * (compaction, cost accruals, feedback, …): the judge grades the agent's
 * process, not the runtime's bookkeeping. Synthetic runtime-injected
 * messages (`payload.synthetic: true`) are skipped for the same reason.
 *
 * Size cap (documented contract): the digest is bounded by `maxChars`
 * (default {@link TRANSCRIPT_DIGEST_MAX_CHARS}) with MOST-RECENT-TURNS-WIN
 * truncation — whole events are kept from the END of the transcript while
 * they fit, dropped events are summarized by a leading
 * `[transcript truncated: showing the most recent K of N events]` header,
 * and each individual event's text is clipped to
 * {@link TRANSCRIPT_EVENT_MAX_CHARS} (keeping its TAIL — the most recent
 * content — behind a `[…clipped]` marker) so one enormous tool result
 * cannot evict the rest of the run. The newest event is always kept.
 *
 * An empty transcript (stub invokers, hand-built RunResults) degrades to
 * the final `agentOutput` behind an explicit `(no transcript recorded)`
 * marker — honest evidence for the judge (and its A3 abstention) instead of
 * an empty block.
 */
import type { RunResult } from "@crewhaus/eval-grader";

type TranscriptEvent = RunResult["transcript"][number];

/** Default digest budget, in characters (~6k tokens). */
export const TRANSCRIPT_DIGEST_MAX_CHARS = 24_000;

/** Per-event clip, in characters — one huge tool result must not evict the
 *  rest of the run from the digest. */
export const TRANSCRIPT_EVENT_MAX_CHARS = 2_000;

/** Payload text of a `user_message`/`assistant_message`; null for synthetic
 *  runtime-injected messages and non-text payloads (mirrors
 *  grader-continuity's `messageText` reader). */
function messageText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["synthetic"] === true) return null;
  const content = p["content"];
  if (typeof content === "string") return content.trim() !== "" ? content : null;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim() !== "") {
      texts.push(b["text"]);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

/** Clip `text` to `max` characters keeping the TAIL (most recent content
 *  wins — same rule as the event-level truncation). */
function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "[…clipped] ";
  return marker + text.slice(text.length - Math.max(0, max - marker.length));
}

/** Render one transcript event as a digest block, or null for kinds (and
 *  synthetic messages) the digest skips. */
function renderEvent(ev: TranscriptEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.kind) {
    case "user_message": {
      const text = messageText(ev.payload);
      return text === null ? null : clipTail(`[user] ${text}`, TRANSCRIPT_EVENT_MAX_CHARS);
    }
    case "assistant_message": {
      const text = messageText(ev.payload);
      return text === null ? null : clipTail(`[assistant] ${text}`, TRANSCRIPT_EVENT_MAX_CHARS);
    }
    case "tool_use": {
      const name = typeof p["name"] === "string" ? p["name"] : "(unknown tool)";
      let input = "";
      try {
        input = JSON.stringify(p["input"] ?? null);
      } catch {
        input = "(unserializable input)";
      }
      return clipTail(`[tool_use] ${name} ${input}`, TRANSCRIPT_EVENT_MAX_CHARS);
    }
    case "tool_result": {
      const isError = p["isError"] === true;
      const content =
        typeof p["content"] === "string" ? p["content"] : JSON.stringify(p["content"] ?? "");
      return clipTail(
        `[tool_result${isError ? " ERROR" : ""}] ${content}`,
        TRANSCRIPT_EVENT_MAX_CHARS,
      );
    }
    case "error": {
      const name = typeof p["name"] === "string" ? p["name"] : "error";
      const message = typeof p["message"] === "string" ? p["message"] : "";
      return clipTail(`[error] ${name}: ${message}`, TRANSCRIPT_EVENT_MAX_CHARS);
    }
    case "run_failed": {
      const cls = typeof p["class"] === "string" ? p["class"] : "unknown";
      const message = typeof p["message"] === "string" ? p["message"] : "";
      return clipTail(`[run_failed] ${cls}: ${message}`, TRANSCRIPT_EVENT_MAX_CHARS);
    }
    default:
      return null;
  }
}

/**
 * Render the run's transcript digest for a trajectory judge. See the module
 * doc for the truncation contract. `maxChars` is a test/code seam — the
 * grading path always uses the default budget.
 */
export function renderTranscriptDigest(
  run: RunResult,
  opts: { readonly maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? TRANSCRIPT_DIGEST_MAX_CHARS;
  const rendered = run.transcript.map(renderEvent).filter((line): line is string => line !== null);

  if (rendered.length === 0) {
    // Honest degradation for transcript-less RunResults: the judge sees the
    // final output behind an explicit marker instead of an empty block.
    return `(no transcript recorded)\n[final output] ${clipTail(run.agentOutput, TRANSCRIPT_EVENT_MAX_CHARS)}`;
  }

  // Most-recent-turns-win: keep whole events from the END while they fit.
  // The newest event is always kept (clipped to the budget if it alone
  // exceeds it).
  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const block = rendered[i] as string;
    const cost = block.length + (kept.length > 0 ? 1 : 0); // +1 for the joining newline
    if (kept.length > 0 && used + cost > maxChars) break;
    if (kept.length === 0 && block.length > maxChars) {
      kept.unshift(clipTail(block, maxChars));
      used = maxChars;
      continue;
    }
    kept.unshift(block);
    used += cost;
  }

  const dropped = rendered.length - kept.length;
  const header =
    dropped > 0
      ? `[transcript truncated: showing the most recent ${kept.length} of ${rendered.length} events]\n`
      : "";
  return header + kept.join("\n");
}
