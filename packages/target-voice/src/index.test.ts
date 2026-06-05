import { describe, expect, test } from "bun:test";
import type { IrVoiceV0 } from "@crewhaus/ir";
import { TargetEmitError, emitVoice } from "./index.js";

const baseIr: IrVoiceV0 = {
  version: 0,
  name: "hello-voice",
  target: "voice",
  agent: { model: "gpt-4o-realtime-preview", instructions: "be brief" },
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

describe("emitVoice", () => {
  test("emits agent.ts + voice-loop.ts + daemon.ts (T1 bundle structure)", () => {
    const bundle = emitVoice(baseIr);
    expect(bundle.files.map((f) => f.path).sort()).toEqual([
      "agent.ts",
      "daemon.ts",
      "voice-loop.ts",
    ]);
  });

  test("agent.ts exports AGENT_CONFIG with the spec values inlined", () => {
    const code = emitVoice(baseIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(code).toContain("AGENT_CONFIG");
    expect(code).toContain('"hello-voice"');
    expect(code).toContain('"gpt-4o-realtime-preview"');
    expect(code).toContain('"alloy"');
    expect(code).toContain("bargeInTriggerFrames: 4");
  });

  test("voice-loop.ts wires barge-in-controller + vad-engine + voice-runtime", () => {
    const code = emitVoice(baseIr).files.find((f) => f.path === "voice-loop.ts")?.content ?? "";
    expect(code).toContain("@crewhaus/barge-in-controller");
    expect(code).toContain("@crewhaus/voice-runtime");
    expect(code).toContain("@crewhaus/vad-engine");
    expect(code).toContain("createBargeInController");
    expect(code).toContain("createRealtimeAdapter");
    expect(code).toContain("frames30ms");
  });

  test("daemon.ts has a --smoke <pcm-path> path that emits voice_event JSON lines", () => {
    const code = emitVoice(baseIr).files.find((f) => f.path === "daemon.ts")?.content ?? "";
    expect(code).toContain('"--smoke"');
    expect(code).toContain('"voice_event"');
    expect(code).toContain('"smoke_start"');
    expect(code).toContain('"smoke_done"');
    expect(code).toContain("loadPcm");
  });

  test("vapi provider is forwarded to the loop verbatim", () => {
    const ir: IrVoiceV0 = {
      ...baseIr,
      voice: { ...baseIr.voice, provider: "vapi" },
    };
    const code = emitVoice(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(code).toContain('provider: "vapi"');
  });

  test("telephony block (when present) is wired into AGENT_CONFIG", () => {
    const ir: IrVoiceV0 = {
      ...baseIr,
      telephony: { provider: "twilio" },
    };
    const code = emitVoice(ir).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(code).toContain('telephony: { provider: "twilio" }');
  });

  test("absent telephony block yields telephony: undefined", () => {
    const code = emitVoice(baseIr).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(code).toContain("telephony: undefined");
  });

  test("TargetEmitError type is exported", () => {
    expect(TargetEmitError).toBeDefined();
  });

  test("TargetEmitError carries the compiler code, name, and message", () => {
    const err = new TargetEmitError("voice codegen blew up");
    expect(err).toBeInstanceOf(TargetEmitError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TargetEmitError");
    expect(err.message).toBe("voice codegen blew up");
    expect(err.code).toBe("compiler");
  });

  test("TargetEmitError threads its cause through toJSON()", () => {
    const root = new Error("disk full");
    const err = new TargetEmitError("could not emit daemon", root);
    expect(err.cause).toBe(root);
    expect(err.toJSON()).toEqual({
      name: "TargetEmitError",
      code: "compiler",
      message: "could not emit daemon",
      cause: { name: "Error", message: "disk full" },
    });
  });
});
