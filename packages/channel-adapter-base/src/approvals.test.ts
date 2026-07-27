import { describe, expect, test } from "bun:test";
import {
  type ApprovalDecision,
  type ApprovalStore,
  InMemoryApprovalStore,
  type NewPendingApproval,
  type PendingApproval,
  type RuntimeApprovalRecord,
  approvalFallbackText,
  createApprovalPrompter,
  createRuntimeBackedApprovalStore,
  postApprovalPrompt,
  previewApprovalInput,
  resolveApproval,
} from "./index";

/** Deterministic id generator: appr_1, appr_2, … */
function seqIds(): () => string {
  let n = 0;
  return () => `appr_${++n}`;
}

/** Yield to the macrotask queue so an awaiting prompter reaches its `waitFor`. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("InMemoryApprovalStore", () => {
  test("put mints an id + createdAt and starts pending", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds(), now: () => 0 });
    const p = await store.put({
      toolName: "bash",
      inputPreview: "{}",
      surface: "daemon",
      sessionId: "s1",
    });
    expect(p.id).toBe("appr_1");
    expect(p.status).toBe("pending");
    expect(p.createdAt).toBe(new Date(0).toISOString());
    expect(await store.get("appr_1")).toEqual(p);
    expect(await store.get("nope")).toBeNull();
  });

  test("resolve transitions once, then is an idempotent no-op returning null", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const p = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    const first = await store.resolve(p.id, "grant", "cli");
    expect(first?.status).toBe("grant");
    expect(first?.decidedBy).toBe("cli");
    // Second resolve is a no-op: null, and the recorded decision is unchanged.
    expect(await store.resolve(p.id, "deny", "attacker")).toBeNull();
    expect((await store.get(p.id))?.status).toBe("grant");
    expect(await store.resolve("unknown", "grant", "x")).toBeNull();
  });

  test("list filters by status and sessionId, newest first", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const a = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    const b = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s2" });
    const c = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    await store.resolve(a.id, "grant", "cli");
    expect((await store.list()).length).toBe(3);
    // Newest first; a (appr_1) is resolved, so b + c remain pending.
    expect((await store.list({ status: "pending" })).map((p) => p.id)).toEqual([c.id, b.id]);
    expect((await store.list({ sessionId: "s1" })).map((p) => p.id)).toEqual([c.id, a.id]);
    expect((await store.list({ status: "pending", sessionId: "s1" })).map((p) => p.id)).toEqual([
      c.id,
    ]);
  });

  test("waitFor settles immediately for an already-resolved id and rejects an unknown one", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const p = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    await store.resolve(p.id, "deny", "cli");
    expect(await store.waitFor(p.id)).toBe("deny");
    await expect(store.waitFor("unknown")).rejects.toThrow(/unknown approval/);
  });

  test("capacity eviction drops resolved records but never pending ones", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds(), capacity: 2 });
    const a = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    const b = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    await store.resolve(a.id, "grant", "cli"); // a resolved
    await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" }); // overflow → evict a
    expect(await store.get(a.id)).toBeNull();
    expect(await store.get(b.id)).not.toBeNull(); // pending survives
  });
});

describe("postApprovalPrompt", () => {
  const pending: PendingApproval = {
    id: "appr_1",
    toolName: "bash",
    inputPreview: "{}",
    surface: "daemon",
    sessionId: "s1",
    status: "pending",
    createdAt: new Date(0).toISOString(),
  };

  test("interactive path renders buttons and returns the message ts", async () => {
    let sent = "";
    const res = await postApprovalPrompt({
      pending,
      sendText: async (t) => {
        sent = t;
      },
      postInteractive: async (a) => {
        expect(a.approvalId).toBe("appr_1");
        return { messageTs: "9.9" };
      },
    });
    expect(res).toEqual({ interactive: true, messageTs: "9.9" });
    expect(sent).toBe(""); // no text fallback when interactive
  });

  test("text fallback fires the crewhaus approvals grant hint", async () => {
    let sent = "";
    const res = await postApprovalPrompt({
      pending,
      sendText: async (t) => {
        sent = t;
      },
    });
    expect(res).toEqual({ interactive: false });
    expect(sent).toBe(approvalFallbackText("appr_1"));
    expect(sent).toContain("crewhaus approvals grant appr_1");
  });
});

describe("resolveApproval", () => {
  test("publishes approval_resolved and appends one audit record on the transition", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const p = await store.put({
      toolName: "bash",
      inputPreview: "{}",
      surface: "daemon",
      sessionId: "s1",
    });
    const published: string[] = [];
    const audit: Array<{ kind: string; payload: unknown }> = [];
    const resolved = await resolveApproval({
      store,
      approvalId: p.id,
      decision: "grant",
      by: "slack:U9",
      publish: (e) => published.push(`${e.kind}:${e.approvalId}`),
      auditSink: { append: async (r) => audit.push(r) },
    });
    expect(resolved?.status).toBe("grant");
    expect(published).toEqual([`approval_resolved:${p.id}`]);
    expect(audit.length).toBe(1);
    expect(audit[0]?.kind).toBe("approval_resolved");
    expect((audit[0]?.payload as { decision: string }).decision).toBe("grant");
  });

  test("a duplicate resolve is a no-op: returns null, no second audit/publish", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const p = await store.put({ toolName: "t", inputPreview: "{}", surface: "d", sessionId: "s1" });
    const published: string[] = [];
    const audit: unknown[] = [];
    const deps = {
      store,
      approvalId: p.id,
      decision: "grant" as ApprovalDecision,
      by: "cli",
      publish: (e: { kind: string }) => published.push(e.kind),
      auditSink: { append: async (r: unknown) => audit.push(r) },
    };
    expect((await resolveApproval(deps))?.status).toBe("grant");
    expect(await resolveApproval(deps)).toBeNull(); // Slack retried the click
    expect(published.length).toBe(1);
    expect(audit.length).toBe(1);
  });

  test("resolving an unknown id returns null with no effects", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const published: string[] = [];
    const out = await resolveApproval({
      store,
      approvalId: "missing",
      decision: "deny",
      by: "cli",
      publish: (e) => published.push(e.kind),
    });
    expect(out).toBeNull();
    expect(published).toEqual([]);
  });
});

describe("park → approve → resume e2e", () => {
  test("in-process: prompter parks, the store resolves grant, the tool proceeds", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const trace: string[] = [];
    const audit: Array<{ kind: string; payload: unknown }> = [];
    const publish = (e: { kind: string; approvalId: string }): void => {
      trace.push(`${e.kind}:${e.approvalId}`);
    };

    const prompter = createApprovalPrompter({
      store,
      surface: "daemon",
      sessionId: "sess_1",
      notify: async (p) => {
        trace.push(`notify:${p.id}`);
      },
      publish,
    });

    // PARK — the tool asks; the prompter persists a pending approval, publishes
    // approval_requested, surfaces the prompt, and awaits the decision.
    const parked = prompter("bash", { command: "deploy prod" });
    await tick();
    const pendings = await store.list({ status: "pending", sessionId: "sess_1" });
    expect(pendings.length).toBe(1);
    const id = pendings[0]?.id ?? "";
    expect(pendings[0]?.inputPreview).toBe('{"command":"deploy prod"}');
    expect(trace).toEqual([`approval_requested:${id}`, `notify:${id}`]);

    // APPROVE — the Slack button (or CLI verb) resolves the same store.
    const resolved = await resolveApproval({
      store,
      approvalId: id,
      decision: "grant",
      by: "slack:U9",
      publish,
      auditSink: { append: async (r) => audit.push(r) },
    });
    expect(resolved?.decidedBy).toBe("slack:U9");
    expect(trace).toContain(`approval_resolved:${id}`);
    expect(audit.length).toBe(1);

    // RESUME — the parked prompter unblocks with grant, so the tool executes.
    await expect(parked).resolves.toBe(true);
  });

  test("in-process: a deny unblocks the prompter with false (tool blocked)", async () => {
    const store = new InMemoryApprovalStore({ genId: seqIds() });
    const prompter = createApprovalPrompter({
      store,
      surface: "daemon",
      sessionId: "sess_2",
      notify: async () => {},
    });
    const parked = prompter("bash", { command: "rm -rf /" });
    await tick();
    const id = (await store.list({ status: "pending" }))[0]?.id ?? "";
    await resolveApproval({ store, approvalId: id, decision: "deny", by: "slack:U9" });
    await expect(parked).resolves.toBe(false);
  });

  test("works against any ApprovalStore — a scripted double drives the decision", async () => {
    // A minimal hand-scripted store: parks are recorded; waitFor returns a
    // pre-programmed decision. Proves the prompter depends only on the seam.
    const parked: NewPendingApproval[] = [];
    const scripted: ApprovalStore = {
      put: (input) => {
        parked.push(input);
        return Promise.resolve({
          ...input,
          id: `appr_${parked.length}`,
          status: "pending",
          createdAt: new Date(0).toISOString(),
        });
      },
      get: () => Promise.resolve(null),
      resolve: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      waitFor: (): Promise<ApprovalDecision> => Promise.resolve("grant"),
    };
    const prompter = createApprovalPrompter({
      store: scripted,
      surface: "gateway",
      sessionId: "sess_3",
      notify: async () => {},
      context: { thread: "T-1" },
    });
    await expect(prompter("write", { path: "/etc/hosts" })).resolves.toBe(true);
    expect(parked.length).toBe(1);
    expect(parked[0]?.toolName).toBe("write");
    expect(parked[0]?.surface).toBe("gateway");
    expect(parked[0]?.context).toEqual({ thread: "T-1" });
  });
});

describe("previewApprovalInput", () => {
  test("serializes and truncates, never throwing on a cyclic input", () => {
    expect(previewApprovalInput({ a: 1 })).toBe('{"a":1}');
    expect(previewApprovalInput("x".repeat(300)).endsWith("…")).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(typeof previewApprovalInput(cyclic)).toBe("string");
  });
});

/**
 * Loop contract 0.4 (G11) — the bridge that makes the channel approval surface
 * reachable. The channel store and the runtime store were separate, and only
 * the runtime's was ever written to, so the Slack approve/deny flow queried an
 * empty map: it could not prompt, and a grant could not resume anything.
 */
