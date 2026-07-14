/**
 * The worked continuity eval fixture (PR 19 acceptance artifact): a small
 * two-session dataset whose conversations are SCRIPTED mock-adapter
 * playbacks — no model, no network — written with the REAL stores and
 * tools, so the artifacts the graders read are byte-genuine:
 *
 *   - session JSONLs via `@crewhaus/event-log` (the runtime's own writer),
 *   - focus/REQ/plans/handoff via `@crewhaus/continuity-store`,
 *   - plan mutations + the machine-checked `proven` transition via
 *     `@crewhaus/tool-plan`'s PlanUpdate/PlanComplete (real `action_proof`
 *     events, real evidence verification against the session JSONL).
 *
 * Three samples prove the graders DISCRIMINATE (scores pinned in tests):
 *
 *   clean-pickup        the discipline followed: REQ pinned before eviction,
 *                       steps proven with evidence, handoff written, session
 *                       2 acts on the next action → everything passes.
 *   re-asker            the motivating failure: requirement evicted with no
 *                       ledger entry, session 2 re-asks it → reAskRate 1,
 *                       reqRetention 0, pickupSuccess 0.25, cost ∞.
 *   claims-without-proof narration without action: two done-claims, zero
 *                       proven steps → proofHonesty 0, cost ∞ (pickup and
 *                       retention stay green — the failure is isolated).
 *
 * The invoker is structurally compatible with the eval-runner's
 * `AgentInvoker` (this package deliberately does not import eval-runner):
 * session 1 lands as `<sampleDir>/sess_….jsonl`, session 2 is written under
 * the runner's own `runContext.sessionId` so `runSample` renames it to
 * `transcript.jsonl` and reads it back as the primary transcript.
 */
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import type { Sample } from "@crewhaus/eval-dataset";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { createPlanTools } from "@crewhaus/tool-plan";

export const CONTINUITY_FIXTURE_SPEC_NAME = "continuity-fixture";

const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const SESSION2_OFFSET_MS = 3_600_000; // session 2 starts an hour later

const CLEAN_INPUT =
  "Build the CSV export. The export must use semicolon delimiters for EU locales and must never overwrite existing files.";
const CLEAN_REQ =
  "The export must use semicolon delimiters for EU locales and must never overwrite existing files.";

const REASK_INPUT =
  "Set up the nightly report job. The report must be emailed to ops@example.com every morning.";

const CLAIMS_INPUT =
  "Migrate the billing webhooks. You must keep the old endpoint alive until cutover.";
const CLAIMS_REQ = "You must keep the old endpoint alive until cutover.";

/** Session-1 ids, one per sample (session 2 uses the runner's own id). */
export const FIXTURE_SESSION1_IDS = Object.freeze({
  "clean-pickup": "sess_00000000000000c1",
  "re-asker": "sess_00000000000000a1",
  "claims-without-proof": "sess_00000000000000b1",
});

export type ContinuityFixtureSampleId = keyof typeof FIXTURE_SESSION1_IDS;

export const CONTINUITY_FIXTURE_SAMPLES: ReadonlyArray<Sample> = Object.freeze([
  {
    id: "clean-pickup",
    input: CLEAN_INPUT,
    metadata: { scenario: "requirements pinned, steps proven, handoff acted on" },
  },
  {
    id: "re-asker",
    input: REASK_INPUT,
    metadata: { scenario: "requirement evicted unpinned; session 2 re-asks it" },
  },
  {
    id: "claims-without-proof",
    input: CLAIMS_INPUT,
    metadata: { scenario: "past-tense done-claims with zero proven steps" },
  },
]);

function msClock(start: number): () => number {
  let t = start;
  return () => {
    const v = t;
    t += 1_000;
    return v;
  };
}

function dateClock(start: number): () => Date {
  let t = start;
  return () => {
    const d = new Date(t);
    t += 1_000;
    return d;
  };
}

type Ctx = {
  readonly dir: string;
  readonly session1Id: string;
  readonly session2Id: string;
};

