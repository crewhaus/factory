/**
 * Compaction must leave the history ending on a USER turn.
 *
 * Current Claude models reject a trailing assistant message as prefill
 * (`400 "This model does not support assistant message prefill. The
 * conversation must end with a user message."`). autoCompact used to return
 * `[marker, summary]`, and the runtime compacts AFTER the inbound user message
 * is appended — so the first request after every compaction was a prefill
 * 400. The tombstone recovery then "fixed" it by appending "[previous
 * assistant turn was rejected as invalid; please retry]", while the user's
 * actual question had been summarized away.
 *
 * The stub adapter here answers exactly like the API: any main-turn request
 * whose last message is `role: "assistant"` throws the prefill 400. Each of
 * the three compaction call paths — pre-turn under `singleTurn`, pre-turn in
 * the REPL, and reactive `forceCompact` on `prompt_too_long` — must reach the
 * model with the user's pending words, verbatim, as the final message: no 400,
 * no tombstone, and the kept message never externalized as `context_evicted`.
 *
 * Scripted adapter, real session log — no `mock.module`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { COMPACTION_CONTINUE, SUMMARY_MARKER } from "@crewhaus/compaction-autocompact";
import { createRunContext } from "@crewhaus/run-context";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { isSyntheticMessage, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-compact-user-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const PREFILL_MESSAGE =
  "This model does not support assistant message prefill. The conversation must end with a user message.";

/** The Anthropic SDK's shape for the prefill rejection. */
function prefillError(): Error {
  return Object.assign(new Error(`400 ${PREFILL_MESSAGE}`), {
    name: "BadRequestError",
    status: 400,
    error: { type: "invalid_request_error", message: PREFILL_MESSAGE },
  });
}

function promptTooLongError(): Error {
  return Object.assign(new Error("prompt is too long: 250000 tokens > 200000 maximum"), {
    name: "BadRequestError",
    status: 400,
    error: { type: "invalid_request_error", message: "prompt is too long" },
  });
}

