/**
 * Loop contract 0.4 (Batch B, G53) — unit tests for the trajectory-export
 * assembly: (state, action, observation, reward) tuples from session event
 * logs + trace events, with the terminal-sparse reward ladder (eval_graded >
 * user rating > null). Fixtures mirror runtime-core's REAL event payload
 * shapes (assistant content blocks, granular tool_use/tool_result events,
 * the API-shape tool_result round logged as a user_message).
 */
import { describe, expect, test } from "bun:test";
import {
  type LoggedEvent,
  assembleTrajectory,
  parseJsonlLoose,
  resolveSessionReward,
  trajectoryStepsToJsonl,
} from "./sessions-export";

const SESSION = "sess_00000000000000ab";

/** A two-turn tool session, shaped exactly like runtime-core logs it. */
function toolSessionEvents(): LoggedEvent[] {
  return [
    { kind: "user_message", payload: { content: "list the files" } },
    {
      kind: "assistant_message",
      payload: {
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
        ],
      },
    },
    { kind: "tool_use", payload: { id: "tu_1", name: "bash", input: { command: "ls" } } },
    {
      kind: "tool_result",
      payload: { toolUseId: "tu_1", content: "a.txt\nb.txt", isError: false },
    },
    // The API-shape tool_result round the runtime ALSO logs as a user
    // message — must be skipped (consumed from the granular event above).
    {
      kind: "user_message",
      payload: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a.txt\nb.txt" }] },
    },
    { kind: "assistant_message", payload: { content: [{ type: "text", text: "Two files." }] } },
    // Non-conversational kinds are skipped by contract.
    { kind: "cost_accrual", payload: { costUsdMicros: 12 } },
    { kind: "model_meta", payload: { stopReason: "end_turn", model: "m" } },
  ];
}

describe("assembleTrajectory — steps", () => {
  test("one step per assistant action; tool observation joined by toolUseId", () => {
    const steps = assembleTrajectory(SESSION, toolSessionEvents());
    expect(steps).toHaveLength(2);

    const first = steps[0];
    expect(first?.sessionId).toBe(SESSION);
    expect(first?.step).toBe(0);
    expect(first?.state).toEqual([{ role: "user", text: "list the files" }]);
    expect(first?.action).toEqual({
      text: "Let me look.",
      toolCalls: [{ tool: "bash", input: { command: "ls" } }],
    });
    expect(first?.observation).toEqual({
      results: [{ tool: "bash", text: "a.txt\nb.txt", isError: false }],
    });
    expect(first?.reward).toBeNull();

    const second = steps[1];
    expect(second?.step).toBe(1);
    // Full prefix: user, the prior assistant action, its tool result.
    expect(second?.state).toEqual([
      { role: "user", text: "list the files" },
      {
        role: "assistant",
        text: "Let me look.",
        toolCalls: [{ tool: "bash", input: { command: "ls" } }],
      },
      { role: "tool", text: "a.txt\nb.txt" },
    ]);
    expect(second?.action).toEqual({ text: "Two files." });
    // A plain text turn has no environment response.
    expect(second?.observation).toBeNull();
  });

  test("synthetic corrective user messages stay in the state, tagged", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "answer" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "draft" }] } },
      {
        kind: "user_message",
        payload: { content: "[evaluation failed: scored 0.20] please revise", synthetic: true },
      },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "better" }] } },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[1]?.state).toEqual([
      { role: "user", text: "answer" },
      { role: "assistant", text: "draft" },
      { role: "user", text: "[evaluation failed: scored 0.20] please revise", synthetic: true },
    ]);
  });

  test("error tool results carry isError", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "go" } },
      {
        kind: "assistant_message",
        payload: { content: [{ type: "tool_use", id: "t9", name: "webFetch", input: {} }] },
      },
      { kind: "tool_use", payload: { id: "t9", name: "webFetch", input: {} } },
      { kind: "tool_result", payload: { toolUseId: "t9", content: "boom", isError: true } },
    ]);
    expect(steps[0]?.observation).toEqual({
      results: [{ tool: "webFetch", text: "boom", isError: true }],
    });
  });

  test("a session with no assistant action yields no steps", () => {
    expect(
      assembleTrajectory(SESSION, [{ kind: "user_message", payload: { content: "hello?" } }]),
    ).toEqual([]);
  });

  test("malformed payloads are skipped, never thrown on", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message" },
      { kind: "user_message", payload: { content: 42 } },
      { kind: "assistant_message", payload: null },
      { kind: "user_message", payload: { content: "ok" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "fine" }] } },
      { kind: "tool_result", payload: "not-an-object" },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.state).toEqual([{ role: "user", text: "ok" }]);
  });
});

// -------- reward ladder --------

function feedbackEvent(thumbs: "up" | "down", turnNumber: number, ts: string): LoggedEvent {
  return {
    kind: "user_feedback",
    payload: {
      schemaVersion: 1,
      id: `fb_${turnNumber}`,
      sessionId: SESSION,
      turnNumber,
      modality: "binary",
      rating: { thumbs },
      source: "cli",
      ts,
    },
  };
}

