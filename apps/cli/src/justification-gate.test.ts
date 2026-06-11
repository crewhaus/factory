import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { openAuditLog, verify } from "@crewhaus/audit-log";
import type { JustificationJudge } from "@crewhaus/permission-engine";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import {
  InvalidJudgeChoiceError,
  createJustificationJudge,
  justificationAuditDir,
  openJustificationAuditSink,
  resolveJudgeChoice,
} from "./justification-gate";

// ---------------------------------------------------------------------------
// Pure judge-choice resolution (flag > spec > rule-based) + invalid handling.
// ---------------------------------------------------------------------------

describe("resolveJudgeChoice", () => {
  test("defaults to rule-based when neither flag nor spec supply a judge", () => {
    expect(resolveJudgeChoice(undefined, undefined)).toBe("rule-based");
    expect(resolveJudgeChoice(undefined, {})).toBe("rule-based");
  });

  test("the spec's security.justification.judge is used when the flag is absent", () => {
    expect(resolveJudgeChoice(undefined, { judge: "claude" })).toBe("claude");
  });

  test("the --justification-judge flag overrides the spec", () => {
    // spec says claude, flag says rule-based → flag wins.
    expect(resolveJudgeChoice("rule-based", { judge: "claude" })).toBe("rule-based");
    expect(resolveJudgeChoice("claude", { judge: "rule-based" })).toBe("claude");
  });

  test("an unrecognised value throws InvalidJudgeChoiceError with the allowed list", () => {
    expect(() => resolveJudgeChoice("gpt-omniscient", undefined)).toThrow(InvalidJudgeChoiceError);
    try {
      resolveJudgeChoice("gpt-omniscient", undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidJudgeChoiceError);
      expect((err as InvalidJudgeChoiceError).choice).toBe("gpt-omniscient");
      expect((err as InvalidJudgeChoiceError).message).toContain("rule-based, claude");
    }
  });
});

