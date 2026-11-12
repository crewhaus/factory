/**
 * The guarded clear, the store's own file list, and the proof recheck the
 * doors that act use under `continuity.proof: require`: a frozen proof counts
 * only while the session log it was read from still says the same thing.
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
import YAML from "yaml";
import {
  ContinuityClearConflictError,
  type ContinuityStore,
  type FrozenProof,
  type HandoffInput,
  type PlanRecord,
  countsAsProvenChecked,
  createContinuityStore,
  renderHandoff,
  stepRecheckKey,
} from "./index";

let tmp: string;
const SESS = "sess_0123456789abcdef";
const OTHER = "sess_fedcba9876543210";
const fixedNow = (): Date => new Date("2026-07-13T12:00:00.000Z");

function makeStore(overrides: Record<string, unknown> = {}): ContinuityStore {
  return createContinuityStore({
    specName: "support-bot",
    rootDir: join(tmp, ".crewhaus", "state"),
    now: fixedNow,
    ...overrides,
  });
}

function logToolPair(sessionId: string, toolUseId: string, input: unknown = { cmd: "bun test" }) {
  const dir = join(tmp, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: toolUseId, name: "Bash", input } })}\n` +
      `${JSON.stringify({ ts: 2, version: 1, kind: "tool_result", payload: { toolUseId, content: "42 pass", isError: false } })}\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "continuity-recheck-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("planClear + clear({expectFingerprint})", () => {
  test("lists files relative to .crewhaus, recursive under plans/, sorted", async () => {
    const store = makeStore();
    await store.writeFocus("ship it");
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.writeGoal({ title: "g" });
    const plan = await store.planClear("all");
    expect(plan.entries.map((e) => e.path)).toEqual([
      "state/support-bot/focus.md",
      "state/support-bot/goals.yaml",
      "state/support-bot/plans/plan-0001-p.md",
    ]);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.planClear("goals")).entries.map((e) => e.path)).toEqual([
      "state/support-bot/goals.yaml",
    ]);
  });

  test("a stale fingerprint moves nothing", async () => {
    const store = makeStore();
    await store.writeFocus("ship it");
    await store.createPlan({ title: "p", steps: ["a"] });
    const planned = await store.planClear("all");
    // A file arrives between the dry run and the clear.
    await store.createPlan({ title: "q", steps: ["b"] });
    const err = await store
      .clear("all", { expectFingerprint: planned.fingerprint })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContinuityClearConflictError);
    for (const rel of ["focus.md", "plans/plan-0001-p.md", "plans/plan-0002-q.md"]) {
      expect(existsSync(join(store.dir(), rel))).toBe(true);
    }
    expect(await store.listTrash()).toEqual([]);
  });

  test("a current fingerprint clears, and clear(scope) alone is unchanged", async () => {
    const store = makeStore();
    await store.writeFocus("ship it");
    const planned = await store.planClear("focus");
    const moved = await store.clear("focus", { expectFingerprint: planned.fingerprint });
    expect(moved.moved).toHaveLength(1);
    expect(existsSync(join(store.dir(), "focus.md"))).toBe(false);
    await store.writeGoal({ title: "g" });
    await store.clear("goals");
    expect(existsSync(join(store.dir(), "goals.yaml"))).toBe(false);
  });
});

describe("storeFiles + listScopes", () => {
  test("storeFiles names the spec scope even from a session-scoped store", () => {
    const store = makeStore({ scope: { kind: "session", sessionId: SESS } });
    const spec = join(tmp, ".crewhaus", "state", "support-bot");
    expect(store.dir()).toBe(join(spec, "sessions", SESS));
    expect(store.storeFiles()).toEqual(
      [
        "focus.md",
        "goals.yaml",
        "plans",
        "handoff.md",
        "sessions",
        "thredz-goals.json",
        ".lock",
      ].map((n) => join(spec, n)),
    );
  });

  test("listScopes reads <spec>/sessions/", async () => {
    await makeStore({ scope: { kind: "session", sessionId: OTHER } }).writeFocus("b");
    await makeStore({ scope: { kind: "session", sessionId: SESS } }).writeFocus("a");
    mkdirSync(join(tmp, ".crewhaus", "state", "support-bot", "sessions", "not-a-session"));
    expect(await makeStore().listScopes()).toEqual({ spec: true, sessions: [SESS, OTHER].sort() });
  });
});

describe("recheckProofs", () => {
  async function provenStep(store: ContinuityStore, toolUseId: string): Promise<FrozenProof> {
    await store.createPlan({ title: "p", steps: ["run the tests"] });
    logToolPair(SESS, toolUseId);
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId, sessionId: SESS }]);
    return plan.steps[0]?.proofs[0] as FrozenProof;
  }

  test("a proof frozen from a real session log passes", async () => {
    const store = makeStore();
    const proof = await provenStep(store, "tu_real");
    expect(await store.recheckProofs({ proofs: [proof] })).toEqual({ ok: true });
  });

  test("a hand-written proof whose tool use id is in no log is missing", async () => {
    const store = makeStore();
    const forged: FrozenProof = {
      toolUseId: "tu_made_up",
      sessionId: SESS,
      toolName: "Bash",
      inputHash: "sha256:00",
      resultDigest: "42 pass",
      verifiedAt: "2026-07-13T00:00:00.000Z",
    };
    expect(await store.recheckProofs({ proofs: [forged] })).toEqual({
      ok: false,
      toolUseId: "tu_made_up",
      why: "missing",
    });
  });

  test("a changed input hash is changed", async () => {
    const store = makeStore();
    const proof = await provenStep(store, "tu_hash");
    expect(await store.recheckProofs({ proofs: [{ ...proof, inputHash: "sha256:ff" }] })).toEqual({
      ok: false,
      toolUseId: "tu_hash",
      why: "changed",
    });
    expect(
      (await store.recheckProofs({ proofs: [{ ...proof, resultDigest: "all green" }] })).ok,
    ).toBe(false);
  });

  test("a log that cannot be read is unreadable, never ok", async () => {
    const store = makeStore();
    const proof = await provenStep(store, "tu_torn");
    // Tear the log before the proof's lines.
    const path = join(tmp, ".crewhaus", "sessions", `${SESS}.jsonl`);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, `{"ts":0,"kind":"tool_us\n${text}`);
    expect(await store.recheckProofs({ proofs: [proof] })).toEqual({
      ok: false,
      toolUseId: "tu_torn",
      why: "unreadable",
    });
  });

  test("a record with no proofs is missing", async () => {
    expect(await makeStore().recheckProofs({ proofs: [] })).toEqual({ ok: false, why: "missing" });
    expect(await makeStore().recheckProofs({})).toEqual({ ok: false, why: "missing" });
  });

  test("countsAsProvenChecked consults the recheck only under require", () => {
    const record = { status: "proven", proofs: [{} as FrozenProof] };
    const failed = { ok: false as const, why: "missing" as const };
    expect(countsAsProvenChecked(record, "require", failed)).toBe(false);
    expect(countsAsProvenChecked(record, "require", { ok: true })).toBe(true);
    expect(countsAsProvenChecked(record, "ladder", failed)).toBe(true);
    expect(countsAsProvenChecked(record, "off", failed)).toBe(true);
  });
});

describe("the handoff under require", () => {
  test("lists a hand-proved goal as open, and a genuinely proven one as done", async () => {
    const store = makeStore({ proofMode: "require" });
    logToolPair(SESS, "tu_good");
    const real = await store.writeGoal({ title: "Real goal", target: 1 });
    await store.updateGoal(
      real.id,
      { current: 1, status: "proven", evidence: [{ toolUseId: "tu_good", sessionId: SESS }] },
      {},
    );
    // A second goal written into goals.yaml by hand, with a made-up proof.
    const path = join(store.dir(), "goals.yaml");
    const doc = YAML.parse(readFileSync(path, "utf8")) as { goals: unknown[] };
    doc.goals.push({
      id: "goal-0002",
      title: "Hand-proved goal",
      status: "proven",
      target: 1,
      current: 1,
      proofs: [
        {
          toolUseId: "tu_forged",
          sessionId: SESS,
          toolName: "Bash",
          inputHash: "sha256:00",
          resultDigest: "done",
          verifiedAt: "2026-07-13T00:00:00.000Z",
        },
      ],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    writeFileSync(path, YAML.stringify(doc));
    const out = await store.renderHandoff();
    const goals = out.slice(out.indexOf("## Goals"), out.indexOf("## Unresolved"));
    expect(goals).toContain("goal-0002");
    expect(goals).not.toContain("goal-0001");
    // The ladder render of the same files lists neither.
    const ladder = await makeStore().renderHandoff();
    const ladderGoals = ladder.slice(ladder.indexOf("## Goals"), ladder.indexOf("## Unresolved"));
    expect(ladderGoals).not.toContain("goal-0002");
  });
});

describe("renderHandoff with recheck failures", () => {
  const proof: FrozenProof = {
    toolUseId: "tu_abc",
    sessionId: SESS,
    toolName: "Bash",
    inputHash: "sha256:00",
    resultDigest: "42 pass",
    verifiedAt: "2026-07-13T00:00:00.000Z",
  };
  const plan: PlanRecord = {
    id: "plan-0001",
    slug: "ship-csv-export",
    title: "Ship CSV export",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
    steps: [
      { index: 1, text: "Parse the CSV", status: "proven", proofs: [proof] },
      { index: 2, text: "Write the exporter", status: "claimed", proofs: [] },
      { index: 3, text: "Add tests", status: "open", proofs: [] },
    ],
  };
  const done: PlanRecord = {
    id: "plan-0003",
    slug: "done",
    title: "Done plan",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    steps: [{ index: 1, text: "Ship it", status: "proven", proofs: [proof] }],
  };
  const input: HandoffInput = {
    focusBody: "Ship CSV export",
    activePlan: plan,
    plans: [plan, done],
    goals: [
      {
        id: "goal-0001",
        title: "Increase coverage",
        status: "claimed",
        target: 80,
        current: 40,
        unit: "%",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
      {
        id: "goal-0002",
        title: "Hand-proved goal",
        status: "proven",
        target: 1,
        current: 1,
        proofs: [proof],
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    ],
    requirements: [],
    lastSessionId: SESS,
  };
  const recheckFailed = {
    steps: new Set([stepRecheckKey("plan-0001", 1), stepRecheckKey("plan-0003", 1)]),
    goals: new Set(["goal-0002"]),
  };

  /** renderHandoff of `input` on main, before the recheck existed (ladder and off alike). */
  const PINNED_FROM_MAIN =
    "<!-- crewhaus:handoff -->\n# Handoff\n\n## Focus\n\nShip CSV export\n\n## Active plan\n\nplan-0001 — Ship CSV export (1/3 steps proven)\n\n1. [proven] Parse the CSV — proof: tu_abc (sess_0123456789abcdef)\n2. [claimed — unverified] Write the exporter\n3. [open] Add tests\n\n## Goals\n\n- goal-0001 [claimed — unverified] Increase coverage (40/80 %)\n\n## Unresolved requirements\n\n_none_\n\n## Next actions\n\n1. Verify or redo: Write the exporter (plan-0001 step 2 is claimed but unproven)\n2. Do: Add tests (plan-0001 step 3)\n\n## Last session\n\nsess_0123456789abcdef\n";

  test("ladder and off renders are byte-identical to main's, failures or not", () => {
    for (const proofMode of ["ladder", "off"] as const) {
      expect(renderHandoff({ ...input, proofMode })).toBe(PINNED_FROM_MAIN);
      expect(renderHandoff({ ...input, proofMode, recheckFailed })).toBe(PINNED_FROM_MAIN);
    }
  });

  test("under require a failed recheck keeps the step and goal open", () => {
    const out = renderHandoff({ ...input, proofMode: "require", recheckFailed });
    expect(out).toContain("plan-0001 — Ship CSV export (0/3 steps proven)");
    expect(out).toContain("- plan-0003 — Done plan (0/1 steps proven)");
    expect(out).toContain("- goal-0002 [proven] Hand-proved goal (1/1)");
    expect(out).toContain(
      "Prove: Parse the CSV (plan-0001 step 1 is marked proven with a proof the session log does not match, not proven under continuity.proof: require)",
    );
    // Without failures, require reads as the ladder does for verified records.
    const clean = renderHandoff({ ...input, proofMode: "require" });
    expect(clean).not.toContain("goal-0002");
    expect(clean).toContain("(1/3 steps proven)");
  });
});
