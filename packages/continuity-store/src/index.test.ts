/**
 * Store round-trips (focus cap + marker gating, plan frontmatter, goals.yaml),
 * REQ ledger verbatim + attribution, proof ladder through the store surface,
 * trash/restore, tenant fencing (fail-closed), and session-vs-spec scoping.
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
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import {
  type ContinuityStore,
  ContinuityStoreError,
  FOCUS_MARKER,
  REQUIREMENTS_LEDGER_MAX_BYTES,
  createContinuityStore,
} from "./index";

let tmp: string; // harness root; .crewhaus lives under it

const SESS = "sess_0123456789abcdef";
const fixedNow = (): Date => new Date("2026-07-13T12:00:00.000Z");

function makeStore(overrides: Record<string, unknown> = {}): ContinuityStore {
  return createContinuityStore({
    specName: "support-bot",
    rootDir: join(tmp, ".crewhaus", "state"),
    now: fixedNow,
    ...overrides,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "continuity-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createContinuityStore — validation", () => {
  test("rejects an empty or traversal-shaped specName", () => {
    expect(() => createContinuityStore({ specName: "" })).toThrow(ContinuityStoreError);
    expect(() => createContinuityStore({ specName: "a/b" })).toThrow(ContinuityStoreError);
    expect(() => createContinuityStore({ specName: ".." })).toThrow(ContinuityStoreError);
  });

  test("rejects a malformed session-scope sessionId", () => {
    expect(() =>
      createContinuityStore({
        specName: "s",
        scope: { kind: "session", sessionId: "../../evil" },
      }),
    ).toThrow(ContinuityStoreError);
  });
});

describe("focus.md — round-trip, cap, marker gating", () => {
  test("write → read round-trips the body and stamps the marker", async () => {
    const store = makeStore();
    await store.writeFocus("Ship CSV export");
    const focus = await store.readFocus();
    expect(focus?.body).toBe("Ship CSV export");
    const raw = readFileSync(join(store.dir(), "focus.md"), "utf8");
    expect(raw.startsWith(FOCUS_MARKER)).toBe(true);
  });

  test("readFocus is null before any write", async () => {
    expect(await makeStore().readFocus()).toBeNull();
  });

  test("enforces focusMaxChars with an instructive error", async () => {
    const store = makeStore({ focusMaxChars: 32 });
    await expect(store.writeFocus("x".repeat(33))).rejects.toThrow(/cap is 32/);
    await store.writeFocus("x".repeat(32)); // exactly at the cap is fine
  });

  test("refuses to overwrite a user-authored focus.md (no marker)", async () => {
    const store = makeStore();
    mkdirSync(store.dir(), { recursive: true });
    writeFileSync(join(store.dir(), "focus.md"), "# My own notes\n");
    await expect(store.writeFocus("new focus")).rejects.toThrow(/refusing to overwrite/);
    // And reads treat it as not crewhaus-managed.
    expect(await store.readFocus()).toBeNull();
    expect(readFileSync(join(store.dir(), "focus.md"), "utf8")).toBe("# My own notes\n");
  });

  test("writeFocus preserves the requirements ledger and active plan pointer", async () => {
    const store = makeStore();
    await store.appendRequirement({
      text: "export must be RFC-4180 CSV",
      source: { sessionId: SESS, turn: 1 },
      status: "open",
    });
    await store.createPlan({ title: "Ship CSV export" });
    await store.writeFocus("new focus body");
    const focus = await store.readFocus();
    expect(focus?.body).toBe("new focus body");
    expect(focus?.activePlanId).toBe("plan-0001");
    expect(focus?.requirements.length).toBe(1);
  });
});

describe("requirements ledger — verbatim + attribution", () => {
  test("appends REQ-nnn entries verbatim with (user, sess, turn) attribution", async () => {
    const store = makeStore();
    const req = await store.appendRequirement({
      text: 'use "Tab" as the delimiter\nand quote everything',
      source: { sessionId: SESS, turn: 3 },
    });
    expect(req.id).toBe("REQ-001");
    expect(req.status).toBe("open");
    const listed = await store.listRequirements();
    expect(listed.length).toBe(1);
    expect(listed[0]?.text).toBe('use "Tab" as the delimiter\nand quote everything'); // verbatim
    expect(listed[0]?.source).toEqual({ sessionId: SESS, turn: 3 });
    const second = await store.appendRequirement({
      text: "second requirement",
      source: { sessionId: SESS, turn: 4 },
    });
    expect(second.id).toBe("REQ-002");
  });

  test("updating an id requires the text to match verbatim (no paraphrase)", async () => {
    const store = makeStore();
    await store.appendRequirement({ text: "exact words", source: { sessionId: SESS, turn: 1 } });
    const updated = await store.appendRequirement({
      id: "REQ-001",
      text: "exact words",
      source: { sessionId: SESS, turn: 2 },
      status: "confirmed",
    });
    expect(updated.status).toBe("confirmed");
    expect(updated.source.turn).toBe(1); // original attribution kept
    await expect(
      store.appendRequirement({
        id: "REQ-001",
        text: "roughly those words",
        source: { sessionId: SESS, turn: 2 },
        status: "confirmed",
      }),
    ).rejects.toThrow(/verbatim/);
  });

  test("caps the ledger with oldest-first eviction and a truncation marker", async () => {
    const store = makeStore();
    const bigText = "y".repeat(4000);
    const perEntry = bigText.length + 80;
    const count = Math.ceil(REQUIREMENTS_LEDGER_MAX_BYTES / perEntry) + 2;
    for (let i = 0; i < count; i++) {
      await store.appendRequirement({
        text: `${bigText}-${i}`,
        source: { sessionId: SESS, turn: i },
      });
    }
    const focus = await store.readFocus();
    expect(focus?.ledgerTruncated).toBe(true);
    expect(focus?.requirements.length).toBeLessThan(count);
    // Newest survives, oldest evicted.
    expect(focus?.requirements.at(-1)?.text.endsWith(`-${count - 1}`)).toBe(true);
    expect(focus?.requirements[0]?.text.endsWith("-0")).toBe(false);
    expect(readFileSync(join(store.dir(), "focus.md"), "utf8")).toContain("[ledger truncated]");
  });

  test("validates source.sessionId and explicit ids", async () => {
    const store = makeStore();
    await expect(
      store.appendRequirement({ text: "x", source: { sessionId: "nope", turn: 1 } }),
    ).rejects.toThrow(/sessionId/);
    await expect(
      store.appendRequirement({ id: "REQ-x", text: "x", source: { sessionId: SESS, turn: 1 } }),
    ).rejects.toThrow(/REQ-nnn/);
  });
});

describe("plans — frontmatter round-trip + ladder", () => {
  test("createPlan writes plan-NNNN-<slug>.md with YAML frontmatter + numbered steps", async () => {
    const store = makeStore();
    const plan = await store.createPlan({
      title: "Ship CSV export!",
      steps: ["Parse the CSV", "Write the exporter"],
    });
    expect(plan.id).toBe("plan-0001");
    expect(plan.slug).toBe("ship-csv-export");
    const path = join(store.dir(), "plans", "plan-0001-ship-csv-export.md");
    const raw = readFileSync(path, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("id: plan-0001");
    expect(raw).toContain("title: Ship CSV export!");
    expect(raw).toContain("1. [open] Parse the CSV");
    expect(raw).toContain("2. [open] Write the exporter");

    const roundTrip = await store.getPlan("plan-0001");
    expect(roundTrip?.title).toBe("Ship CSV export!");
    expect(roundTrip?.createdAt).toBe("2026-07-13T12:00:00.000Z");
    expect(roundTrip?.steps.map((s) => s.text)).toEqual(["Parse the CSV", "Write the exporter"]);
  });

  test("first plan becomes the active plan; set_active/getActivePlan work", async () => {
    const store = makeStore();
    await store.createPlan({ title: "one" });
    await store.createPlan({ title: "two" });
    expect((await store.getActivePlan())?.id).toBe("plan-0001");
    await store.setActivePlan("plan-0002");
    expect((await store.getActivePlan())?.id).toBe("plan-0002");
    await expect(store.setActivePlan("plan-0099")).rejects.toThrow(/no plan/);
  });

  test("addStep + setStepStatus round-trip (claimed is free — no evidence)", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await store.addStep("plan-0001", "b\nwith newline collapsed");
    const claimed = await store.setStepStatus("plan-0001", 2, "claimed");
    expect(claimed.steps[1]?.text).toBe("b with newline collapsed");
    expect(claimed.steps[1]?.status).toBe("claimed");
    expect(claimed.steps[1]?.proofs).toEqual([]);
  });

  test("setStepStatus rejects unknown steps and plans instructively", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await expect(store.setStepStatus("plan-0001", 9, "claimed")).rejects.toThrow(/no step 9/);
    await expect(store.setStepStatus("plan-0044", 1, "claimed")).rejects.toThrow(/no plan/);
  });
});

describe("proof ladder — proven via the store", () => {
  function logToolPair(sessionId: string, toolUseId: string, isError = false): void {
    const dir = join(tmp, ".crewhaus", "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    appendFileSync(
      path,
      `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: toolUseId, name: "Bash", input: { cmd: "bun test" } } })}\n` +
        `${JSON.stringify({ ts: 2, version: 1, kind: "tool_result", payload: { toolUseId, content: "42 pass", isError } })}\n`,
    );
  }

  test("proveStep verifies, freezes the proof excerpt, and pins the session", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["run the tests"] });
    logToolPair(SESS, "tu_abc");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_abc", sessionId: SESS }]);
    expect(plan.steps[0]?.status).toBe("proven");
    const proof = plan.steps[0]?.proofs[0];
    expect(proof?.toolName).toBe("Bash");
    expect(proof?.inputHash).toMatch(/^sha256:/);
    expect(proof?.resultDigest).toBe("42 pass");

    // The excerpt survives a re-read from disk (frozen into frontmatter).
    const reread = await store.getPlan("plan-0001");
    expect(reread?.steps[0]?.proofs[0]?.resultDigest).toBe("42 pass");

    // Retention pin written for the cited session.
    const retention = JSON.parse(
      readFileSync(join(tmp, ".crewhaus", "retention.json"), "utf8"),
    ) as { pins: string[] };
    expect(retention.pins).toEqual([SESS]);
  });

  test("proveStep rejects missing evidence with the design's error text", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    await expect(
      store.proveStep("plan-0001", 1, [{ toolUseId: "tu_ghost", sessionId: SESS }]),
    ).rejects.toThrow(
      "no verified evidence for tu_ghost: run the action first, then complete the step with its toolUseId.",
    );
    expect((await store.getPlan("plan-0001"))?.steps[0]?.status).toBe("open");
  });

  test("proveStep rejects isError evidence and leaves the step unproven", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    logToolPair(SESS, "tu_fail", true);
    await expect(
      store.proveStep("plan-0001", 1, [{ toolUseId: "tu_fail", sessionId: SESS }]),
    ).rejects.toThrow(/isError: true/);
    expect((await store.getPlan("plan-0001"))?.steps[0]?.status).toBe("open");
  });

  test("store-level default sessionId resolves refs without one", async () => {
    const store = makeStore({ sessionId: SESS });
    await store.createPlan({ title: "p", steps: ["a"] });
    logToolPair(SESS, "tu_default");
    const plan = await store.proveStep("plan-0001", 1, [{ toolUseId: "tu_default" }]);
    expect(plan.steps[0]?.proofs[0]?.sessionId).toBe(SESS);
  });
});

describe("goals.yaml — round-trip + proven gate", () => {
  test("writeGoal/listGoals/updateGoal round-trip through YAML", async () => {
    const store = makeStore();
    const goal = await store.writeGoal({ title: "coverage", target: 80, current: 40, unit: "%" });
    expect(goal.id).toBe("goal-0001");
    const raw = readFileSync(join(store.dir(), "goals.yaml"), "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain("title: coverage");
    const updated = await store.updateGoal("goal-0001", { current: 55, status: "claimed" });
    expect(updated.current).toBe(55);
    expect(updated.status).toBe("claimed");
    expect((await store.listGoals())[0]?.current).toBe(55);
  });

  test("goal proven requires evidence (claimed never does)", async () => {
    const store = makeStore();
    await store.writeGoal({ title: "g" });
    await expect(store.updateGoal("goal-0001", { status: "proven" })).rejects.toThrow(
      /requires evidence/,
    );
    const dir = join(tmp, ".crewhaus", "sessions");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${SESS}.jsonl`),
      `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: "tu_g", name: "Fetch", input: {} } })}\n` +
        `${JSON.stringify({ ts: 2, version: 1, kind: "tool_result", payload: { toolUseId: "tu_g", content: "done", isError: false } })}\n`,
    );
    const proven = await store.updateGoal("goal-0001", {
      status: "proven",
      evidence: [{ toolUseId: "tu_g", sessionId: SESS }],
    });
    expect(proven.status).toBe("proven");
    expect(proven.proofs?.[0]?.toolUseId).toBe("tu_g");
  });
});

describe("clear/restore — trash round-trip via the store", () => {
  test("clear('plans') moves the plans dir to trash and restore brings it back", async () => {
    const store = makeStore();
    await store.createPlan({ title: "p", steps: ["a"] });
    const result = await store.clear("plans");
    expect(result.moved).toEqual(["state/support-bot/plans"]);
    expect(existsSync(join(store.dir(), "plans"))).toBe(false);
    expect(result.trashDir).toContain(join(tmp, ".crewhaus", "trash"));

    const snapshots = await store.listTrash();
    expect(snapshots.length).toBe(1);

    await store.restore(result.ts);
    expect((await store.getPlan("plan-0001"))?.title).toBe("p");
    expect(await store.listTrash()).toEqual([]);
  });

  test("clear('all') trashes focus, plans, goals, and handoff", async () => {
    const store = makeStore();
    await store.writeFocus("f");
    await store.createPlan({ title: "p" });
    await store.writeGoal({ title: "g" });
    await store.writeHandoff({ lastSessionId: SESS });
    const result = await store.clear("all");
    expect(result.moved.sort()).toEqual([
      "state/support-bot/focus.md",
      "state/support-bot/goals.yaml",
      "state/support-bot/handoff.md",
      "state/support-bot/plans",
    ]);
  });
});

describe("scoping — session vs spec isolation", () => {
  test("session scope nests under sessions/<id> and never collides with spec scope", async () => {
    const specStore = makeStore();
    const sessionStore = makeStore({ scope: { kind: "session", sessionId: SESS } });
    expect(sessionStore.dir()).toBe(
      join(tmp, ".crewhaus", "state", "support-bot", "sessions", SESS),
    );
    await specStore.writeFocus("spec-wide agenda");
    await sessionStore.writeFocus("this conversation");
    expect((await specStore.readFocus())?.body).toBe("spec-wide agenda");
    expect((await sessionStore.readFocus())?.body).toBe("this conversation");
    await sessionStore.createPlan({ title: "session plan" });
    expect(await specStore.listPlans()).toEqual([]);
  });

  test("two session scopes are isolated from each other", async () => {
    const a = makeStore({ scope: { kind: "session", sessionId: "sess_aaaaaaaaaaaaaaaa" } });
    const b = makeStore({ scope: { kind: "session", sessionId: "sess_bbbbbbbbbbbbbbbb" } });
    await a.writeFocus("thread A");
    expect(await b.readFocus()).toBeNull();
  });
});

describe("tenant fencing — fail closed (CWE-1230)", () => {
  test("with an ambient tenant, a store rooted outside the tenant root throws", () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    expect(() =>
      withTenant(tenant, () =>
        createContinuityStore({ specName: "s", rootDir: join(tmp, "elsewhere", "state") }),
      ),
    ).toThrow(TenancyError);
  });

  test("with an ambient tenant, the default root lands inside the tenant and works", async () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    await withTenant(tenant, async () => {
      const store = createContinuityStore({ specName: "s", now: fixedNow });
      expect(store.dir()).toBe(join(tmp, "tenants", "acme", "state", "s"));
      await store.writeFocus("tenant focus");
      expect((await store.readFocus())?.body).toBe("tenant focus");
    });
    // The write really landed under the tenant root.
    expect(existsSync(join(tmp, "tenants", "acme", "state", "s", "focus.md"))).toBe(true);
  });

  test("an explicit tenant option fences even without ambient context", () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    expect(() =>
      createContinuityStore({
        specName: "s",
        tenant,
        rootDir: join(tmp, "outside", "state"),
      }),
    ).toThrow(TenancyError);
  });

  test("ambient tenant fences per-operation on a store built outside the scope", async () => {
    // Built WITHOUT a tenant (paths under the plain .crewhaus root)…
    const store = makeStore();
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    // …then used inside a tenant scope: every path is now out of fence.
    await expect(withTenant(tenant, () => store.writeFocus("x"))).rejects.toThrow(TenancyError);
    await expect(withTenant(tenant, () => store.listRequirements())).rejects.toThrow(TenancyError);
  });
});

describe("handoff (store surface)", () => {
  test("writeHandoff renders deterministically and refuses unmanaged files", async () => {
    const store = makeStore();
    await store.writeFocus("Ship it");
    const path = await store.writeHandoff({ lastSessionId: SESS });
    const first = readFileSync(path, "utf8");
    await store.writeHandoff({ lastSessionId: SESS });
    expect(readFileSync(path, "utf8")).toBe(first);

    writeFileSync(path, "hand-written notes");
    await expect(store.writeHandoff({ lastSessionId: SESS })).rejects.toThrow(
      /refusing to overwrite/,
    );
  });
});