describe("createJustificationJudge", () => {
  test("returns undefined for rule-based (caller falls back to ruleBasedJustificationJudge)", async () => {
    expect(await createJustificationJudge("rule-based", undefined)).toBeUndefined();
  });

  test("returns a callable JustificationJudge for claude (lazy import resolves)", async () => {
    // Proves the CLI's lazy import of @crewhaus/justification-judge-claude +
    // the anthropic adapter resolves and yields a function. The judge's
    // verdict behaviour (incl. fail-closed) is exhaustively covered in the
    // judge package's own stubbed tests; here we only assert the handoff
    // produces the functional interface runChatLoop consumes. A dummy key
    // satisfies the adapter constructor — it is never called (no turn runs).
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-no-call";
    try {
      const judge = await createJustificationJudge("claude", "claude-haiku-4-5");
      expect(typeof judge).toBe("function");
    } finally {
      // Assignment (not `delete`) to restore — matches the env-restore pattern
      // used elsewhere (runtime-core/src/index.test.ts) and avoids noDelete.
      process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  test("a non-Anthropic judge model resolves via the model-router and carries the STRIPPED wire model", async () => {
    // `local/<m>@<url>` resolves the real OpenAI-compatible adapter with NO
    // API key required, so this exercises the router path end-to-end. The
    // endpoint is unreachable (port 1) — the judge fails CLOSED, and its
    // verdict's judgeModel must carry the stripped wire id `<model> (error)`,
    // NOT the full prefixed router string the old hardcoded
    // createAnthropicAdapter() path passed verbatim.
    const judge = await createJustificationJudge(
      "claude",
      "local/justification-judge-model@http://127.0.0.1:1/v1",
    );
    expect(typeof judge).toBe("function");
    if (judge === undefined) throw new Error("unreachable");
    const verdict = await judge({
      toolName: "SendMessage",
      justification: "post the summary",
      sessionGoal: "summarize the channel",
      input: { text: "hi" },
    });
    expect(verdict.allow).toBe(false); // fail-closed on transport error
    expect(verdict.judgeModel).toBe("justification-judge-model (error)");
  });
});

describe("openJustificationAuditSink", () => {
  test("returns undefined when disabled", async () => {
    expect(await openJustificationAuditSink({ cwd: "/tmp", enabled: false })).toBeUndefined();
  });

  test("roots the audit dir at <cwd>/.crewhaus/audit", () => {
    expect(justificationAuditDir("/work")).toBe(join("/work", ".crewhaus", "audit"));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the CLI-resolved judge + CLI-opened durable sink actually
// govern a real gate decision, and the durable, hash-chained
// `permission_justification_evaluated` record records the judge identity.
// This closes the CLI->runtime handoff gap (the prior CLI test only proved
// the lazy import resolved; the judge was never called because stdin closed
// before any turn).
// ---------------------------------------------------------------------------

/** One-turn stub adapter: emits a `tool_use` for the justification-gated
 *  `sendmessage` tool (carrying a justification), then plain text so the
 *  single-turn loop terminates. No network — deterministic. */
function makeGatedToolUseAdapter(justification: string): ProviderAdapter {
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
            block: { type: "tool_use", id: "toolu_cli", name: "sendmessage", input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ body: "ack", justification }),
            },
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

describe("justification gate end-to-end (CLI sink + judge -> durable audit)", () => {
  test("a CLI-opened audit sink records a verify()-clean permission_justification_evaluated record carrying the judge identity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "crewhaus-just-gate-"));
    try {
      // The judge the CLI would resolve — here a stub with a distinctive model
      // id so the assertion on the DURABLE record's judgeModel is exact and
      // deterministic (no live model). The CLI's real claude-judge factory is
      // covered above; the judge package's verdict logic is covered in its own
      // suite. This test owns the handoff: CLI sink + a judge -> a real gate
      // decision -> a durable, hash-chained record.
      const judge: JustificationJudge = async () => ({
        allow: true,
        reason: "justification is consistent with the acknowledgement goal",
        confidence: 0.83,
        judgeModel: "claude-haiku-4-5",
      });

      // Open the sink exactly the way `crewhaus run` does (rooted at
      // <cwd>/.crewhaus/audit), via the CLI helper under test.
      const sink = await openJustificationAuditSink({ cwd, enabled: true });
      expect(sink).toBeDefined();

      const sendMessage = buildTool({
        name: "sendmessage",
        description: "send a message (justification-gated)",
        inputSchema: z.object({ body: z.string(), justification: z.string().optional() }),
        requireJustification: true,
        execute: async () => "sent",
      });

      const JUSTIFICATION = "acknowledge the user's support ticket per the session goal";
      await runChatLoop({
        model: "test-model",
        instructions: "Acknowledge support tickets the user points you at.",
        _adapter: makeGatedToolUseAdapter(JUSTIFICATION),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "ack the ticket" }],
        tools: [sendMessage],
        permissionMode: "bypass",
        justificationJudge: judge,
        // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
        justificationAuditSink: sink!,
      });

      // The durable, hash-chained chain must be intact.
      const auditDir = justificationAuditDir(cwd);
      const v = await verify(auditDir);
      expect(v.ok).toBe(true);
      expect(v.recordsChecked).toBe(1);

      // Read the record back and assert the kind, verbatim justification, and
      // judge identity — proving the CLI-resolved judge governed a real gate
      // decision that reached the durable audit log.
      const log = await openAuditLog({ rootDir: auditDir });
      const records = [];
      for await (const r of log.read()) records.push(r);
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec?.kind).toBe("permission_justification_evaluated");
      const payload = rec?.payload as {
        toolName: string;
        justification: string;
        verdict: string;
        judgeModel: string;
        confidence?: number;
      };
      expect(payload.toolName).toBe("sendmessage");
      expect(payload.verdict).toBe("allow");
      expect(payload.judgeModel).toBe("claude-haiku-4-5");
      // Stored VERBATIM (the audit kind's contract), not a `reason` substring.
      expect(payload.justification).toBe(JUSTIFICATION);
      expect(payload.confidence).toBe(0.83);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("--no-justification-audit (enabled:false) writes no durable record", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "crewhaus-just-gate-off-"));
    try {
      const sink = await openJustificationAuditSink({ cwd, enabled: false });
      expect(sink).toBeUndefined();

      const sendMessage = buildTool({
        name: "sendmessage",
        description: "send a message (justification-gated)",
        inputSchema: z.object({ body: z.string(), justification: z.string().optional() }),
        requireJustification: true,
        execute: async () => "sent",
      });

      await runChatLoop({
        model: "test-model",
        instructions: "Acknowledge support tickets the user points you at.",
        _adapter: makeGatedToolUseAdapter("ack the ticket per the goal"),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "ack the ticket" }],
        tools: [sendMessage],
        permissionMode: "bypass",
        // no judge => rule-based default; no sink => no durable record.
      });

      // Nothing was written under the audit dir (verify on a missing dir is ok/0).
      const v = await verify(justificationAuditDir(cwd));
      expect(v.ok).toBe(true);
      expect(v.recordsChecked).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
