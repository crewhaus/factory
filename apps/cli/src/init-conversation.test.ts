/**
 * v0.3.0 §2.9 / PR 18 — the conversational `crewhaus init --interactive`,
 * driven end-to-end by scripted mock adapters.
 *
 * The suite pins the release's motivating-failure fixes on the creator flow
 * itself: multi-turn stdin with nothing discarded, first-message
 * multi-requirement extraction echoed into the transcript, validation
 * errors revised IN-context (tool errors, not blind re-attempts), the
 * requirements ledger protecting a clarification answer across compaction
 * (never re-asked), resume with a ledger-seeded first message, and a
 * terminal funding failure that leaves a resumable session behind.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { RunFailedError } from "@crewhaus/errors";
import {
  INIT_INTERVIEW_SAVED_NOTE,
  InterviewIncompleteError,
  RESUME_KICKOFF_MESSAGE,
  conversationalPathAllowed,
  extractReqMappingLines,
  runConversationalInterview,
} from "./init-conversation";
import { renderCliFailure } from "./run-failure";

const TMP_ROOTS: string[] = [];
function newTargetDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-init-conv-${name}-`));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scripted adapter (the continuity.test.ts pattern): one content-block array
// per model CALL, full request capture (system blocks included) so ledger
// re-injection and toolChoice absence can be asserted byte-for-byte.
// ---------------------------------------------------------------------------

type StreamRequest = Parameters<ProviderAdapter["stream"]>[0];
type ScriptBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function makeScriptedAdapter(
  scripts: ScriptBlock[][],
  opts: { throwAtCall?: { index: number; error: unknown } } = {},
): {
  adapter: ProviderAdapter;
  requests: () => StreamRequest[];
  callCount: () => number;
} {
  const requests: StreamRequest[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      requests.push({
        ...req,
        system: req.system.map((b) => ({ ...b })),
        messages: req.messages.map((m) => ({ ...m })),
      } as StreamRequest);
      const callIndex = i;
      i++;
      if (opts.throwAtCall !== undefined && callIndex === opts.throwAtCall.index) {
        const err = opts.throwAtCall.error;
        return (async function* () {
          throw err;
          // biome-ignore lint/correctness/noUnreachable: keeps the function a generator
          yield undefined as never;
        })();
      }
      const content = scripts[Math.min(callIndex, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block === undefined) continue;
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          }
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return { adapter, requests: () => requests, callCount: () => i };
}

/**
 * Deterministic stdin pacing for REPL-driven tests: pre-buffered lines on an
 * OPEN PassThrough race the readline question (a line arriving with no
 * pending question can be dropped), so instead each line is written only
 * when the REPL actually prompts — `rl.question("\nyou> ")` writes its
 * prompt to process.stdout synchronously while the question is pending,
 * which is the reliable "now it's listening" signal. When the lines run out
 * and `endWhenExhausted` is set, the next prompt gets EOF instead.
 */
function paceStdin(
  input: PassThrough,
  lines: string[],
  opts: { endWhenExhausted?: boolean } = {},
): { restore(): void } {
  const original = process.stdout.write.bind(process.stdout);
  const patched: typeof process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    if (text.includes("you> ")) {
      const next = lines.shift();
      queueMicrotask(() => {
        if (next !== undefined) input.write(next);
        else if (opts.endWhenExhausted === true) input.end();
      });
    }
    // biome-ignore lint/suspicious/noExplicitAny: pass-through of the node overloads
    return original(chunk as any, ...(rest as [any?, any?]));
  };
  process.stdout.write = patched;
  return {
    restore: () => {
      process.stdout.write = original;
    },
  };
}

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readSessionLines(targetDir: string, sessionId: string): LoggedLine[] {
  const file = join(targetDir, ".crewhaus", "sessions", `${sessionId}.jsonl`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as LoggedLine);
}

function assistantText(line: LoggedLine): string {
  const content = line.payload?.["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: unknown; text?: unknown };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("\n");
  }
  return "";
}

