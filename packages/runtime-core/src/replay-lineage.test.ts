/**
 * The egress check reads a run's lineage, and a run resumed from its log should
 * read the same lineage it had. Each tool result is tagged at `tool`, including
 * one from a tool that sets `classifyOutput: false`, so a verbatim copy of it
 * meets the egress check as a tool result does within one run.
 *
 * Self-contained: a scripted adapter (no network), an in-memory audit sink, and
 * a session root pinned to an mkdtemp directory.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { _clearEgressCache } from "@crewhaus/egress-classifier";
import { openEventLog } from "@crewhaus/event-log";
import { type RuleSet, emptyRuleSet } from "@crewhaus/permission-engine";
import { DATA_LINEAGE_CAP, createRunContext, tagContent } from "@crewhaus/run-context";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { type EgressAuditSink, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-replay-lineage-"));
afterAll(() => {
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  _clearEgressCache();
});

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };
type StreamRequest = Parameters<ProviderAdapter["stream"]>[0];

function scripted(scripts: ReadonlyArray<ReadonlyArray<Block>>): {
  adapter: ProviderAdapter;
  requests: StreamRequest[];
} {
  const requests: StreamRequest[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) } as StreamRequest);
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i++;
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (const [index, block] of content.entries()) {
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            } as const;
          } else {
            yield {
              kind: "content_block_start",
              index,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            } as const;
          }
          yield { kind: "content_block_stop", index } as const;
        }
        yield {
          kind: "message_delta",
          stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return { adapter, requests };
}

const DONE: Block = { type: "text", text: "done" };
const NOTE_LINE = "quarterly figures for the northern region are in tab three";
const NOTES = `${NOTE_LINE}\nnothing else of interest in this file today`;

const readCall = (id: string): Block => ({ type: "tool_use", id, name: "ReadNotes", input: {} });
const sendCall = (id: string, body: string): Block => ({
  type: "tool_use",
  id,
  name: "SendOut",
  input: { body },
});

function harness(): {
  readNotes: ReturnType<typeof buildTool>;
  sendOut: ReturnType<typeof buildTool>;
  sends: string[];
  verdicts: unknown[];
  records: Array<Record<string, unknown>>;
  sink: EgressAuditSink;
} {
  const sends: string[] = [];
  const verdicts: unknown[] = [];
  const records: Array<Record<string, unknown>> = [];
  const readNotes = buildTool({
    name: "ReadNotes",
    description: "reads notes",
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => NOTES,
  });
  const sendOut = buildTool({
    name: "SendOut",
    description: "sends text out",
    inputSchema: z.object({ body: z.string() }),
    scope: "external",
    execute: async (input: { body: string }) => {
      sends.push(input.body);
      return "sent";
    },
  });
  const sink: EgressAuditSink = {
    async append(input) {
      const payload = input.payload as Record<string, unknown>;
      verdicts.push(payload["verdict"]);
      records.push(payload);
      return undefined;
    },
  };
  return { readNotes, sendOut, sends, verdicts, records, sink };
}

/** Run one: read the notes. Returns the session the next run resumes. */
async function readInRunOne(h: ReturnType<typeof harness>): Promise<string> {
  const ctx = createRunContext();
  await runChatLoop({
    model: "test-model",
    instructions: "t",
    _adapter: scripted([[readCall("tu_read")], [DONE]]).adapter,
    runContext: ctx,
    tools: [h.readNotes, h.sendOut],
    sessionRootDir: SESSION_ROOT,
    singleTurn: true,
    seedMessages: [{ role: "user", content: "read the notes" }],
    permissionMode: "bypass",
  });
  return ctx.sessionId;
}

/** A session on disk holding only an opening exchange, for lines a test writes itself. */
async function emptySession(): Promise<string> {
  const ctx = createRunContext();
  await runChatLoop({
    model: "test-model",
    instructions: "t",
    _adapter: scripted([[DONE]]).adapter,
    runContext: ctx,
    sessionRootDir: SESSION_ROOT,
    singleTurn: true,
    seedMessages: [{ role: "user", content: "hello" }],
    permissionMode: "bypass",
  });
  return ctx.sessionId;
}

