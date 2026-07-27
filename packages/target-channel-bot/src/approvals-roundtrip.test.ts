/**
 * Loop contract 0.4 (G11) — the channel approval surface, EXECUTED.
 *
 * Every other approval test in this package asserts on emitted source text,
 * which is exactly how a completely unreachable park → prompt → grant → resume
 * surface passed CI for so long: the strings were all present and correct, and
 * nothing they described could ever run. Three things were broken at once —
 * the emitted turn threaded neither `askMode` nor `approvals`, the router's
 * catch queried a channel store nothing ever wrote to, and that store was
 * structurally incompatible with the runtime one anyway.
 *
 * So this test runs the emitted router for real, over the real bridged store,
 * and asserts the round trip end to end: a parked turn POSTS a prompt carrying
 * a real approval id, and a grant RE-DRIVES the turn.
 *
 * No Slack and no model: the adapter is a local fake that captures what would
 * have been posted, and the "agent" is a stub that parks the way runtime-core
 * does (persist, then throw the classified report) and succeeds once granted.
 * The store underneath is the REAL `createPendingApprovalStore` on a temp dir,
 * because store semantics are half of what broke here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IrChannelV0 } from "@crewhaus/ir";
import { emitChannelBot } from "./index.js";

/** Same minimal spec index.test.ts uses; inlined so the two files stay independent. */
const MIN_IR: IrChannelV0 = {
  version: 0,
  name: "demo",
  target: "channel",
  agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
  tools: [],
  toolConfigs: {},
  channels: {
    slack: {
      botToken: { kind: "env", name: "SLACK_BOT_TOKEN" },
      signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
    },
  },
  routing: { sessionKey: "thread" },
  mcp_servers: {},
  permissions: { rules: [] },
  subAgents: [],
  compaction: {},
};

type RoundTripResult = {
  readonly prompts: Array<{ approvalId: string; toolName: string; text: string }>;
  readonly replies: string[];
  readonly reactions: string[];
  readonly turnCalls: Array<{ sessionId: string; message: string; isNew: boolean }>;
  readonly storeAfter: Array<{ id: string; decision?: string }>;
  readonly secondResolveWasNull: boolean;
};

/**
 * Driver executed in a subprocess beside the emitted `session-router.ts`, so
 * the module under test is the real generated file, imported the way the
 * daemon imports it.
 */
const DRIVER_SRC = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import { createRuntimeBackedApprovalStore, resolveApproval } from "@crewhaus/channel-adapter-base";
import { RunFailedError } from "@crewhaus/errors";
import { createSessionRouter } from "./session-router.ts";

const root = mkdtempSync(join(tmpdir(), "channel-approvals-"));
const runtimeStore = createPendingApprovalStore({ rootDir: root });
const approvals = createRuntimeBackedApprovalStore(runtimeStore);

const prompts = [];
const replies = [];
const reactions = [];
const turnCalls = [];
let granted = false;

// Stands in for the emitted agent. Parks the way runtime-core does: persist
// the record FIRST, then throw the classified report — the ordering the
// router's catch depends on, since it lists the store immediately after.
const agent = {
  async runTurn({ sessionId, isNew, message }) {
    turnCalls.push({ sessionId, isNew, message });
    if (!granted) {
      await runtimeStore.persist({
        id: "appr_00000000000000aa",
        toolName: "sendmessage",
        inputHash: "hash-1",
        input: { text: "post to #general" },
        runId: "run_1",
        sessionId,
        surface: "channel",
        createdAt: new Date().toISOString(),
      });
      throw new RunFailedError({
        class: "approval_pending",
        title: "awaiting tool approval",
        detail: "parked as approval appr_00000000000000aa",
        exitCode: 36,
      });
    }
    return "posted it";
  },
};

const adapter = {
  id: "slack",
  async sendReply({ text }) {
    replies.push(text);
  },
  async react({ emoji }) {
    reactions.push(emoji);
  },
  async postApproval({ approval }) {
    prompts.push({
      // postApprovalPrompt hands the adapter a FLATTENED shape, not the record.
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      text: approval.inputPreview,
    });
    // postApprovalPrompt reads messageTs off the result.
    return { messageTs: "200.1" };
  },
};

const router = createSessionRouter({ agent, approvals });
const event = {
  adapterId: "slack",
  workspaceId: "T1",
  channelId: "C1",
  userId: "U1",
  threadId: "100.0",
  text: "please post to general",
  eventId: "ev1",
};

// 1. The turn parks. The router must catch it and post a prompt.
await router.handle(event, adapter);

// 2. A human clicks Approve. This is the gateway's path, verbatim.
const resolved = await resolveApproval({
  store: approvals,
  approvalId: "appr_00000000000000aa",
  decision: "grant",
  by: "slack:U1",
});

// 3. Slack retries the interaction — the guard must refuse the second one, or
//    the turn is driven twice and the side effect happens twice.
const second = await resolveApproval({
  store: approvals,
  approvalId: "appr_00000000000000aa",
  decision: "grant",
  by: "slack:U1",
});

// 4. The grant re-drives the parked turn.
granted = true;
if (resolved !== null) await router.resumeApproval(resolved, adapter);

process.stdout.write(
  JSON.stringify({
    prompts,
    replies,
    reactions,
    turnCalls,
    storeAfter: (await runtimeStore.list()).map((a) => ({ id: a.id, decision: a.decision })),
    secondResolveWasNull: second === null,
  }),
);
`;

async function runRoundTrip(): Promise<RoundTripResult> {
  const emitted = new Map(emitChannelBot(MIN_IR).files.map((f) => [f.path, f.content]));
  const router = emitted.get("session-router.ts");
  if (router === undefined) throw new Error("no session-router.ts emitted");
  // Beside the package sources so the emitted @crewhaus/* imports resolve.
  const dir = mkdtempSync(join(import.meta.dir, ".approval-run-"));
  writeFileSync(join(dir, "session-router.ts"), router);
  writeFileSync(join(dir, "driver.ts"), DRIVER_SRC);
  try {
    const proc = Bun.spawn([process.execPath, join(dir, "driver.ts")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (out.trim() === "") throw new Error(`driver produced no output; stderr:\n${err}`);
    return JSON.parse(out) as RoundTripResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("emitChannelBot — park → prompt → grant → resume (emitted router executed)", () => {
  test("a parked turn posts a prompt, and the grant re-drives the turn", async () => {
    const res = await runRoundTrip();

    // The prompt actually reached the channel — this is the assertion the
    // whole feature was missing. Before the bridge, `list()` returned [] and
    // no prompt was ever posted.
    expect(res.prompts).toHaveLength(1);
    expect(res.prompts[0]?.approvalId).toBe("appr_00000000000000aa");
    expect(res.prompts[0]?.toolName).toBe("sendmessage");
    // The preview is rendered from the raw input the runtime parked.
    expect(res.prompts[0]?.text).toContain("post to #general");

    // The grant re-drove the SAME session, and the reply reached the thread.
    expect(res.turnCalls).toHaveLength(2);
    expect(res.turnCalls[1]?.sessionId).toBe(res.turnCalls[0]?.sessionId);
    expect(res.turnCalls[1]?.isNew).toBe(false);
    expect(res.replies).toContain("posted it");

    // The decision landed in the RUNTIME store — the only one a re-driven turn
    // consults when it re-asks the permission engine.
    expect(res.storeAfter).toHaveLength(1);
    expect(res.storeAfter[0]?.decision).toBe("grant");

    // A Slack interaction retry must not drive the turn a second time.
    expect(res.secondResolveWasNull).toBe(true);
  }, 60_000);
});