describe("assembleTrajectory — reward ladder (G53)", () => {
  test("no signal → terminal reward null, no rewardSource", () => {
    const steps = assembleTrajectory(SESSION, toolSessionEvents());
    const last = steps[steps.length - 1];
    expect(last?.reward).toBeNull();
    expect(last?.rewardSource).toBeUndefined();
  });

  test("user rating (latest by ts) lands on the terminal step only", () => {
    const events = [
      ...toolSessionEvents(),
      feedbackEvent("down", 1, "2026-01-01T00:00:10.000Z"),
      feedbackEvent("up", 2, "2026-01-02T00:00:10.000Z"),
    ];
    const steps = assembleTrajectory(SESSION, events);
    expect(steps[0]?.reward).toBeNull();
    const last = steps[steps.length - 1];
    expect(last?.reward).toBe(1); // thumbs up → 1, the LATEST record wins
    expect(last?.rewardSource).toBe("user_rating");
  });

  test("eval_graded (sibling trace events) outranks a user rating; LAST pass wins", () => {
    const events = [...toolSessionEvents(), feedbackEvent("up", 2, "2026-01-02T00:00:10.000Z")];
    const traceEvents = [
      { kind: "eval_graded", score: 0.2, threshold: 0.7, verdict: "fail", retryIndex: 0 },
      { kind: "eval_graded", score: 0.9, threshold: 0.7, verdict: "pass", retryIndex: 1 },
    ];
    const steps = assembleTrajectory(SESSION, events, traceEvents);
    const last = steps[steps.length - 1];
    expect(last?.reward).toBe(0.9);
    expect(last?.rewardSource).toBe("eval_graded");
  });

  test("a durable in-log eval_graded mirror line is accepted too (envelope shape)", () => {
    const events: LoggedEvent[] = [
      ...toolSessionEvents(),
      { kind: "eval_graded", payload: { score: 0.4, threshold: 0.7, verdict: "fail" } },
    ];
    const last = assembleTrajectory(SESSION, events).at(-1);
    expect(last?.reward).toBe(0.4);
    expect(last?.rewardSource).toBe("eval_graded");
  });

  test("a rating for a DIFFERENT session is ignored", () => {
    const foreign = {
      ...feedbackEvent("up", 1, "2026-01-01T00:00:10.000Z"),
    } as { kind: string; payload: Record<string, unknown> };
    foreign.payload = { ...foreign.payload, sessionId: "sess_ffffffffffffffff" };
    const steps = assembleTrajectory(SESSION, [...toolSessionEvents(), foreign]);
    expect(steps.at(-1)?.reward).toBeNull();
  });

  test("resolveSessionReward: non-finite eval scores are ignored", () => {
    expect(
      resolveSessionReward(SESSION, [], [{ kind: "eval_graded", score: Number.NaN }]),
    ).toBeUndefined();
  });
});