async function appendResults(
  sessionId: string,
  results: ReadonlyArray<Anthropic.ToolResultBlockParam>,
): Promise<void> {
  const log = await openEventLog(sessionId, { rootDir: SESSION_ROOT });
  for (const result of results) {
    await log.append({
      kind: "assistant_message",
      payload: {
        content: [{ type: "tool_use", id: result.tool_use_id, name: "ReadNotes", input: {} }],
      },
    });
    await log.append({ kind: "user_message", payload: { content: [result] } });
  }
  await log.append({ kind: "assistant_message", payload: { content: [DONE] } });
  await log.close();
}

async function resume(sessionId: string, ctx = createRunContext({ sessionId })) {
  await runChatLoop({
    model: "test-model",
    instructions: "t",
    _adapter: scripted([[DONE]]).adapter,
    runContext: ctx,
    sessionRootDir: SESSION_ROOT,
    singleTurn: true,
    resume: { sessionId },
    seedMessages: [{ role: "user", content: "and now?" }],
    permissionMode: "bypass",
  });
  return ctx;
}

describe("a resumed run keeps the lineage of what it replays", () => {
  test("read in one run, send in the resumed run: refused at a model-chosen destination, with the reason", async () => {
    const h = harness();
    const sessionId = await readInRunOne(h);

    const ctx = createRunContext({ sessionId });
    const { adapter, requests } = scripted([[sendCall("tu_send", NOTE_LINE)], [DONE]]);
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext: ctx,
      tools: [h.readNotes, h.sendOut],
      sessionRootDir: SESSION_ROOT,
      singleTurn: true,
      resume: { sessionId },
      seedMessages: [{ role: "user", content: "send the line" }],
      permissionMode: "bypass",
      resolveSinkScope: () => "external-dynamic",
      egressAuditSink: h.sink,
    });

    expect(h.sends).toEqual([]);
    expect(h.verdicts).toEqual(["block"]);
    expect(ctx.dataLineage?.get(NOTE_LINE)).toBe("tool");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("[egress denied]");
  });

  test("the same send at a configured sink goes out and records a warning", async () => {
    const h = harness();
    const sessionId = await readInRunOne(h);

    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: scripted([[sendCall("tu_send", NOTE_LINE)], [DONE]]).adapter,
      runContext: createRunContext({ sessionId }),
      tools: [h.readNotes, h.sendOut],
      sessionRootDir: SESSION_ROOT,
      singleTurn: true,
      resume: { sessionId },
      seedMessages: [{ role: "user", content: "send the line" }],
      permissionMode: "bypass",
      resolveSinkScope: () => "external-configured",
      egressAuditSink: h.sink,
    });

    expect(h.sends).toEqual([NOTE_LINE]);
    expect(h.verdicts).toEqual(["warn"]);
  });

  test("control: with nothing replayed, the same send goes out and nothing is recorded", async () => {
    const h = harness();
    const ctx = createRunContext();

    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: scripted([[sendCall("tu_send", NOTE_LINE)], [DONE]]).adapter,
      runContext: ctx,
      tools: [h.readNotes, h.sendOut],
      sessionRootDir: SESSION_ROOT,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "send the line" }],
      permissionMode: "bypass",
      resolveSinkScope: () => "external-dynamic",
      egressAuditSink: h.sink,
    });

    expect(h.sends).toEqual([NOTE_LINE]);
    expect(h.verdicts).toEqual([]);
    expect(ctx.dataLineage?.size ?? 0).toBe(0);
  });

  test("parity: a resume refuses what one run refuses", async () => {
    const h = harness();
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: scripted([[readCall("tu_read")], [sendCall("tu_send", NOTE_LINE)], [DONE]]).adapter,
      runContext: createRunContext(),
      tools: [h.readNotes, h.sendOut],
      sessionRootDir: SESSION_ROOT,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "read and send" }],
      permissionMode: "bypass",
      resolveSinkScope: () => "external-dynamic",
      egressAuditSink: h.sink,
    });
    expect(h.sends).toEqual([]);
    expect(h.verdicts).toEqual(["block"]);
  });

  test("a resume with no tool results tags nothing", async () => {
    const ctx = await resume(await emptySession());
    expect(ctx.dataLineage?.size ?? 0).toBe(0);
  });

  test("a result in text parts and an error result are tagged, and the user's own text is not", async () => {
    const sessionId = await emptySession();
    const partOne = "first part of a result held in text parts";
    const partTwo = "second part of a result held in text parts";
    const failure = "the read failed and said so in this error text";
    await appendResults(sessionId, [
      {
        type: "tool_result",
        tool_use_id: "tu_parts",
        content: [
          { type: "text", text: partOne },
          { type: "text", text: partTwo },
        ],
      },
      { type: "tool_result", tool_use_id: "tu_error", content: failure, is_error: true },
    ]);

    const ctx = await resume(sessionId);

    expect(ctx.dataLineage?.get(partOne)).toBe("tool");
    expect(ctx.dataLineage?.get(partTwo)).toBe("tool");
    expect(ctx.dataLineage?.get(failure)).toBe("tool");
    expect(ctx.dataLineage?.has("hello")).toBe(false);
    expect(ctx.dataLineage?.has("and now?")).toBe(false);
  });

  test("past the lineage cap the newest results survive", async () => {
    const sessionId = await emptySession();
    const resultText = (i: number): string => `replayed result number ${i} of this session`;
    const total = DATA_LINEAGE_CAP + 44;
    await appendResults(
      sessionId,
      Array.from({ length: total }, (_, i) => ({
        type: "tool_result" as const,
        tool_use_id: `tu_${i}`,
        content: resultText(i),
      })),
    );

    const ctx = await resume(sessionId);

    expect(ctx.dataLineage?.size).toBe(DATA_LINEAGE_CAP);
    expect(ctx.dataLineage?.get(resultText(total - 1))).toBe("tool");
    expect(ctx.dataLineage?.get(resultText(total - DATA_LINEAGE_CAP))).toBe("tool");
    expect(ctx.dataLineage?.has(resultText(total - DATA_LINEAGE_CAP - 1))).toBe(false);
    expect(ctx.dataLineage?.has(resultText(0))).toBe(false);
  }, 20_000); // writes and replays several hundred log lines

  test("what the caller tagged before the run stays newest past the cap, at its own origin", async () => {
    const sessionId = await emptySession();
    const resultText = (i: number): string => `replayed result number ${i} of that session`;
    const total = DATA_LINEAGE_CAP + 10;
    await appendResults(
      sessionId,
      Array.from({ length: total }, (_, i) => ({
        type: "tool_result" as const,
        tool_use_id: `tu_${i}`,
        content: resultText(i),
      })),
    );
    const inbound = "the message that started this run, tagged by its caller";
    const ctx = createRunContext({ sessionId });
    tagContent(ctx, inbound, "channel");

    await resume(sessionId, ctx);

    expect(ctx.dataLineage?.size).toBe(DATA_LINEAGE_CAP);
    expect(ctx.dataLineage?.get(inbound)).toBe("channel");
    expect([...(ctx.dataLineage?.keys() ?? [])].at(-1)).toBe(inbound);
    expect(ctx.dataLineage?.get(resultText(total - 1))).toBe("tool");
  }, 20_000); // writes and replays several hundred log lines
});

