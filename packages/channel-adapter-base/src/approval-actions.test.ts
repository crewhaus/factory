/**
 * A click on a channel daemon's card, decided as the linked member, over a real
 * file-backed approvals store in a temp harness and a planted approver projection.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type ApproverProjection, mintId, mintRunId } from "@crewhaus/control-contract";
import { createApproverReader, readProposals } from "@crewhaus/control-records";
import { createDecisions } from "@crewhaus/control-service";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import {
  type PendingApproval as StoredApproval,
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import {
  type ApprovalActionAdapter,
  type ApprovalInteraction,
  type DecisionWatch,
  createApprovalActions,
  linkAnswer,
} from "./approval-actions";
import {
  POSTED_APPROVALS_KEPT,
  type PendingApproval,
  _resetPostedApprovalsForTest,
  createRuntimeBackedApprovalStore,
  postApprovalPrompt,
  postedApprovalIds,
} from "./approvals";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => _resetPostedApprovalsForTest());

const TEAM = "T0";
const USER = "U0";
const SUBJECT = `slack:${TEAM}:${USER}`;

type Member = { readonly principal: string; readonly decide: "operator" | "maintainer" | "owner" };

/** A temp harness, its session root, the real store and the channel bridge over it. */
function harness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "approval-actions-")));
  roots.push(dir);
  const root = join(dir, ".crewhaus", "sessions");
  const runtime = createPendingApprovalStore({ rootDir: root });
  const bridge = createRuntimeBackedApprovalStore(runtime);
  return { dir, root, runtime, bridge };
}

function plantProjection(
  dir: string,
  owner: string,
  members: readonly Member[],
  links: ReadonlyArray<{ readonly external: string; readonly principal: string }>,
  extra: Partial<ApproverProjection> = {},
): void {
  const control = join(dir, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(
    join(control, "approvers.json"),
    `${JSON.stringify({
      v: 1,
      epoch: 1,
      generatedAt: new Date().toISOString(),
      harness: "hrn_00000000000000c1",
      owner,
      governedSince: new Date(Date.now() - 86_400_000).toISOString(),
      members,
      links,
      ...extra,
    })}\n`,
  );
}

async function park(
  runtime: ReturnType<typeof createPendingApprovalStore>,
  toolName: string,
  input: unknown,
  over: Partial<StoredApproval> = {},
): Promise<StoredApproval> {
  const record: StoredApproval = {
    id: generateApprovalId(),
    toolName,
    inputHash: hashApprovalInput(toolName, input),
    input,
    runId: mintRunId(),
    sessionId: "sess_00000000000000aa",
    surface: "channel",
    createdAt: new Date().toISOString(),
    ...over,
  };
  await runtime.persist(record);
  return record;
}

type Interaction = ApprovalInteraction & { readonly responseUrl?: string };

function click(
  approvalId: string,
  decision: "grant" | "deny" = "grant",
  extra: Partial<Interaction> = {},
): Interaction {
  return { kind: "approval_action", approvalId, decision, userId: USER, teamId: TEAM, ...extra };
}

/** A fake Slack adapter that records every call. */
function fakeAdapter(options: { ack?: () => Promise<void> } = {}) {
  const answers: string[] = [];
  const acks: Array<{ state?: string; by: string; toolName?: string }> = [];
  const adapter: ApprovalActionAdapter<Interaction> = {
    id: "slack",
    parseInteraction: () => undefined,
    async ackApproval(args) {
      acks.push({
        by: args.by,
        ...(args.state !== undefined ? { state: args.state } : {}),
        ...(args.toolName !== undefined ? { toolName: args.toolName } : {}),
      });
      if (options.ack !== undefined) await options.ack();
    },
    async answerInteraction(args) {
      answers.push(args.text);
    },
  };
  return { adapter, answers, acks };
}

function fakeRouter() {
  const resumed: Array<{ id: string; trigger: RunContext["trigger"]; continues?: string }> = [];
  return {
    resumed,
    router: {
      async resumeApproval(approval: PendingApproval): Promise<void> {
        // The router's turn creates the run's first context inside the scope.
        const ctx = createRunContext({ sessionId: approval.sessionId });
        resumed.push({
          id: approval.id,
          trigger: ctx.trigger,
          ...(ctx.continues !== undefined ? { continues: ctx.continues } : {}),
        });
      },
    },
  };
}

function fakeWatch(): DecisionWatch & { fire(): void } {
  const listeners: Array<() => void> = [];
  return {
    onChange: (cb) => {
      listeners.push(cb);
    },
    close: () => undefined,
    fire: () => {
      for (const l of listeners) l();
    },
  };
}

/** Let the work queued off the request path run: event-loop turns, counted, never a clock. */
async function drain(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
}

/** What a decision leaves under the session root: claim files, and `decide` log lines. */
function decisionFiles(root: string): string[] {
  const log = join(root, "approvals.d", "decisions");
  const decided = entries(log)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(log, name), "utf8").split("\n"))
    .filter((line) => line !== "" && (JSON.parse(line) as { event?: string }).event === "decide");
  return [...entries(join(root, "approvals.d", "claims")), ...decided];
}