function textOf(message: Anthropic.MessageParam | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

const isSummaryRequest = (req: ProviderRequest): boolean =>
  /Summarize the prior conversation/.test(textOf(req.messages[req.messages.length - 1]));

type PrefillStrictAdapter = ProviderAdapter & {
  /** Every main-turn request, in order (summarizer calls excluded). */
  readonly requests: ProviderRequest[];
  /** How many main-turn requests were refused as prefill. */
  prefillRejections: number;
};

/**
 * A provider that behaves like Sonnet 5 / Opus 5 on the one point under test:
 * a main-turn request ending on an assistant message is a 400. Summarizer
 * calls answer "compacted summary"; main turns answer `reply(n)`. `firstError`
 * (when given) is thrown by the FIRST main-turn request, before the prefill
 * check — used to drive the reactive path.
 */
function prefillStrictAdapter(opts: {
  reply?: (n: number) => string;
  firstError?: () => Error;
}): PrefillStrictAdapter {
  const requests: ProviderRequest[] = [];
  const adapter: PrefillStrictAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    requests,
    prefillRejections: 0,
    stream: (req) => {
      const summary = isSummaryRequest(req);
      if (!summary) requests.push({ ...req, messages: [...req.messages] });
      const n = requests.length;
      return (async function* () {
        let text: string;
        if (summary) {
          text = "compacted summary";
        } else {
          if (n === 1 && opts.firstError !== undefined) throw opts.firstError();
          if (req.messages[req.messages.length - 1]?.role === "assistant") {
            adapter.prefillRejections += 1;
            throw prefillError();
          }
          text = opts.reply?.(n) ?? "answer";
        }
        yield { kind: "message_start" } as const;
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield { kind: "message_delta", stopReason: "end_turn" } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return adapter;
}

type LoggedEvent = { readonly kind: string; readonly payload: Record<string, unknown> };

function sessionEvents(root: string): LoggedEvent[] {
  const files = readdirSync(root).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return readFileSync(join(root, files[0] as string), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

/** The shared post-compaction assertions: every main request ended on a user
 *  turn, and the one after compaction is [marker, summary, pending verbatim]. */
function expectCompactedRequest(
  adapter: PrefillStrictAdapter,
  compactedRequest: ProviderRequest | undefined,
  pending: string,
): void {
  expect(adapter.prefillRejections).toBe(0);
  for (const req of adapter.requests) {
    expect(req.messages[req.messages.length - 1]?.role).toBe("user");
  }
  const messages = compactedRequest?.messages ?? [];
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(textOf(messages[0])).toBe(SUMMARY_MARKER);
  expect(textOf(messages[1])).toBe("compacted summary");
  expect(textOf(messages[2])).toBe(pending);
  // The marker is runtime-injected (§7.2.1): routing never reads it as the
  // human's text. The kept message is the human's own and stays unmarked.
  const [marker, , kept] = messages;
  expect(marker !== undefined && isSyntheticMessage(marker)).toBe(true);
  expect(kept !== undefined && isSyntheticMessage(kept)).toBe(false);
}

function expectNoTombstoneAndKeptNotEvicted(events: LoggedEvent[], pending: string): void {
  const userTexts = events
    .filter((e) => e.kind === "user_message")
    .map((e) => e.payload["content"]);
  expect(userTexts.some((c) => typeof c === "string" && c.includes("rejected as invalid"))).toBe(
    false,
  );
  const evicted = events.filter((e) => e.kind === "context_evicted");
  expect(evicted.length).toBeGreaterThan(0);
  // §2.3 — the kept message is still in the history, so it is not copied into
  // the requirements ledger; everything the summary replaced is.
  expect(evicted.some((e) => e.payload["text"] === pending)).toBe(false);
}

const filler = (tag: string): string => `${tag} ${"lorem ipsum dolor sit amet ".repeat(40)}`;

/** Turns the §2.3 requirements ledger on, so evictions land in the session
 *  log as `context_evicted` — the contract the kept message must not break. */
const LEDGER_ON = { loadPlan: async (): Promise<string | null> => null } as const;

/**
 * Bun's readline over a pre-buffered, ended stream delivers only the first
 * line, so a multi-turn REPL test feeds one line per completed turn (the same
 * pump as budget.test.ts), then EOFs.
 */
function interactiveStdin(
  bus: { subscribe(fn: (e: TraceEvent) => void): () => void },
  lines: readonly string[],
): NodeJS.ReadableStream {
  const stream = new PassThrough();
  let i = 0;
  const writeNext = (): void => {
    if (i < lines.length) {
      stream.write(`${lines[i]}\n`);
      i += 1;
    } else {
      stream.end();
    }
  };
  bus.subscribe((e) => {
    if (e.kind === "turn_end") setImmediate(writeNext);
  });
  setImmediate(writeNext);
  return stream;
}

describe("compaction ends the history on a user turn", () => {
  test("pre-turn, singleTurn: the pending inbound message is the final turn, verbatim", async () => {
    const root = mkdtempSync(join(SESSION_ROOT, "single-"));
    const adapter = prefillStrictAdapter({});
    const pending = "What did we decide about the retry budget?";
    const result = await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext: createRunContext(),
      sessionRootDir: root,
      permissionMode: "bypass",
      continuity: LEDGER_ON,
      singleTurn: true,
      // ~4.4K chars of history ≈ 1.1K tokens: over 0.85 × 1K, and five
      // messages sit inside the default snip window, so autocompact fires.
      contextLimit: 1000,
      seedMessages: [
        { role: "user", content: filler("u1") },
        { role: "assistant", content: filler("a1") },
        { role: "user", content: filler("u2") },
        { role: "assistant", content: filler("a2") },
        { role: "user", content: pending },
      ],
    });
    expect(result).toBe("answer");
    expect(adapter.requests).toHaveLength(1);
    expectCompactedRequest(adapter, adapter.requests[0], pending);
    expectNoTombstoneAndKeptNotEvicted(sessionEvents(root), pending);
  });

  test("pre-turn, REPL: the newly typed line is the final turn, verbatim", async () => {
    const root = mkdtempSync(join(SESSION_ROOT, "repl-"));
    const adapter = prefillStrictAdapter({ reply: (n) => filler(`reply-${n}`) });
    const pending = "and the retry budget?";
    const runContext = createRunContext();
    const input = interactiveStdin(runContext.eventBus, [
      filler("first"),
      filler("second"),
      pending,
    ]);
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext,
      sessionRootDir: root,
      permissionMode: "bypass",
      continuity: LEDGER_ON,
      input,
      stdout: () => {},
      contextLimit: 1000,
    });
    // Turns 1–2 fit; turn 3 carries ~4.4K chars of history and compacts.
    expect(adapter.requests).toHaveLength(3);
    expect(adapter.requests[1]?.messages).toHaveLength(3);
    expectCompactedRequest(adapter, adapter.requests[2], pending);
    expectNoTombstoneAndKeptNotEvicted(sessionEvents(root), pending);
  });

  test("reactive forceCompact on prompt_too_long: the retry ends on the pending message", async () => {
    const root = mkdtempSync(join(SESSION_ROOT, "reactive-"));
    const adapter = prefillStrictAdapter({ firstError: promptTooLongError });
    const pending = "summarise the incident for the channel";
    const result = await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext: createRunContext(),
      sessionRootDir: root,
      permissionMode: "bypass",
      continuity: LEDGER_ON,
      singleTurn: true,
      seedMessages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: pending },
      ],
    });
    expect(result).toBe("answer");
    // The prompt_too_long attempt, then exactly one retry — no prefill 400,
    // so no tombstone round-trip in between.
    expect(adapter.requests).toHaveLength(2);
    expectCompactedRequest(adapter, adapter.requests[1], pending);
    const events = sessionEvents(root);
    expectNoTombstoneAndKeptNotEvicted(events, pending);
    // §2.3 — the reactive `compaction` event still persists the summary text
    // (it used to be read only from a two-message result).
    const reactive = events.find(
      (e) => e.kind === "compaction" && e.payload["kind"] === "reactive",
    );
    expect(reactive?.payload["after"]).toBe(3);
    expect(reactive?.payload["summary"]).toBe("compacted summary");
  });

  test("a pending message too large to keep is summarized, and a synthetic continuation ends the history", async () => {
    const root = mkdtempSync(join(SESSION_ROOT, "oversized-"));
    const adapter = prefillStrictAdapter({});
    // > 25% of the 1K context limit, so it is not kept verbatim.
    const pending = filler("an oversized paste");
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext: createRunContext(),
      sessionRootDir: root,
      permissionMode: "bypass",
      continuity: LEDGER_ON,
      singleTurn: true,
      contextLimit: 1000,
      seedMessages: [
        { role: "user", content: filler("u1") },
        { role: "assistant", content: filler("a1") },
        { role: "user", content: filler("u2") },
        { role: "assistant", content: filler("a2") },
        { role: "user", content: pending },
      ],
    });
    expect(adapter.prefillRejections).toBe(0);
    const messages = adapter.requests[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(messages[2])).toBe(COMPACTION_CONTINUE);
    const [, , continuation] = messages;
    expect(continuation !== undefined && isSyntheticMessage(continuation)).toBe(true);
    // Not kept, so it was externalized before the drop like the rest.
    const evicted = sessionEvents(root).filter((e) => e.kind === "context_evicted");
    expect(evicted.some((e) => e.payload["text"] === pending)).toBe(true);
  });
});