describe("a call a person approved on a parked approval goes out as approved", () => {
  const LATER_NOTE = "a sentence this session never read from any tool at all";

  /** A run that may park: `SendOut` asks, and the store answers. */
  async function approvedRun(
    h: ReturnType<typeof harness>,
    store: ReturnType<typeof createPendingApprovalStore>,
    sessionId: string,
    script: ReadonlyArray<ReadonlyArray<Block>>,
    tools: ReadonlyArray<ReturnType<typeof buildTool>> = [h.readNotes, h.sendOut],
    permissionRules?: RuleSet,
    sinkScope: "external-dynamic" | "external-configured" = "external-dynamic",
  ): Promise<{ requests: StreamRequest[]; caught: unknown }> {
    const { adapter, requests } = scripted(script);
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        runContext: createRunContext({ sessionId }),
        tools: [...tools],
        sessionRootDir: SESSION_ROOT,
        singleTurn: true,
        resume: { sessionId },
        seedMessages: [{ role: "user", content: "send it" }],
        permissionMode: "default",
        settingsDir: null,
        askMode: "pause",
        approvals: { store },
        resolveSinkScope: () => sinkScope,
        egressAuditSink: h.sink,
        ...(permissionRules !== undefined ? { permissionRules } : {}),
      });
    } catch (err) {
      caught = err;
    }
    return { requests, caught };
  }

  function approvalStore(): ReturnType<typeof createPendingApprovalStore> {
    return createPendingApprovalStore({
      rootDir: mkdtempSync(join(SESSION_ROOT, "approvals-")),
    });
  }

  test("read, park, grant, resume: one send, the grant spent, and a warned record naming the approval", async () => {
    const h = harness();
    const store = approvalStore();
    const posts: string[] = [];
    // A second sink the rules allow outright: no person approved what it sends.
    const postOut = buildTool({
      name: "PostOut",
      description: "posts text out",
      inputSchema: z.object({ body: z.string() }),
      scope: "external",
      execute: async (input: { body: string }) => {
        posts.push(input.body);
        return "posted";
      },
    });
    const allowPost: RuleSet = {
      ...emptyRuleSet,
      yaml: [{ type: "alwaysAllow", pattern: "PostOut", source: "yaml" }],
    };
    const tools = [h.readNotes, h.sendOut, postOut];
    const sessionId = await readInRunOne(h);

    const parked = await approvedRun(
      h,
      store,
      sessionId,
      [[sendCall("tu_send", NOTE_LINE)]],
      tools,
      allowPost,
    );
    expect(parked.caught).toBeDefined();
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max");

    // The approved send, then the same text through the sink no one approved.
    const resumed = await approvedRun(
      h,
      store,
      sessionId,
      [
        [sendCall("tu_send_2", NOTE_LINE)],
        [{ type: "tool_use", id: "tu_post", name: "PostOut", input: { body: NOTE_LINE } }],
        [DONE],
      ],
      tools,
      allowPost,
    );

    expect(resumed.caught).toBeUndefined();
    expect(h.sends).toEqual([NOTE_LINE]);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeDefined();
    // The match stays on record, as a warning that names the approval.
    expect(h.verdicts[0]).toBe("warn");
    expect(h.records[0]?.["originsFound"]).toEqual(["tool"]);
    expect(h.records[0]?.["approvalId"]).toBe(pending.id);
    expect(String(h.records[0]?.["reason"])).toContain(pending.id);
    // The later call in the same run keeps the policy's verdict.
    expect(posts).toEqual([]);
    expect(h.verdicts).toEqual(["warn", "block"]);
    expect(h.records[1]?.["approvalId"]).toBeUndefined();
    expect(JSON.stringify(resumed.requests.at(-1)?.messages)).toContain("[egress denied]");
  });

  test("an always-allow grant and the settings rule it saved: the approved call goes out once, and the rule alone meets the check", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await readInRunOne(h);

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", NOTE_LINE)]]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max", { always: true });
    // What `crewhaus approvals grant --always` saves beside the grant.
    const standing: RuleSet = {
      ...emptyRuleSet,
      settings: [{ type: "alwaysAllow", pattern: "SendOut", source: "settings" }],
    };

    // The approved call, then the same call again under the rule alone.
    const resumed = await approvedRun(
      h,
      store,
      sessionId,
      [[sendCall("tu_send_2", NOTE_LINE)], [sendCall("tu_send_3", NOTE_LINE)], [DONE]],
      undefined,
      standing,
    );

    expect(resumed.caught).toBeUndefined();
    expect(h.sends).toEqual([NOTE_LINE]);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeDefined();
    expect(h.verdicts).toEqual(["warn", "block"]);
    expect(h.records[0]?.["approvalId"]).toBe(pending.id);
    expect(String(h.records[0]?.["reason"])).toContain(pending.id);
    expect(h.records[1]?.["approvalId"]).toBeUndefined();
    expect(JSON.stringify(resumed.requests.at(-1)?.messages)).toContain("[egress denied]");
  });

  test("a reworded retry in a later run runs the approved input, as approved, once", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await readInRunOne(h);

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", NOTE_LINE)]]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max");

    // The model words the send differently: what runs is what was approved.
    const retry = await approvedRun(h, store, sessionId, [
      [sendCall("tu_reworded", LATER_NOTE)],
      [DONE],
    ]);

    expect(retry.caught).toBeUndefined();
    expect(h.sends).toEqual([NOTE_LINE]);
    expect(h.verdicts).toEqual(["warn"]);
    expect(h.records[0]?.["approvalId"]).toBe(pending.id);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeDefined();
  });

  test("control: an approved send of text the run never read goes out, once, and spends the grant", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await readInRunOne(h);

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", LATER_NOTE)]]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max");

    await approvedRun(h, store, sessionId, [[sendCall("tu_send_2", LATER_NOTE)], [DONE]]);

    expect(h.sends).toEqual([LATER_NOTE]);
    expect(h.verdicts).toEqual([]);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeDefined();
  });

  test("one grant runs one of two identical calls made in parallel", async () => {
    const h = harness();
    const store = approvalStore();
    const sends: string[] = [];
    // Read-only and concurrency-safe is what runs in parallel, and a rule asks.
    const ask: RuleSet = {
      ...emptyRuleSet,
      yaml: [{ type: "alwaysAsk", pattern: "SendOut", source: "yaml" }],
    };
    const parallelSend = buildTool({
      name: "SendOut",
      description: "sends text out",
      inputSchema: z.object({ body: z.string() }),
      scope: "external",
      readOnly: true,
      concurrencySafe: true,
      execute: async (input: { body: string }) => {
        sends.push(input.body);
        return "sent";
      },
    });
    const sessionId = await emptySession();

    await approvedRun(
      h,
      store,
      sessionId,
      [[sendCall("tu_send", LATER_NOTE)]],
      [parallelSend],
      ask,
    );
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max");

    // The first call's spend takes a moment, so the second reaches the gate
    // while the grant is held and not yet spent.
    const slowSpend: typeof store = {
      ...store,
      persist: async (approval) => {
        await Bun.sleep(25);
        await store.persist(approval);
      },
    };
    await approvedRun(
      h,
      slowSpend,
      sessionId,
      [[sendCall("tu_a", LATER_NOTE), sendCall("tu_b", LATER_NOTE)], [DONE]],
      [parallelSend],
      ask,
    );

    expect(sends).toEqual([LATER_NOTE]);
  });

  /** What `crewhaus approvals grant --always` saves beside the grant. */
  const standingSendOut: RuleSet = {
    ...emptyRuleSet,
    settings: [{ type: "alwaysAllow", pattern: "SendOut", source: "settings" }],
  };

  test("an always-allow grant and the rule it saved: a reworded call carrying a line the run read is refused, and the grant stays unspent", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await readInRunOne(h);

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", NOTE_LINE)]]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max", { always: true });

    // The rule decides a call worded differently: it meets the check as any call does.
    const resumed = await approvedRun(
      h,
      store,
      sessionId,
      [[sendCall("tu_reworded", `Here it is: ${NOTE_LINE}`)], [DONE]],
      undefined,
      standingSendOut,
    );

    expect(resumed.caught).toBeUndefined();
    expect(h.sends).toEqual([]);
    expect(h.verdicts).toEqual(["block"]);
    expect(h.records[0]?.["approvalId"]).toBeUndefined();
    expect(JSON.stringify(resumed.requests.at(-1)?.messages)).toContain("[egress denied]");
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeUndefined();
  });

  test("an always-allow grant and the rule it saved: one of two identical calls made in parallel runs under the grant, and the other meets the check", async () => {
    const h = harness();
    const store = approvalStore();
    const parallelSend = buildTool({
      name: "SendOut",
      description: "sends text out",
      inputSchema: z.object({ body: z.string() }),
      scope: "external",
      readOnly: true,
      concurrencySafe: true,
      execute: async (input: { body: string }) => {
        h.sends.push(input.body);
        return "sent";
      },
    });
    const sessionId = await readInRunOne(h);

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", NOTE_LINE)]], [parallelSend]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max", { always: true });

    // The first call's spend takes a moment, so the second reaches the gate
    // while the grant is held and not yet spent.
    let spends = 0;
    const slowSpend: typeof store = {
      ...store,
      consume: async (id, request) => {
        if (id === pending.id) spends += 1;
        await Bun.sleep(25);
        return store.consume(id, request);
      },
    };
    await approvedRun(
      h,
      slowSpend,
      sessionId,
      [[sendCall("tu_a", NOTE_LINE), sendCall("tu_b", NOTE_LINE)], [DONE]],
      [parallelSend],
      standingSendOut,
    );

    expect(h.sends).toEqual([NOTE_LINE]);
    expect(h.verdicts).toEqual(["warn", "block"]);
    expect(spends).toBe(1);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeDefined();
  });

  test("an always-allow grant and the rule it saved: a call that now lands elsewhere meets the check, and the grant stays unspent", async () => {
    const h = harness();
    const store = approvalStore();
    const puts: string[] = [];
    const putOut = buildTool({
      name: "PutOut",
      description: "puts text out at a path",
      inputSchema: z.object({ path: z.string(), body: z.string() }),
      scope: "external",
      operativeArgs: [{ field: "path", kind: "path" }],
      execute: async (input: { path: string; body: string }) => {
        puts.push(input.body);
        return "put";
      },
    });
    const standing: RuleSet = {
      ...emptyRuleSet,
      settings: [{ type: "alwaysAllow", pattern: "PutOut", source: "settings" }],
    };
    const put = (id: string): Block => ({
      type: "tool_use",
      id,
      name: "PutOut",
      input: { path: "pub/link/x.md", body: NOTE_LINE },
    });
    // Outside the session root, which the runtime keeps as its own record.
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-replay-lineage-ws-")));
    mkdirSync(join(ws, "pub"));
    mkdirSync(join(ws, "public"));
    mkdirSync(join(ws, "elsewhere"));
    symlinkSync("../public", join(ws, "pub", "link"));
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      const sessionId = await readInRunOne(h);
      await approvedRun(h, store, sessionId, [[put("tu_put")]], [h.readNotes, putOut]);
      const [pending] = await store.list();
      if (pending === undefined) throw new Error("expected a park");
      await store.resolve(pending.id, "grant", "max", { always: true });

      // The directory link moves between the approval and the resume.
      rmSync(join(ws, "pub", "link"));
      symlinkSync("../elsewhere", join(ws, "pub", "link"));
      const resumed = await approvedRun(
        h,
        store,
        sessionId,
        [[put("tu_put_2")], [DONE]],
        [h.readNotes, putOut],
        standing,
      );

      expect(resumed.caught).toBeUndefined();
      expect(puts).toEqual([]);
      expect(h.verdicts).toEqual(["block"]);
      expect(h.records[0]?.["approvalId"]).toBeUndefined();
      expect(JSON.stringify(resumed.requests.at(-1)?.messages)).toContain("[egress denied]");
      expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeUndefined();
    } finally {
      process.chdir(cwd);
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a call a rule allows reads the approvals store only when the egress check would refuse it", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await readInRunOne(h);
    let reads = 0;
    const counted: typeof store = {
      ...store,
      get: async (toolName, inputHash) => {
        reads += 1;
        return store.get(toolName, inputHash);
      },
      list: async () => {
        reads += 1;
        return store.list();
      },
    };

    // Nothing the run read, to a model-chosen destination: the verdict is `pass`.
    await approvedRun(
      h,
      counted,
      sessionId,
      [[sendCall("tu_plain", LATER_NOTE)], [DONE]],
      undefined,
      standingSendOut,
    );
    expect(h.sends).toEqual([LATER_NOTE]);
    expect(h.verdicts).toEqual([]);
    expect(reads).toBe(0);

    // A line the run read, to a configured sink: the verdict is `warn`.
    await approvedRun(
      h,
      counted,
      sessionId,
      [[sendCall("tu_configured", NOTE_LINE)], [DONE]],
      undefined,
      standingSendOut,
      "external-configured",
    );
    expect(h.sends).toEqual([LATER_NOTE, NOTE_LINE]);
    expect(h.verdicts).toEqual(["warn"]);
    expect(reads).toBe(0);

    // The approved repeat of a parked call: the store is read, the call goes
    // out with a warning that names the approval, and the grant is spent.
    await approvedRun(h, store, sessionId, [[sendCall("tu_park", NOTE_LINE)]]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max", { always: true });
    const resumed = await approvedRun(
      h,
      counted,
      sessionId,
      [[sendCall("tu_repeat", NOTE_LINE)], [DONE]],
      undefined,
      standingSendOut,
    );

    expect(resumed.caught).toBeUndefined();
    expect(reads).toBeGreaterThan(0);
    expect(h.sends).toEqual([LATER_NOTE, NOTE_LINE, NOTE_LINE]);
    expect(h.verdicts).toEqual(["warn", "warn"]);
    expect(h.records[1]?.["approvalId"]).toBe(pending.id);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeDefined();
  });

  test("a call a rule allows meets the egress check when a lookup in the approvals store fails", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await readInRunOne(h);
    let lookups = 0;
    const unreadable: typeof store = {
      ...store,
      get: async () => {
        lookups += 1;
        throw new Error("EACCES: approvals unreadable");
      },
    };

    // A line the run read is refused, and a call carrying nothing it read goes out.
    const run = await approvedRun(
      h,
      unreadable,
      sessionId,
      [[sendCall("tu_send", NOTE_LINE)], [sendCall("tu_plain", LATER_NOTE)], [DONE]],
      undefined,
      standingSendOut,
    );

    expect(run.caught).toBeUndefined();
    expect(lookups).toBeGreaterThan(0);
    expect(h.verdicts).toEqual(["block"]);
    expect(JSON.stringify(run.requests.at(-1)?.messages)).toContain("[egress denied]");
    expect(h.sends).toEqual([LATER_NOTE]);
  });

  test("a call the justification check refuses leaves the grant unspent, and its retry asks nobody again", async () => {
    const h = harness();
    const store = approvalStore();
    let ran = 0;
    const justified = buildTool({
      name: "SendOut",
      description: "sends text out",
      inputSchema: z.object({ body: z.string() }),
      requireJustification: true,
      execute: async () => {
        ran += 1;
        return "sent";
      },
    });
    const sessionId = await emptySession();

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", LATER_NOTE)]], [justified]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max");

    // Refused, then tried once more in the same run: the same refusal, no new card.
    const resumed = await approvedRun(
      h,
      store,
      sessionId,
      [[sendCall("tu_send_2", LATER_NOTE)], [sendCall("tu_send_3", LATER_NOTE)], [DONE]],
      [justified],
    );

    expect(resumed.caught).toBeUndefined();
    expect(ran).toBe(0);
    const denials = JSON.stringify(resumed.requests.at(-1)?.messages).split(
      "[justification denied]",
    );
    expect(denials).toHaveLength(3);
    expect((await store.list()).map((a) => a.id)).toEqual([pending.id]);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeUndefined();
  });

  test("a call a tool's rate limit refuses leaves the grant unspent, and its retry asks nobody again", async () => {
    const h = harness();
    const store = approvalStore();
    const sessionId = await emptySession();

    await approvedRun(h, store, sessionId, [[sendCall("tu_send", LATER_NOTE)]]);
    const [pending] = await store.list();
    if (pending === undefined) throw new Error("expected a park");
    await store.resolve(pending.id, "grant", "max");

    // A bucket that holds no token, so the call waits for one. From the egress
    // check on, each reading of the clock is 31 seconds on, past the limiter's
    // 30-second wait, until the next model call: the wait ends at once.
    const realNow = Date.now;
    let offset = 0;
    let waiting = false;
    const clock = spyOn(Date, "now").mockImplementation(() => {
      if (waiting) offset += 31_000;
      return realNow() + offset;
    });
    const { adapter, requests } = scripted([
      [sendCall("tu_send_2", LATER_NOTE)],
      [sendCall("tu_send_3", LATER_NOTE)],
      [DONE],
    ]);
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: {
          ...adapter,
          stream: (req) => {
            waiting = false;
            return adapter.stream(req);
          },
        },
        runContext: createRunContext({ sessionId }),
        tools: [h.readNotes, h.sendOut],
        sessionRootDir: SESSION_ROOT,
        singleTurn: true,
        resume: { sessionId },
        seedMessages: [{ role: "user", content: "send it" }],
        permissionMode: "default",
        settingsDir: null,
        askMode: "pause",
        approvals: { store },
        resolveSinkScope: () => {
          waiting = true;
          return "external-dynamic";
        },
        egressAuditSink: h.sink,
        rateLimits: { SendOut: { rpm: 1, burst: 0 } },
      });
    } catch (err) {
      caught = err;
    } finally {
      clock.mockRestore();
    }

    expect(caught).toBeUndefined();
    expect(h.sends).toEqual([]);
    // Refused by the rate gate both times, after the egress check let it pass.
    expect(h.verdicts).toEqual([]);
    expect(JSON.stringify(requests.at(-1)?.messages).split("[rate-limited]")).toHaveLength(3);
    expect((await store.list()).map((a) => a.id)).toEqual([pending.id]);
    expect((await store.list()).find((a) => a.id === pending.id)?.consumedAt).toBeUndefined();
  });

  test("a call approved at the prompt inside one run keeps the egress verdict: tagged text to a model-chosen sink is refused", async () => {
    const h = harness();
    const store = approvalStore();
    const ctx = createRunContext();
    const input = new PassThrough();
    input.write("read the notes and send the first line\n"); // the user turn
    const asked: string[] = [];
    ctx.eventBus.subscribe((ev) => {
      if (ev.kind !== "permission_decision") return;
      if (ev.askOutcome !== undefined) asked.push(`${ev.toolName}:${ev.askOutcome}`);
      // The prompt is asked right after an `ask` decision is published: the
      // person answers yes once it is, and then stdin closes.
      else if (ev.decision === "ask") {
        setImmediate(() => {
          input.write("y\n");
          input.end();
        });
      }
    });
    const { adapter, requests } = scripted([
      [readCall("tu_read")],
      [sendCall("tu_send", NOTE_LINE)],
      [DONE],
    ]);

    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext: ctx,
      input,
      tools: [h.readNotes, h.sendOut],
      sessionRootDir: SESSION_ROOT,
      permissionMode: "default",
      settingsDir: null,
      permissionRules: {
        ...emptyRuleSet,
        yaml: [{ type: "alwaysAllow", pattern: "ReadNotes", source: "yaml" }],
      },
      approvals: { store },
      resolveSinkScope: () => "external-dynamic",
      egressAuditSink: h.sink,
    });

    // The person approved the call, and the egress check still refused it.
    expect(asked).toEqual(["SendOut:approved"]);
    expect(h.sends).toEqual([]);
    expect(h.verdicts).toEqual(["block"]);
    expect(h.records[0]?.["approvalId"]).toBeUndefined();
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("[egress denied]");
    // The prompt is the approval: nothing was parked or spent in the store.
    expect(await store.list()).toEqual([]);
  });
});