function rig(options: { ack?: () => Promise<void>; audit?: unknown[] } = {}) {
  const h = harness();
  const owner = mintId("prn");
  const fake = fakeAdapter(options);
  const routed = fakeRouter();
  const watch = fakeWatch();
  const audit = options.audit ?? [];
  const actions = createApprovalActions({
    approvals: h.bridge,
    adapters: new Map([["slack", fake.adapter]]),
    sessionRouter: routed.router,
    harnessDir: h.dir,
    approvers: createApproverReader({ now: () => Number.NaN }),
    watch,
    auditSink: {
      append: async (record) => {
        audit.push(record);
      },
    },
  });
  return { ...h, owner, ...fake, ...routed, watch, actions, audit };
}

describe("who clicked", () => {
  test("an unlinked click decides nothing and names the link verb (no projection, and no link)", async () => {
    const r = rig();
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const res = await r.actions.handle(click(p.id), r.adapter);
    expect(res.status).toBe(200);
    await drain();
    expect(r.answers).toEqual([linkAnswer(SUBJECT)]);
    expect(r.answers[0]).toContain("crewhaus access link slack:T0:U0");
    // Present, but without this subject.
    plantProjection(r.dir, r.owner, [], [{ external: "slack:T0:U9", principal: r.owner }]);
    expect((await r.actions.handle(click(p.id), r.adapter)).status).toBe(200);
    await drain();
    expect(r.answers).toHaveLength(2);
    expect(r.answers[1]).toContain("crewhaus access link slack:T0:U0");
    expect(decisionFiles(r.root)).toEqual([]);
    expect((await r.bridge.get(p.id))?.status).toBe("pending");
    expect(r.acks).toEqual([]);
    expect(r.resumed).toEqual([]);
  });

  test("a click with no workspace counts as unlinked", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const { teamId: _none, ...bare } = click(p.id);
    await r.actions.handle(bare as Interaction, r.adapter);
    await drain();
    expect(r.answers).toEqual([linkAnswer(undefined)]);
    expect(decisionFiles(r.root)).toEqual([]);
  });

  test("a linked operator decides an operator request, recorded as the member", async () => {
    const audit: unknown[] = [];
    const r = rig({ audit });
    const operator = mintId("prn");
    plantProjection(
      r.dir,
      r.owner,
      [{ principal: operator, decide: "operator" }],
      [{ external: SUBJECT, principal: operator }],
    );
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const res = await r.actions.handle(click(p.id), r.adapter);
    expect(res.status).toBe(200);
    const stored = (await r.runtime.list()).find((a) => a.id === p.id);
    expect(stored?.decision).toBe("grant");
    expect(stored?.decidedByPrincipal).toBe(operator);
    expect(stored?.decidedBy).toBe("slack");
    expect(stored?.decidedVia).toBe("slack");
    // No record names the Slack account.
    expect(JSON.stringify(stored)).not.toContain(USER);
    await drain();
    expect(r.acks).toEqual([{ by: "slack", state: "Approved", toolName: "Write" }]);
    expect(audit).toHaveLength(1);
    expect((audit[0] as { payload: { by: string } }).payload.by).toBe(operator);
    expect(r.resumed.map((x) => x.id)).toEqual([p.id]);
  });

  test("a linked operator is refused a maintainer request, and nothing is claimed", async () => {
    const r = rig();
    const operator = mintId("prn");
    plantProjection(
      r.dir,
      r.owner,
      [{ principal: operator, decide: "operator" }],
      [{ external: SUBJECT, principal: operator }],
    );
    const p = await park(r.runtime, "Write", { path: "a.md" }, { requiredClass: "maintainer" });
    expect((await r.actions.handle(click(p.id), r.adapter)).status).toBe(200);
    await drain();
    expect(r.answers).toEqual(["Needs a maintainer."]);
    expect(entries(join(r.root, "approvals.d", "claims"))).toEqual([]);
    expect((await r.bridge.get(p.id))?.status).toBe("pending");
    expect(r.resumed).toEqual([]);
  });

  test("a projection that cannot be read decides nothing and names the sync verb", async () => {
    const r = rig();
    const control = join(r.dir, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, "approvers.json"), "{ not json");
    const p = await park(r.runtime, "Write", { path: "a.md" });
    await r.actions.handle(click(p.id), r.adapter);
    await drain();
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0]).toContain("crewhaus access sync");
    expect(decisionFiles(r.root)).toEqual([]);
  });

  test("a store with no session root decides no click", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const { rootDir: _gone, ...rootless } = r.bridge;
    const fake = fakeAdapter();
    const actions = createApprovalActions({
      approvals: rootless,
      adapters: new Map([["slack", fake.adapter]]),
      sessionRouter: fakeRouter().router,
      harnessDir: r.dir,
    });
    await actions.handle(click(p.id), fake.adapter);
    await drain();
    expect(fake.answers).toEqual([
      "This daemon cannot check who may decide; use `crewhaus approvals`.",
    ]);
    expect(decisionFiles(r.root)).toEqual([]);
  });
});