const systemTexts = (req: StreamRequest | undefined): string[] =>
  (req?.system ?? []).map((b) => b.text);

const VALID_YAML =
  "name: acme-bot\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: Answer only from the FAQ.\n";
const INVALID_YAML = "name: acme-bot\ntarget: cli\nagent:\n  model: claude-opus-4-7\n";

const MAPPING_REPLY = [
  "All requirements are confirmed and map to spec fields:",
  'REQ-001 "support bot for Acme" → name',
  'REQ-002 "claude-opus-4-7" → agent.model',
  'REQ-003 "only answer from the FAQ" → agent.instructions',
  'REQ-004 "terminal (cli)" → target',
].join("\n");

// Real Anthropic out-of-credit shape as normalised by adapter-anthropic —
// the same fixture run-failed.test.ts pins (classify → billing → halt).
const BILLING_ERROR = Object.assign(
  new Error(
    "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  ),
  {
    providerId: "anthropic",
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  },
);

describe("runConversationalInterview — the full conversation", () => {
  test("multi-REQ extraction echoed, ask_user answered over stdin, spec written, mapping surfaced — no forced toolChoice", async () => {
    const targetDir = newTargetDir("full");
    const homeDir = newTargetDir("home-full");
    const main = makeScriptedAdapter([
      // Turn 1 — extract every requirement from the opening message, echo
      // them back, then ask ONE clarifying question.
      [
        {
          type: "text",
          text: 'Got it. Requirements so far: REQ-001 "support bot for Acme"; REQ-002 "claude-opus-4-7"; REQ-003 "only answer from the FAQ". Open questions: delivery surface.',
        },
        {
          type: "tool_use",
          id: "tu_ask1",
          name: "ask_user",
          input: { question: "Should this run as a terminal (cli) agent or a channel bot?" },
        },
      ],
      // ask_user tool result → end the turn and wait for the answer.
      [{ type: "text", text: "(waiting for your answer)" }],
      // Turn 2 — the answer arrived as a user message; confirm, map, emit.
      [
        { type: "text", text: `REQ-004 confirmed. ${MAPPING_REPLY}` },
        { type: "tool_use", id: "tu_emit1", name: "emit_spec", input: { yaml: VALID_YAML } },
      ],
      // emit_spec success → closing confirmation; the loop then ends itself.
      [{ type: "text", text: "Interview complete — crewhaus.yaml validated." }],
    ]);

    const input = new PassThrough();
    // Deliberately never EOF'd: a validated emit_spec must end the interview
    // on its own (the turn_end abort), never a stdin EOF.
    const pacer = paceStdin(input, [
      "Build a support bot for Acme on claude-opus-4-7 that must only answer from the FAQ.\n",
      "A terminal (cli) agent.\n",
    ]);

    const logLines: string[] = [];
    let result: Awaited<ReturnType<typeof runConversationalInterview>>;
    try {
      result = await runConversationalInterview({
        targetDir,
        specName: "init-acme-bot",
        model: "test-model",
        log: (line) => {
          logLines.push(line);
        },
        _adapter: main.adapter,
        input,
        homeDir,
      });
    } finally {
      pacer.restore();
    }

    // Outcome: the exact YAML the model emitted, parsed by the live union.
    expect(result.yaml).toBe(VALID_YAML);
    expect(result.spec.target).toBe("cli");
    expect(result.mappingLines).toEqual([
      'REQ-001 "support bot for Acme" → name',
      'REQ-002 "claude-opus-4-7" → agent.model',
      'REQ-003 "only answer from the FAQ" → agent.instructions',
      'REQ-004 "terminal (cli)" → target',
    ]);

    // NO forced toolChoice on any call, and BOTH interview tools advertised
    // alongside the continuity fabric's tools.
    expect(main.callCount()).toBe(4);
    for (const req of main.requests()) {
      expect((req as { toolChoice?: unknown }).toolChoice).toBeUndefined();
    }
    const toolNames = (main.requests()[0]?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("ask_user");
    expect(toolNames).toContain("emit_spec");
    expect(toolNames).toContain("FocusWrite");

    // The clarifying question was surfaced on the terminal…
    expect(
      logLines.some((l) =>
        l.includes("[interviewer] Should this run as a terminal (cli) agent or a channel bot?"),
      ),
    ).toBe(true);
    // …and the continuity fabric announced itself at boot.
    expect(logLines.some((l) => l.includes("[memory] continuity on"))).toBe(true);

    // The user's ANSWER reached the model as the next user message —
    // multi-turn stdin, nothing discarded (the single-shot path threw this
    // exact line away).
    const finalTurnMessages = JSON.stringify(main.requests()[2]?.messages ?? []);
    expect(finalTurnMessages).toContain("A terminal (cli) agent.");

    // Persisted transcript: the session is on disk under the TARGET dir with
    // both user lines, and the first assistant message echoes every REQ.
    const lines = readSessionLines(targetDir, result.sessionId);
    const userEvents = lines.filter((l) => l.kind === "user_message");
    expect(JSON.stringify(userEvents)).toContain("Build a support bot for Acme");
    expect(JSON.stringify(userEvents)).toContain("A terminal (cli) agent.");
    const firstAssistant = lines.find((l) => l.kind === "assistant_message");
    expect(firstAssistant).toBeDefined();
    const echo = assistantText(firstAssistant as LoggedLine);
    expect(echo).toContain("Requirements so far");
    expect(echo).toContain("REQ-001");
    expect(echo).toContain("REQ-002");
    expect(echo).toContain("REQ-003");
    const meta = JSON.parse(
      readFileSync(join(targetDir, ".crewhaus", "sessions", `${result.sessionId}.json`), "utf-8"),
    ) as { name?: string };
    expect(meta.name).toBe("init-acme-bot");
  });
});

describe("runConversationalInterview — emit_spec validation errors revise in-context", () => {
  test("an invalid draft returns as a tool error and the corrected re-emit happens in the SAME conversation", async () => {
    const targetDir = newTargetDir("revise");
    const homeDir = newTargetDir("home-revise");
    const main = makeScriptedAdapter([
      [
        { type: "text", text: 'REQ-001 "acme bot" → name. Emitting.' },
        { type: "tool_use", id: "tu_bad", name: "emit_spec", input: { yaml: INVALID_YAML } },
      ],
      // The validator's SpecParseError arrives as an is_error tool result;
      // the model fixes exactly that error and re-emits — no restart.
      [
        { type: "text", text: "Fixing the missing instructions field." },
        { type: "tool_use", id: "tu_good", name: "emit_spec", input: { yaml: VALID_YAML } },
      ],
      [{ type: "text", text: "Validated." }],
    ]);

    const input = new PassThrough();
    const pacer = paceStdin(input, ["Build the acme bot.\n"]);

    let result: Awaited<ReturnType<typeof runConversationalInterview>>;
    try {
      result = await runConversationalInterview({
        targetDir,
        specName: "init-acme-bot",
        model: "test-model",
        log: () => {},
        _adapter: main.adapter,
        input,
        homeDir,
      });
    } finally {
      pacer.restore();
    }

    expect(result.yaml).toBe(VALID_YAML);
    // The second model call carries the validation error as a TOOL ERROR in
    // the conversation — not a fresh single-shot attempt with a feedback
    // string (call 2 still contains the full turn history).
    const call2 = main.requests()[1];
    const toolResults = (call2?.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => (b as { type?: string }).type === "tool_result")
        : [],
    ) as Array<{ tool_use_id: string; content?: unknown; is_error?: boolean }>;
    const errorResult = toolResults.find((r) => r.tool_use_id === "tu_bad");
    expect(errorResult).toBeDefined();
    expect(errorResult?.is_error).toBe(true);
    expect(JSON.stringify(errorResult?.content)).toContain("instructions");
    // One session, one conversation: exactly three model calls, no restarts.
    expect(main.callCount()).toBe(3);
  });
});

describe("runConversationalInterview — the ledger protects answers across compaction (never re-asked)", () => {
  test("a compaction-evicted clarification answer reaches the final model call verbatim in <requirements_ledger>, and ask_user ran exactly once", async () => {
    const targetDir = newTargetDir("ledger");
    const homeDir = newTargetDir("home-ledger");
    const ANSWER =
      "Use a semicolon (;) as the CSV delimiter, and always quote fields that contain one.";
    const SUMMARY_OMITTING_ANSWER =
      "Summary: the user wants a CSV exporter; implementation details were discussed.";
    const filler = (seed: string): string => `${seed} ${"x".repeat(400)}`;

    const main = makeScriptedAdapter([
      // Turn 1 — long opening; ask the delimiter question.
      [
        { type: "text", text: filler("REQ-001 pinned: a CSV exporter agent.") },
        {
          type: "tool_use",
          id: "tu_ask_delim",
          name: "ask_user",
          input: { question: "Which delimiter should the export use?" },
        },
      ],
      [{ type: "text", text: filler("(waiting for your answer)") }],
      // Turn 2 — the ANSWER arrives; the tiny context limit trips
      // snip+autocompact BEFORE this call, evicting the middle (and the
      // answer) exactly like the motivating failure.
      [{ type: "text", text: filler("REQ-002 confirmed: semicolon delimiter.") }],
      // Turn 3 — history now holds only the (answer-omitting) summary; the
      // ledger re-injects the answer, so the model emits without re-asking.
      [
        { type: "text", text: 'REQ-002 "semicolon delimiter" → agent.instructions' },
        { type: "tool_use", id: "tu_emit", name: "emit_spec", input: { yaml: VALID_YAML } },
      ],
      [{ type: "text", text: "Done." }],
    ]);
    // The autocompact summarizer DELIBERATELY omits the answer — the exact
    // "unverified summary dropped the requirement" failure. Correctness must
    // not depend on it.
    const summarizer = makeScriptedAdapter([[{ type: "text", text: SUMMARY_OMITTING_ANSWER }]]);

    const input = new PassThrough();
    const pacer = paceStdin(input, [
      `${filler("Build a CSV exporter agent.")}\n`,
      `${ANSWER}\n`,
      "Nothing else — emit the spec now.\n",
    ]);

    let result: Awaited<ReturnType<typeof runConversationalInterview>>;
    try {
      result = await runConversationalInterview({
        targetDir,
        specName: "init-csv-exporter",
        model: "test-model",
        log: () => {},
        _adapter: main.adapter,
        _compactionAdapter: summarizer.adapter,
        input,
        homeDir,
        _compaction: {
          contextLimit: 400,
          compactionThreshold: 0.5,
          snipKeepHead: 1,
          snipKeepTail: 2,
        },
      });
    } finally {
      pacer.restore();
    }

    expect(result.yaml).toBe(VALID_YAML);
    expect(summarizer.callCount()).toBeGreaterThanOrEqual(1);

    // The final emit turn's model call: the ANSWER is gone from message
    // history (genuinely evicted — only the answer-omitting summary remains)…
    const emitCall = main.requests()[3];
    expect(emitCall).toBeDefined();
    const emitHistory = JSON.stringify(emitCall?.messages ?? []);
    expect(emitHistory).not.toContain(ANSWER);
    expect(emitHistory).toContain(SUMMARY_OMITTING_ANSWER);
    // …but re-injected VERBATIM in the <requirements_ledger> tail block —
    // the model never needs to re-ask.
    // startsWith, not includes: the interview system prompt itself MENTIONS
    // the <requirements_ledger> tag; the rendered tail block begins with it.
    const ledgerBlock = systemTexts(emitCall).find((t) => t.startsWith("<requirements_ledger>"));
    expect(ledgerBlock).toBeDefined();
    expect(ledgerBlock).toContain(ANSWER);

    // Durable, zero-model-trust: the eviction landed in the event log…
    const lines = readSessionLines(targetDir, result.sessionId);
    expect(
      lines.some(
        (l) =>
          l.kind === "context_evicted" &&
          l.payload?.["role"] === "user" &&
          l.payload?.["text"] === ANSWER,
      ),
    ).toBe(true);
    // …and the transcript shows the question was asked exactly ONCE — the
    // second ask attempt (the motivating failure) is absent.
    const askUses = lines.filter(
      (l) => l.kind === "tool_use" && l.payload?.["name"] === "ask_user",
    );
    expect(askUses.length).toBe(1);
  });
});

describe("runConversationalInterview — resume", () => {
  test("an interrupted interview resumes: ledger-seeded first assistant message, replayed history, no duplicate questions", async () => {
    const targetDir = newTargetDir("resume");
    const homeDir = newTargetDir("home-resume");
    const OPENING = "Build a support bot for Acme; it must answer from the FAQ only.";
    const FOCUS =
      'REQ-001 "support bot for Acme" (confirmed); REQ-002 "answer from the FAQ only" (confirmed); open: delivery surface?';

    // ---- Session 1: pin the REQs, ask, then the terminal dies (EOF). ----
    const first = makeScriptedAdapter([
      [
        { type: "text", text: "Got it. Requirements so far: REQ-001; REQ-002." },
        { type: "tool_use", id: "tu_focus", name: "FocusWrite", input: { focus: FOCUS } },
        {
          type: "tool_use",
          id: "tu_ask",
          name: "ask_user",
          input: { question: "Should it run in the terminal or on a channel?" },
        },
      ],
      [{ type: "text", text: "(waiting for your answer)" }],
    ]);
    const input1 = new PassThrough();
    // The session dies (EOF) before the user can answer the open question.
    const pacer1 = paceStdin(input1, [`${OPENING}\n`], { endWhenExhausted: true });

    let incomplete: unknown;
    try {
      await runConversationalInterview({
        targetDir,
        specName: "init-acme-bot",
        model: "test-model",
        log: () => {},
        _adapter: first.adapter,
        input: input1,
        homeDir,
      });
    } catch (err) {
      incomplete = err;
    } finally {
      pacer1.restore();
    }
    expect(incomplete).toBeInstanceOf(InterviewIncompleteError);
    expect((incomplete as Error).message).toContain(INIT_INTERVIEW_SAVED_NOTE);

    // ---- Session 2: --resume. ----
    const second = makeScriptedAdapter([
      // Kick-off turn: the FIRST assistant message is the resume summary,
      // and the still-open question is re-surfaced (never the confirmed ones).
      [
        {
          type: "text",
          text: "Resuming: 2 requirements confirmed, 1 open question (delivery surface).",
        },
        {
          type: "tool_use",
          id: "tu_ask2",
          name: "ask_user",
          input: { question: "Still open: terminal or channel?" },
        },
      ],
      [{ type: "text", text: "(waiting for your answer)" }],
      [
        { type: "text", text: 'REQ-003 confirmed. REQ-001 "support bot for Acme" → name' },
        { type: "tool_use", id: "tu_emit2", name: "emit_spec", input: { yaml: VALID_YAML } },
      ],
      [{ type: "text", text: "Validated — resuming paid off." }],
    ]);
    const input2 = new PassThrough();
    const pacer2 = paceStdin(input2, ["Terminal.\n"]);

    let result: Awaited<ReturnType<typeof runConversationalInterview>>;
    try {
      result = await runConversationalInterview({
        targetDir,
        specName: "init-acme-bot",
        model: "test-model",
        resume: true,
        log: () => {},
        _adapter: second.adapter,
        input: input2,
        homeDir,
      });
    } finally {
      pacer2.restore();
    }

    expect(result.yaml).toBe(VALID_YAML);

    // The kick-off model call was SEEDED, not user-typed: history replayed
    // (the opening requirement is present), the synthetic kick-off is the
    // last user message, and the session-1 focus (the pinned REQs) rides in
    // the <current_plan> tail — the ledger-seeded first message.
    const kickoff = second.requests()[0];
    const kickoffHistory = JSON.stringify(kickoff?.messages ?? []);
    expect(kickoffHistory).toContain(OPENING);
    // (JSON-escaped, so match on the quote-free head of the kick-off text.)
    expect(RESUME_KICKOFF_MESSAGE).toContain("Resume the interview from the saved session");
    expect(kickoffHistory).toContain("Resume the interview from the saved session");
    // startsWith, not includes: the interview system prompt itself MENTIONS
    // the <current_plan> tag; the rendered tail block begins with it.
    const planBlock = systemTexts(kickoff).find((t) => t.startsWith("<current_plan>"));
    expect(planBlock).toBeDefined();
    expect(planBlock).toContain('REQ-001 "support bot for Acme"');

    // The resumed session's first assistant message IS the resume summary.
    const lines = readSessionLines(targetDir, result.sessionId);
    const kickoffIndex = lines.findIndex(
      (l) =>
        l.kind === "user_message" && JSON.stringify(l.payload).includes("Resume the interview"),
    );
    expect(kickoffIndex).toBeGreaterThan(-1);
    const firstResumedAssistant = lines
      .slice(kickoffIndex)
      .find((l) => l.kind === "assistant_message");
    expect(assistantText(firstResumedAssistant as LoggedLine)).toStartWith("Resuming: 2");

    // No duplicate questions: across BOTH sessions the transcript holds
    // exactly the one original ask and the one open-question re-surface —
    // the confirmed REQs were never re-asked.
    const askUses = lines.filter(
      (l) => l.kind === "tool_use" && l.payload?.["name"] === "ask_user",
    );
    expect(askUses.length).toBe(2);
  });

  test("--resume with no saved interview fails with a start-fresh hint", async () => {
    const targetDir = newTargetDir("resume-none");
    const homeDir = newTargetDir("home-resume-none");
    const main = makeScriptedAdapter([[{ type: "text", text: "unused" }]]);
    const input = new PassThrough();
    input.end();
    await expect(
      runConversationalInterview({
        targetDir,
        specName: "init-nothing",
        model: "test-model",
        resume: true,
        log: () => {},
        _adapter: main.adapter,
        input,
        homeDir,
      }),
    ).rejects.toThrow(/no saved interview .* crewhaus init --interactive/);
  });
});

describe("runConversationalInterview — terminal failure mid-interview", () => {
  test("a funding failure surfaces the classified FailureReport + saved-interview hint, and --resume completes the interview", async () => {
    const targetDir = newTargetDir("failure");
    const homeDir = newTargetDir("home-failure");
    const OPENING = "Build the acme bot on claude-opus-4-7.";
    const ANSWER = "Terminal agent, please.";

    // ---- Session 1: question asked, answer given, then the account runs dry.
    const first = makeScriptedAdapter(
      [
        [
          { type: "text", text: "REQ-001 pinned." },
          {
            type: "tool_use",
            id: "tu_ask",
            name: "ask_user",
            input: { question: "Terminal or channel?" },
          },
        ],
        [{ type: "text", text: "(waiting)" }],
        [{ type: "text", text: "never reached" }],
      ],
      { throwAtCall: { index: 2, error: BILLING_ERROR } },
    );
    const input1 = new PassThrough();
    const pacer1 = paceStdin(input1, [`${OPENING}\n`, `${ANSWER}\n`]);

    let failure: unknown;
    try {
      await runConversationalInterview({
        targetDir,
        specName: "init-acme-bot",
        model: "test-model",
        log: () => {},
        _adapter: first.adapter,
        input: input1,
        homeDir,
      });
    } catch (err) {
      failure = err;
    } finally {
      pacer1.restore();
    }
    expect(failure).toBeInstanceOf(RunFailedError);
    if (!(failure instanceof RunFailedError)) return;
    expect(failure.report.class).toBe("billing");
    expect(failure.report.exitCode).toBe(31);

    // The CLI surface: the PR-3 FailureReport + the saved-interview hint —
    // exactly what runInitInteractive prints before exiting with code 31.
    const rendered = renderCliFailure(failure, { notes: [INIT_INTERVIEW_SAVED_NOTE] });
    expect(rendered.exitCode).toBe(31);
    expect(rendered.text).toContain("provider account out of funding");
    expect(rendered.text).toContain("Your credit balance is too low");
    expect(rendered.text).toContain(INIT_INTERVIEW_SAVED_NOTE);

    // The interview is genuinely saved: the transcript (incl. the answer
    // typed seconds before the failure) is on disk.
    const store = await import("@crewhaus/session-store");
    const sessions = await store
      .createSessionStore({ rootDir: join(targetDir, ".crewhaus", "sessions") })
      .list();
    const failedSessionId = sessions.find((s: { name: string }) => s.name === "init-acme-bot")?.id;
    expect(failedSessionId).toBeDefined();
    const savedLines = readSessionLines(targetDir, failedSessionId as string);
    expect(JSON.stringify(savedLines)).toContain(ANSWER);

    // ---- Session 2: --resume completes with everything already answered.
    const second = makeScriptedAdapter([
      [
        {
          type: "text",
          text: 'Resuming: 2 requirements confirmed, 0 open questions. REQ-001 "acme bot" → name',
        },
        { type: "tool_use", id: "tu_emit", name: "emit_spec", input: { yaml: VALID_YAML } },
      ],
      [{ type: "text", text: "Complete." }],
    ]);
    const input2 = new PassThrough();
    input2.end(); // nothing left to type — the kick-off turn finishes the job

    const result = await runConversationalInterview({
      targetDir,
      specName: "init-acme-bot",
      model: "test-model",
      resume: true,
      log: () => {},
      _adapter: second.adapter,
      input: input2,
      homeDir,
    });
    expect(result.yaml).toBe(VALID_YAML);
    expect(result.sessionId).toBe(failedSessionId as string);
    // The pre-failure answer was replayed into the resumed context — no
    // work redone, nothing re-asked.
    expect(JSON.stringify(second.requests()[0]?.messages ?? [])).toContain(ANSWER);
  });
});

describe("conversationalPathAllowed — the TTY / --yes gate", () => {
  test("allows only an interactive TTY without --yes", () => {
    expect(conversationalPathAllowed({ stdinIsTTY: true, assumeYes: false }).allowed).toBe(true);
    const nonTty = conversationalPathAllowed({ stdinIsTTY: false, assumeYes: false });
    expect(nonTty.allowed).toBe(false);
    expect(nonTty.reason).toContain("TTY");
    const yes = conversationalPathAllowed({ stdinIsTTY: true, assumeYes: true });
    expect(yes.allowed).toBe(false);
    expect(yes.reason).toContain("--yes");
  });
});

describe("extractReqMappingLines", () => {
  test("returns the LAST assistant message's REQ → field lines, tolerating garbage", () => {
    const jsonl = [
      "not json at all",
      JSON.stringify({ kind: "user_message", payload: { content: "REQ-001 → decoy" } }),
      JSON.stringify({
        kind: "assistant_message",
        payload: { content: [{ type: "text", text: 'early draft:\nREQ-001 "a" → name' }] },
      }),
      JSON.stringify({
        kind: "assistant_message",
        payload: {
          content: [
            {
              type: "text",
              text: 'final mapping:\nREQ-001 "a" → name\nREQ-002 "b" -> agent.model\nno req here',
            },
          ],
        },
      }),
    ].join("\n");
    expect(extractReqMappingLines(jsonl)).toEqual([
      'REQ-001 "a" → name',
      'REQ-002 "b" -> agent.model',
    ]);
  });

  test("returns [] when no assistant message carries a mapping", () => {
    const jsonl = JSON.stringify({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "hello" }] },
    });
    expect(extractReqMappingLines(jsonl)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLI-level regression fences: the scripted fallback stays byte-identical,
// and the conversational path is refused without a TTY (or with --yes).
// ---------------------------------------------------------------------------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

async function runInitCli(
  args: ReadonlyArray<string>,
  opts: { cwd: string; stdin: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, "init", "--interactive", ...args], {
    cwd: opts.cwd,
    env: { PATH: process.env["PATH"] ?? "", ...(opts.env ?? {}) },
    stdin: Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("crewhaus init --interactive — scripted fallback + non-TTY gating (subprocess)", () => {
  test("no credentials → the scripted questionnaire, byte-identical output, validated spec on disk", async () => {
    const root = newTargetDir("cli-fallback");
    mkdirSync(root, { recursive: true });
    const { exitCode, stdout } = await runInitCli(["scripted-bot"], {
      cwd: root,
      stdin: "\n\n\nhelp users\n\n",
    });
    expect(exitCode).toBe(0);
    // The subprocess resolves paths through the real cwd (/private/var on
    // macOS), so compare against the realpath'd root.
    const targetFile = join(realpathSync(root), "scripted-bot", "crewhaus.yaml");
    const expectedLines = [
      "no model credentials detected — falling back to the scripted questionnaire.\n",
      "harness name [scripted-bot]: ",
      "target shape (cli | workflow | research) [cli]: ",
      "model [claude-opus-4-7]: ",
      "one-line instructions for the agent: ",
      "tools (comma-separated names, or blank): ",
      `wrote ${targetFile}\n`,
      "next: cd scripted-bot && crewhaus run crewhaus.yaml\n",
    ];
    expect(stdout).toBe(expectedLines.join(""));
    const yaml = readFileSync(targetFile, "utf-8");
    expect(yaml).toContain("name: scripted-bot");
    expect(yaml).toContain("target: cli");
    expect(yaml).toContain("help users");
  });

  test("credentials but no TTY → the conversational path is refused; the scripted questionnaire runs", async () => {
    const root = newTargetDir("cli-notty");
    mkdirSync(root, { recursive: true });
    const { exitCode, stdout } = await runInitCli(["gated-bot"], {
      cwd: root,
      stdin: "\n\n\nhelp users\n\n",
      env: { ANTHROPIC_API_KEY: "sk-ant-api01-test" },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "the conversational interview needs an interactive terminal (TTY) — falling back to the scripted questionnaire.\n",
    );
    expect(stdout).not.toContain("interactive spec authoring");
    expect(existsSync(join(root, "gated-bot", "crewhaus.yaml"))).toBe(true);
  });

  test("--yes with credentials → scripted questionnaire by request", async () => {
    const root = newTargetDir("cli-yes");
    mkdirSync(root, { recursive: true });
    const { exitCode, stdout } = await runInitCli(["yes-bot", "--yes"], {
      cwd: root,
      stdin: "\n\n\nhelp users\n\n",
      env: { ANTHROPIC_API_KEY: "sk-ant-api01-test" },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "--yes requested the scripted questionnaire — falling back to the scripted questionnaire.\n",
    );
    expect(existsSync(join(root, "yes-bot", "crewhaus.yaml"))).toBe(true);
  });

  test("--resume without the conversational path refuses with a clear error", async () => {
    const root = newTargetDir("cli-resume-refuse");
    mkdirSync(root, { recursive: true });
    const { exitCode, stderr } = await runInitCli(["resume-bot", "--resume"], {
      cwd: root,
      stdin: "",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "crewhaus init --interactive --resume needs the conversational interview",
    );
  });
});
