import { describe, expect, test } from "bun:test";
import {
  type SessionLogEvent,
  advanceSessionTail,
  formatSessionEvent,
  formatSessionEventTime,
  formatUsdMicros,
  parseSessionEventLine,
  pickSessionToTail,
  renderSessionLog,
} from "./sessions-tail";

const TS = Date.UTC(2026, 6, 17, 13, 5, 9); // 13:05:09 UTC

describe("formatSessionEventTime", () => {
  test("renders UTC HH:MM:SS deterministically", () => {
    expect(formatSessionEventTime(TS)).toBe("13:05:09");
  });
  test("guards a missing/NaN ts", () => {
    expect(formatSessionEventTime(undefined)).toBe("--:--:--");
    expect(formatSessionEventTime(Number.NaN)).toBe("--:--:--");
  });
});

describe("formatSessionEvent", () => {
  const opts = { withTime: false } as const;

  test("user_message with string content renders `user>`", () => {
    const ev: SessionLogEvent = {
      ts: TS,
      kind: "user_message",
      payload: { content: "hello there" },
    };
    expect(formatSessionEvent(ev, opts)).toBe("user> hello there");
  });

  test("synthetic user_message renders `sys>`", () => {
    const ev: SessionLogEvent = {
      kind: "user_message",
      payload: { content: "continue", synthetic: true },
    };
    expect(formatSessionEvent(ev, opts)).toBe("sys> continue");
  });

  test("tool-result echo user_message (block array, no text) renders nothing", () => {
    const ev: SessionLogEvent = {
      kind: "user_message",
      payload: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    };
    expect(formatSessionEvent(ev, opts)).toBeUndefined();
  });

  test("assistant_message renders text and notes tool calls", () => {
    const textOnly: SessionLogEvent = {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "Let me check." }] },
    };
    expect(formatSessionEvent(textOnly, opts)).toBe("asst> Let me check.");

    const withTools: SessionLogEvent = {
      kind: "assistant_message",
      payload: {
        content: [
          { type: "text", text: "Reading files." },
          { type: "tool_use", id: "t1", name: "read", input: {} },
        ],
      },
    };
    expect(formatSessionEvent(withTools, opts)).toBe("asst> Reading files. (+1 tool call)");

    const toolsOnly: SessionLogEvent = {
      kind: "assistant_message",
      payload: {
        content: [
          { type: "tool_use", id: "t1", name: "read", input: {} },
          { type: "tool_use", id: "t2", name: "grep", input: {} },
        ],
      },
    };
    expect(formatSessionEvent(toolsOnly, opts)).toBe("asst> (2 tool calls)");
  });

  test("tool_use renders name + input, tool_result renders content + error flag", () => {
    const use: SessionLogEvent = {
      kind: "tool_use",
      payload: { id: "t1", name: "bash", input: { command: "ls" } },
    };
    expect(formatSessionEvent(use, opts)).toBe('  ↳ bash({"command":"ls"})');

    const ok: SessionLogEvent = {
      kind: "tool_result",
      payload: { toolUseId: "t1", content: "a\nb" },
    };
    expect(formatSessionEvent(ok, opts)).toBe("  ⤶ a b");

    const err: SessionLogEvent = {
      kind: "tool_result",
      payload: { toolUseId: "t1", content: "boom", isError: true },
    };
    expect(formatSessionEvent(err, opts)).toBe("  ⤶ ERROR boom");
  });

  test("error + run_failed render their class/message", () => {
    expect(
      formatSessionEvent({ kind: "error", payload: { name: "RateLimit", message: "429" } }, opts),
    ).toBe("  ! RateLimit: 429");
    expect(
      formatSessionEvent(
        { kind: "run_failed", payload: { class: "billing", message: "out of funds" } },
        opts,
      ),
    ).toBe("  ✗ run failed [billing] out of funds");
  });

  test("side-channel kinds render nothing", () => {
    for (const kind of [
      "tool_stats",
      "model_meta",
      "mcp_stats",
      "permission",
      "recovery",
      "toolset",
      "context_evicted",
    ]) {
      expect(formatSessionEvent({ kind, payload: {} }, opts)).toBeUndefined();
    }
  });

  test("0.6.0 — routing kinds render by default and are hidden by transcriptOnly", () => {
    for (const kind of ["model_route", "cost_accrual", "model_stage", "judge_verdict"]) {
      expect(formatSessionEvent({ kind, payload: {} }, opts)).toBeDefined();
      expect(
        formatSessionEvent({ kind, payload: {} }, { ...opts, transcriptOnly: true }),
      ).toBeUndefined();
    }
  });

  test("prefixes the UTC time by default", () => {
    const ev: SessionLogEvent = { ts: TS, kind: "user_message", payload: { content: "hi" } };
    expect(formatSessionEvent(ev)).toBe("13:05:09 user> hi");
  });

  test("truncates long text", () => {
    const ev: SessionLogEvent = {
      kind: "user_message",
      payload: { content: "x".repeat(500) },
    };
    const line = formatSessionEvent(ev, { withTime: false, maxChars: 10 });
    expect(line).toBe(`user> ${"x".repeat(9)}…`);
  });
});

