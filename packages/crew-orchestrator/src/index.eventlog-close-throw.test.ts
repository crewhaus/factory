/**
 * Isolated test for the defensive `eventLog.close().catch(() => {})` in
 * `driveCrew`'s `finally`.
 *
 * The orchestrator opens one event-log handle for the whole crew session and
 * closes it once the drive loop finishes. The close is wrapped in
 * `.catch(() => {})` so a flush/close failure on teardown can never turn a
 * successful crew run into a rejected iterator — the events the consumer
 * already saw stand, and the run resolves cleanly. Through ordinary inputs the
 * close always succeeds, so we force it: the mock makes ONLY the first
 * `openEventLog` call (the orchestrator's own handle) reject on `close()`,
 * while every later call (the per-role `runChatLoop` handles) delegates to the
 * real implementation untouched. The crew must still complete with `crew_done`
 * and must not surface the close error.
 *
 * `mock.module` mutates the shared module registry, so this lives in its own
 * file: Bun gives each test file a fresh module graph, which keeps the stub
 * from leaking into `index.test.ts`.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { EventLog } from "@crewhaus/event-log";

// Capture the REAL `openEventLog` *before* registering the stub below. A
// dynamic import resolved prior to `mock.module` returns the genuine module
// binding, so calling `realOpen` from inside the stub delegates to the real
// implementation instead of recursing into the stub.
const realOpen = (await import("@crewhaus/event-log")).openEventLog;

let openCalls = 0;

mock.module("@crewhaus/event-log", () => ({
  // Wrap only the FIRST handle (the orchestrator's crew-session log) so its
  // `close()` rejects. Subsequent handles (runtime-core's per-turn logs) are
  // returned verbatim, so resume/replay and their own clean close keep
  // working.
  openEventLog: async (sessionId: string, opts?: { rootDir?: string }): Promise<EventLog> => {
    const handle = await realOpen(sessionId, opts ?? {});
    openCalls += 1;
    if (openCalls === 1) {
      return {
        append: handle.append.bind(handle),
        read: handle.read.bind(handle),
        close: async () => {
          // Best-effort real close so the temp dir still tidies up, then
          // reject the way a flush failure would.
          await handle.close().catch(() => {});
          throw new Error("synthetic close failure");
        },
      };
    }
    return handle;
  },
}));

// Import the unit under test AFTER the stub is registered so its
// `import { openEventLog } from "@crewhaus/event-log"` binding resolves to the
// wrapped factory.
const { Crew } = await import("./index.js");
type CrewEvent = import("./index.js").CrewEvent;

function newTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "crew-orchestrator-closethrow-"));
}

async function collect(iter: AsyncIterable<CrewEvent>): Promise<CrewEvent[]> {
  const out: CrewEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function makeSoloAdapter(): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: () =>
      (async function* () {
        yield { kind: "message_start" } as StreamEvent;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as StreamEvent;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok solo" },
        } as StreamEvent;
        yield { kind: "content_block_stop", index: 0 } as StreamEvent;
        yield { kind: "message_delta", stopReason: "end_turn" } as StreamEvent;
        yield { kind: "message_stop" } as StreamEvent;
      })(),
  };
}

describe("event-log close failure on teardown", () => {
  test("a rejecting eventLog.close() does not fail an otherwise-successful crew run", async () => {
    const root = newTempRoot();
    try {
      const crew = Crew()
        .setName("close-throw")
        .addRole("solo", { model: "stub", instructions: "Solo." })
        .setEntry("solo")
        .compile();

      // The consumer drains every event; the close rejection inside the
      // drive loop's `finally` must be swallowed so this resolves normally.
      const events = await collect(
        crew.run("hello", { sessionRootDir: root, _adapter: makeSoloAdapter(), maxActivations: 4 }),
      );

      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["role_start", "role_end", "crew_done"]);
      const done = events[events.length - 1];
      if (done?.kind !== "crew_done") throw new Error("crew_done missing");
      expect(done.finalOutput).toBe("ok solo");
      // Sanity: the orchestrator's handle was the one we wrapped.
      expect(openCalls).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
