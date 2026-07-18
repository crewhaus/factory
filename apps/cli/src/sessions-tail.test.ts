import { describe, expect, test } from "bun:test";
import {
  type SessionLogEvent,
  advanceSessionTail,
  formatSessionEvent,
  formatSessionEventTime,
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
      "model_route",
      "tool_stats",
      "cost_accrual",
      "mcp_stats",
      "context_evicted",
    ]) {
      expect(formatSessionEvent({ kind, payload: {} }, opts)).toBeUndefined();
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
      JSON.stringify({ ts: TS, kind: "model_route", payload: { model: "x" } }),
      JSON.stringify({
        ts: TS,
        kind: "assistant_message",
        payload: { content: [{ type: "text", text: "yo" }] },
      }),
      "",
    ].join("\n");
    expect(renderSessionLog(text, { withTime: false })).toEqual(["user> hi", "asst> yo"]);
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
