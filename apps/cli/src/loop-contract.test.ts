import { describe, expect, test } from "bun:test";
import type { HookDef } from "@crewhaus/hooks-engine";
import {
  formatCompileWarning,
  isValidAskMode,
  loopContractRunOptions,
  mergeSpecHooks,
  resolveAskMode,
  resolveStreaming,
} from "./loop-contract";

describe("resolveAskMode (loop contract 0.4, Batch C — G11)", () => {
  test('defaults to "pause" — the documented safe direction', () => {
    expect(resolveAskMode(undefined, undefined)).toBe("pause");
  });

  test("the spec's permissions.ask_mode is honoured when no flag is given", () => {
    expect(resolveAskMode(undefined, "deny")).toBe("deny");
    expect(resolveAskMode(undefined, "pause")).toBe("pause");
  });

  test("a valid flag beats the spec, mirroring --permission-mode precedence", () => {
    expect(resolveAskMode("deny", "pause")).toBe("deny");
    expect(resolveAskMode("pause", "deny")).toBe("pause");
  });

  test("a non-string flag (a bare --ask-mode parses as true) falls through to the spec", () => {
    expect(resolveAskMode(true, "deny")).toBe("deny");
  });

  test("validation is the caller's job — an invalid flag never silently wins", () => {
    // The CLI die()s on this before calling. If that guard were ever dropped,
    // falling through to the spec/default is the safe direction.
    expect(isValidAskMode("sometimes")).toBe(false);
    expect(resolveAskMode("sometimes", "pause")).toBe("pause");
    expect(resolveAskMode("sometimes", undefined)).toBe("pause");
  });
});

describe("loopContractRunOptions (loop contract 0.4, Batch A)", () => {
  test("an empty IR slice spreads NOTHING (runtime defaults stay authoritative)", () => {
    expect(loopContractRunOptions({})).toEqual({});
    expect(loopContractRunOptions({ limits: {}, compaction: {}, agent: {} })).toEqual({});
  });

  test("every limits field maps 1:1 onto the option contract", () => {
    const out = loopContractRunOptions({
      limits: {
        maxToolIterations: 25,
        maxConcurrentTools: 2,
        contextLimit: 120_000,
        deadlineMs: 600_000,
        turnTimeoutMs: 120_000,
        modelCallTimeoutMs: 60_000,
        loopDetection: { window: 12, threshold: 3, escalation: "abort" },
      },
    });
    expect(out).toEqual({
      maxToolIterations: 25,
      maxConcurrentTools: 2,
      contextLimit: 120_000,
      deadlineMs: 600_000,
      turnTimeoutMs: 120_000,
      modelCallTimeoutMs: 60_000,
      loopDetection: { window: 12, threshold: 3, escalation: "abort" },
    });
  });

  test("a partial limits block carries only the declared fields", () => {
    const out = loopContractRunOptions({ limits: { maxToolIterations: 40 } });
    expect(out).toEqual({ maxToolIterations: 40 });
    expect("maxConcurrentTools" in out).toBe(false);
    expect("loopDetection" in out).toBe(false);
  });

  test("thinking is carried verbatim in both forms", () => {
    expect(loopContractRunOptions({ agent: { thinking: { budgetTokens: 2048 } } })).toEqual({
      thinking: { budgetTokens: 2048 },
    });
    expect(loopContractRunOptions({ agent: { thinking: { effort: "low" } } })).toEqual({
      thinking: { effort: "low" },
    });
  });

  test("rateLimits carries the per-tool record (incl. the * bucket); empty records are dropped", () => {
    expect(
      loopContractRunOptions({
        agent: { rateLimits: { bash: { rpm: 30, burst: 5 }, "*": { rpm: 120 } } },
      }),
    ).toEqual({ rateLimits: { bash: { rpm: 30, burst: 5 }, "*": { rpm: 120 } } });
    expect(loopContractRunOptions({ agent: { rateLimits: {} } })).toEqual({});
  });

  test("compaction tuning knobs land on the runtime option names", () => {
    expect(
      loopContractRunOptions({
        compaction: { threshold: 0.8, snipKeepHead: 6, snipKeepTail: 30 },
      }),
    ).toEqual({ compactionThreshold: 0.8, snipKeepHead: 6, snipKeepTail: 30 });
  });
});

describe("mergeSpecHooks (spec hooks BELOW settings.json priority)", () => {
  const settings: HookDef[] = [
    { event: "pre-tool", matcher: "Bash", command: "settings.sh" },
    { event: "stop", command: "user-stop.sh" },
  ];

  test("spec hooks come FIRST (lowest layer) and settings.json entries follow", () => {
    const merged = mergeSpecHooks(
      [{ event: "pre-tool", matcher: "Bash", command: "spec.sh", timeoutMs: 3000 }],
      settings,
    );
    expect(merged.map((h) => h.command)).toEqual(["spec.sh", "settings.sh", "user-stop.sh"]);
    // aggregateDecisions shallow-merges mutate later-wins, so the settings
    // layer (later) overrides the spec layer — "below settings.json priority".
  });

  test("no spec hooks returns the settings array unchanged (same reference)", () => {
    expect(mergeSpecHooks(undefined, settings)).toBe(settings);
    expect(mergeSpecHooks([], settings)).toBe(settings);
  });

  test("spec declaration order is preserved inside the spec layer", () => {
    const merged = mergeSpecHooks(
      [
        { event: "session-start", command: "a.sh" },
        { event: "session-start", command: "b.sh" },
      ],
      [],
    );
    expect(merged.map((h) => h.command)).toEqual(["a.sh", "b.sh"]);
  });
});

describe("resolveStreaming (--streaming flag > spec agent.streaming)", () => {
  test("the flag forces streaming on regardless of the spec", () => {
    expect(resolveStreaming(true, undefined)).toBe(true);
    expect(resolveStreaming(true, false)).toBe(true);
  });

  test("without the flag the spec's declared value is carried verbatim", () => {
    expect(resolveStreaming(false, true)).toBe(true);
    expect(resolveStreaming(false, false)).toBe(false);
  });

  test("neither flag nor spec → undefined (caller spreads nothing)", () => {
    expect(resolveStreaming(false, undefined)).toBeUndefined();
  });
});

describe("formatCompileWarning", () => {
  test("renders code + path + message on one line", () => {
    expect(
      formatCompileWarning({
        code: "accepted-but-unwired",
        path: "thredz",
        message: "thredz is accepted on the channel shape but its emitter does not wire it yet",
      }),
    ).toBe(
      "warning[accepted-but-unwired] thredz: thredz is accepted on the channel shape but its emitter does not wire it yet",
    );
  });
});