describe("Always allow", () => {
  test("from the owner: one narrow rule for 30 days, row and settings entry", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "notes/a.md" });
    await r.actions.handle(click(p.id, "grant", { always: true }), r.adapter);
    const rows = readFileSync(
      join(r.dir, ".crewhaus", "run", "control", "standing-rules.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["pattern"]).toBe("Write(notes/a.md)");
    expect(rows[0]?.["createdBy"]).toBe(r.owner);
    const settings = JSON.parse(readFileSync(join(r.dir, ".crewhaus", "settings.json"), "utf8"));
    expect(settings.permissions.rules).toEqual([
      { type: "alwaysAllow", pattern: "Write(notes/a.md)" },
    ]);
    await drain();
    expect(r.acks[0]?.state).toBe("Approved, and allowed for 30 days");
  });

  test("from a maintainer: allowed once, no settings write, one request to the owner", async () => {
    const r = rig();
    const maintainer = mintId("prn");
    plantProjection(
      r.dir,
      r.owner,
      [{ principal: maintainer, decide: "maintainer" }],
      [{ external: SUBJECT, principal: maintainer }],
    );
    const p = await park(r.runtime, "Write", { path: "notes/a.md" });
    await r.actions.handle(click(p.id, "grant", { always: true }), r.adapter);
    const stored = (await r.runtime.list()).find((a) => a.id === p.id);
    expect(stored?.decision).toBe("grant");
    expect(stored?.always).toBeUndefined();
    expect(existsSync(join(r.dir, ".crewhaus", "settings.json"))).toBe(false);
    const proposals = readProposals(r.dir);
    if (proposals.state !== "present") throw new Error(proposals.state);
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]?.terms.pattern).toBe("Write(notes/a.md)");
    expect(proposals.rows[0]?.state).toBe("pending");
    expect(proposals.rows[0]?.proposedBy).toBe(maintainer);
    await drain();
    expect(r.acks[0]?.state).toBe("Allowed once; the owner was asked to allow it from now on");
  });

  test("a call no rule can name decides nothing and says why", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "CopyPath", { source: "a.md", destination: "b.md" });
    expect((await r.actions.handle(click(p.id, "grant", { always: true }), r.adapter)).status).toBe(
      200,
    );
    await drain();
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0]).toStartWith("This call can't become a standing rule (");
    expect(r.answers[0]).toContain("several-places");
    expect(r.answers[0]).toEndWith("Approve allows it once.");
    expect(decisionFiles(r.root)).toEqual([]);
    expect((await r.bridge.get(p.id))?.status).toBe("pending");
  });
});

