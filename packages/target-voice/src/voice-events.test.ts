/**
 * Why voice-runtime's input-check events (`input_blocked`, `input_warned`)
 * carry rule ids and never the caller's words: the emitted voice loop hands
 * every adapter event to its listener whole, and the smoke daemon prints each
 * one whole to stdout, which a supervised run keeps in its logs. This pins
 * that premise; if the daemon ever filters or rewrites events, the events'
 * content rule should be revisited with it. It changes nothing emitted.
 */
import { describe, expect, test } from "bun:test";
import type { IrVoiceV0 } from "@crewhaus/ir";
import { emitVoice } from "./index.js";

const LOOP_FORWARDS = "const off = adapter.on((ev) => opts.listener(ev));";
const DAEMON_PRINTS = 'listener: (ev) => emit({ kind: "voice_event", event: ev }),';
const DAEMON_EMIT = "process.stdout.write(`${JSON.stringify(event)}\\n`);";

const ir: IrVoiceV0 = {
  version: 0,
  name: "voice-events",
  target: "voice",
  agent: { model: "gpt-realtime", instructions: "be brief" },
  voice: {
    provider: "openai",
    voiceId: "alloy",
    vad: "server",
    bargeInTriggerFrames: 4,
    bargeInWindowMs: 200,
  },
  tools: [],
  toolConfigs: Object.freeze({}),
  mcp_servers: Object.freeze({}),
  permissions: { rules: [] },
  compaction: {},
};

const fileOf = (path: string): string =>
  emitVoice(ir).files.find((f) => f.path === path)?.content ?? "";

/** What breaks the premise, or [] when every event reaches stdout whole. */
function premiseProblems(loop: string, daemon: string): string[] {
  const problems: string[] = [];
  if (!loop.includes(LOOP_FORWARDS)) problems.push("the loop does not forward every event whole");
  if (!daemon.includes(DAEMON_PRINTS)) problems.push("the daemon does not print every event whole");
  if (!daemon.includes(DAEMON_EMIT)) problems.push("the daemon's emit is not a whole-line print");
  return problems;
}

describe("voice events reach the smoke daemon's stdout whole (premise)", () => {
  test("holds for the emitted bundle", () => {
    const loop = fileOf("voice-loop.ts");
    const daemon = fileOf("daemon.ts");
    expect(loop.length).toBeGreaterThan(0);
    expect(daemon.length).toBeGreaterThan(0);
    expect(premiseProblems(loop, daemon)).toEqual([]);
  });

  test("fails on a daemon whose listener prints a filtered or rewritten event", () => {
    const loop = fileOf("voice-loop.ts");
    const daemon = fileOf("daemon.ts");
    const filtered = daemon.replace(
      DAEMON_PRINTS,
      'listener: (ev) => { if (ev.kind !== "audio_chunk") emit({ kind: "voice_event", event: ev }); },',
    );
    expect(filtered).not.toBe(daemon);
    expect(premiseProblems(loop, filtered)).toEqual([
      "the daemon does not print every event whole",
    ]);
    const rewritten = daemon.replace(
      DAEMON_PRINTS,
      'listener: (ev) => emit({ kind: "voice_event", event: { kind: ev.kind } }),',
    );
    expect(premiseProblems(loop, rewritten)).toEqual([
      "the daemon does not print every event whole",
    ]);
  });
});
