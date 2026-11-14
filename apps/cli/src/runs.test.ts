import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { append, readPage } from "@crewhaus/control-records";
import { createRunContext, runWithScope } from "@crewhaus/run-context";
import { createPendingApprovalStore, runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import {
  RUNS_LEDGER_DIR,
  RunsError,
  isRunsSessionId,
  resolveRunsResumeSpecPath,
  resolveRunsResumeTarget,
  runsLedgerAt,
  runsResumeScope,
} from "./runs";

describe("isRunsSessionId", () => {
  test("accepts sess_<16 hex>, rejects everything else", () => {
    expect(isRunsSessionId("sess_0123456789abcdef")).toBe(true);
    expect(isRunsSessionId("sess_0123456789ABCDEF")).toBe(false); // uppercase hex not allowed
    expect(isRunsSessionId("sess_012")).toBe(false);
    expect(isRunsSessionId("0123456789abcdef")).toBe(false);
    expect(isRunsSessionId("")).toBe(false);
  });
});

describe("resolveRunsResumeSpecPath", () => {
  const cwd = "/harness";

  test("returns the absolute --spec when it exists", () => {
    const exists = (p: string) => p === "/harness/agent.yaml";
    expect(resolveRunsResumeSpecPath("agent.yaml", cwd, exists)).toBe("/harness/agent.yaml");
    expect(isAbsolute(resolveRunsResumeSpecPath("agent.yaml", cwd, exists))).toBe(true);
  });

  test("keeps an absolute --spec as-is", () => {
    const exists = (p: string) => p === "/other/spec.yaml";
    expect(resolveRunsResumeSpecPath("/other/spec.yaml", cwd, exists)).toBe("/other/spec.yaml");
  });

  test("throws RunsError naming the missing --spec", () => {
    const exists = () => false;
    expect(() => resolveRunsResumeSpecPath("missing.yaml", cwd, exists)).toThrow(RunsError);
    try {
      resolveRunsResumeSpecPath("missing.yaml", cwd, exists);
    } catch (err) {
      expect((err as Error).message).toContain("--spec not found");
      expect((err as Error).message).toContain("/harness/missing.yaml");
    }
  });

  test("falls back to cwd/crewhaus.yaml when no --spec is given", () => {
    const exists = (p: string) => p === join(cwd, "crewhaus.yaml");
    expect(resolveRunsResumeSpecPath(undefined, cwd, exists)).toBe(join(cwd, "crewhaus.yaml"));
  });

  test("throws RunsError when neither --spec nor the fallback exists", () => {
    const exists = () => false;
    expect(() => resolveRunsResumeSpecPath(undefined, cwd, exists)).toThrow(RunsError);
    try {
      resolveRunsResumeSpecPath(undefined, cwd, exists);
    } catch (err) {
      expect((err as Error).message).toContain("no --spec given");
      expect((err as Error).message).toContain(cwd);
    }
  });
});

describe("resolveRunsResumeTarget", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function harness(): string {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-runs-resume-"));
    dirs.push(dir);
    return dir;
  }
  const sessionId = (n: number) => `sess_${String(n).padStart(16, "0")}`;
  function plant(dir: string, row: Record<string, unknown>): void {
    const written = append(runsLedgerAt(dir), {
      at: new Date().toISOString(),
      trigger: { kind: "cli" },
      ...row,
    });
    expect(written.ok).toBe(true);
  }

  test("a run id resolves to its session; a run that ended is refused by name, and its session id still resumes", () => {
    const dir = harness();
    const [finished, parked, cancelled] = [mintRunId(), mintRunId(), mintRunId()];
    plant(dir, { id: finished, state: "running", session: sessionId(1) });
    plant(dir, { id: finished, state: "succeeded" });
    plant(dir, { id: parked, state: "running", session: sessionId(2) });
    plant(dir, { id: parked, state: "waiting-for-approval", decision: "appr_0123456789abcdef" });
    plant(dir, { id: cancelled, state: "running", session: sessionId(5) });
    plant(dir, { id: cancelled, state: "waiting-for-approval" });
    plant(dir, { id: cancelled, state: "cancelled" });
    expect(() => resolveRunsResumeTarget(finished, dir)).toThrow(
      `run ${finished} was succeeded; nothing was resumed`,
    );
    expect(() => resolveRunsResumeTarget(cancelled, dir)).toThrow(
      `run ${cancelled} was cancelled; nothing was resumed`,
    );
    expect(resolveRunsResumeTarget(sessionId(1), dir)).toEqual({ sessionId: sessionId(1) });
    // The parked run's last row carries no session: a resolver that read only the fold would find none.
    expect(resolveRunsResumeTarget(parked, dir)).toEqual({
      sessionId: sessionId(2),
      continues: parked,
    });
  });

  test("a root's id resolves to the session of its newest run", () => {
    const dir = harness();
    const root = mintRunId();
    const [older, newer] = [mintRunId(), mintRunId()];
    plant(dir, { id: root, state: "queued", execution: "run_00000000000000aa" });
    plant(dir, { id: root, state: "preparing", execution: "run_00000000000000aa" });
    plant(dir, { id: root, state: "running", execution: "run_00000000000000aa" });
    plant(dir, { id: older, state: "running", session: sessionId(3), parent: root });
    plant(dir, { id: older, state: "succeeded" });
    plant(dir, { id: newer, state: "running", session: sessionId(4), parent: root });
    plant(dir, { id: newer, state: "waiting-for-approval", decision: "appr_0123456789abcdef" });
    expect(resolveRunsResumeTarget(root, dir)).toEqual({
      sessionId: sessionId(4),
      continues: newer,
    });
  });

  test("a session id resolves to itself, continuing its newest parked run", () => {
    const dir = harness();
    const [parkedOld, parkedNew] = [mintRunId(), mintRunId()];
    plant(dir, { id: parkedOld, state: "running", session: sessionId(5) });
    plant(dir, { id: parkedOld, state: "waiting-for-approval", decision: "appr_0123456789abcdef" });
    plant(dir, { id: parkedNew, state: "running", session: sessionId(5) });
    plant(dir, { id: parkedNew, state: "waiting-for-approval", decision: "appr_0123456789abcdee" });
    expect(resolveRunsResumeTarget(sessionId(5), dir)).toEqual({
      sessionId: sessionId(5),
      continues: parkedNew,
    });
    // No run records at all: the session still resumes, with nothing to continue.
    expect(resolveRunsResumeTarget(sessionId(6), harness())).toEqual({ sessionId: sessionId(6) });
  });

  test("a parked supervised run's scope comes back, by session id and by run id, and goes into the resume", () => {
    const dir = harness();
    const root = mintRunId();
    const parked = mintRunId();
    const scope = `run:${root}`;
    plant(dir, { id: root, state: "queued", execution: "run_00000000000000ab" });
    plant(dir, {
      id: parked,
      state: "running",
      session: sessionId(8),
      parent: root,
      resumeScope: scope,
    });
    plant(dir, { id: parked, state: "waiting-for-approval", decision: "appr_0123456789abcdef" });
    const want = { sessionId: sessionId(8), continues: parked, resumeScope: scope };
    expect(resolveRunsResumeTarget(sessionId(8), dir)).toEqual(want);
    expect(resolveRunsResumeTarget(parked, dir)).toEqual(want);
    expect(resolveRunsResumeTarget(root, dir)).toEqual(want);
    expect(runsResumeScope(want)).toEqual({
      trigger: { kind: "resume" },
      continues: parked,
      resumeScope: scope,
    });
  });

  test("a run parked under a work item resumes in it; a parked run with no recorded scope resumes with none", () => {
    const dir = harness();
    const workItem = mintId("wi");
    const [worked, bare] = [mintRunId(), mintRunId()];
    plant(dir, {
      id: worked,
      state: "running",
      session: sessionId(9),
      resumeScope: `work:${workItem}`,
    });
    plant(dir, { id: worked, state: "waiting-for-approval", decision: "appr_0123456789abcdef" });
    expect(resolveRunsResumeTarget(sessionId(9), dir)).toEqual({
      sessionId: sessionId(9),
      continues: worked,
      resumeScope: `work:${workItem}`,
    });
    plant(dir, { id: bare, state: "running", session: sessionId(10) });
    plant(dir, { id: bare, state: "waiting-for-approval", decision: "appr_0123456789abcdee" });
    const target = resolveRunsResumeTarget(bare, dir);
    expect(target).toEqual({ sessionId: sessionId(10), continues: bare });
    expect(runsResumeScope(target)).toEqual({ trigger: { kind: "resume" }, continues: bare });
  });

  test("an id no run record has is refused, naming it", () => {
    const dir = harness();
    const unknown = mintRunId();
    expect(() => resolveRunsResumeTarget(unknown, dir)).toThrow(RunsError);
    expect(() => resolveRunsResumeTarget(unknown, dir)).toThrow(unknown);
    expect(() => resolveRunsResumeTarget("run_1234abcd", dir)).toThrow(RunsError);
  });

  test("run records that cannot be read whole are refused for a run id", () => {
    const dir = harness();
    const id = mintRunId();
    plant(dir, { id, state: "running", session: sessionId(7) });
    appendFileSync(join(dir, RUNS_LEDGER_DIR, "000001.jsonl"), "not json\n");
    expect(() => resolveRunsResumeTarget(id, dir)).toThrow(/could not be read whole/);
  });

  test("the resumed loop's running row continues the parked run and was started by a resume", async () => {
    const dir = harness();
    const sessions = join(dir, "sessions");
    const store = createPendingApprovalStore({ rootDir: join(dir, "approvals") });
    const danger = buildTool({
      name: "danger",
      description: "must be approved",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: false,
      destructive: false,
      concurrencySafe: false,
      execute: async () => "did it",
    });
    const first = createRunContext();
    let parkedError: unknown;
    try {
      await runChatLoop({
        ...LOOP,
        runContext: first,
        sessionRootDir: sessions,
        runLedgerDir: dir,
        permissionMode: "default",
        tools: [danger],
        approvals: { store },
        _adapter: scriptedAdapter("tool"),
      });
    } catch (err) {
      parkedError = err;
    }
    expect((parkedError as { report?: { class?: string } }).report?.class).toBe("approval_pending");

    const target = resolveRunsResumeTarget(first.runId, dir);
    expect(target).toEqual({
      sessionId: first.sessionId,
      continues: first.runId,
      resumeScope: `session:${first.sessionId}`,
    });
    // As the CLI does: the resumed loop mints its context inside the scope.
    let resumed = first;
    const answer = await runWithScope(runsResumeScope(target), () => {
      resumed = createRunContext({ sessionId: first.sessionId });
      return runChatLoop({
        ...LOOP,
        runContext: resumed,
        sessionRootDir: sessions,
        runLedgerDir: dir,
        resume: { sessionId: first.sessionId },
        _adapter: scriptedAdapter("text"),
      });
    });
    expect(resumed.runId).not.toBe(first.runId);
    expect(typeof answer).toBe("string");
    const rows: Record<string, unknown>[] = [];
    for (const item of readPage(runsLedgerAt(dir), { limit: 100 }).items) rows.unshift(item.record);
    const running = rows.find((r) => r["id"] === resumed.runId && r["state"] === "running");
    expect(running).toMatchObject({
      continues: first.runId,
      trigger: { kind: "resume" },
      session: first.sessionId,
    });
    expect(rows.filter((r) => r["id"] === first.runId).map((r) => r["state"])).toEqual([
      "running",
      "waiting-for-approval",
    ]);
  });
});

const LOOP = {
  model: "test-model",
  instructions: "resume test",
  singleTurn: true,
  seedMessages: [{ role: "user" as const, content: "go" }],
  installSigintHandler: false,
  spinner: false,
  stdout: () => {},
  settingsDir: null,
} as const;

/** A model that calls `danger` once (`tool`) or answers in text (`text`). */
function scriptedAdapter(reply: "tool" | "text"): ProviderAdapter {
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
    stream: () =>
      (async function* () {
        yield { kind: "message_start" } as const;
        if (reply === "tool") {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: "danger", input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"x":1}' },
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
            delta: { type: "text_delta", text: "resumed" },
          } as const;
        }
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: reply === "tool" ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}