describe("parseSessionEventLine", () => {
  test("parses a JSON object line, tolerates junk", () => {
    expect(parseSessionEventLine('{"kind":"error","payload":{}}')).toEqual({
      kind: "error",
      payload: {},
    });
    expect(parseSessionEventLine("")).toBeUndefined();
    expect(parseSessionEventLine("not json")).toBeUndefined();
    expect(parseSessionEventLine("123")).toBeUndefined();
  });
});

describe("renderSessionLog", () => {
  test("renders each transcript line, skipping side-channel + blank", () => {
    const text = [
      JSON.stringify({ ts: TS, kind: "user_message", payload: { content: "hi" } }),
      JSON.stringify({ ts: TS, kind: "tool_stats", payload: { toolName: "x" } }),
      JSON.stringify({ ts: TS, kind: "model_route", payload: { model: "x" } }),
      JSON.stringify({
        ts: TS,
        kind: "assistant_message",
        payload: { content: [{ type: "text", text: "yo" }] },
      }),
      "",
    ].join("\n");
    // 0.6.0 — the route line renders between the turns; the transcript-only
    // view is the 0.5.x output.
    expect(renderSessionLog(text, { withTime: false })).toEqual([
      "user> hi",
      "  ⇢ route x",
      "asst> yo",
    ]);
    expect(renderSessionLog(text, { withTime: false, transcriptOnly: true })).toEqual([
      "user> hi",
      "asst> yo",
    ]);
  });
});

describe("advanceSessionTail", () => {
  test("only emits newly-appended, newline-terminated lines", () => {
    const l1 = `${JSON.stringify({ kind: "user_message", payload: { content: "one" } })}\n`;
    const l2 = `${JSON.stringify({ kind: "assistant_message", payload: { content: [{ type: "text", text: "two" }] } })}\n`;

    const first = advanceSessionTail(l1, { lineCount: 0 }, { withTime: false });
    expect(first.lines).toEqual(["user> one"]);
    expect(first.cursor.lineCount).toBe(1);

    // Re-poll with the same content → nothing new.
    const stable = advanceSessionTail(l1, first.cursor, { withTime: false });
    expect(stable.lines).toEqual([]);
    expect(stable.cursor.lineCount).toBe(1);

    // Second event appended.
    const second = advanceSessionTail(l1 + l2, first.cursor, { withTime: false });
    expect(second.lines).toEqual(["asst> two"]);
    expect(second.cursor.lineCount).toBe(2);
  });

  test("does not consume a partially-written last line until its newline lands", () => {
    const full = `${JSON.stringify({ kind: "user_message", payload: { content: "done" } })}\n`;
    const partial = `${full}{"kind":"user_message","payload":{"content":"half`; // no newline yet
    const step = advanceSessionTail(partial, { lineCount: 0 }, { withTime: false });
    expect(step.lines).toEqual(["user> done"]);
    expect(step.cursor.lineCount).toBe(1);

    // The partial line completes on the next write.
    const completed = `${partial}"}}\n`;
    const next = advanceSessionTail(completed, step.cursor, { withTime: false });
    expect(next.lines).toEqual(["user> half"]);
    expect(next.cursor.lineCount).toBe(2);
  });
});

