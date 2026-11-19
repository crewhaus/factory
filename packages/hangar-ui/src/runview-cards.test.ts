/**
 * The run view's cards: every kind a harness's trace can carry has its own card,
 * the shape UIs' kinds all draw here too, an unknown kind still draws, and what
 * a model wrote is never shown.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as adapter from "../assets/js/runview/adapter.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as cards from "../assets/js/runview/cards.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as runview from "../assets/js/runview/index.js";

type Card = {
  kind: string;
  title: string;
  severity: string;
  sub?: string;
  meta?: string;
  badge?: string;
  children?: { label: string; text: string }[];
};
const { CARD_KINDS, cardFor, fmtMicros } = cards as {
  CARD_KINDS: readonly string[];
  cardFor(event: unknown): Card;
  fmtMicros(micros: unknown): string;
};
const { fromEnvelope, fromLegacy, MARKER_WORDS } = adapter as {
  fromEnvelope(
    type: string,
    env: unknown,
  ): { id: string | null; marker?: string; card: Card; resumeFrom?: string }[];
  fromLegacy(event: string, data: unknown): { marker?: string; card: Card; costMicros?: number }[];
  MARKER_WORDS: Readonly<Record<string, string>>;
};
const { stateOf } = runview as { stateOf(items: unknown[]): string | null };

/** The trace union's kinds, read from its source. */
function traceKinds(): string[] {
  const path = join(import.meta.dir, "..", "..", "trace-event-bus", "src", "types.ts");
  const source = readFileSync(path, "utf8");
  const union = source.slice(
    source.indexOf("export type TraceEvent ="),
    source.indexOf("export type TraceEventKind"),
  );
  const names = [...union.matchAll(/\|\s*(\w+)/g)].map((m) => m[1] as string);
  return names.map((name) => {
    const at = source.indexOf(`export type ${name} =`);
    const body = source.slice(at, source.indexOf("\n};", at));
    const kind = /kind:\s*"([^"]+)"/.exec(body)?.[1];
    if (kind === undefined) throw new Error(`${name} has no kind`);
    return kind;
  });
}

/**
 * The shape UIs' renderer kinds (crewhaus/ui `_shared/events.js`: its renderers, its
 * failure card, and the kinds its feed skips). Each draws its own card here too.
 */
const SHAPE_UI_KINDS = [
  "turn_start",
  "turn_end",
  "model_response",
  "tool_call_start",
  "tool_call_end",
  "mcp_call_start",
  "mcp_call_end",
  "permission_decision",
  "hook_fired",
  "compaction_fired",
  "error_recovered",
  "sub_agent_start",
  "sub_agent_end",
  "role_start",
  "role_end",
  "handoff",
  "a2a_message",
  "crew_done",
  "cost_accrual",
  "test_verdict",
  "program_output",
  "coverage_report",
  "sanitizer_report",
  "circuit_state_changed",
  "cache_rotation",
  "model_route",
  "model_tier_route",
  "model_failover",
  "run_failed",
  "model_stream_token",
  "tool_stream_chunk",
  "model_request",
];

describe("cardFor", () => {
  test("every kind of the trace union has its own card", () => {
    const kinds = traceKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(45);
    for (const kind of kinds) {
      const card = cardFor({ kind, turn: 1, toolName: "Bash" });
      expect([kind, card.title.startsWith("Other event")]).toEqual([kind, false]);
      expect([kind, CARD_KINDS.includes(kind)]).toEqual([kind, true]);
      expect(["quiet", "info", "notice", "warn", "error"]).toContain(card.severity);
    }
  });

  test("every kind the shape UIs draw has its card here", () => {
    for (const kind of SHAPE_UI_KINDS) {
      expect([kind, cardFor({ kind }).title.startsWith("Other event")]).toEqual([kind, false]);
    }
  });

  test("an unknown kind still draws, named", () => {
    expect(cardFor({ kind: "new_thing" })).toEqual({
      kind: "new_thing",
      title: "Other event (new_thing)",
      severity: "info",
    });
    expect(cardFor(null).title).toBe("Other event (unknown)");
  });

  test("what a model wrote is never shown", () => {
    const thought = "secret plan: first I will";
    for (const kind of ["model_response", "model_stream_token", "model_request"]) {
      const card = cardFor({
        kind,
        text: thought,
        content: thought,
        delta: thought,
        thinking: thought,
      });
      expect(JSON.stringify(card)).not.toContain("secret plan");
    }
  });

  test("a failed tool and a failed run read as problems, in words", () => {
    expect(cardFor({ kind: "tool_call_end", toolName: "Bash", isError: true })).toMatchObject({
      title: "A call to Bash failed",
      severity: "error",
      badge: "failed",
    });
    expect(cardFor({ kind: "run_failed", class: "auth", message: "no key" })).toMatchObject({
      severity: "error",
      badge: "auth",
      sub: "no key",
    });
  });

  test("a card with only its kind states no outcome and holds no placeholder", () => {
    const outcome = /\b(allowed|given|finished|ok)\b|found nothing/i;
    for (const kind of CARD_KINDS) {
      const card = cardFor({ kind });
      expect(`${kind}: ${card.title}`).not.toContain("?");
      expect(`${kind}: ${outcome.test(card.title)}`).toBe(`${kind}: false`);
      expect(`${kind}: ${/^[A-Z]/.test(card.title)}`).toBe(`${kind}: true`);
      expect(`${kind}: ${card.badge === "ok" || card.badge === "failed"}`).toBe(`${kind}: false`);
    }
    // With the field that proves it, the outcome is said.
    expect(cardFor({ kind: "tool_call_end", toolName: "Bash", isError: false })).toMatchObject({
      title: "A call to Bash finished",
      badge: "ok",
    });
    expect(cardFor({ kind: "approval_resolved", decision: "deny" }).title).toBe(
      "Approval was denied",
    );
  });

  test("an unpriced cost is unknown, never $0", () => {
    expect(fmtMicros(undefined)).toBe("cost unknown");
    expect(cardFor({ kind: "cost_accrual" }).meta).toBe("cost unknown");
    expect(fmtMicros(1_500_000)).toBe("$1.50");
  });
});

