/**
 * Item 20 — the durable `egress_decision` audit writer. Before this, egress
 * verdicts existed ONLY as ephemeral trace-bus `permission_decision` events;
 * the `egress_decision` AuditKind had no writer. runChatLoop now appends one
 * `egress_decision` record per NON-PASS egress verdict (warn OR block) when a
 * caller wires `egressAuditSink`, storing only the lineage summary — never the
 * raw payload.
 *
 * Self-contained (no module mocks): a scripted ProviderAdapter (no network), a
 * single-shot `input` stream, an in-memory EgressAuditSink, and a RunContext
 * pre-seeded with tagged data-lineage so the external-scope tool trips the
 * classifier deterministically.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { _clearEgressCache } from "@crewhaus/egress-classifier";
import { createRunContext } from "@crewhaus/run-context";
import type { TrustOrigin } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { type EgressAuditSink, runChatLoop } from "./index";

const FEATURES = {
  caching: "explicit" as const,
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
};

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}
function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null } as Anthropic.TextBlock;
}

function scriptedAdapter(scripts: ReadonlyArray<Anthropic.ContentBlock[]>): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: FEATURES,
    estimateTokens: () => 0,
    stream: () => {
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      i++;
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block === undefined) continue;
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          } else if (block.type === "tool_use") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          }
        }
        yield { kind: "message_delta", stopReason: hasToolUse ? "tool_use" : "end_turn" } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

type CapturedRecord = { kind: string; payload: unknown };
function recordingSink(): { sink: EgressAuditSink; records: CapturedRecord[] } {
  const records: CapturedRecord[] = [];
  return {
    records,
    sink: {
      async append(input) {
        records.push({ kind: input.kind, payload: input.payload });
        return undefined;
      },
    },
  };
}

function quietStdout(): () => void {
  const spy = spyOn(process.stdout, "write").mockImplementation(
    (() => true) as typeof process.stdout.write,
  );
  return () => spy.mockRestore();
}

async function runOnce(opts: {
  readonly sink?: EgressAuditSink;
  readonly lineage?: Map<string, TrustOrigin>;
  readonly toolInput: Record<string, unknown>;
  /** external-dynamic → block on non-user origin; configured → warn. */
  readonly dynamic?: boolean;
}): Promise<void> {
  _clearEgressCache();
  const ctx = createRunContext();
  if (opts.lineage !== undefined) ctx.dataLineage = opts.lineage;
  const exfil = buildTool({
    name: "exfil",
    description: "external sink",
    inputSchema: z.object({ url: z.string() }),
    scope: "external",
    execute: async () => "sent",
  });
  const input = new PassThrough();
  input.write("go\n");
  input.end();
  const restore = quietStdout();
  try {
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: scriptedAdapter([[toolUse("tu_1", "exfil", opts.toolInput)], [textBlock("done")]]),
      input,
      runContext: ctx,
      tools: [exfil],
      permissionMode: "bypass",
      ...(opts.sink !== undefined ? { egressAuditSink: opts.sink } : {}),
      ...(opts.dynamic === true ? { resolveSinkScope: () => "external-dynamic" } : {}),
    });
  } finally {
    restore();
  }
}

describe("egress_decision durable writer (item 20)", () => {
  test("a WARN verdict appends one egress_decision record (lineage summary only)", async () => {
    const { sink, records } = recordingSink();
    // configured sink + non-user origin → warn; tagged token present in payload.
    await runOnce({
      sink,
      lineage: new Map<string, TrustOrigin>([["super-secret-token", "subagent"]]),
      toolInput: { url: "https://x.example/?d=super-secret-token" },
      dynamic: false,
    });
    const egress = records.filter((r) => r.kind === "egress_decision");
    expect(egress.length).toBe(1);
    const p = egress[0]?.payload as Record<string, unknown>;
    expect(p["sinkId"]).toBe("exfil");
    expect(p["sinkScope"]).toBe("external-configured");
    expect(p["verdict"]).toBe("warn");
    expect(p["originsFound"]).toEqual(["subagent"]);
    expect(typeof p["matchCount"]).toBe("number");
    // NO raw payload is stored — the outbound url / secret must not appear.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("x.example");
  });

  test("a BLOCK verdict appends one egress_decision record", async () => {
    const { sink, records } = recordingSink();
    await runOnce({
      sink,
      lineage: new Map<string, TrustOrigin>([["super-secret-token", "subagent"]]),
      toolInput: { url: "https://x.example/?d=super-secret-token" },
      dynamic: true, // external-dynamic → block on non-user origin
    });
    const egress = records.filter((r) => r.kind === "egress_decision");
    expect(egress.length).toBe(1);
    expect((egress[0]?.payload as Record<string, unknown>)["verdict"]).toBe("block");
  });

  test("a PASS verdict writes NOTHING (only non-pass verdicts are durable)", async () => {
    const { sink, records } = recordingSink();
    // No lineage tagged → classifyEgress returns pass → no audit record.
    await runOnce({
      sink,
      toolInput: { url: "https://x.example/hello" },
    });
    expect(records.filter((r) => r.kind === "egress_decision").length).toBe(0);
  });

  test("omitting the sink is a no-op (zero behaviour change for existing callers)", async () => {
    // Just assert the run completes without throwing when no sink is wired.
    await runOnce({
      lineage: new Map<string, TrustOrigin>([["super-secret-token", "subagent"]]),
      toolInput: { url: "https://x.example/?d=super-secret-token" },
    });
    expect(true).toBe(true);
  });

  test("a sink append failure is swallowed (a full audit disk must not crash the run)", async () => {
    const throwingSink: EgressAuditSink = {
      async append() {
        throw new Error("audit disk full");
      },
    };
    await runOnce({
      sink: throwingSink,
      lineage: new Map<string, TrustOrigin>([["super-secret-token", "subagent"]]),
      toolInput: { url: "https://x.example/?d=super-secret-token" },
    });
    // Reaching here means the throw was caught inside runChatLoop.
    expect(true).toBe(true);
  });
});