describe("serialization helpers", () => {
  test("trajectoryStepsToJsonl: one line per step, trailing newline, empty for none", () => {
    const steps = assembleTrajectory(SESSION, toolSessionEvents());
    const jsonl = trajectoryStepsToJsonl(steps);
    const lines = jsonl.split("\n").filter((l) => l !== "");
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "action",
      "observation",
      "reward",
      "sessionId",
      "state",
      "step",
    ]);
    expect(trajectoryStepsToJsonl([])).toBe("");
  });

  test("parseJsonlLoose drops malformed lines", () => {
    expect(parseJsonlLoose('{"kind":"eval_graded","score":1}\nnot json\n\n{"a":1}\n')).toEqual([
      { kind: "eval_graded", score: 1 },
      { a: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 (design §8.1, §8.2) — steps carry the served model from `model_meta`.
// ---------------------------------------------------------------------------
describe("assembleTrajectory — served model per step (0.6.0)", () => {
  const asst = (text: string): LoggedEvent => ({
    kind: "assistant_message",
    payload: { content: [{ type: "text", text }] },
  });
  const meta = (model: string, extra: Record<string, unknown> = {}): LoggedEvent => ({
    kind: "model_meta",
    payload: { stopReason: "end_turn", model, usage: { input: 1, output: 1 }, ...extra },
  });

  test("streaming order (assistant then meta) and non-streaming order (meta then assistant) both pair", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q1" } },
      asst("draft"),
      meta("claude-haiku-4-5", { profile: "fast" }),
      { kind: "user_message", payload: { content: "q2" } },
      meta("claude-opus-5", { profile: "strong" }),
      asst("strong answer"),
    ]);
    expect(steps.map((s) => [s.model, s.profile])).toEqual([
      ["claude-haiku-4-5", "fast"],
      ["claude-opus-5", "strong"],
    ]);
  });

  test("a judge's or compaction's model_meta never attributes an action; a primary one does", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q" } },
      asst("draft"),
      meta("claude-sonnet-5", { role: "judge" }),
      meta("claude-haiku-4-5", { role: "compaction" }),
      meta("claude-haiku-4-5", { role: "primary" }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.model).toBe("claude-haiku-4-5");
    expect(steps[0]?.profile).toBeUndefined();
  });

  test("a cascade's draft and escalation metas both attribute; an interleaved judge is skipped", () => {
    // Design §7.3 / §8.1 — cheap draft, judge fails it, strong re-run under
    // `on_fail: escalate`. The committed answers carry the `draft` and
    // `escalation` roles, not `primary`; the judge's meta commits no message.
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q" } },
      asst("cheap draft"),
      meta("claude-haiku-4-5", { role: "draft", profile: "fast" }),
      meta("claude-sonnet-5", { role: "judge", profile: "checker" }),
      {
        kind: "user_message",
        payload: { content: "[evaluation failed: scored 0.40] please revise", synthetic: true },
      },
      asst("strong answer"),
      meta("claude-opus-5", { role: "escalation", profile: "strong" }),
    ]);
    expect(steps.map((s) => [s.model, s.profile])).toEqual([
      ["claude-haiku-4-5", "fast"],
      ["claude-opus-5", "strong"],
    ]);
  });

  test("a sub-agent child's own `subagent`-role meta attributes its action", () => {
    // The child's model_response lands on the child's bus and log, beside the
    // child's own assistant_message — answer work, not auxiliary.
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "child prompt" } },
      meta("claude-haiku-4-5", { role: "subagent" }),
      asst("child answer"),
    ]);
    expect(steps.map((s) => s.model)).toEqual(["claude-haiku-4-5"]);
  });

  test("every auxiliary role is skipped; an unknown role string is not", () => {
    for (const role of [
      "judge",
      "guide",
      "classifier",
      "consult",
      "committee",
      "shadow",
      "compaction",
    ]) {
      const steps = assembleTrajectory(SESSION, [
        { kind: "user_message", payload: { content: "q" } },
        asst("a"),
        meta("aux-model", { role }),
      ]);
      expect(steps[0]?.model).toBeUndefined();
    }
    const future = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q" } },
      asst("a"),
      meta("m", { role: "some-future-answer-role" }),
    ]);
    expect(future[0]?.model).toBe("m");
  });

  test("an orphaned meta or action never crosses a turn boundary", () => {
    // Streaming path, empty committed content: the response's meta lands with
    // no assistant_message. The next turn's action must not inherit it.
    const orphanMeta = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q1" } },
      meta("claude-haiku-4-5"),
      { kind: "user_message", payload: { content: "q2" } },
      asst("answer"),
      meta("claude-opus-5"),
    ]);
    expect(orphanMeta.map((s) => s.model)).toEqual(["claude-opus-5"]);

    // A dropped mirror line: the unattributed action must not take the next
    // turn's meta, even when that turn logs meta-first.
    const orphanAction = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q1" } },
      asst("unpriced"),
      { kind: "user_message", payload: { content: "q2" } },
      meta("claude-opus-5"),
      asst("priced"),
    ]);
    expect(orphanAction.map((s) => s.model)).toEqual([undefined, "claude-opus-5"]);

    // The tool_result echo round is not a boundary: a meta held across it
    // (or an action awaiting across it) still pairs within the turn.
    const echoRound = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q" } },
      {
        kind: "assistant_message",
        payload: { content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }] },
      },
      {
        kind: "user_message",
        payload: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
      },
      meta("claude-haiku-4-5"),
    ]);
    expect(echoRound.map((s) => s.model)).toEqual(["claude-haiku-4-5"]);
  });

  test("a tool loop pairs one meta per committed assistant message, in order", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "list" } },
      {
        kind: "assistant_message",
        payload: { content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }] },
      },
      meta("claude-haiku-4-5"),
      { kind: "tool_use", payload: { id: "tu_1", name: "bash", input: {} } },
      { kind: "tool_result", payload: { toolUseId: "tu_1", content: "ok", isError: false } },
      asst("done"),
      meta("claude-opus-5"),
    ]);
    expect(steps.map((s) => s.model)).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
  });

  test("without model_meta (advisor events off, or a 0.5.x log) steps carry no model key", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q" } },
      asst("a"),
    ]);
    expect(steps).toHaveLength(1);
    expect("model" in (steps[0] as object)).toBe(false);
    expect("profile" in (steps[0] as object)).toBe(false);
    // The fixture's trailing model_meta attributes the LAST action only.
    const legacy = assembleTrajectory(SESSION, toolSessionEvents());
    expect(legacy[0]?.model).toBeUndefined();
    expect(legacy[1]?.model).toBe("m");
  });

  test("model rides the JSONL line", () => {
    const steps = assembleTrajectory(SESSION, [
      { kind: "user_message", payload: { content: "q" } },
      meta("claude-opus-5"),
      asst("a"),
    ]);
    expect(JSON.parse(trajectoryStepsToJsonl(steps).trim())).toMatchObject({
      model: "claude-opus-5",
    });
  });
});