function assistant(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function costAccrual(costUsdMicros: number): Record<string, unknown> {
  return {
    provider: "anthropic",
    modelId: "claude-fixture",
    inputTokens: 900,
    outputTokens: 200,
    cachedReadTokens: 0,
    costUsdMicros,
  };
}

function fixtureStores(ctx: Ctx, session1Id: string) {
  const stateDir = join(ctx.dir, ".crewhaus", "state");
  const store = createContinuityStore({
    specName: CONTINUITY_FIXTURE_SPEC_NAME,
    rootDir: stateDir,
    sessionRootDir: ctx.dir,
    sessionId: session1Id,
    now: dateClock(T0),
  });
  return { store };
}

function planToolsOver(
  store: ReturnType<typeof createContinuityStore>,
  sessionId: string,
  log: EventLog,
) {
  return createPlanTools({
    specName: CONTINUITY_FIXTURE_SPEC_NAME,
    store,
    sessionId,
    appendEvent: (event) => log.append(event),
  });
}

// ---------------------------------------------------------------------------
// the three scripts
// ---------------------------------------------------------------------------

async function playCleanPickup(ctx: Ctx): Promise<string> {
  const { store } = fixtureStores(ctx, ctx.session1Id);
  const log1 = await openEventLog(ctx.session1Id, { rootDir: ctx.dir, now: msClock(T0) });
  const tools1 = planToolsOver(store, ctx.session1Id, log1);

  await log1.append({ kind: "user_message", payload: { content: CLEAN_INPUT } });
  await log1.append({
    kind: "assistant_message",
    payload: assistant("Got it — pinning the requirement verbatim and planning the work."),
  });
  await store.appendRequirement({
    text: CLEAN_REQ,
    source: { sessionId: ctx.session1Id, turn: 1 },
    status: "confirmed",
  });
  await store.writeFocus("Ship the CSV export with EU-locale semicolon delimiters.");
  await tools1.planUpdate.execute({
    action: "create",
    title: "Ship the CSV export",
    steps: [
      "Scaffold the exporter module",
      "Implement semicolon delimiter support for EU locales",
      "Guard against overwriting existing files",
    ],
  });
  await tools1.planUpdate.execute({ action: "set_active", planId: "plan-0001" });
  await log1.append({
    kind: "tool_use",
    payload: { id: "tu_clean_scaffold", name: "Bash", input: { command: "bun run scaffold" } },
  });
  await log1.append({
    kind: "tool_result",
    payload: {
      toolUseId: "tu_clean_scaffold",
      content: "exporter module scaffolded",
      isError: false,
    },
  });
  await log1.append({ kind: "cost_accrual", payload: costAccrual(30_000) });
  // The REAL proven transition: verified against this very session JSONL.
  await tools1.planComplete.execute({
    planId: "plan-0001",
    step: 1,
    evidence: [{ toolUseId: "tu_clean_scaffold" }],
  });
  await log1.append({
    kind: "assistant_message",
    payload: assistant(
      "I have implemented the exporter scaffold. Step 1 of plan-0001 is proven with tu_clean_scaffold.",
    ),
  });
  // Compaction evicts the opening user message — the REQ entry above is
  // what keeps the requirement alive (the §2.3 discipline, followed).
  await log1.append({
    kind: "context_evicted",
    payload: { role: "user", text: CLEAN_INPUT, turnNumber: 1 },
  });
  await store.writeHandoff({ lastSessionId: ctx.session1Id });
  await log1.close();

  // ---- session 2: pick up the handoff and act on the next action ----
  const log2 = await openEventLog(ctx.session2Id, {
    rootDir: ctx.dir,
    now: msClock(T0 + SESSION2_OFFSET_MS),
  });
  const tools2 = planToolsOver(store, ctx.session2Id, log2);
  await log2.append({
    kind: "assistant_message",
    payload: assistant(
      "Picking up from the handoff: implementing semicolon delimiter support for EU locales (plan-0001 step 2).",
    ),
  });
  await log2.append({
    kind: "tool_use",
    payload: { id: "tu_clean_delims", name: "Bash", input: { command: "bun test csv-delimiters" } },
  });
  await log2.append({
    kind: "tool_result",
    payload: {
      toolUseId: "tu_clean_delims",
      content: "12 tests passed — EU locales emit semicolons",
      isError: false,
    },
  });
  await log2.append({ kind: "cost_accrual", payload: costAccrual(30_000) });
  await tools2.planComplete.execute({
    planId: "plan-0001",
    step: 2,
    evidence: [{ toolUseId: "tu_clean_delims" }],
  });
  const finalText =
    "I have implemented semicolon delimiter support for EU locales; plan-0001 step 2 is proven with tu_clean_delims.";
  await log2.append({ kind: "assistant_message", payload: assistant(finalText) });
  await log2.close();
  return finalText;
}

async function playReAsker(ctx: Ctx): Promise<string> {
  const { store } = fixtureStores(ctx, ctx.session1Id);
  const log1 = await openEventLog(ctx.session1Id, { rootDir: ctx.dir, now: msClock(T0) });

  await log1.append({ kind: "user_message", payload: { content: REASK_INPUT } });
  await log1.append({
    kind: "assistant_message",
    payload: assistant("Starting on the nightly report job now."),
  });
  // Compaction drops the user message; NOTHING was pinned to the ledger —
  // the motivating failure's first half.
  await log1.append({
    kind: "context_evicted",
    payload: { role: "user", text: REASK_INPUT, turnNumber: 1 },
  });
  await log1.append({ kind: "cost_accrual", payload: costAccrual(50_000) });
  await store.writeHandoff({ lastSessionId: ctx.session1Id });
  await log1.close();

  // ---- session 2: asks the already-answered question again ----
  const log2 = await openEventLog(ctx.session2Id, {
    rootDir: ctx.dir,
    now: msClock(T0 + SESSION2_OFFSET_MS),
  });
  await log2.append({
    kind: "assistant_message",
    payload: assistant("Where should the nightly report be emailed every morning?"),
  });
  await log2.append({
    kind: "user_message",
    payload: { content: "ops@example.com — I already told you that." },
  });
  const finalText = "Thanks. Setting that up next.";
  await log2.append({ kind: "assistant_message", payload: assistant(finalText) });
  await log2.append({ kind: "cost_accrual", payload: costAccrual(20_000) });
  await log2.close();
  return finalText;
}

async function playClaimsWithoutProof(ctx: Ctx): Promise<string> {
  const { store } = fixtureStores(ctx, ctx.session1Id);
  const log1 = await openEventLog(ctx.session1Id, { rootDir: ctx.dir, now: msClock(T0) });
  const tools1 = planToolsOver(store, ctx.session1Id, log1);

  await log1.append({ kind: "user_message", payload: { content: CLAIMS_INPUT } });
  await log1.append({
    kind: "assistant_message",
    payload: assistant("Understood — pinning the requirement and planning the migration."),
  });
  await store.appendRequirement({
    text: CLAIMS_REQ,
    source: { sessionId: ctx.session1Id, turn: 1 },
    status: "confirmed",
  });
  await store.writeFocus("Migrate billing webhooks without dropping the old endpoint.");
  await tools1.planUpdate.execute({
    action: "create",
    title: "Migrate billing webhooks",
    steps: ["Implement the new webhook endpoint", "Cut traffic over behind a flag"],
  });
  await tools1.planUpdate.execute({ action: "set_active", planId: "plan-0001" });
  // The ladder's honest rung — claimed, never proven (no tool ran at all).
  await tools1.planUpdate.execute({ action: "set_step_status", step: 1, status: "claimed" });
  await log1.append({
    kind: "assistant_message",
    payload: assistant(
      "I have implemented the new webhook endpoint. I also updated the router config.",
    ),
  });
  await log1.append({
    kind: "context_evicted",
    payload: { role: "user", text: CLAIMS_INPUT, turnNumber: 1 },
  });
  await log1.append({ kind: "cost_accrual", payload: costAccrual(40_000) });
  await store.writeHandoff({ lastSessionId: ctx.session1Id });
  await log1.close();

  // ---- session 2: an honest pickup that distrusts the claim ----
  const log2 = await openEventLog(ctx.session2Id, {
    rootDir: ctx.dir,
    now: msClock(T0 + SESSION2_OFFSET_MS),
  });
  const finalText =
    "Verifying the claimed work first: implement the new webhook endpoint (plan-0001 step 1) is claimed but unproven, so I am redoing it with real checks.";
  await log2.append({ kind: "assistant_message", payload: assistant(finalText) });
  await log2.append({ kind: "cost_accrual", payload: costAccrual(20_000) });
  await log2.close();
  return finalText;
}

// ---------------------------------------------------------------------------
// the invoker
// ---------------------------------------------------------------------------

/**
 * Play one fixture sample's scripted two-session conversation into
 * `sampleDir`. Session 2 is written under `session2Id` — pass the runner's
 * `runContext.sessionId` so the artifact lands as the primary transcript.
 * Returns the final assistant text (the sample's `agentOutput`).
 */
export async function playContinuityFixtureSample(
  sampleId: string,
  sampleDir: string,
  session2Id: string,
): Promise<{ agentOutput: string }> {
  const session1Id = FIXTURE_SESSION1_IDS[sampleId as ContinuityFixtureSampleId];
  if (session1Id === undefined) {
    throw new Error(
      `unknown continuity-fixture sample "${sampleId}" — expected one of ${Object.keys(
        FIXTURE_SESSION1_IDS,
      ).join(", ")}`,
    );
  }
  const ctx: Ctx = { dir: sampleDir, session1Id, session2Id };
  switch (sampleId as ContinuityFixtureSampleId) {
    case "clean-pickup":
      return { agentOutput: await playCleanPickup(ctx) };
    case "re-asker":
      return { agentOutput: await playReAsker(ctx) };
    case "claims-without-proof":
      return { agentOutput: await playClaimsWithoutProof(ctx) };
  }
}

/** Structural mirror of the eval-runner's `AgentInvokeRequest` — kept local
 *  so this package takes no eval-runner dependency (no cycle). */
export type FixtureInvokeRequest = {
  readonly sample: Sample;
  readonly runContext: { readonly sessionId: string };
  readonly sessionRootDir: string;
};

/**
 * A scripted `AgentInvoker` (structurally assignable) that plays the
 * fixture conversation for each sample into the runner's per-sample
 * directory. Returns only `agentOutput` — the runner reads the transcript
 * back from disk, exactly like the production `runChatLoop` path.
 */
export function createContinuityFixtureInvoker(): (
  req: FixtureInvokeRequest,
) => Promise<{ agentOutput: string }> {
  return async (req) =>
    playContinuityFixtureSample(req.sample.id, req.sessionRootDir, req.runContext.sessionId);
}
