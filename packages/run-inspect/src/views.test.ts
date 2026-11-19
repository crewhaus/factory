/**
 * The five views: thinking never in any of them, cost never a guessed $0, context
 * that resolves what a manifest points back to, the key/detail taxonomy, and field
 * names a key-name masker never hides.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { isCredentialKey } from "@crewhaus/spec-patch";
import {
  LogBuilder,
  NOW,
  SESSION,
  removeFixtures,
  runId,
  simpleRun,
  spanId,
} from "./__fixtures__/build";
import {
  COST_NOT_TRACKED_WORDS,
  COST_UNKNOWN_WORDS,
  type ContextList,
  type ContextUsed,
  DETAIL_OUTCOMES,
  ENTRY_KINDS,
  HIDDEN_FOR_SAFETY,
  LINE_KINDS,
  type LoadedRun,
  type TimelinePage,
  foldContext,
  foldSpanTree,
  foldSummary,
  foldTimeline,
  foldWhy,
  importanceOf,
  loadedRunFromText,
} from "./index";

afterAll(removeFixtures);

function fromText(text: string, run?: string): LoadedRun {
  const got = loadedRunFromText(text, {
    now: NOW,
    session: SESSION,
    ...(run !== undefined ? { run } : {}),
  });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function allViews(loaded: LoadedRun, actions: readonly string[]): unknown[] {
  return [
    foldSummary(loaded),
    foldTimeline(loaded, { view: "full", limit: 500 }),
    foldTimeline(loaded, { view: "key", limit: 500 }),
    foldSpanTree(loaded),
    ...actions.map((action) => foldWhy(loaded, action)),
    foldContext(loaded, "all"),
  ];
}

describe("thinking", () => {
  test("thinking and redacted thinking blocks are in no view", () => {
    const CANARY = "CANARY-private-reasoning-7f3a";
    const b = new LogBuilder();
    const run = runId(1);
    const [root, turn, model] = [spanId(1), spanId(2), spanId(3)];
    b.stamp(run, root);
    b.add("user_message", { content: "hello" }, { run, span: root });
    b.add(
      "assistant_message",
      {
        content: [
          { type: "thinking", thinking: CANARY, signature: CANARY },
          { type: "redacted_thinking", data: CANARY },
          { type: "text", text: "hi there" },
        ],
      },
      { run, span: model },
    );
    b.close(run, model, "model", { parent: turn, call: 1 });
    b.close(run, turn, "turn", { parent: root });
    b.close(run, root, "run");
    const loaded = fromText(b.text(), run);
    const text = JSON.stringify(
      allViews(loaded, [`answer:${model}`, `model:${model}`, `turn:${turn}`]),
    );
    expect(text).toContain("hi there");
    expect(text).not.toContain(CANARY);
  });
});

describe("later corrections", () => {
  test("a rating that names an answer's model span is shown with that answer, and only with it", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const spans = simpleRun(b, run, 0x100, { answer: "The notes say goodbye." });
    // Written later by `crewhaus rate`, through an unscoped handle.
    const rating = (target: string, correction: string) =>
      b.add("user_feedback", {
        schemaVersion: 1,
        id: `fb_${target}`,
        sessionId: SESSION,
        turnNumber: 1,
        targetSpanId: target,
        modality: "binary",
        rating: { thumbs: "down" },
        correction,
        source: "cli",
        ts: "2026-11-15T09:00:00.000Z",
      });
    rating(spans.answerModel, "They say hello.");
    rating(spans.model, "not this one");
    const loaded = fromText(b.text(), run);
    const why = foldWhy(loaded, `answer:${spans.answerModel}`);
    if ("ok" in why) throw new Error(why.message);
    expect(why.result.value?.text).toBe("The notes say goodbye.");
    expect(why.result.value?.corrections).toEqual([
      {
        id: expect.stringMatching(/^s:\d+$/),
        at: "2026-11-15T09:00:00.000Z",
        rating: "thumbs down",
        correction: "They say hello.",
      },
    ]);
    const tool = foldWhy(loaded, `tool:${spans.tool}`);
    if ("ok" in tool) throw new Error(tool.message);
    expect(tool.result.value?.corrections).toEqual([]);
  });
});

describe("cost", () => {
  const priced = (micros: number, extra: Record<string, unknown> = {}) => ({
    provider: "anthropic",
    modelId: "test-model",
    inputTokens: 100,
    outputTokens: 20,
    cachedReadTokens: 0,
    costUsdMicros: micros,
    ...extra,
  });

  test("per-call lines and a helper's roll-up are summed once; a run total with no role is skipped", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100, {
      cost: [
        priced(10_000, { unpriced: false }),
        priced(20_000, { unpriced: false }),
        priced(5_000, { summary: true, role: "subagent", unpriced: false }),
        priced(999_000_000, { summary: true, unpriced: false }),
      ],
    });
    const cost = foldSummary(fromText(b.text(), run)).cost;
    expect(cost).toMatchObject({
      state: "recorded",
      value: { usdMicros: 35_000, lines: 3, words: "$0.04" },
    });
  });

  test("an unpriced line makes the total unknown, never $0", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100, {
      cost: [priced(10_000, { unpriced: false }), priced(0, { unpriced: true })],
    });
    const cost = foldSummary(fromText(b.text(), run)).cost;
    expect(cost).toMatchObject({
      state: "recorded",
      value: { usdMicros: null, unknown: "unpriced", words: COST_UNKNOWN_WORDS },
    });
    expect(cost.value?.words).not.toContain("$0");
  });

  test("a line with tokens, no cost and no word on pricing is unknown, pieced together by its rule", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100, { cost: [priced(0)] });
    const loaded = fromText(b.text(), run);
    const cost = foldSummary(loaded).cost;
    expect(cost).toMatchObject({
      state: "reconstructed",
      rule: "zero-cost-with-tokens",
      value: { usdMicros: null, unknown: "zero-cost-with-tokens", words: COST_UNKNOWN_WORDS },
    });
    const page = foldTimeline(loaded, { view: "full" }) as TimelinePage;
    const line = page.entries.find((e) => e.kind === "cost");
    expect(line?.title).toBe(`Cost: ${COST_UNKNOWN_WORDS}`);
    expect(JSON.stringify(page)).not.toContain("$0.00");
  });

  test("tracking off and no cost lines: 'Cost not tracked'; tracking off but a session budget kept lines: summed, no gap", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100, { recording: { costTracking: false } });
    const off = foldSummary(fromText(b.text(), run));
    expect(off.cost).toMatchObject({
      state: "not-recorded",
      gap: { reason: "cost-off" },
      value: { usdMicros: null, words: COST_NOT_TRACKED_WORDS },
    });
    const c = new LogBuilder();
    simpleRun(c, run, 0x100, {
      recording: { costTracking: false },
      cost: [priced(2_000_000, { unpriced: false })],
    });
    const budgeted = foldSummary(fromText(c.text(), run));
    expect(budgeted.cost.value).toMatchObject({ usdMicros: 2_000_000, words: "$2.00" });
    expect(budgeted.gaps.some((gap) => gap.reason === "cost-off")).toBe(false);
  });
});

describe("context used", () => {
  function contextRun(): { loaded: LoadedRun; first: string; second: string } {
    const b = new LogBuilder();
    const run = runId(1);
    const [root, first, second, third] = [spanId(1), spanId(2), spanId(3), spanId(4)];
    b.stamp(run, root);
    const manifest = (span: string, call: number, extra: Record<string, unknown>) =>
      b.add(
        "context_manifest",
        {
          v: 1,
          run,
          span,
          turn: { run: 1, session: 1 },
          call,
          blocks: [
            { kind: "instructions", bytes: 40, fingerprint: "a".repeat(64), cached: true },
            ...(call === 3
              ? []
              : [
                  {
                    kind: "recalled-memory",
                    bytes: 90,
                    fingerprint: "b".repeat(64),
                    cached: false,
                  },
                ]),
          ],
          tools: { fingerprint: "c".repeat(64), advertised: 2, inSpec: 3 },
          model: {
            wire: "m-1",
            provider: "anthropic",
            params: { maxTokens: 1024, temperature: 0.2 },
          },
          messages: { count: call, afterCompaction: false },
          ...extra,
        },
        { run, span },
      );
    manifest(first, 1, {
      files: [{ path: "AGENTS.md", bytes: 300, fingerprint: "d".repeat(64) }],
      tools: { fingerprint: "c".repeat(64), advertised: 2, inSpec: 3, names: ["Read", "Write"] },
      recalled: {
        at: "session-start",
        query: { fingerprint: "e".repeat(64) },
        requested: 3,
        returned: 2,
        items: [
          {
            ref: { store: "fact", backend: "local", localId: "f-1" },
            score: 0.9,
            status: "included",
          },
          {
            ref: { store: "wiki", backend: "local", localId: "w-2", version: 4 },
            status: "redacted",
            rules: ["injection.ignore-previous"],
          },
        ],
      },
    });
    manifest(second, 2, { recalled: { sameAs: first } });
    manifest(third, 3, {});
    return { loaded: fromText(b.text(), run), first, second };
  }

  test("a redacted memory stays visible as 'Hidden for safety' with its rules and ref, never text", () => {
    const { loaded } = contextRun();
    const one = foldContext(loaded, 1) as ContextUsed;
    const hidden = one.recalled.value?.items.find((item) => item.status === "redacted");
    expect(hidden).toEqual({
      ref: { store: "wiki", backend: "local", localId: "w-2", version: 4 },
      status: "redacted",
      rules: ["injection.ignore-previous"],
      label: HIDDEN_FOR_SAFETY,
    });
    expect(one.files).toEqual([{ path: "AGENTS.md", bytes: 300 }]);
    expect(one.model.params).toEqual({ maxTokens: 1024, temperature: 0.2 });
  });

  test("sameAs and absent tool names resolve to the manifest that listed them", () => {
    const { loaded } = contextRun();
    const two = foldContext(loaded, 2) as ContextUsed;
    const one = foldContext(loaded, 1) as ContextUsed;
    expect(two.recalled.state).toBe("recorded");
    expect(two.recalled.refs).toEqual([two.id, one.id]);
    expect(two.recalled.value?.items.length).toBe(2);
    expect(two.tools).toMatchObject({ state: "recorded", value: { names: ["Read", "Write"] } });
    expect(two.tools.refs).toEqual([two.id, one.id]);
    expect(two.onlyInstructions).toBe(false);
  });

  test("a call given only its instructions says so; an unknown call is refused; all lists every call", () => {
    const { loaded } = contextRun();
    expect((foldContext(loaded, 3) as ContextUsed).onlyInstructions).toBe(true);
    expect(foldContext(loaded, 9)).toMatchObject({ ok: false, code: "not_found" });
    expect((foldContext(loaded, "all") as ContextList).calls.map((c) => c.call)).toEqual([1, 2, 3]);
  });
});

describe("the taxonomy", () => {
  test("every entry kind the folds emit has one row, and checks are key unless they allow or pass", () => {
    for (const kind of Object.values(LINE_KINDS)) {
      if (kind !== undefined) expect(Object.hasOwn(ENTRY_KINDS, kind)).toBe(true);
    }
    expect([...DETAIL_OUTCOMES].sort()).toEqual(["allow", "pass"]);
    for (const outcome of [
      "deny",
      "ask:parked",
      "parked",
      "refused",
      "redacted",
      "block",
      "fail",
      "abort",
      "expired",
      "superseded",
      "consumed",
    ]) {
      expect([outcome, importanceOf("check", outcome)]).toEqual([outcome, "key"]);
    }
    expect(importanceOf("check", "allow")).toBe("detail");
    expect(importanceOf("check", "pass")).toBe("detail");
    const table: Record<string, string> = {};
    for (const [kind, row] of Object.entries(ENTRY_KINDS)) table[kind] = row.importance;
    expect(table).toEqual({
      "run-start": "key",
      "run-end": "key",
      message: "key",
      "operator-wake": "key",
      answer: "key",
      tool: "key",
      check: "by-outcome",
      "approval-outcome": "key",
      error: "key",
      "run-failed": "key",
      failover: "key",
      helper: "key",
      compaction: "key",
      eviction: "key",
      feedback: "key",
      gap: "key",
      note: "detail",
      turn: "detail",
      "model-call": "detail",
      route: "detail",
      context: "detail",
      cost: "detail",
      stats: "detail",
      "plan-write": "detail",
      judge: "detail",
      proof: "detail",
      toolset: "detail",
      crew: "detail",
      other: "detail",
    });
  });

  test("every kind a fixture run emits is in the table, and the key view of a run with only detail is 'filtered'", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100);
    const page = foldTimeline(fromText(b.text(), run), {
      view: "full",
      limit: 500,
    }) as TimelinePage;
    for (const entry of page.entries) expect(Object.hasOwn(ENTRY_KINDS, entry.kind)).toBe(true);
    expect(new Set(page.entries.map((e) => e.kind))).toEqual(
      new Set([
        "run-start",
        "message",
        "context",
        "answer",
        "model-call",
        "tool",
        "check",
        "turn",
        "run-end",
      ]),
    );
    // Only detail: no stamp, no messages, just stats.
    const c = new LogBuilder();
    c.add("tool_stats", { toolName: "Read", durationMs: 3, isError: false });
    c.add("model_meta", { stopReason: "end_turn", model: "m" });
    const quiet = fromText(c.text());
    const key = foldTimeline(quiet, { view: "key" }) as TimelinePage;
    expect(key).toMatchObject({ entries: [], empty: "filtered" });
    expect((foldTimeline(quiet, { view: "full" }) as TimelinePage).entries.length).toBe(2);
    expect(foldTimeline(fromText(""), { view: "key" })).toMatchObject({
      entries: [],
      empty: "no-data",
    });
  });

  test("pages are newest first, and before continues where a page stopped", () => {
    const b = new LogBuilder();
    const run = runId(1);
    simpleRun(b, run, 0x100);
    const loaded = fromText(b.text(), run);
    const all = (foldTimeline(loaded, { view: "full", limit: 500 }) as TimelinePage).entries;
    const first = foldTimeline(loaded, { view: "full", limit: 3 }) as TimelinePage;
    expect(first.entries.map((e) => e.id)).toEqual(all.slice(0, 3).map((e) => e.id));
    expect(first.next).toBe(all[2]?.id);
    const second = foldTimeline(loaded, {
      view: "full",
      limit: 3,
      before: first.next,
    }) as TimelinePage;
    expect(second.entries.map((e) => e.id)).toEqual(all.slice(3, 6).map((e) => e.id));
    expect(all[0]?.kind).toBe("run-end");
    expect(foldTimeline(loaded, { before: "s:999999" })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });
});

describe("field names", () => {
  test("no key of any view over the fixtures is one a key-name masker hides", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const spans = simpleRun(b, run, 0x100, {
      trigger: { kind: "heartbeat", lane: "heartbeat", synthetic: true },
      cost: [
        {
          provider: "a",
          modelId: "m",
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          costUsdMicros: 3,
        },
      ],
      route: {
        turnNumber: 1,
        routeKey: "band-2",
        model: "m",
        policy: "cheap-first",
        reason: "short",
      },
    });
    const loaded = fromText(b.text(), run);
    const views = [
      ...allViews(loaded, [
        `tool:${spans.tool}`,
        `answer:${spans.answerModel}`,
        `model:${spans.model}`,
        `turn:${spans.turn}`,
      ]),
      foldContext(loaded, 1),
    ];
    const keys = new Set<string>();
    let walked = 0;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          walked++;
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(views);
    expect(walked).toBeGreaterThan(100);
    expect([...keys].filter((key) => isCredentialKey(key))).toEqual([]);
    // The pool's route key is shown as a band, under a name the masker leaves alone.
    expect(JSON.stringify(views)).toContain('"band":"band-2"');
  });
});