describe("the whole request on the card", () => {
  test("an input over the cap is reviewed in full, and an Approve on it decides nothing", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    // {"path":"<n chars>"} is n + 11 characters.
    const long = await park(r.runtime, "Write", { path: "x".repeat(190) });
    const fits = await park(r.runtime, "Write", { path: "y".repeat(189) });
    expect(JSON.stringify(long.input).length).toBe(201);
    expect(JSON.stringify(fits.input).length).toBe(200);
    const cards: Array<{ approvalId: string; fitsCard?: boolean; review?: unknown }> = [];
    for (const record of [long, fits]) {
      const pending = await r.bridge.get(record.id);
      if (pending === null) throw new Error("not found");
      await postApprovalPrompt({
        pending,
        sendText: async () => undefined,
        postInteractive: async (card) => {
          cards.push(card);
          return {};
        },
        harnessDir: r.dir,
      });
    }
    expect(cards.map((c) => [c.approvalId, c.fitsCard])).toEqual([
      [long.id, false],
      [fits.id, true],
    ]);
    // No Home address in the projection: the host and the verb.
    expect(cards[0]?.review).toEqual({
      host: hostname(),
      verb: `crewhaus approvals show ${long.id}`,
    });
    await r.actions.handle(click(long.id), r.adapter);
    await drain();
    expect(r.answers).toEqual([
      `Review on ${hostname()} before approving: \`crewhaus approvals show ${long.id}\``,
    ]);
    expect((await r.bridge.get(long.id))?.status).toBe("pending");
    expect(decisionFiles(r.root)).toEqual([]);
    // Deny needs nothing on the card.
    await r.actions.handle(click(long.id, "deny"), r.adapter);
    expect((await r.bridge.get(long.id))?.status).toBe("deny");
  });

  test("a request about people is reviewed in Home, by the address the projection carries", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }], {
      homeUrl: "https://home.example.test",
    });
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const fake = {
      ...r.runtime,
      list: async () =>
        (await r.runtime.list()).map((a) => (a.id === p.id ? { ...a, sensitivity: "people" } : a)),
    };
    const bridge = createRuntimeBackedApprovalStore(fake);
    const pending = await bridge.get(p.id);
    expect(pending?.sensitivity).toBe("people");
    expect(pending?.fitsCard).toBe(false);
    const cards: Array<{ fitsCard?: boolean; review?: unknown }> = [];
    if (pending === null) throw new Error("not found");
    await postApprovalPrompt({
      pending,
      sendText: async () => undefined,
      postInteractive: async (card) => {
        cards.push(card);
        return {};
      },
      harnessDir: r.dir,
    });
    expect(cards).toEqual([
      expect.objectContaining({
        fitsCard: false,
        review: { url: "https://home.example.test/#/home/needs-you?type=approvals" },
      }),
    ]);
  });
});

describe("answered once the decision is recorded", () => {
  test("an ack that never resolves does not hold the answer, the audit or the resume", async () => {
    const audit: unknown[] = [];
    const r = rig({ ack: () => new Promise<void>(() => undefined), audit });
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const res = await r.actions.handle(click(p.id), r.adapter);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(entries(join(r.root, "approvals.d", "claims")).length).toBeGreaterThan(0);
    expect((await r.bridge.get(p.id))?.status).toBe("grant");
    await drain();
    expect(r.acks).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(r.resumed.map((x) => x.id)).toEqual([p.id]);
  });

  test("an ack that throws is one stderr line", async () => {
    const lines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const r = rig({
        ack: async () => {
          throw new Error("slack is down");
        },
      });
      plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
      const p = await park(r.runtime, "Write", { path: "a.md" });
      expect((await r.actions.handle(click(p.id), r.adapter)).status).toBe(200);
      await drain();
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((l) => l.includes("slack is down"))).toEqual([
      "[gateway] approval ack error: slack is down\n",
    ]);
  });
});

