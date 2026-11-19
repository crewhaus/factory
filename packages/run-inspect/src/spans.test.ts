/**
 * The span tree: compaction durations only where they measure the work, spans whose
 * parent is not the run's under the run, and each check of a concurrent tool group on
 * its own call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { LogBuilder, NOW, SESSION, removeFixtures, runId, spanId } from "./__fixtures__/build";
import {
  type LoadedRun,
  type SpanNode,
  type TimelinePage,
  type WhyRecord,
  foldContext,
  foldSpanTree,
  foldSummary,
  foldTimeline,
  foldWhy,
  loadedRunFromText,
} from "./index";

afterAll(removeFixtures);

function fromText(text: string, run: string): LoadedRun {
  const got = loadedRunFromText(text, { now: NOW, session: SESSION, run });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function find(node: SpanNode | undefined, id: string): SpanNode | undefined {
  if (node === undefined) return undefined;
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = find(child, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function everyView(run: LoadedRun, actions: readonly string[]): string {
  const timeline = foldTimeline(run, { view: "full", limit: 500 }) as TimelinePage;
  return JSON.stringify([
    foldSummary(run),
    timeline,
    foldSpanTree(run),
    ...actions.map((a) => foldWhy(run, a)),
    foldContext(run, "all"),
  ]);
}

describe("compaction durations", () => {
  test("a reactive compaction shows its duration; one before a turn shows none, in any view", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const [root, turn, reactive, preTurn] = [spanId(1), spanId(2), spanId(3), spanId(4)];
    b.stamp(run, root);
    b.add("user_message", { content: "go" }, { run, span: root });
    b.add("compaction", { kind: "autocompact", before: 40, after: 3 }, { run, span: preTurn });
    b.close(run, preTurn, "compaction", { parent: turn, durationMs: 987654 });
    b.add("compaction", { kind: "reactive", before: 30, after: 4 }, { run, span: reactive });
    b.close(run, reactive, "compaction", { parent: turn, durationMs: 4321 });
    b.close(run, turn, "turn", { parent: root, turn: { run: 1, session: 1 } });
    b.close(run, root, "run");
    const loaded = fromText(b.text(), run);
    const tree = foldSpanTree(loaded);
    expect(find(tree.root, reactive)?.durationMs).toMatchObject({ state: "recorded", value: 4321 });
    expect(find(tree.root, preTurn)?.durationMs).toMatchObject({
      state: "not-recorded",
      gap: { reason: "not-recorded" },
    });
    expect(find(tree.root, preTurn)?.durationMs.value).toBeUndefined();
    expect(everyView(loaded, [`turn:${turn}`])).not.toContain("987654");
    expect(everyView(loaded, [])).toContain("4321");
  });

  test("a compaction span with no compaction line shows no duration either", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const [root, lone] = [spanId(1), spanId(5)];
    b.stamp(run, root);
    b.close(run, lone, "compaction", { parent: root, durationMs: 55555 });
    b.close(run, root, "run");
    const loaded = fromText(b.text(), run);
    expect(find(foldSpanTree(loaded).root, lone)?.durationMs.state).toBe("not-recorded");
    expect(everyView(loaded, [])).not.toContain("55555");
  });
});

describe("spans whose parent is not the run's", () => {
  test("a peer's run span and a summarizer's model call sit under the run, marked orphan, and nothing throws", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const [root, turn, tool, peerRun, summarizerModel, compaction] = [
      spanId(1),
      spanId(2),
      spanId(3),
      spanId(4),
      spanId(5),
      spanId(6),
    ];
    b.stamp(run, root);
    b.add("tool_use", { id: "tu_1", name: "AskPeer", input: {} }, { run, span: tool });
    // A peer's inline run names the run's top span, not the calling tool.
    b.close(run, peerRun, "run", { parent: spanId(0x99) });
    // The summarizer's model call names no compaction span.
    b.close(run, summarizerModel, "model", { parent: spanId(0x98), call: 2 });
    b.add("compaction", { kind: "reactive", before: 9, after: 2 }, { run, span: compaction });
    b.close(run, compaction, "compaction", { parent: turn });
    b.close(run, tool, "tool", { parent: turn, toolUseId: "tu_1", call: 1 });
    b.close(run, turn, "turn", { parent: root });
    b.close(run, root, "run");
    const tree = foldSpanTree(fromText(b.text(), run));
    expect(tree.root?.id).toBe(root);
    const top = tree.root?.children ?? [];
    expect(top.find((n) => n.id === peerRun)).toMatchObject({ orphan: true });
    expect(top.find((n) => n.id === summarizerModel)).toMatchObject({ orphan: true });
    expect(top.find((n) => n.id === turn)?.orphan).toBeUndefined();
    expect(find(tree.root, tool)?.orphan).toBeUndefined();
    expect(find(tree.root, compaction)?.orphan).toBeUndefined();
  });

  test("a span lines name that nothing closes is unfinished, under the run, with its gap", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const [root, tool] = [spanId(1), spanId(2)];
    b.stamp(run, root);
    b.add("tool_use", { id: "tu_1", name: "Bash", input: {} }, { run, span: tool });
    const loaded = fromText(b.text(), run);
    const tree = foldSpanTree(loaded);
    // The run itself never closed: the process stopped.
    expect(tree.root).toMatchObject({ id: root, kind: "run", unfinished: true });
    expect(tree.root?.children.map((n) => [n.id, n.unfinished])).toEqual([[tool, true]]);
    const unfinished = tree.gaps.filter((gap) => gap.reason === "unfinished");
    expect(unfinished.length).toBe(2);
    expect(foldSummary(loaded).durationMs).toMatchObject({
      state: "not-recorded",
      gap: { reason: "unfinished" },
    });
  });
});

describe("a concurrent tool group", () => {
  test("each check sits on its own call, and two calls sharing a provider id stay two", () => {
    const b = new LogBuilder();
    const run = runId(1);
    const [root, turn, a, bb, c, d] = [
      spanId(1),
      spanId(2),
      spanId(3),
      spanId(4),
      spanId(5),
      spanId(6),
    ];
    b.stamp(run, root);
    const calls = [
      { span: a, id: "tu_1", call: 1, name: "Read" },
      { span: bb, id: "tu_2", call: 2, name: "Grep" },
      { span: c, id: "tu_3", call: 3, name: "Write" },
    ];
    for (const call of calls) {
      b.add("tool_use", { id: call.id, name: call.name, input: {} }, { run, span: call.span });
    }
    // Interleaved checks: each names its own span.
    const outcomes: Record<string, string> = { [a]: "allow", [bb]: "deny", [c]: "ask:parked" };
    for (const call of [calls[2], calls[0], calls[1]]) {
      if (call === undefined) continue;
      b.add(
        "verdict",
        {
          v: 1,
          run,
          span: call.span,
          on: { kind: "tool", toolUseId: call.id, call: call.call },
          gate: "permission",
          outcome: outcomes[call.span],
        },
        { run, span: call.span },
      );
    }
    for (const call of calls) {
      b.add(
        "tool_result",
        { toolUseId: call.id, content: `${call.name} done` },
        { run, span: call.span },
      );
      b.close(run, call.span, "tool", { parent: turn, toolUseId: call.id, call: call.call });
    }
    // A later response reuses the provider's id tu_1 for another call.
    b.add("tool_use", { id: "tu_1", name: "Read", input: { again: true } }, { run, span: d });
    b.add("tool_result", { toolUseId: "tu_1", content: "second read" }, { run, span: d });
    b.close(run, d, "tool", { parent: turn, toolUseId: "tu_1", call: 4 });
    b.close(run, turn, "turn", { parent: root });
    b.close(run, root, "run");
    const loaded = fromText(b.text(), run);
    for (const call of calls) {
      const why = foldWhy(loaded, `tool:${call.span}`) as WhyRecord;
      expect([call.name, why.checks.value?.map((check) => check.outcome)]).toEqual([
        call.name,
        [outcomes[call.span]],
      ]);
    }
    const second = foldWhy(loaded, `tool:${d}`) as WhyRecord;
    expect(second.checks.value).toEqual([]);
    expect(second.result.value?.text).toBe("second read");
    const page = foldTimeline(loaded, { view: "full" }) as TimelinePage;
    const tools = page.entries.filter((entry) => entry.kind === "tool");
    expect(tools.map((t) => t.title).sort()).toEqual(
      ["Used Grep", "Used Read", "Used Read", "Used Write"].sort(),
    );
    expect(tools.filter((t) => t.detail === "second read").length).toBe(1);
    expect(tools.filter((t) => t.detail === "Read done").length).toBe(1);
  });
});
