import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { snip } from "./index";

function userMsg(text: string): Anthropic.MessageParam {
  return { role: "user", content: text };
}

function asstMsg(text: string): Anthropic.MessageParam {
  return { role: "assistant", content: text };
}

describe("snip", () => {
  test("returns a copy unchanged when input fits in head+tail", () => {
    const messages = [userMsg("a"), asstMsg("b"), userMsg("c")];
    const out = snip(messages, 2, 2);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages); // copy, not the same reference
  });

  test("removes middle and inserts marker with correct N", () => {
    const messages = [
      userMsg("u1"),
      asstMsg("a1"),
      userMsg("u2"),
      asstMsg("a2"),
      userMsg("u3"),
      asstMsg("a3"),
    ];
    // keepHead=2, keepTail=2 → drop 2 middle messages
    const out = snip(messages, 2, 2);
    expect(out.length).toBe(5);
    expect(out[0]).toEqual(userMsg("u1"));
    expect(out[1]).toEqual(asstMsg("a1"));
    expect(out[2]).toEqual({
      role: "assistant",
      content: "[Context compacted: 2 messages removed]",
    });
    expect(out[3]).toEqual(userMsg("u3"));
    expect(out[4]).toEqual(asstMsg("a3"));
  });

  test("marker text reports the correct N", () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`));
    const out = snip(messages, 1, 1);
    // 10 - 1 - 1 = 8 removed
    expect(out[1]).toEqual({
      role: "assistant",
      content: "[Context compacted: 8 messages removed]",
    });
    expect(out.length).toBe(3);
  });

  test("does not mutate the input array", () => {
    const messages = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const len = messages.length;
    snip(messages, 1, 1);
    expect(messages.length).toBe(len);
  });

  test("rejects negative keepHead/keepTail", () => {
    expect(() => snip([], -1, 1)).toThrow(RangeError);
    expect(() => snip([], 1, -1)).toThrow(RangeError);
  });

  test("orphan defense: pulls tailStart back to keep tool_use's result", () => {
    // u(0), a:tool_use tu_1 (1), u:tool_result tu_1 (2), a(3), u(4), a(5), u(6), a(7)
    // Naive snip with keepHead=2, keepTail=2 cuts [2..6), orphaning tu_1's result at index 2.
    const messages: Anthropic.MessageParam[] = [
      userMsg("u0"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
      asstMsg("a3"),
      userMsg("u4"),
      asstMsg("a5"),
      userMsg("u6"),
      asstMsg("a7"),
    ];

    const out = snip(messages, 2, 2);
    // Boundary should pull back so tool_result for tu_1 (index 2) is kept inside head.
    // After adjustment headEnd should be at least 3, tailStart at least 6.
    // Result must contain the tool_use at index 1 AND its matching tool_result at index 2.
    const flat = out.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const hasUse = flat.some((b) => b.type === "tool_use" && b.id === "tu_1");
    const hasResult = flat.some((b) => b.type === "tool_result" && b.tool_use_id === "tu_1");
    expect(hasUse).toBe(true);
    expect(hasResult).toBe(true);
  });

  test("orphan defense: pulls headEnd forward to keep tool_result's use", () => {
    // u(0), a(1), u(2), a:tool_use tu_2 (3), u:tool_result tu_2 (4), a(5)
    // Naive snip with keepHead=2, keepTail=2 cuts [2..4), losing tu_2's tool_use.
    const messages: Anthropic.MessageParam[] = [
      userMsg("u0"),
      asstMsg("a1"),
      userMsg("u2"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "Read", input: { path: "/x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_2", content: "file content" }],
      },
      asstMsg("a5"),
    ];

    const out = snip(messages, 2, 2);
    const flat = out.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const hasUse = flat.some((b) => b.type === "tool_use" && b.id === "tu_2");
    const hasResult = flat.some((b) => b.type === "tool_result" && b.tool_use_id === "tu_2");
    expect(hasUse).toBe(true);
    expect(hasResult).toBe(true);
  });

  test("orphan defense can collapse to no-op when adjustments meet", () => {
    // Conversation entirely composed of tool pairs that all reference each other —
    // the boundary should walk to either end and nothing gets snipped.
    const messages: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_A", name: "X", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_A", content: "x" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_B", name: "Y", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_B", content: "y" }],
      },
    ];
    // keepHead=1, keepTail=1 would cut 2 middle, but both halves orphan their counterparts.
    const out = snip(messages, 1, 1);
    // After defense, the snip should either produce a valid pair-preserving result or
    // collapse to the original. Either way, every tool_result has a matching tool_use.
    const flat = out.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    const useIds = new Set(
      flat.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id),
    );
    const resultIds = flat
      .filter((b) => b.type === "tool_result")
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    for (const id of resultIds) {
      expect(useIds.has(id)).toBe(true);
    }
  });

  test("tool_use in head with no matching result anywhere does not move the boundary", () => {
    // index 1 holds a tool_use whose tool_result is absent from the entire
    // conversation. The head-side defense must scan the whole array, find no
    // result (findToolResultIndex → -1), and leave the snip boundary alone.
    const messages: Anthropic.MessageParam[] = [
      userMsg("u0"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_orphan", name: "Bash", input: { cmd: "ls" } }],
      },
      userMsg("u2"),
      asstMsg("a3"),
      userMsg("u4"),
      asstMsg("a5"),
      userMsg("u6"),
      asstMsg("a7"),
    ];

    const out = snip(messages, 2, 2);
    // Naive cut [2..6) removes 4 messages; nothing pulls the boundary because
    // the dangling tool_use has no result to rescue.
    expect(out.length).toBe(5);
    expect(out[2]).toEqual({
      role: "assistant",
      content: "[Context compacted: 4 messages removed]",
    });
    // The dangling tool_use stays in the head untouched (a tool_use without a
    // result is API-legal; only orphan tool_results are rejected).
    const flat = out.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    expect(flat.some((b) => b.type === "tool_use" && b.id === "tu_orphan")).toBe(true);
  });

  test("pre-orphaned tool_result in tail with no use anywhere does not move the boundary", () => {
    // index 6 holds a tool_result whose tool_use is absent from the entire
    // conversation (the input was already orphaned). The tail-side defense must
    // scan the whole array, find no use (findToolUseIndex → -1), and leave the
    // snip boundary alone — input orphans are preserved, not "fixed".
    const messages: Anthropic.MessageParam[] = [
      userMsg("u0"),
      asstMsg("a1"),
      userMsg("u2"),
      asstMsg("a3"),
      userMsg("u4"),
      asstMsg("a5"),
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_ghost", content: "stale" }],
      },
      asstMsg("a7"),
    ];

    const out = snip(messages, 2, 2);
    // Naive cut [2..6) removes 4 messages; the pre-orphaned result stays in tail.
    expect(out.length).toBe(5);
    expect(out[2]).toEqual({
      role: "assistant",
      content: "[Context compacted: 4 messages removed]",
    });
    const flat = out.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    expect(flat.some((b) => b.type === "tool_result" && b.tool_use_id === "tu_ghost")).toBe(true);
  });
});