describe("decided elsewhere", () => {
  const cli = (r: ReturnType<typeof rig>, ref: string, via: "cli" | "home") =>
    createDecisions({
      hangarRoot: join(r.dir, "home"),
      identity: { username: "sam", hostname: "laptop" },
      now: () => Date.now(),
    }).resolve({
      harnessDir: r.dir,
      rootDir: r.root,
      ref,
      choice: "grant",
      actor: { kind: "principal", principal: r.owner },
      via,
    });

  test("a stale click says where it was decided, claims nothing more and resumes nothing", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    expect((await cli(r, p.id, "cli")).outcome).toBe("decided");
    const claims = () => entries(join(r.root, "approvals.d", "claims")).sort();
    const before = claims();
    expect(before.length).toBeGreaterThan(0);
    expect((await r.actions.handle(click(p.id), r.adapter)).status).toBe(200);
    await drain();
    expect(r.answers).toEqual(["Already granted with `crewhaus approvals`."]);
    expect(claims()).toEqual(before);
    expect(r.acks).toEqual([]);
    expect(r.resumed).toEqual([]);
  });

  test("a click and a grant at a terminal at once: one wins, one claim, at most one resume", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const [, terminal] = await Promise.all([
      r.actions.handle(click(p.id), r.adapter),
      cli(r, p.id, "cli"),
    ]);
    await drain();
    const stored = (await r.runtime.list()).find((a) => a.id === p.id);
    const clickWon = stored?.decidedVia === "slack";
    expect(terminal.outcome).toBe(clickWon ? "already-decided" : "decided");
    if (clickWon) {
      expect(r.acks).toHaveLength(1);
      expect(r.resumed).toHaveLength(1);
    } else {
      expect(r.answers).toEqual(["Already granted with `crewhaus approvals`."]);
      expect(r.resumed).toEqual([]);
    }
    const claims = entries(join(r.root, "approvals.d", "claims")).filter((f) =>
      f.endsWith(".json"),
    );
    expect(claims).toHaveLength(1);
  });

  test("a Home grant on a card with buttons: one follow-up in its thread, one resume, nothing on a second change", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const sent: string[] = [];
    const pending = await r.bridge.get(p.id);
    if (pending === null) throw new Error("not found");
    const posted = await postApprovalPrompt({
      pending,
      sendText: async (t) => void sent.push(t),
      postInteractive: async () => ({}),
      harnessDir: r.dir,
    });
    expect(posted.interactive).toBe(true);
    expect((await cli(r, p.id, "home")).outcome).toBe("decided");
    r.watch.fire();
    await drain();
    expect(sent).toEqual(["Granted in Home"]);
    expect(r.resumed).toEqual([
      { id: p.id, trigger: { kind: "approval-resume", via: "home" }, continues: p.runId },
    ]);
    r.watch.fire();
    await drain();
    expect(sent).toHaveLength(1);
    expect(r.resumed).toHaveLength(1);
    // The grant itself is spent by the next turn in that conversation, as it is
    // bound to its session (a control: this holds without any of the above).
    const spent = await r.runtime.consume(p.id, {
      runId: mintRunId(),
      resumeScope: `session:${p.sessionId}`,
      places: [],
      approvers: createApproverReader()(r.dir),
    });
    expect(spent.outcome).toBe("consumed");
  });

  test("a Home grant on a text card from an adapter without buttons: the follow-up, and no resume", async () => {
    const h = harness();
    const owner = mintId("prn");
    plantProjection(h.dir, owner, [], [{ external: SUBJECT, principal: owner }]);
    const slack = fakeAdapter();
    const plain: ApprovalActionAdapter<Interaction> = { id: "telegram" };
    const routed = fakeRouter();
    const watch = fakeWatch();
    createApprovalActions({
      approvals: h.bridge,
      adapters: new Map([
        ["slack", slack.adapter],
        ["telegram", plain],
      ]),
      sessionRouter: routed.router,
      harnessDir: h.dir,
      approvers: createApproverReader({ now: () => Number.NaN }),
      watch,
    });
    const p = await park(h.runtime, "Write", { path: "a.md" });
    const sent: string[] = [];
    const pending = await h.bridge.get(p.id);
    if (pending === null) throw new Error("not found");
    const posted = await postApprovalPrompt({
      pending,
      sendText: async (t) => void sent.push(t),
      harnessDir: h.dir,
    });
    expect(posted.interactive).toBe(false);
    expect(sent).toHaveLength(1);
    const home = await createDecisions({
      hangarRoot: join(h.dir, "home"),
      identity: { username: "sam", hostname: "laptop" },
      now: () => Date.now(),
    }).resolve({
      harnessDir: h.dir,
      rootDir: h.root,
      ref: p.id,
      choice: "grant",
      actor: { kind: "principal", principal: owner },
      via: "home",
    });
    expect(home.outcome).toBe("decided");
    watch.fire();
    await drain();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe("Granted in Home");
    expect(routed.resumed).toEqual([]);
    // The grant waits, unspent, for the next message in that conversation.
    const spent = await h.runtime.consume(p.id, {
      runId: mintRunId(),
      resumeScope: `session:${p.sessionId}`,
      places: [],
      approvers: createApproverReader()(h.dir),
    });
    expect(spent.outcome).toBe("consumed");
  });

  test("a card this process decided gets no follow-up", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const sent: string[] = [];
    const pending = await r.bridge.get(p.id);
    if (pending === null) throw new Error("not found");
    await postApprovalPrompt({
      pending,
      sendText: async (t) => void sent.push(t),
      harnessDir: r.dir,
    });
    await r.actions.handle(click(p.id), r.adapter);
    r.watch.fire();
    await drain();
    expect(sent).toHaveLength(1);
    expect(r.resumed).toHaveLength(1);
  });

  test("after a restart nothing is posted", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    const sent: string[] = [];
    const pending = await r.bridge.get(p.id);
    if (pending === null) throw new Error("not found");
    await postApprovalPrompt({
      pending,
      sendText: async (t) => void sent.push(t),
      harnessDir: r.dir,
    });
    _resetPostedApprovalsForTest();
    const watch = fakeWatch();
    const routed = fakeRouter();
    createApprovalActions({
      approvals: r.bridge,
      adapters: new Map([["slack", r.adapter]]),
      sessionRouter: routed.router,
      harnessDir: r.dir,
      watch,
    });
    expect((await cli(r, p.id, "home")).outcome).toBe("decided");
    watch.fire();
    await drain();
    expect(sent).toHaveLength(1);
    expect(routed.resumed).toEqual([]);
  });
});