describe("pickSessionToTail", () => {
  test("returns the explicit id verbatim", () => {
    expect(pickSessionToTail("sess_0123456789abcdef", { list: () => [], mtimeMs: () => 0 })).toBe(
      "sess_0123456789abcdef",
    );
  });

  test("picks the newest session log by mtime", () => {
    const files = ["sess_0000000000000001.jsonl", "sess_0000000000000002.jsonl", "notes.txt"];
    const mtimes: Record<string, number> = {
      "sess_0000000000000001.jsonl": 100,
      "sess_0000000000000002.jsonl": 200,
    };
    const picked = pickSessionToTail(undefined, {
      list: () => files,
      mtimeMs: (f) => mtimes[f] ?? 0,
    });
    expect(picked).toBe("sess_0000000000000002");
  });

  test("returns undefined when no session logs exist", () => {
    expect(
      pickSessionToTail(undefined, { list: () => ["notes.txt"], mtimeMs: () => 0 }),
    ).toBeUndefined();
    expect(pickSessionToTail(undefined, { list: () => [], mtimeMs: () => 0 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 (design §8.2) — route / cost / eval / stage lines.
// ---------------------------------------------------------------------------
describe("formatSessionEvent — 0.6.0 routing lines", () => {
  const opts = { withTime: false } as const;

  test("model_route renders model[profile], policy, band, stage, rule, explored and reason", () => {
    const full: SessionLogEvent = {
      kind: "model_route",
      payload: {
        turnNumber: 3,
        routeKey: "main/hard",
        model: "claude-opus-5",
        policy: "learned",
        reason: "best arm",
        profile: "strong",
        stage: "escalation",
        ruleId: "code-goes-strong",
        explored: true,
      },
    };
    expect(formatSessionEvent(full, opts)).toBe(
      "  ⇢ route claude-opus-5[strong] policy=learned band=main/hard stage=escalation rule=code-goes-strong explored — best arm",
    );
    // A 0.5.x line (no profile/stage/rule) renders the fields it has.
    const legacy: SessionLogEvent = {
      kind: "model_route",
      payload: {
        turnNumber: 1,
        routeKey: "easy",
        model: "claude-haiku-4-5",
        policy: "heuristic",
        reason: "no tools",
        explored: false,
      },
    };
    expect(formatSessionEvent(legacy, opts)).toBe(
      "  ⇢ route claude-haiku-4-5 policy=heuristic band=easy — no tools",
    );
  });

  test("model_tier_route, model_failover and model_directive render their decision", () => {
    expect(
      formatSessionEvent(
        {
          kind: "model_tier_route",
          payload: {
            tier: "default",
            model: "claude-opus-5",
            reason: "escalated after fast-tier failure",
            escalated: true,
          },
        },
        opts,
      ),
    ).toBe("  ⇢ tier default claude-opus-5 escalated — escalated after fast-tier failure");
    expect(
      formatSessionEvent(
        {
          kind: "model_failover",
          payload: { from: "anthropic/claude-opus-5", to: "openai/gpt-4o", reason: "breaker_open" },
        },
        opts,
      ),
    ).toBe("  ⇢ failover anthropic/claude-opus-5 → openai/gpt-4o — breaker_open");
    expect(
      formatSessionEvent(
        {
          kind: "model_directive",
          payload: { source: "repl", requested: "fast", resolved: "fast", accepted: true },
        },
        opts,
      ),
    ).toBe("  ⇢ /model fast pinned");
    expect(
      formatSessionEvent(
        {
          kind: "model_directive",
          payload: { source: "repl", requested: "turbo", accepted: false, reason: "unknown arm" },
        },
        opts,
      ),
    ).toBe("  ⇢ /model turbo refused — unknown arm");
  });

  test("cost_accrual renders spend, model[profile], role, stage and tokens", () => {
    const judge: SessionLogEvent = {
      kind: "cost_accrual",
      payload: {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        inputTokens: 1200,
        outputTokens: 40,
        cachedReadTokens: 0,
        costUsdMicros: 4200,
        role: "judge",
        profile: "checker",
      },
    };
    expect(formatSessionEvent(judge, opts)).toBe(
      "  $ $0.0042 claude-sonnet-5[checker] role=judge 1200→40 tok",
    );
    const unpriced: SessionLogEvent = {
      kind: "cost_accrual",
      payload: {
        provider: "openai",
        modelId: "local/llama",
        inputTokens: 10,
        outputTokens: 2,
        cachedReadTokens: 0,
        costUsdMicros: 0,
        unpriced: true,
        stage: "draft",
      },
    };
    expect(formatSessionEvent(unpriced, opts)).toBe(
      "  $ $0.0000 local/llama stage=draft 10→2 tok (unpriced)",
    );
  });

  test("model_stage renders stage/strategy, model, role, outcome, cause and cost", () => {
    expect(
      formatSessionEvent(
        {
          kind: "model_stage",
          payload: {
            turnNumber: 2,
            stage: "escalate",
            strategy: "cascade",
            role: "escalation",
            model: "claude-opus-5",
            profile: "strong",
            outcome: "done",
            costUsdMicros: 91000,
          },
        },
        opts,
      ),
    ).toBe("  ◇ stage escalate/cascade claude-opus-5[strong] role=escalation done $0.0910");
    expect(
      formatSessionEvent(
        {
          kind: "model_stage",
          payload: {
            stage: "escalate",
            strategy: "cascade",
            role: "escalation",
            model: "claude-opus-5",
            outcome: "skipped",
            cause: "max_escalations",
          },
        },
        opts,
      ),
    ).toBe("  ◇ stage escalate/cascade claude-opus-5 role=escalation skipped — max_escalations");
  });

  test("judge_verdict and eval_graded render verdict, score, bar, judge, graded arm and escalation", () => {
    expect(
      formatSessionEvent(
        {
          kind: "judge_verdict",
          payload: {
            turnNumber: 1,
            stepOrNode: "review",
            verdict: "fail",
            score: 0.4,
            judgeModel: "claude-sonnet-5",
          },
        },
        opts,
      ),
    ).toBe("  ⚖ judge review fail 0.40 by claude-sonnet-5");
    expect(
      formatSessionEvent(
        {
          kind: "eval_graded",
          payload: {
            score: 0.3,
            threshold: 0.7,
            verdict: "fail",
            graderType: "llm_judge",
            retryIndex: 1,
            model: "claude-haiku-4-5",
            judgeModel: "claude-sonnet-5",
            escalatedTo: "anthropic/claude-opus-5",
          },
        },
        opts,
      ),
    ).toBe(
      "  ⚖ eval fail 0.30 (bar 0.70) by claude-sonnet-5 of claude-haiku-4-5 → escalate anthropic/claude-opus-5 retry 1",
    );
  });

  test("every routing-line field is one line and capped at maxChars, like transcript text", () => {
    // `requested` is user-typed `/model …` text; a newline in it must not
    // print what looks like a second transcript line.
    const spoof = formatSessionEvent(
      {
        kind: "model_directive",
        payload: {
          source: "channel",
          requested: "fast\n12:00:00 user> FAKE LINE\nsys> injected",
          accepted: true,
        },
      },
      opts,
    );
    expect(spoof).toBeDefined();
    expect((spoof as string).split("\n")).toHaveLength(1);
    expect(spoof).toBe("  ⇢ /model fast 12:00:00 user> FAKE LINE sys> injected pinned");

    // Provider error text in `reason` / `cause` is capped at maxChars.
    const capped = { withTime: false, maxChars: 40 } as const;
    const long = "r".repeat(600);
    expect(
      formatSessionEvent(
        { kind: "model_failover", payload: { from: "a", to: "b", reason: long } },
        capped,
      ),
    ).toBe(`  ⇢ failover a → b — ${"r".repeat(39)}…`);
    expect(
      formatSessionEvent(
        {
          kind: "model_stage",
          payload: { stage: "s", strategy: "x", model: "m", outcome: "failed", cause: long },
        },
        capped,
      ),
    ).toBe(`  ◇ stage s/x m failed — ${"r".repeat(39)}…`);
    expect(
      formatSessionEvent(
        { kind: "model_route", payload: { model: "m", reason: `tabs\tand\n\nlines ${long}` } },
        capped,
      ),
    ).toBe(`  ⇢ route m — tabs and lines ${"r".repeat(24)}…`);
    // Model / profile / judge fields go through the same seam.
    expect(
      formatSessionEvent(
        { kind: "judge_verdict", payload: { verdict: "fail", judgeModel: "j\nudge", model: long } },
        capped,
      ),
    ).toBe(`  ⚖ judge fail by j udge of ${"r".repeat(39)}…`);
    expect(
      formatSessionEvent(
        { kind: "cost_accrual", payload: { costUsdMicros: 1, modelId: "m", profile: "p\nq" } },
        capped,
      ),
    ).toBe("  $ $0.0000 m[p q]");
  });

  test("formatUsdMicros guards a missing value", () => {
    expect(formatUsdMicros(undefined)).toBe("$?");
    expect(formatUsdMicros(1_234_567)).toBe("$1.2346");
  });

  test("advanceSessionTail carries the option through the follow loop", () => {
    const l1 = `${JSON.stringify({ kind: "user_message", payload: { content: "one" } })}\n`;
    const l2 = `${JSON.stringify({ kind: "cost_accrual", payload: { modelId: "m", costUsdMicros: 100 } })}\n`;
    const shown = advanceSessionTail(l1 + l2, { lineCount: 0 }, { withTime: false });
    expect(shown.lines).toEqual(["user> one", "  $ $0.0001 m"]);
    const hidden = advanceSessionTail(
      l1 + l2,
      { lineCount: 0 },
      { withTime: false, transcriptOnly: true },
    );
    expect(hidden.lines).toEqual(["user> one"]);
    expect(hidden.cursor.lineCount).toBe(2);
  });
});