describe("the two streams as one", () => {
  test("Home's own stream: a replay, output, a state and its end", () => {
    const items = fromLegacy("replay", {
      events: [
        { kind: "turn_start", turn: 1 },
        { kind: "cost_accrual", costUsdMicros: 2500 },
      ],
      proseTail: ["hello", ""],
      eventsTruncated: true,
    });
    expect(items[0]?.marker).toBe("replayed");
    expect(items[0]?.card.title).toContain("older ones were not kept");
    expect(items[2]?.costMicros).toBe(2500);
    expect(items.at(-1)?.card.kind).toBe("output");
    expect(fromLegacy("done", {})[0]?.marker).toBe("closed");
    expect(fromLegacy("state", { snapshot: { state: "running" } })[0]?.card.title).toBe(
      "Now running",
    );
    expect(fromLegacy("ping", {})).toEqual([]);
  });

  test("Home's own stream: how a run ended, from its exit or its ledger row", () => {
    const failed = fromLegacy("replay", {
      events: [],
      live: false,
      entry: { exitCode: 2, failureClass: "auth" },
    });
    const exit = failed.find((item) => item.card.kind === "exit")?.card;
    expect(exit).toMatchObject({ title: "Exited 2", severity: "error" });
    expect(exit?.sub).toContain("Exit code 2");
    expect(exit?.sub).toContain("Will not auto-restart");
    expect(exit?.children?.[0]?.label).toBe("Fix");
    expect(exit?.children?.[0]?.text).toContain("credential");
    expect(stateOf(failed)).toBe("Exited 2");

    const clean = fromLegacy("exit", {
      classification: { disposition: "clean", title: "Finished cleanly", exitCode: 0 },
    })[0]?.card;
    expect(clean).toMatchObject({ title: "Finished cleanly", severity: "notice" });
    const parked = fromLegacy("exit", {
      classification: { disposition: "parked", title: "Parked", restartable: false },
    })[0]?.card;
    expect(parked?.severity).toBe("warn");

    // Still running, it says so; ended with nothing recorded, it says it ended.
    expect(stateOf(fromLegacy("replay", { events: [], live: true }))).toBe("Running");
    const ended = [...fromLegacy("replay", { events: [], live: false }), ...fromLegacy("done", {})];
    expect(stateOf(ended)).toBe("Ended");
    expect(stateOf(fromLegacy("replay", { events: [], live: false }))).toBeNull();
  });

  test("the versioned API's stream: states, trace kinds and the stream's own markers", () => {
    const started = fromEnvelope("run.started", { id: "c1", at: "t", payload: {} });
    expect(started[0]).toMatchObject({ id: "c1", card: { title: "Running" } });
    expect(
      fromEnvelope("run.trace", { id: "c2", payload: { traceKind: "tool_call_end" } })[0]?.card
        .kind,
    ).toBe("tool_call_end");
    expect(
      fromEnvelope("stream.gap", { id: "c3", payload: { reason: "evicted" } })[0],
    ).toMatchObject({
      marker: "gap",
      card: { title: MARKER_WORDS["evicted"] },
    });
    expect(
      fromEnvelope("stream.gap", { id: "c4", payload: { reason: "unreadable" } })[0]?.card.title,
    ).toBe("Events are missing here: unreadable");
    expect(fromEnvelope("stream.reset", { id: "c5", payload: {} })[0]?.card.title).toBe(
      "This history was replaced (copied or restored). Showing it from the start.",
    );
    expect(
      fromEnvelope("stream.pause", { id: "c6", payload: { resumeFrom: "c6" } })[0],
    ).toMatchObject({
      marker: "pause",
      resumeFrom: "c6",
      card: { title: "Paused after a long stretch of events." },
    });
    expect(
      fromEnvelope("run.failed", { id: "c7", payload: { failureClass: "auth" } })[0]?.card,
    ).toMatchObject({
      title: "Failed",
      severity: "error",
      sub: "Why: auth",
    });
  });
});
