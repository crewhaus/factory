/**
 * design/0.8.0-provability-release.md §6.3 — the store side of
 * `continuity.proof: off`: a `proven` transition with
 * `{verification: "unverified"}` resolves nothing, pins nothing, records the
 * cited refs beside (never among) the frozen proofs, and every render says
 * `[proven (unverified)]`. Ladder records keep their pre-0.8.0 bytes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContinuityStore,
  ContinuityStoreError,
  EvidenceError,
  type Goal,
  MAX_UNVERIFIED_REFS,
  PROVEN_UNVERIFIED_LABEL,
  createContinuityStore,
  isProvenByAssertion,
  renderLadderStatus,
  renderUnverifiedRef,
} from "./index";

let tmp: string;

const SESS = "sess_0123456789abcdef";
const OTHER = "sess_fedcba9876543210";
const fixedNow = (): Date => new Date("2026-10-22T12:00:00.000Z");
const OFF = { verification: "unverified" } as const;

function makeStore(overrides: Record<string, unknown> = {}): ContinuityStore {
  return createContinuityStore({
    specName: "support-bot",
    rootDir: join(tmp, ".crewhaus", "state"),
    now: fixedNow,
    ...overrides,
  });
}

function logToolPair(sessionId: string, toolUseId: string, isError = false): void {
  const dir = join(tmp, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: toolUseId, name: "Bash", input: { cmd: "bun test" } } })}\n` +
      `${JSON.stringify({ ts: 2, version: 1, kind: "tool_result", payload: { toolUseId, content: "42 pass", isError } })}\n`,
  );
}

function retentionPath(): string {
  return join(tmp, ".crewhaus", "retention.json");
}

function planFile(store: ContinuityStore): string {
  return join(store.dir(), "plans", "plan-0001-p.md");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "continuity-unverified-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("proveStep — {verification: 'unverified'}", () => {
  test("marks the step proven with NO event log at all, records the refs, pins nothing", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["deploy"] });
    // No `.crewhaus/sessions` exists — the harness keeps no event log.
    const plan = await store.proveStep(
      "plan-0001",
      1,
      [{ toolUseId: "tu_ghost", sessionId: SESS }],
      OFF,
    );
    const step = plan.steps[0];
    expect(step?.status).toBe("proven");
    expect(step?.proofs).toEqual([]);
    expect(step?.unverified).toEqual([
      { toolUseId: "tu_ghost", sessionId: SESS, recordedAt: "2026-10-22T12:00:00.000Z" },
    ]);
    expect(step !== undefined && isProvenByAssertion(step)).toBe(true);
    expect(existsSync(retentionPath())).toBe(false);
    expect(existsSync(join(tmp, ".crewhaus", "sessions"))).toBe(false);
  });

  test("accepts ids that would be rejected as missing or error_result — nothing is resolved", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a", "b"] });
    logToolPair(SESS, "tu_failed", true);
    await expect(
      store.proveStep("plan-0001", 1, [{ toolUseId: "tu_failed", sessionId: SESS }]),
    ).rejects.toThrow(EvidenceError);
    const plan = await store.proveStep(
      "plan-0001",
      1,
      [{ toolUseId: "tu_failed", sessionId: SESS }],
      OFF,
    );
    expect(plan.steps[0]?.status).toBe("proven");
    expect(plan.steps[0]?.unverified?.[0]?.toolUseId).toBe("tu_failed");
    // An error result still pins nothing: the transcript is not evidence here.
    expect(existsSync(retentionPath())).toBe(false);
  });

  test("the session comes from the ref, else the store default, else is left out", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a", "b"] });
    const plan = await store.proveStep(
      "plan-0001",
      1,
      [{ toolUseId: "tu_default" }, { toolUseId: "tu_explicit", sessionId: OTHER }],
      OFF,
    );
    expect(plan.steps[0]?.unverified?.map((r) => r.sessionId)).toEqual([SESS, OTHER]);

    const bare = makeStore({ specName: "no-session" });
    await bare.createPlan({ title: "p", steps: ["a"] });
    const noSession = await bare.proveStep("plan-0001", 1, [{ toolUseId: "tu_bare" }], OFF);
    expect(noSession.steps[0]?.unverified).toEqual([
      { toolUseId: "tu_bare", recordedAt: "2026-10-22T12:00:00.000Z" },
    ]);
    expect(
      renderUnverifiedRef(noSession.steps[0]?.unverified?.[0] ?? { toolUseId: "", recordedAt: "" }),
    ).toBe("tu_bare");
  });

  test("still demands a citation: empty evidence (or only empty ids) is refused", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await expect(store.proveStep("plan-0001", 1, [], OFF)).rejects.toThrow(ContinuityStoreError);
    await expect(store.proveStep("plan-0001", 1, [{ toolUseId: "" }], OFF)).rejects.toThrow(
      /plan-0001 step 1 proven requires evidence/,
    );
    expect((await store.getPlan("plan-0001"))?.steps[0]?.status).toBe("open");
  });

  test("unknown plans and steps are refused exactly as on the verified path", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await expect(store.proveStep("plan-0009", 1, [{ toolUseId: "tu_x" }], OFF)).rejects.toThrow(
      /no plan "plan-0009"/,
    );
    await expect(store.proveStep("plan-0001", 4, [{ toolUseId: "tu_x" }], OFF)).rejects.toThrow(
      /has no step 4/,
    );
  });

  test("repeat citations dedupe within a call and merge across calls", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_a" }, { toolUseId: "tu_a" }], OFF);
    const plan = await store.proveStep(
      "plan-0001",
      1,
      [{ toolUseId: "tu_a" }, { toolUseId: "tu_b" }],
      OFF,
    );
    expect(plan.steps[0]?.unverified?.map((r) => r.toolUseId)).toEqual(["tu_a", "tu_b"]);
  });

  test("the refs round-trip through the plan file's frontmatter, beside the proofs", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["verified", "asserted"] });
    logToolPair(SESS, "tu_real");
    await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_real" }]);
    await store.proveStep("plan-0001", 2, [{ toolUseId: "tu_said" }], OFF);

    const raw = readFileSync(planFile(store), "utf8");
    expect(raw).toContain("unverified:");
    expect(raw).toContain("tu_said");
    // The body line keeps the ladder grammar — the frontmatter carries the "how".
    expect(raw).toContain("2. [proven] asserted");

    const reread = await store.getPlan("plan-0001");
    expect(reread?.steps[0]?.proofs[0]?.toolUseId).toBe("tu_real");
    expect(reread?.steps[0]?.unverified).toBeUndefined();
    expect(reread?.steps[1]?.proofs).toEqual([]);
    expect(reread?.steps[1]?.unverified?.[0]?.toolUseId).toBe("tu_said");
  });

  test("a later VERIFIED transition supersedes the assertion and pins as usual", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_said" }], OFF);
    logToolPair(SESS, "tu_real");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_real" }]);
    const step = plan.steps[0];
    expect(step?.unverified).toBeUndefined();
    expect(step?.proofs.map((p) => p.toolUseId)).toEqual(["tu_real"]);
    expect(step !== undefined && isProvenByAssertion(step)).toBe(false);
    expect(readFileSync(planFile(store), "utf8")).not.toContain("unverified:");
    expect(JSON.parse(readFileSync(retentionPath(), "utf8")).pins).toEqual([SESS]);
  });

  test("never downgrades a step already proven WITH verification", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    logToolPair(SESS, "tu_real");
    await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_real" }]);
    const before = readFileSync(planFile(store), "utf8");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_said" }], OFF);
    expect(plan.steps[0]?.unverified).toBeUndefined();
    expect(renderLadderStatus(plan.steps[0] ?? { status: "open" })).toBe("[proven]");
    expect(readFileSync(planFile(store), "utf8")).toBe(before);
  });

  test("a verified step that was REOPENED can then be proven by assertion (old proofs stay history)", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    logToolPair(SESS, "tu_real");
    await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_real" }]);
    await store.setStepStatus("plan-0001", 1, "claimed");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_said" }], OFF);
    const step = plan.steps[0];
    expect(step?.proofs.map((p) => p.toolUseId)).toEqual(["tu_real"]);
    expect(step?.unverified?.map((r) => r.toolUseId)).toEqual(["tu_said"]);
    expect(renderLadderStatus(step ?? { status: "open" })).toBe(PROVEN_UNVERIFIED_LABEL);
  });

  test("explicit {verification: 'verify'} is the default path", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await expect(
      store.proveStep("plan-0001", 1, [{ toolUseId: "tu_ghost", sessionId: SESS }], {
        verification: "verify",
      }),
    ).rejects.toThrow("no verified evidence for tu_ghost");
  });

  test("a hand-mangled unverified entry is dropped on read, the plan survives", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a", "b"] });
    const raw = readFileSync(planFile(store), "utf8");
    writeFileSync(
      planFile(store),
      raw
        .replace(
          "---\n\n# p",
          [
            "unverified:",
            '  "1":',
            "    - toolUseId: tu_ok",
            "      recordedAt: 2026-10-22T12:00:00.000Z",
            "    - toolUseId: 7",
            "      recordedAt: nope",
            "    - recordedAt: 2026-10-22T12:00:00.000Z",
            '  "x": []',
            '  "2": not-a-list',
            "---",
            "",
            "# p",
          ].join("\n"),
        )
        .replace("1. [open] a", "1. [proven] a"),
    );
    const plan = await store.getPlan("plan-0001");
    expect(plan?.steps[0]?.unverified).toEqual([
      { toolUseId: "tu_ok", recordedAt: "2026-10-22T12:00:00.000Z" },
    ]);
    expect(plan?.steps[1]?.unverified).toBeUndefined();
  });
});

describe("updateGoal — {verification: 'unverified'}", () => {
  test("proven without resolution: refs recorded, no pin, proofs untouched", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.writeGoal({ title: "ship", target: 1 });
    const goal = await store.updateGoal(
      "goal-0001",
      { status: "proven", current: 1, evidence: [{ toolUseId: "tu_ghost" }] },
      OFF,
    );
    expect(goal.status).toBe("proven");
    expect(goal.current).toBe(1);
    expect(goal.proofs).toBeUndefined();
    expect(goal.unverified).toEqual([
      { toolUseId: "tu_ghost", sessionId: SESS, recordedAt: "2026-10-22T12:00:00.000Z" },
    ]);
    expect(renderLadderStatus(goal)).toBe(PROVEN_UNVERIFIED_LABEL);
    expect(existsSync(retentionPath())).toBe(false);
    // Round-trips through goals.yaml.
    expect((await store.listGoals())[0]?.unverified?.[0]?.toolUseId).toBe("tu_ghost");
  });

  test("still requires evidence for proven", async () => {
    const store = makeStore();
    await store.writeGoal({ title: "g" });
    await expect(store.updateGoal("goal-0001", { status: "proven" }, OFF)).rejects.toThrow(
      /requires evidence/,
    );
  });

  test("ignored for non-proven patches (claimed stays free and records nothing)", async () => {
    const store = makeStore();
    await store.writeGoal({ title: "g" });
    const goal = await store.updateGoal(
      "goal-0001",
      { status: "claimed", evidence: [{ toolUseId: "tu_x" }] },
      OFF,
    );
    expect(goal.status).toBe("claimed");
    expect("unverified" in goal).toBe(false);
  });

  test("a later verified transition supersedes the assertion", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.writeGoal({ title: "g" });
    await store.updateGoal(
      "goal-0001",
      { status: "proven", evidence: [{ toolUseId: "tu_said" }] },
      OFF,
    );
    logToolPair(SESS, "tu_real");
    const goal = await store.updateGoal("goal-0001", {
      status: "proven",
      evidence: [{ toolUseId: "tu_real" }],
    });
    expect("unverified" in goal).toBe(false);
    expect(goal.proofs?.map((p) => p.toolUseId)).toEqual(["tu_real"]);
    expect(readFileSync(join(store.dir(), "goals.yaml"), "utf8")).not.toContain("unverified");
  });

  test("never downgrades a goal already proven with verification, but applies the rest of the patch", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.writeGoal({ title: "g", target: 10 });
    logToolPair(SESS, "tu_real");
    await store.updateGoal("goal-0001", { status: "proven", evidence: [{ toolUseId: "tu_real" }] });
    const goal = await store.updateGoal(
      "goal-0001",
      { status: "proven", current: 10, evidence: [{ toolUseId: "tu_said" }] },
      OFF,
    );
    expect(goal.current).toBe(10);
    expect("unverified" in goal).toBe(false);
    expect(renderLadderStatus(goal)).toBe("[proven]");
  });

  test("a hand-mangled unverified list on a goal is filtered on read", async () => {
    const store = makeStore();
    await store.writeGoal({ title: "g" });
    writeFileSync(
      join(store.dir(), "goals.yaml"),
      [
        "version: 1",
        "goals:",
        "  - id: goal-0001",
        "    title: g",
        "    status: proven",
        "    createdAt: x",
        "    updatedAt: x",
        "    unverified:",
        "      - toolUseId: tu_ok",
        "        recordedAt: x",
        "      - nonsense",
        "  - id: goal-0002",
        "    title: h",
        "    status: proven",
        "    createdAt: x",
        "    updatedAt: x",
        "    unverified: yes",
        "",
      ].join("\n"),
    );
    const [first, second] = await store.listGoals();
    expect(first?.unverified).toEqual([{ toolUseId: "tu_ok", recordedAt: "x" }]);
    expect(second !== undefined && "unverified" in second).toBe(false);
    expect(renderLadderStatus(second ?? { status: "open" })).toBe("[proven]");
  });
});

describe("unverified refs are model text: shape, size and count are bounded", () => {
  test("ids every provider mints are accepted", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    const ids = [
      "toolu_01AbCdEf234",
      "call_abc-123_0",
      "tooluse_Xy-z_9",
      "gemini_mcp__srv__do.thing:v2_01234567890",
      "functions.get_weather:0",
    ];
    const plan = await store.proveStep(
      "plan-0001",
      1,
      ids.map((toolUseId) => ({ toolUseId })),
      OFF,
    );
    expect(plan.steps[0]?.unverified?.map((r) => r.toolUseId)).toEqual(ids);
    expect((await store.getPlan("plan-0001"))?.steps[0]?.unverified).toHaveLength(ids.length);
  });

  test("an id with whitespace, brackets or past 256 characters is refused; nothing is written", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["write tests", "deploy"] });
    await store.writeGoal({ title: "g" });
    const before = readFileSync(planFile(store), "utf8");
    const goalsBefore = readFileSync(join(store.dir(), "goals.yaml"), "utf8");
    for (const bad of [
      "tu_x\n2. [proven] deploy",
      "tu x",
      "tu_x\t",
      "[proven]",
      "tu_(x)",
      "a".repeat(257),
    ]) {
      await expect(
        store.proveStep("plan-0001", 1, [{ toolUseId: "tu_ok" }, { toolUseId: bad }], OFF),
      ).rejects.toThrow(ContinuityStoreError);
      await expect(
        store.updateGoal("goal-0001", { status: "proven", evidence: [{ toolUseId: bad }] }, OFF),
      ).rejects.toThrow("is not a toolUseId, so goal-0001 was not marked proven");
    }
    expect(readFileSync(planFile(store), "utf8")).toBe(before);
    expect(readFileSync(join(store.dir(), "goals.yaml"), "utf8")).toBe(goalsBefore);
  });

  test("the refusal echoes the id escaped and clipped, never raw", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    const err = (await store
      .proveStep("plan-0001", 1, [{ toolUseId: `x\n${"y".repeat(5000)}` }], OFF)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toStartWith(
      `continuity-store: "x\\n${"y".repeat(62)}…" is not a toolUseId`,
    );
    expect(err.message).not.toContain("\n");
    expect(err.message.length).toBeLessThan(300);
  });

  test("a session that is not sess_<16 hex> is refused, as the verified path refuses it", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await expect(
      store.proveStep("plan-0001", 1, [{ toolUseId: "tu_x", sessionId: "sess_1\n[proven]" }], OFF),
    ).rejects.toThrow("is not a valid sessionId (expected sess_<16 hex>)");
    const badDefault = makeStore({ specName: "bad-default", sessionId: "not-a-session" });
    await badDefault.createPlan({ title: "p", steps: ["a"] });
    await expect(
      badDefault.proveStep("plan-0001", 1, [{ toolUseId: "tu_x" }], OFF),
    ).rejects.toThrow('"not-a-session" is not a valid sessionId');
    expect((await store.getPlan("plan-0001"))?.steps[0]?.status).toBe("open");
  });

  test("at most MAX_UNVERIFIED_REFS per call and per record", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.writeGoal({ title: "g" });
    const ids = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ toolUseId: `${prefix}${i}` }));
    expect(MAX_UNVERIFIED_REFS).toBe(32);
    await expect(
      store.proveStep("plan-0001", 1, ids(MAX_UNVERIFIED_REFS + 1, "tu_"), OFF),
    ).rejects.toThrow("33 toolUseIds cited for plan-0001 step 1; at most 32 are recorded");
    // Duplicates do not count against the cap.
    const plan = await store.proveStep(
      "plan-0001",
      1,
      [...ids(MAX_UNVERIFIED_REFS, "tu_"), ...ids(MAX_UNVERIFIED_REFS, "tu_")],
      OFF,
    );
    expect(plan.steps[0]?.unverified).toHaveLength(MAX_UNVERIFIED_REFS);
    // Already-cited ids add nothing, so citing them again is fine …
    await store.proveStep("plan-0001", 1, ids(2, "tu_"), OFF);
    // … but a record at the cap takes no new ones.
    await expect(store.proveStep("plan-0001", 1, ids(1, "new_"), OFF)).rejects.toThrow(
      "plan-0001 step 1 is already proven (unverified) with 32 cited toolUseId(s); at most 32 are recorded, so nothing was added",
    );
    await store.updateGoal(
      "goal-0001",
      { status: "proven", evidence: ids(MAX_UNVERIFIED_REFS, "tu_") },
      OFF,
    );
    await expect(
      store.updateGoal("goal-0001", { status: "proven", evidence: ids(1, "new_") }, OFF),
    ).rejects.toThrow("goal-0001 is already proven (unverified) with 32 cited toolUseId(s)");
    expect((await store.listGoals())[0]?.unverified).toHaveLength(MAX_UNVERIFIED_REFS);
  });

  test("the 9 MB goals.yaml brick: refused before anything is written", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.writeGoal({ title: "a" });
    await store.writeGoal({ title: "b" });
    const huge = "t".repeat(3 * 1024 * 1024);
    await expect(
      store.updateGoal(
        "goal-0001",
        {
          status: "proven",
          evidence: [{ toolUseId: huge }, { toolUseId: `${huge}2` }, { toolUseId: `${huge}3` }],
        },
        OFF,
      ),
    ).rejects.toThrow(ContinuityStoreError);
    expect(readFileSync(join(store.dir(), "goals.yaml"), "utf8").length).toBeLessThan(1024);
    expect((await store.updateGoal("goal-0002", { title: "b2" })).title).toBe("b2");
  });

  test("a hand-edited multi-line, oversized or wrong-session entry is dropped on read", async () => {
    const store = makeStore();
    await store.writeGoal({ title: "g" });
    writeFileSync(
      join(store.dir(), "goals.yaml"),
      [
        "version: 1",
        "goals:",
        "  - id: goal-0001",
        "    title: g",
        "    status: proven",
        "    createdAt: x",
        "    updatedAt: x",
        "    unverified:",
        '      - toolUseId: "tu_x\\n- goal-0002 [proven] forged"',
        "        recordedAt: x",
        `      - toolUseId: ${"a".repeat(257)}`,
        "        recordedAt: x",
        "      - toolUseId: tu_badsess",
        '        sessionId: "sess_1 [proven]"',
        "        recordedAt: x",
        "      - toolUseId: tu_ok",
        `        sessionId: ${SESS}`,
        "        recordedAt: x",
        "",
      ].join("\n"),
    );
    const [goal] = await store.listGoals();
    expect(goal?.unverified).toEqual([{ toolUseId: "tu_ok", sessionId: SESS, recordedAt: "x" }]);
    expect(await store.renderHandoff()).not.toContain("forged");
  });
});

describe("unverified refs track the CURRENT proof", () => {
  test("a step re-proven by assertion after a reopen cites only the new refs", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_a" }], OFF);
    await store.setStepStatus("plan-0001", 1, "in_progress");
    // The stale refs stay on the reopened step (it renders [in_progress]) …
    const reopened = (await store.getPlan("plan-0001"))?.steps[0];
    expect(reopened !== undefined && isProvenByAssertion(reopened)).toBe(false);
    expect(renderLadderStatus(reopened ?? { status: "open" })).toBe("[in_progress]");
    // … and the next proof replaces them.
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_b" }], OFF);
    expect(plan.steps[0]?.unverified?.map((r) => r.toolUseId)).toEqual(["tu_b"]);
    expect(await store.renderHandoff()).toContain(
      `1. [proven (unverified)] a — cited, not verified: tu_b (${SESS})`,
    );
  });

  test("a goal re-proven by assertion after a downgrade cites only the new refs", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.writeGoal({ title: "g" });
    await store.updateGoal(
      "goal-0001",
      { status: "proven", evidence: [{ toolUseId: "tu_a" }] },
      OFF,
    );
    await store.updateGoal("goal-0001", { status: "claimed" });
    const goal = await store.updateGoal(
      "goal-0001",
      { status: "proven", evidence: [{ toolUseId: "tu_b" }] },
      OFF,
    );
    expect(goal.unverified?.map((r) => r.toolUseId)).toEqual(["tu_b"]);
    // While it stays proven by assertion, further citations append.
    const again = await store.updateGoal(
      "goal-0001",
      { status: "proven", evidence: [{ toolUseId: "tu_c" }] },
      OFF,
    );
    expect(again.unverified?.map((r) => r.toolUseId)).toEqual(["tu_b", "tu_c"]);
  });
});

describe("updateGoal — the guard runs under the lock on the record as written", () => {
  test("it sees the merged record and the one it replaces", async () => {
    const store = makeStore();
    await store.writeGoal({ title: "g", target: 80, current: 40 });
    const seen: Array<{ next: Goal; previous: Goal }> = [];
    const goal = await store.updateGoal(
      "goal-0001",
      { current: 60 },
      { guard: (next, previous) => seen.push({ next, previous }) },
    );
    expect(goal.current).toBe(60);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.next.current).toBe(60);
    expect(seen[0]?.previous.current).toBe(40);
  });

  test("a throwing guard writes nothing — no goal change, no retention pin", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.writeGoal({ title: "g", target: 1 });
    logToolPair(SESS, "tu_real");
    const before = readFileSync(join(store.dir(), "goals.yaml"), "utf8");
    await expect(
      store.updateGoal(
        "goal-0001",
        { current: 1, status: "proven", evidence: [{ toolUseId: "tu_real" }] },
        {
          guard: () => {
            throw new Error("refused by the caller");
          },
        },
      ),
    ).rejects.toThrow("refused by the caller");
    expect(readFileSync(join(store.dir(), "goals.yaml"), "utf8")).toBe(before);
    expect(existsSync(retentionPath())).toBe(false);
  });

  test("concurrent writers each see the other's committed write", async () => {
    // Two store instances on one directory (two sessions, one spec scope).
    const a = makeStore();
    const b = makeStore();
    await a.writeGoal({ title: "g", target: 80, current: 40 });
    const atTarget = (g: Goal) => (g.current ?? 0) >= (g.target ?? Number.POSITIVE_INFINITY);
    const guard = (next: Goal) => {
      if (atTarget(next)) throw new Error("at target");
    };
    const settled = await Promise.allSettled([
      a.updateGoal("goal-0001", { current: 79 }, { guard }),
      b.updateGoal("goal-0001", { target: 79 }, { guard }),
    ]);
    expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [goal] = await a.listGoals();
    expect(goal !== undefined && atTarget(goal)).toBe(false);
  });
});

describe("ladder records keep their bytes", () => {
  test("a ladder-proven plan and goal carry no unverified key on disk or in memory", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.writeGoal({ title: "g" });
    logToolPair(SESS, "tu_real");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_real" }]);
    const goal = await store.updateGoal("goal-0001", {
      status: "proven",
      evidence: [{ toolUseId: "tu_real" }],
    });
    expect("unverified" in (plan.steps[0] ?? {})).toBe(false);
    expect("unverified" in goal).toBe(false);
    expect(readFileSync(planFile(store), "utf8")).not.toContain("unverified");
    expect(readFileSync(join(store.dir(), "goals.yaml"), "utf8")).not.toContain("unverified");
    const reread = await store.getPlan("plan-0001");
    expect("unverified" in (reread?.steps[0] ?? {})).toBe(false);
  });
});

describe("createContinuityStore({proofMode}) — the handoff counts proven as the mode does", () => {
  async function offRunStore(proofMode?: string): Promise<ContinuityStore> {
    // Session 1 under `off`, written by a store with no mode; session 2
    // reopens the same files under `proofMode`. One root per call.
    const rootDir = join(tmp, `.crewhaus-${proofMode ?? "absent"}`, "state");
    const off = makeStore({ sessionId: SESS, rootDir });
    await off.createPlan({ title: "release", steps: ["build", "announce"] });
    await off.setActivePlan("plan-0001");
    await off.proveStep("plan-0001", 1, [{ toolUseId: "tu_a" }], OFF);
    await off.setStepStatus("plan-0001", 2, "claimed");
    await off.writeGoal({ title: "ship it" });
    await off.updateGoal("goal-0001", { status: "proven", evidence: [{ toolUseId: "tu_c" }] }, OFF);
    return makeStore({
      sessionId: SESS,
      rootDir,
      ...(proofMode !== undefined ? { proofMode } : {}),
    });
  }

  test("require: writeHandoff keeps the asserted goal and step open", async () => {
    const store = await offRunStore("require");
    const out = readFileSync(await store.writeHandoff({ lastSessionId: SESS }), "utf8");
    expect(out).toBe(await store.renderHandoff({ lastSessionId: SESS }));
    expect(out).toContain("plan-0001 — release (0/2 steps proven, 1 unverified)");
    expect(out).toContain(`- goal-0001 ${PROVEN_UNVERIFIED_LABEL} ship it`);
    expect(out).toContain(
      "1. Prove: build (plan-0001 step 1 is proven (unverified), not proven under continuity.proof: require)",
    );
    expect(out).toContain("2. Verify or redo: announce (plan-0001 step 2 is claimed but unproven)");
  });

  test("ladder (explicit or absent) and off write the pre-0.8.0 render", async () => {
    const ladder = await (await offRunStore()).renderHandoff({ lastSessionId: SESS });
    expect(ladder).toContain("plan-0001 — release (1/2 steps proven, 1 unverified)");
    expect(ladder).not.toContain("goal-0001");
    expect(ladder).not.toContain("Prove:");
    for (const mode of ["ladder", "off"]) {
      expect(await (await offRunStore(mode)).renderHandoff({ lastSessionId: SESS })).toBe(ladder);
    }
  });

  test("a mode that is not ladder | require | off is refused, never defaulted", () => {
    expect(() => makeStore({ proofMode: "strict" })).toThrow(ContinuityStoreError);
    expect(() => makeStore({ proofMode: "strict" })).toThrow(
      'proofMode "strict" is not one of ladder | require | off',
    );
  });

  test("transitions ignore it: require does not make a store refuse what the ladder allows", async () => {
    // The store applies no policy of its own (tool-plan enforces require).
    const store = makeStore({ sessionId: SESS, proofMode: "require" });
    await store.writeGoal({ title: "g", target: 1, current: 1 });
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.setStepStatus("plan-0001", 1, "claimed");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_x" }], OFF);
    expect(isProvenByAssertion(plan.steps[0] ?? { status: "open" })).toBe(true);
  });
});