describe("the resume", () => {
  test("a granted click continues the parked run once, in a scope its first context takes", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    await r.actions.handle(click(p.id), r.adapter);
    await drain();
    expect(r.resumed).toEqual([
      { id: p.id, trigger: { kind: "approval-resume", via: "slack" }, continues: p.runId },
    ]);
    // A retried click is answered with the current state and continues nothing.
    await r.actions.handle(click(p.id), r.adapter);
    await drain();
    expect(r.resumed).toHaveLength(1);
    expect(r.answers).toEqual(["Already granted in Slack."]);
  });

  test("a deny continues nothing", async () => {
    const r = rig();
    plantProjection(r.dir, r.owner, [], [{ external: SUBJECT, principal: r.owner }]);
    const p = await park(r.runtime, "Write", { path: "a.md" });
    await r.actions.handle(click(p.id, "deny"), r.adapter);
    await drain();
    expect(r.acks).toEqual([{ by: "slack", state: "Denied", toolName: "Write" }]);
    expect(r.resumed).toEqual([]);
  });
});

describe("the posted cards", () => {
  test(`${POSTED_APPROVALS_KEPT + 1} prompts keep ${POSTED_APPROVALS_KEPT}, the oldest out`, async () => {
    const ids: string[] = [];
    for (let i = 0; i <= POSTED_APPROVALS_KEPT; i++) {
      const id = `appr_${i.toString(16).padStart(16, "0")}`;
      ids.push(id);
      await postApprovalPrompt({
        pending: {
          id,
          toolName: "t",
          inputPreview: "{}",
          surface: "channel",
          sessionId: "sess_1",
          status: "pending",
          createdAt: new Date(0).toISOString(),
        },
        sendText: async () => undefined,
      });
    }
    const kept = postedApprovalIds();
    expect(kept).toHaveLength(POSTED_APPROVALS_KEPT);
    expect(kept.includes(ids[0] as string)).toBe(false);
    expect(kept[0]).toBe(ids[1]);
    expect(kept.at(-1)).toBe(ids.at(-1));
  });
});
