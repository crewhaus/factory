/**
 * Loop contract 0.4 (Batch C) — runtime-core's three items:
 *
 *  - G11 pending-approval seam: a headless `ask` with `ask_mode: "pause"` and
 *    an `approvals` store PARKS the run (persist + `approval_requested` +
 *    `approval_pending` / exit 36); a later run re-resolves a granted call
 *    (one-shot) or denies a denied one; `ask_mode: "deny"` / no store keeps the
 *    pre-0.4 collapse-to-deny; and the interactive REPL path is untouched.
 *  - Item 4 identity: an `agentId` on the run's bus is stamped onto every
 *    trace envelope end-to-end through a real run.
 *  - Item 7 per-tool cost attribution: a priceable NON-streaming response's
 *    cost is split across its tool_use blocks onto each `tool_use` log record;
 *    absent when unpriceable or under streaming (split not computable).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { DEFAULT_PRICING, computeCostMicros, resolvePricing } from "@crewhaus/cost-tracker";
import { RunFailedError } from "@crewhaus/errors";
import { createRunContext } from "@crewhaus/run-context";
import {
  type PendingApproval,
  type PendingApprovalStore,
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { loadOrCreateAgentIdentity, runChatLoop } from "./index";

const ADAPTER_FEATURES = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
} as const;

type ScriptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

const text = (t: string): ScriptBlock => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown): ScriptBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** Scripted adapter: one content-block array per call, fixed usage. */
function scriptedAdapter(
  scripts: ReadonlyArray<ReadonlyArray<ScriptBlock>>,
  usage: { input: number; output: number } = { input: 10, output: 5 },
): { adapter: ProviderAdapter; calls: () => number } {
  let i = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: ADAPTER_FEATURES,
    estimateTokens: () => 0,
    stream: (_req: ProviderRequest) => {
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
          } else {
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
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage,
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return { adapter, calls: () => i };
}

/** A non-read-only tool → "ask" in default permission mode. */
function dangerTool(onCall?: (input: unknown) => void) {
  return buildTool({
    name: "danger",
    description: "a tool that must be approved",
    inputSchema: z.object({ x: z.number() }).strict(),
    readOnly: false,
    destructive: false,
    concurrencySafe: false,
    execute: async (i) => {
      onCall?.(i);
      return `did ${i.x}`;
    },
  });
}

/** A read-only tool → auto-allowed; used for the cost-attribution runs. */
function echoTool() {
  return buildTool({
    name: "echo",
    description: "echo",
    inputSchema: z.object({ msg: z.string() }).strict(),
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    execute: async (i) => i.msg,
  });
}

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readSessionLines(rootDir: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(rootDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(rootDir, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

let root: string;
let store: PendingApprovalStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-approvals-run-"));
  store = createPendingApprovalStore({ rootDir: join(root, "approvals") });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Single-turn run capturing the trace bus + session log + any throw. */
async function runSingleTurn(
  opts: Omit<Parameters<typeof runChatLoop>[0], "model" | "instructions"> & { model?: string },
): Promise<{ events: TraceEvent[]; logged: LoggedLine[]; caught: unknown; result?: string }> {
  const sessionDir = mkdtempSync(join(root, "sess-"));
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((ev) => events.push(ev));
  let caught: unknown;
  let result: string | undefined;
  try {
    result = await runChatLoop({
      model: opts.model ?? "test-model",
      instructions: "approvals test",
      runContext,
      sessionRootDir: sessionDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "default",
      ...opts,
    });
  } catch (err) {
    caught = err;
  }
  return {
    events,
    logged: readSessionLines(sessionDir),
    caught,
    ...(result !== undefined ? { result } : {}),
  };
}

// ---------------------------------------------------------------------------
// G11 — headless parking / resume.
// ---------------------------------------------------------------------------

describe("G11 — pending-approval parking (headless ask, ask_mode: pause)", () => {
  test("parks the run: persists a PendingApproval, emits approval_requested, halts approval_pending", async () => {
    const executed: unknown[] = [];
    const { adapter } = scriptedAdapter([[use("tu_1", "danger", { x: 1 })], [text("done")]]);
    const { events, logged, caught } = await runSingleTurn({
      _adapter: adapter,
      tools: [dangerTool((i) => executed.push(i))],
      approvals: { store },
    });

    // Classified terminal park.
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("approval_pending");
    expect(caught.report.exitCode).toBe(36);

    // approval_requested carries the persisted id + surface.
    const requested = events.filter((e) => e.kind === "approval_requested");
    expect(requested.length).toBe(1);
    if (requested[0]?.kind !== "approval_requested") throw new Error("unreachable");
    expect(requested[0].toolName).toBe("danger");
    expect(requested[0].surface).toBe("single-turn");
    const approvalId = requested[0].approvalId;
    expect(approvalId).toMatch(/^appr_[0-9a-f]{16}$/);

    // The PendingApproval is persisted (pending, keyed by input hash).
    const pending = await store.get("danger", hashApprovalInput("danger", { x: 1 }));
    expect(pending?.id).toBe(approvalId);
    expect(pending?.decision).toBeUndefined();

    // The tool never ran, and a run_failed is on both the bus and the log.
    expect(executed).toEqual([]);
    expect(events.filter((e) => e.kind === "run_failed").length).toBe(1);
    expect(
      logged.filter((l) => l.kind === "run_failed" && l.payload?.["class"] === "approval_pending")
        .length,
    ).toBe(1);
  });

  test("resume after a grant executes the tool once (one-shot) and consumes the grant", async () => {
    // Phase 1 — park.
    const first = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 7 })], [text("done")]]).adapter,
      tools: [dangerTool()],
      approvals: { store },
    });
    const requested = first.events.find((e) => e.kind === "approval_requested");
    if (requested?.kind !== "approval_requested") throw new Error("expected a park");

    // Out-of-band grant (the CLI/Slack verb path).
    await store.resolve(requested.approvalId, "grant", "tester");

    // Phase 2 — a fresh run re-issues the same call and finds the grant.
    const executed: unknown[] = [];
    const second = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 7 })], [text("done")]]).adapter,
      tools: [dangerTool((i) => executed.push(i))],
      approvals: { store },
    });
    expect(second.caught).toBeUndefined();
    expect(second.result).toBe("done");
    expect(executed).toEqual([{ x: 7 }]);
    // Resolution eventing: an approved askOutcome, and NO re-park.
    expect(
      second.events.some((e) => e.kind === "permission_decision" && e.askOutcome === "approved"),
    ).toBe(true);
    expect(second.events.some((e) => e.kind === "approval_requested")).toBe(false);

    // One-shot: the grant is consumed, so the key no longer resolves.
    expect(await store.get("danger", hashApprovalInput("danger", { x: 7 }))).toBeNull();
  });

  test("a spent grant re-parks an identical later call (one-shot)", async () => {
    const park = async () =>
      runSingleTurn({
        _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 3 })], [text("done")]]).adapter,
        tools: [dangerTool()],
        approvals: { store },
      });
    const first = await park();
    const req = first.events.find((e) => e.kind === "approval_requested");
    if (req?.kind !== "approval_requested") throw new Error("expected a park");
    await store.resolve(req.approvalId, "grant", "tester");
    // Consume the grant.
    await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 3 })], [text("done")]]).adapter,
      tools: [dangerTool()],
      approvals: { store },
    });
    // A THIRD identical call must re-park (grant spent).
    const third = await park();
    expect(third.caught).toBeInstanceOf(RunFailedError);
    expect(third.events.some((e) => e.kind === "approval_requested")).toBe(true);
  });

  test("resume after a deny denies the tool with a note (no park, run continues)", async () => {
    const first = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 9 })], [text("done")]]).adapter,
      tools: [dangerTool()],
      approvals: { store },
    });
    const req = first.events.find((e) => e.kind === "approval_requested");
    if (req?.kind !== "approval_requested") throw new Error("expected a park");
    await store.resolve(req.approvalId, "deny", "cli");

    const executed: unknown[] = [];
    const second = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 9 })], [text("done")]]).adapter,
      tools: [dangerTool((i) => executed.push(i))],
      approvals: { store },
    });
    expect(second.caught).toBeUndefined();
    expect(second.result).toBe("done");
    // Denied: the tool never ran and the model saw an is_error tool_result.
    expect(executed).toEqual([]);
    expect(
      second.events.some((e) => e.kind === "permission_decision" && e.askOutcome === "denied"),
    ).toBe(true);
    expect(second.events.some((e) => e.kind === "approval_requested")).toBe(false);
    const toolResults = second.logged.filter((l) => l.kind === "tool_result");
    expect(toolResults.some((l) => l.payload?.["isError"] === true)).toBe(true);
  });

  test("notify fires once at park with the pending record", async () => {
    const notified: string[] = [];
    const res = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 1 })], [text("done")]]).adapter,
      tools: [dangerTool()],
      approvals: {
        store,
        notify: async (p) => {
          notified.push(p.id);
        },
      },
    });
    const req = res.events.find((e) => e.kind === "approval_requested");
    if (req?.kind !== "approval_requested") throw new Error("expected a park");
    expect(notified).toEqual([req.approvalId]);
  });

  test("ask_mode: deny collapses to a deny even with an approvals store (no park)", async () => {
    const executed: unknown[] = [];
    const res = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 1 })], [text("done")]]).adapter,
      tools: [dangerTool((i) => executed.push(i))],
      approvals: { store },
      askMode: "deny",
    });
    expect(res.caught).toBeUndefined();
    expect(res.result).toBe("done");
    expect(executed).toEqual([]);
    expect(res.events.some((e) => e.kind === "approval_requested")).toBe(false);
    expect(await store.get("danger", hashApprovalInput("danger", { x: 1 }))).toBeNull();
  });

  test("no approvals store: a headless ask collapses to the pre-0.4 deny", async () => {
    const executed: unknown[] = [];
    const res = await runSingleTurn({
      _adapter: scriptedAdapter([[use("tu_1", "danger", { x: 1 })], [text("done")]]).adapter,
      tools: [dangerTool((i) => executed.push(i))],
    });
    expect(res.caught).toBeUndefined();
    expect(res.result).toBe("done");
    expect(executed).toEqual([]);
    expect(res.events.some((e) => e.kind === "approval_requested")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G11 — REPL path unchanged.
// ---------------------------------------------------------------------------

describe("G11 — REPL path is unchanged by the approvals seam", () => {
  test("an interactive ask still prompts on stdin (never parks) even with an approvals store", async () => {
    const executed: unknown[] = [];
    const { adapter } = scriptedAdapter([[use("tu_1", "danger", { x: 1 })], [text("done")]]);
    const sessionDir = mkdtempSync(join(root, "repl-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => events.push(ev));
    const input = new PassThrough();
    input.write("go\n"); // the user turn
    input.write("n\n"); // the approval prompt → deny
    input.end();

    const result = await runChatLoop({
      model: "test-model",
      instructions: "repl approvals test",
      _adapter: adapter,
      runContext,
      sessionRootDir: sessionDir,
      input,
      tools: [dangerTool((i) => executed.push(i))],
      permissionMode: "default",
      approvals: { store },
    });

    expect(result).toBe(""); // REPL returns "" at EOF
    // The REPL prompted (askApproval) and the user denied — NOT a park.
    expect(executed).toEqual([]);
    expect(events.some((e) => e.kind === "approval_requested")).toBe(false);
    expect(events.some((e) => e.kind === "run_failed")).toBe(false);
    expect(events.some((e) => e.kind === "permission_decision" && e.askOutcome === "denied")).toBe(
      true,
    );
    // Nothing was persisted to the approvals store.
    expect(await store.get("danger", hashApprovalInput("danger", { x: 1 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 4 — agent identity stamping.
// ---------------------------------------------------------------------------

describe("Item 4 — agentId is stamped onto every trace envelope", () => {
  test("a run whose bus carries the generated agentId stamps it on all events", async () => {
    const idDir = mkdtempSync(join(root, "identity-"));
    const { agentId } = loadOrCreateAgentIdentity(idDir);
    const runId = "run_stamp01";
    const sessionId = "sess_00000000000000ab";
    const bus = new TraceEventBus({ runId, sessionId, agentId });
    const events: TraceEvent[] = [];
    bus.subscribe((ev) => events.push(ev));
    const runContext = createRunContext({ runId, sessionId, eventBus: bus });
    const sessionDir = mkdtempSync(join(root, "stamp-"));
    const { adapter } = scriptedAdapter([[use("tu_1", "echo", { msg: "hi" })], [text("done")]]);

    await runChatLoop({
      model: "test-model",
      instructions: "identity test",
      runContext,
      sessionRootDir: sessionDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "bypass",
      _adapter: adapter,
      tools: [echoTool()],
    });

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.agentId).toBe(agentId);
    }
    // A representative spread of kinds all carry it.
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("tool_call_start")).toBe(true);
    expect(kinds.has("model_response")).toBe(true);
  });

  test("without an agentId, envelopes omit the field (pre-0.4 behaviour)", async () => {
    const { events } = await runSingleTurn({
      _adapter: scriptedAdapter([[text("hi")]]).adapter,
      permissionMode: "bypass",
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.agentId === undefined)).toBe(true);
  });

  test("the opts.agentId option path (no runContext) builds a bus with the identity and runs clean", async () => {
    const sessionDir = mkdtempSync(join(root, "opt-"));
    const result = await runChatLoop({
      model: "test-model",
      instructions: "identity option test",
      agentId: "deadbeefcafef00d",
      sessionRootDir: sessionDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "bypass",
      _adapter: scriptedAdapter([[text("done")]]).adapter,
    });
    expect(result).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Item 7 — per-tool cost attribution.
// ---------------------------------------------------------------------------

function expectedMicros(model: string, u: { input: number; output: number }): number {
  const row = resolvePricing(DEFAULT_PRICING, "anthropic", model);
  if (row === undefined) throw new Error(`no pricing for ${model}`);
  return computeCostMicros(row, u.input, u.output, 0, 0);
}

describe("Item 7 — per-tool cost attribution on tool_use records", () => {
  test("a priceable non-streaming response splits its cost across the tool_use it emitted", async () => {
    const usage = { input: 1000, output: 500 };
    const { logged } = await runSingleTurn({
      model: "claude-opus-4-8",
      _adapter: scriptedAdapter([[use("tu_1", "echo", { msg: "a" })], [text("done")]], usage)
        .adapter,
      tools: [echoTool()],
      permissionMode: "bypass",
    });
    const toolUse = logged.find((l) => l.kind === "tool_use");
    expect(toolUse?.payload?.["attributedCostUsdMicros"]).toBe(
      expectedMicros("claude-opus-4-8", usage),
    );
    expect(toolUse?.payload?.["attributedCostUsdMicros"] as number).toBeGreaterThan(0);
  });

  test("splits evenly across multiple tool_use blocks in one response", async () => {
    const usage = { input: 1000, output: 500 };
    const { logged } = await runSingleTurn({
      model: "claude-opus-4-8",
      _adapter: scriptedAdapter(
        [[use("tu_1", "echo", { msg: "a" }), use("tu_2", "echo", { msg: "b" })], [text("done")]],
        usage,
      ).adapter,
      tools: [echoTool()],
      permissionMode: "bypass",
    });
    const uses = logged.filter((l) => l.kind === "tool_use");
    expect(uses.length).toBe(2);
    const per = Math.round(expectedMicros("claude-opus-4-8", usage) / 2);
    for (const u of uses) expect(u.payload?.["attributedCostUsdMicros"]).toBe(per);
  });

  test("no attribution when the model is not on the pricing table", async () => {
    const { logged } = await runSingleTurn({
      model: "totally-unpriced-model",
      _adapter: scriptedAdapter([[use("tu_1", "echo", { msg: "a" })], [text("done")]]).adapter,
      tools: [echoTool()],
      permissionMode: "bypass",
    });
    const toolUse = logged.find((l) => l.kind === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.payload?.["attributedCostUsdMicros"]).toBeUndefined();
  });

  test("no attribution under streaming (the split is not computable at dispatch)", async () => {
    const { logged } = await runSingleTurn({
      model: "claude-opus-4-8",
      _adapter: scriptedAdapter([[use("tu_1", "echo", { msg: "a" })], [text("done")]]).adapter,
      tools: [echoTool()],
      permissionMode: "bypass",
      streaming: true,
    });
    const toolUse = logged.find((l) => l.kind === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.payload?.["attributedCostUsdMicros"]).toBeUndefined();
  });
});

/**
 * G11 retention — a run's boot housekeeping sweeps the approvals log beside
 * its sessions, exactly as it already sweeps expired sessions.
 *
 * Nothing else prunes this file unattended: only `list()` compacts it, and
 * `list()`'s only production callers are the human-invoked `crewhaus
 * approvals` verbs. Every record embeds the raw tool input of a call some
 * policy deemed sensitive enough to require a human, so an unswept log is
 * both unbounded and a stale-secret store that `crewhaus retention purge`
 * cannot reach.
 */
describe("G11 — boot-time approvals retention", () => {
  test("a run sweeps expired approvals from its own session root", async () => {
    const sessionDir = mkdtempSync(join(root, "sweep-"));
    const bootStore = createPendingApprovalStore({ rootDir: sessionDir });
    const stale: PendingApproval = {
      id: generateApprovalId(),
      toolName: "bash",
      inputHash: hashApprovalInput("bash", { cmd: "curl -H 'Authorization: Bearer sk-live'" }),
      input: { cmd: "curl -H 'Authorization: Bearer sk-live'" },
      runId: "run_00000000",
      sessionId: "sess_00000000000000ff",
      surface: "single-turn",
      createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    };
    await bootStore.persist(stale);
    expect(await bootStore.get(stale.toolName, stale.inputHash)).toBeNull(); // TTL hides it…
    expect(readFileSync(join(sessionDir, "approvals.jsonl"), "utf-8")).toContain(stale.id); // …but disk still has it

    // Any run rooted here sweeps it at boot.
    await runChatLoop({
      model: "test-model",
      instructions: "x",
      runContext: createRunContext(),
      sessionRootDir: sessionDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      _adapter: scriptedAdapter([[text("done")]]).adapter,
    });

    expect(readFileSync(join(sessionDir, "approvals.jsonl"), "utf-8")).not.toContain(stale.id);
  });

  test("a run against a root with no approvals log does not fail", async () => {
    const sessionDir = mkdtempSync(join(root, "nolog-"));
    const out = await runChatLoop({
      model: "test-model",
      instructions: "x",
      runContext: createRunContext(),
      sessionRootDir: sessionDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      _adapter: scriptedAdapter([[text("fine")]]).adapter,
    });
    expect(out).toBe("fine");
  });
});