describe("a line the runtime did not write changes nothing about a replay", () => {
  const logFile = (sessionId: string): string => join(SESSION_ROOT, `${sessionId}.jsonl`);
  const addLine = (sessionId: string, line: unknown): void => {
    appendFileSync(logFile(sessionId), `${JSON.stringify(line)}\n`);
  };

  async function send(sessionId: string, content: string): Promise<StreamRequest[]> {
    const { adapter, requests } = scripted([[DONE]]);
    await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext: createRunContext({ sessionId }),
      sessionRootDir: SESSION_ROOT,
      singleTurn: true,
      resume: { sessionId },
      seedMessages: [{ role: "user", content }],
      permissionMode: "bypass",
      continuity: { loadPlan: async () => null },
    });
    return requests;
  }

  test("a bracket with no version or payload hides nothing from the next run", async () => {
    const sessionId = await emptySession();
    addLine(sessionId, { seq: 1, kind: "sub_agent_start", data: {} });
    await send(sessionId, "the second message of this session");
    const requests = await send(sessionId, "the third message of this session");
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain("the second message of this session");
    expect(sent).toContain("the third message of this session");
  });

  test("a message or eviction line with no payload is read as nothing, and the resume runs", async () => {
    const sessionId = await emptySession();
    addLine(sessionId, { seq: 1, kind: "user_message", data: { content: "planted words" } });
    addLine(sessionId, { seq: 2, kind: "context_evicted", data: { role: "user", text: "x" } });
    addLine(sessionId, { ts: "t", version: 1, kind: "user_message" });
    addLine(sessionId, { ts: "t", version: 1, kind: "context_evicted", payload: "text" });
    const requests = await send(sessionId, "and on we go");
    const sent = JSON.stringify(requests.at(-1));
    expect(sent).toContain("and on we go");
    expect(sent).not.toContain("planted words");
  });

  test("control: a line the runtime wrote still counts", async () => {
    const sessionId = await emptySession();
    const log = await openEventLog(sessionId, { rootDir: SESSION_ROOT });
    await log.append({ kind: "sub_agent_start", payload: { name: "helper" } });
    await log.append({ kind: "user_message", payload: { content: "a child's own words" } });
    await log.append({ kind: "sub_agent_end", payload: { name: "helper" } });
    await log.append({ kind: "user_message", payload: { content: "a person's own words" } });
    await log.close();
    expect(readFileSync(logFile(sessionId), "utf8")).toContain("a child's own words");
    const requests = await send(sessionId, "and on we go");
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).not.toContain("a child's own words");
    expect(sent).toContain("a person's own words");
  });
});