describe("createRuntimeBackedApprovalStore", () => {
  /** A minimal stand-in for @crewhaus/session-store's PendingApprovalStore. */
  function fakeRuntimeStore(seed: RuntimeApprovalRecord[] = []) {
    const records = new Map(seed.map((r) => [r.id, r]));
    return {
      records,
      store: {
        async persist(a: RuntimeApprovalRecord) {
          records.set(a.id, a);
        },
        async get(toolName: string, inputHash: string) {
          for (const r of records.values()) {
            // Mirrors the real store: it skips CONSUMED records, not decided
            // ones — returning a decided record is exactly how a grant is found.
            if (
              r.toolName === toolName &&
              r.inputHash === inputHash &&
              r.consumedAt === undefined
            ) {
              return r;
            }
          }
          return null;
        },
        async resolve(id: string, decision: "grant" | "deny", by: string) {
          const cur = records.get(id);
          if (cur === undefined) return null;
          // Deliberately mirrors the REAL runtime store: it overwrites and
          // returns the record even when already decided.
          const next = { ...cur, decision, decidedBy: by, decidedAt: "2026-01-01T00:00:00.000Z" };
          records.set(id, next);
          return next;
        },
        async list() {
          return [...records.values()];
        },
      },
    };
  }

  function record(over: Partial<RuntimeApprovalRecord> = {}): RuntimeApprovalRecord {
    return {
      id: "appr_00000000000000aa",
      toolName: "sendmessage",
      inputHash: "h1",
      input: { text: "ship it" },
      runId: "run_1",
      sessionId: "sess_00000000000000aa",
      surface: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...over,
    };
  }

  test("a runtime park is visible to the channel surface, shape-mapped", async () => {
    const { store } = fakeRuntimeStore([record()]);
    const bridged = createRuntimeBackedApprovalStore(store);
    const listed = await bridged.list({ status: "pending", sessionId: "sess_00000000000000aa" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("appr_00000000000000aa");
    expect(listed[0]?.status).toBe("pending");
    // The channel surface renders a preview; the raw input stays behind.
    expect(listed[0]?.inputPreview).toContain("ship it");
    expect((listed[0] as unknown as { input?: unknown }).input).toBeUndefined();
  });

  test("a decided record maps status from the runtime's `decision`", async () => {
    const { store } = fakeRuntimeStore([record({ decision: "grant", decidedBy: "slack:U1" })]);
    const bridged = createRuntimeBackedApprovalStore(store);
    expect((await bridged.get("appr_00000000000000aa"))?.status).toBe("grant");
    expect(await bridged.list({ status: "pending" })).toHaveLength(0);
  });

  /**
   * The gateway's /actions route treats a non-null `resolve` as "I transitioned
   * it" and uses that to ACK Slack and re-drive the turn. The runtime store
   * overwrites and returns the record regardless, so passing it through would
   * double-ACK and double-drive on a Slack retry — a duplicate side effect,
   * not a cosmetic one.
   */
  test("resolve returns null on a SECOND decision, preserving the gateway's guard", async () => {
    const { store } = fakeRuntimeStore([record()]);
    const bridged = createRuntimeBackedApprovalStore(store);
    const first = await bridged.resolve("appr_00000000000000aa", "grant", "slack:U1");
    expect(first?.status).toBe("grant");
    expect(first?.decidedBy).toBe("slack:U1");
    // The retry — Slack redelivers interactions freely.
    expect(await bridged.resolve("appr_00000000000000aa", "grant", "slack:U1")).toBeNull();
    expect(await bridged.resolve("appr_00000000000000aa", "deny", "slack:U2")).toBeNull();
  });

  test("resolve returns null for an unknown id", async () => {
    const { store } = fakeRuntimeStore();
    const bridged = createRuntimeBackedApprovalStore(store);
    expect(await bridged.resolve("appr_ffffffffffffffff", "grant", "x")).toBeNull();
  });

  test("the decision lands in the RUNTIME store — the only one the agent re-asks", async () => {
    const fake = fakeRuntimeStore([record()]);
    const bridged = createRuntimeBackedApprovalStore(fake.store);
    await bridged.resolve("appr_00000000000000aa", "grant", "slack:U1");
    // Keyed the way runtime-core looks it up when the turn is re-driven.
    const found = await fake.store.get("sendmessage", "h1");
    expect(found?.decision).toBe("grant");
  });

  test("put() mints an id in the runtime's appr_<16 hex> space", async () => {
    const { store } = fakeRuntimeStore();
    const bridged = createRuntimeBackedApprovalStore(store);
    const created = await bridged.put({
      toolName: "t",
      inputPreview: "p",
      surface: "channel",
      sessionId: "sess_00000000000000ab",
    });
    // The old channel store minted 24 hex, which session-store's resolve()
    // rejects outright — and so does `crewhaus approvals grant`, the command
    // the Slack prompt tells the operator to run.
    expect(created.id).toMatch(/^appr_[0-9a-f]{16}$/);
  });

  test("list is newest-first", async () => {
    const { store } = fakeRuntimeStore([
      record({ id: "appr_00000000000000a1", createdAt: "2026-01-01T00:00:00.000Z" }),
      record({
        id: "appr_00000000000000a2",
        createdAt: "2026-01-02T00:00:00.000Z",
        inputHash: "h2",
      }),
    ]);
    const bridged = createRuntimeBackedApprovalStore(store);
    expect((await bridged.list()).map((a) => a.id)).toEqual([
      "appr_00000000000000a2",
      "appr_00000000000000a1",
    ]);
  });

  test("waitFor settles on a decision and rejects an unknown id", async () => {
    const fake = fakeRuntimeStore([record()]);
    const bridged = createRuntimeBackedApprovalStore(fake.store, { waitForPollMs: 1 });
    await expect(bridged.waitFor("appr_ffffffffffffffff")).rejects.toThrow(/unknown approval/);
    const settled = bridged.waitFor("appr_00000000000000aa");
    await bridged.resolve("appr_00000000000000aa", "deny", "slack:U9");
    expect(await settled).toBe("deny");
  });
});
