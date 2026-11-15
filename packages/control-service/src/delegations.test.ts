/**
 * The delegation service, end to end over records, with one fake action registered under
 * `merge` (gates that answer scripted verdicts, an effect and a rollback that count their
 * calls), on two command kinds no shipped runtime serves. Nothing ships a test kind.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AREA_MODULES,
  COMMAND_KINDS,
  type DelegationLogLine,
  type DelegationSubject,
  type DelegationTermsRequest,
  mintId,
} from "@crewhaus/control-contract";
import type {
  GateId,
  GateVerdict,
  RollbackPlan,
  SignalReading,
} from "@crewhaus/control-contract/delegation";
import {
  acquireMutatingLease,
  appendDelegationLog,
  casAppend,
  controlPaths,
  decisionsLedger,
  deploymentsLedger,
  openActionDecision,
  readActionDecisions,
  readDelegationLog,
  readDelegations,
  readProposals,
  writeOperatorRecord,
} from "@crewhaus/control-records";
import { AREA_RUNTIMES } from "./areas";
import type { DecisionActor } from "./decisions";
import {
  DELEGATIONS_REVOKER,
  type DelegationHarness,
  type DelegationRefusal,
  NOTHING_DELEGABLE,
  createDelegations,
  delegatedExecutor,
  delegatedRollbackExecutor,
} from "./delegations";
import type { AreaRuntime, DelegatedAction, DelegatedActionScope, Settlement } from "./executor";
import { commandsLedgerOf } from "./ledgers";
import {
  IDENTITY,
  NOW,
  deferred,
  plantProjection,
  removeTempDirs,
  rig,
  rowsOf,
  setUpOwner,
  treeBytes,
} from "./test-helpers";

afterAll(removeTempDirs);

const HRN = "hrn_0123456789abcdef";
const POLICY = `sha256:${"1".repeat(64)}`;
const POLICY_2 = `sha256:${"2".repeat(64)}`;
const REV = `sha256:${"a".repeat(64)}`;
const OWNER_LOCAL: DecisionActor = { kind: "local", identity: IDENTITY };

/** Two kinds of one module that no shipped runtime serves, so the test kind ships nowhere. */
function borrowedKinds(): {
  readonly area: string;
  readonly execute: string;
  readonly rollback: string;
} {
  const served = new Set(
    AREA_RUNTIMES.flatMap((runtime) => [
      ...Object.keys(runtime.executors ?? {}),
      ...Object.keys(runtime.reconcilers ?? {}),
    ]),
  );
  // An area's own kinds first: the core's are the core's.
  for (const module of [...AREA_MODULES].sort(
    (a, b) => Number(a.area === "core") - Number(b.area === "core"),
  )) {
    const free = module.commandKinds
      .map((kind) => kind.id as string)
      .filter((id) => !served.has(id) && Object.hasOwn(COMMAND_KINDS, id));
    if (free.length >= 2) {
      return { area: module.area, execute: free[0] as string, rollback: free[1] as string };
    }
  }
  throw new Error("no module has two kinds no runtime serves");
}
const KINDS = borrowedKinds();

type Script = {
  verdicts: Partial<Record<GateId, Partial<GateVerdict> | "throw">>;
  oneAtATime:
    | boolean
    | ((log: readonly DelegationLogLine[], subject: DelegationSubject) => boolean);
  plan: RollbackPlan | undefined;
  revision: string | undefined;
  signal: SignalReading;
  rollbackOk: boolean;
  effects: number;
  rollbacks: number;
  /** Run while a gate answers, or while the rollback is planned. */
  duringGate?: () => Promise<void>;
  duringPlan?: () => Promise<void>;
  /** Run while the effect reads the subject's revision, before it checks anything. */
  duringRevision?: () => Promise<void>;
  /** Run inside the effect, after the grant is spent. */
  duringEffect?: () => Promise<void>;
  /** What the effect settles as, after `duringEffect`; `succeeded` when unset. */
  run?: () => Promise<Settlement>;
  /** The scope fields the action's scope offers; none when unset. */
  scopeFields?: DelegatedActionScope["fields"];
  /** What the host says, as the page's lines. */
  host?: { template: string; params?: Record<string, unknown> }[];
};

function script(): Script {
  return {
    verdicts: {},
    oneAtATime: true,
    plan: { kind: "revert", binding: "app", pr: 12, base: "main", method: "squash" },
    revision: REV,
    signal: "healthy",
    rollbackOk: true,
    effects: 0,
    rollbacks: 0,
  };
}

function fakeAction(s: Script): { action: DelegatedAction; runtime: AreaRuntime } {
  const gate = (id: GateId) => ({
    evaluate: async (
      _subject: unknown,
      ctx: { bindTo: string; now: number },
    ): Promise<GateVerdict> => {
      await s.duringGate?.();
      const scripted = s.verdicts[id];
      if (scripted === "throw") throw new Error("gate failed to run");
      return {
        gate: id,
        outcome: "pass",
        boundTo: ctx.bindTo,
        evidence: [],
        at: new Date(ctx.now).toISOString(),
        freshUntil: new Date(ctx.now + 3_600_000).toISOString(),
        ...(scripted ?? {}),
      };
    },
  });
  const action: DelegatedAction = {
    action: "merge",
    decisionKind: "merge",
    gates: { scope: gate("scope"), held_out: gate("held_out") },
    requiredGates: ["scope", "held_out"],
    scopeOf: (ceiling) =>
      typeof ceiling["merge"] === "object"
        ? { fields: s.scopeFields ?? {}, ceiling: ceiling["merge"] as Record<string, unknown> }
        : undefined,
    inScope: (_terms, _scope, subject) => subject.ref.startsWith(`${HRN}/`),
    oneAtATime: (log, subject) =>
      typeof s.oneAtATime === "function" ? s.oneAtATime(log, subject) : s.oneAtATime,
    planRollback: async () => {
      await s.duringPlan?.();
      return s.plan;
    },
    currentRevision: async () => {
      await s.duringRevision?.();
      return s.revision;
    },
    signals: async () => s.signal,
    signalIds: ["base-checks"],
    watchMs: () => 60_000,
    previewTerms: async () => s.host ?? [],
    executeKind: KINDS.execute,
    rollbackKind: KINDS.rollback,
  };
  const runtime: AreaRuntime = {
    area: KINDS.area,
    executors: {
      [KINDS.execute]: delegatedExecutor(action, async () => {
        s.effects += 1;
        await s.duringEffect?.();
        return s.run !== undefined ? await s.run() : { state: "succeeded" };
      }),
      [KINDS.rollback]: delegatedRollbackExecutor(async () => {
        s.rollbacks += 1;
        return s.rollbackOk ? { state: "succeeded" } : { state: "failed" };
      }),
    },
    reconcilers: {
      [KINDS.execute]: () => "unknown",
      [KINDS.rollback]: () => "unknown",
    },
    unsupervised: [KINDS.execute, KINDS.rollback],
    delegatedActions: [action],
  };
  return { action, runtime };
}

/** A rig with the fake action registered, an active deployment that allows merges. */
async function setup(
  options: { readonly ceiling?: Record<string, unknown> | null; readonly active?: boolean } = {},
) {
  const s = script();
  const { action, runtime } = fakeAction(s);
  const r = rig({ areas: [...AREA_RUNTIMES, runtime] });
  const harness: DelegationHarness = { dir: r.harness, id: HRN, name: "codebase-steward" };
  const ceiling = options.ceiling === undefined ? { maxDays: 30, merge: {} } : options.ceiling;
  await deploy(r.harness, { ceiling, active: options.active ?? true, policy: POLICY, at: NOW });
  return { r, s, action, harness, service: r.service.delegations };
}

const deployments = new Map<string, string>();

async function deploy(
  dir: string,
  input: { ceiling: Record<string, unknown> | null; active: boolean; policy: string; at: number },
): Promise<string> {
  const ledger = deploymentsLedger(dir);
  const id = mintId("dep", { now: input.at });
  const row = {
    id,
    harness: HRN,
    artifact: { digest: "d".repeat(64), shape: "cli", entry: "dist/agent.ts" },
    policyRevision: input.policy,
    ...(input.ceiling !== null ? { delegation: input.ceiling } : {}),
  };
  await casAppend(ledger, id, null, { ...row, state: "prepared" });
  if (!input.active) return id;
  const previous = deployments.get(dir);
  await casAppend(ledger, id, "prepared", {
    ...row,
    state: "active",
    activatedAt: new Date(input.at).toISOString(),
  });
  if (previous !== undefined) {
    await casAppend(ledger, previous, "active", {
      id: previous,
      harness: HRN,
      state: "superseded",
    });
  }
  deployments.set(dir, id);
  return id;
}

let seq = 0;

/** Turn a rule on: the first try learns the page's digest, the second confirms it. */
async function enable(
  t: Awaited<ReturnType<typeof setup>>,
  terms: DelegationTermsRequest = {},
  actor: DecisionActor = OWNER_LOCAL,
  proposal?: string,
) {
  const first = await t.service.enable(t.harness, {
    action: "merge",
    terms,
    consequencesDigest: "0".repeat(64),
    confirm: "codebase-steward",
    actor,
    cmd: mintId("cmd"),
    ...(proposal !== undefined ? { proposal } : {}),
  });
  if (first.ok || first.code !== "precondition-failed") return first;
  return t.service.enable(t.harness, {
    action: "merge",
    terms,
    consequencesDigest: first.page?.consequencesDigest as string,
    confirm: "codebase-steward",
    actor,
    cmd: mintId("cmd"),
    ...(proposal !== undefined ? { proposal } : {}),
  });
}

async function decision(dir: string, at: number = NOW) {
  seq += 1;
  const opened = await openActionDecision(dir, {
    kind: "merge",
    subject: { ref: `${HRN}/work/${mintId("wi")}`, revision: REV },
    requiredClass: "maintainer",
    proposedBy: "sys:scheduler",
    now: at + seq,
  });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.row;
}

const events = (dir: string): string[] => {
  const read = readDelegationLog(dir);
  return read.state === "present" ? read.lines.map((l) => l.event) : [];
};
const linesOf = (dir: string): DelegationLogLine[] => {
  const read = readDelegationLog(dir);
  return read.state === "present" ? [...read.lines] : [];
};
const ruleState = (dir: string, id: string) => {
  const read = readDelegations(dir);
  return read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
};
const decisionRow = (dir: string, id: string) => {
  const read = readActionDecisions(dir);
  return read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
};
const apply = (t: Awaited<ReturnType<typeof setup>>) =>
  t.service.apply(t.harness, { appliedBy: "sys:scheduler" });

function ruleOf(answer: Awaited<ReturnType<typeof enable>>): string {
  if (!answer.ok) throw new Error(`${answer.code}: ${answer.reason}`);
  return answer.rule?.id as string;
}

describe("a non-owner cannot create a rule", () => {
  async function governed() {
    const t = await setup();
    const owner = await setUpOwner(t.r.hangarRoot);
    const maintainer = mintId("prn");
    const operator = mintId("prn");
    plantProjection(t.r.harness, owner, [
      { principal: maintainer, decide: "maintainer" },
      { principal: operator, decide: "operator" },
    ]);
    return { t, owner, maintainer, operator };
  }

  test("a maintainer's enable is refused for the owner; their propose files one owner-class request", async () => {
    const { t, maintainer } = await governed();
    const refused = await enable(t, {}, { kind: "principal", principal: maintainer });
    expect(refused).toMatchObject({
      ok: false,
      code: "forbidden",
      needs: "h.standing-rule.manage",
    });
    expect(readDelegations(t.r.harness)).toEqual({ state: "absent" });
    const proposed = await t.service.propose(t.harness, {
      action: "merge",
      terms: { days: 7 },
      actor: { kind: "principal", principal: maintainer },
      cmd: mintId("cmd"),
    });
    expect(proposed.ok).toBe(true);
    const read = readProposals(t.r.harness);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({
      kind: "standing-rule-proposal",
      requiredClass: "owner",
      proposedBy: maintainer,
      terms: { ruleKind: "delegate", action: "merge", terms: { days: 7 }, days: 7 },
      state: "pending",
    });
    expect(read.rows[0]).not.toHaveProperty("derivedFrom");
  });

  test("an operator's and a viewer's propose are refused", async () => {
    const { t, operator } = await governed();
    for (const principal of [operator, mintId("prn")]) {
      expect(
        await t.service.propose(t.harness, {
          action: "merge",
          actor: { kind: "principal", principal },
          cmd: mintId("cmd"),
        }),
      ).toMatchObject({ ok: false, code: "forbidden", needs: "h.delegation.propose" });
    }
    expect(readProposals(t.r.harness)).toEqual({ state: "absent" });
  });

  test("a service and a system actor are refused, even on a harness with no approver list", async () => {
    const t = await setup();
    const tree = treeBytes(t.r.harness);
    const actors: DecisionActor[] = [
      { kind: "principal", principal: mintId("prn"), service: true },
      { kind: "principal", principal: "sys:scheduler" },
      { kind: "principal", principal: "sys:delegations" },
      { kind: "anonymous" },
    ];
    for (const actor of actors) {
      const label = JSON.stringify(actor);
      expect([label, (await enable(t, {}, actor)) as DelegationRefusal]).toMatchObject([
        label,
        { ok: false, code: "forbidden" },
      ]);
      expect([
        label,
        await t.service.propose(t.harness, { action: "merge", actor, cmd: mintId("cmd") }),
      ]).toMatchObject([label, { ok: false, code: "forbidden" }]);
      for (const call of [
        t.service.update(t.harness, {
          rule: mintId("rule"),
          expect: 1,
          consequencesDigest: "0".repeat(64),
          confirm: "codebase-steward",
          actor,
          cmd: mintId("cmd"),
        }),
        t.service.resume(t.harness, {
          rule: mintId("rule"),
          expect: 1,
          consequencesDigest: "0".repeat(64),
          confirm: "codebase-steward",
          actor,
          cmd: mintId("cmd"),
        }),
      ]) {
        expect([label, await call]).toMatchObject([label, { ok: false, code: "forbidden" }]);
      }
    }
    // Nothing was written, not even the digest key.
    expect(treeBytes(t.r.harness)).toEqual(tree);
  });
});

describe("the consequences page binds what an owner agrees to", () => {
  test("a stale digest answers the page as it is now; a wrong name is refused", async () => {
    const t = await setup();
    const first = await t.service.enable(t.harness, {
      action: "merge",
      consequencesDigest: "0".repeat(64),
      confirm: "codebase-steward",
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    expect(first).toMatchObject({ ok: false, code: "precondition-failed" });
    const page = (first as DelegationRefusal).page;
    expect(page?.consequencesDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(page?.text).toContain("Let codebase-steward merge its own pull requests");
    for (const confirm of ["", "Codebase-Steward", "someone-else"]) {
      expect(
        await t.service.enable(t.harness, {
          action: "merge",
          consequencesDigest: page?.consequencesDigest as string,
          confirm,
          actor: OWNER_LOCAL,
          cmd: mintId("cmd"),
        }),
      ).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(readDelegations(t.r.harness)).toEqual({ state: "absent" });
    const ok = await t.service.enable(t.harness, {
      action: "merge",
      consequencesDigest: page?.consequencesDigest as string,
      confirm: "codebase-steward",
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    expect(ok.ok).toBe(true);
    // A new active deployment makes a new page: the old digest no longer turns one on.
    await deploy(t.r.harness, {
      ceiling: { maxDays: 30, merge: {} },
      active: true,
      policy: POLICY_2,
      at: NOW + 1,
    });
    expect(
      await t.service.enable(t.harness, {
        action: "merge",
        consequencesDigest: page?.consequencesDigest as string,
        confirm: "codebase-steward",
        actor: OWNER_LOCAL,
        cmd: mintId("cmd"),
      }),
    ).toMatchObject({ ok: false, code: "precondition-failed" });
  });

  test("enabling from a request grants that request once; a person cannot grant it as a rule", async () => {
    const t = await setup();
    await t.service.propose(t.harness, {
      action: "merge",
      terms: { days: 7 },
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    const read = readProposals(t.r.harness);
    const proposal = read.state === "present" ? (read.rows[0]?.id as string) : "";
    const grant = await t.r.service.decisions.resolve({
      harnessDir: t.r.harness,
      ref: proposal,
      choice: "grant",
      actor: OWNER_LOCAL,
      via: "cli",
    });
    expect(grant).toMatchObject({ outcome: "invalid" });
    expect(grant.reason).toContain(`crewhaus delegations enable merge --proposal ${proposal}`);
    const preview = await t.service.preview(t.harness, { action: "merge", terms: { days: 7 } });
    const first = await t.service.enable(t.harness, {
      action: "merge",
      terms: { days: 7 },
      consequencesDigest: preview.ok ? (preview.page.consequencesDigest ?? "0".repeat(64)) : "",
      confirm: "codebase-steward",
      proposal,
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    // Filing the request made the harness's key, so the page read before has its digest.
    const digest = first.ok
      ? preview.ok
        ? (preview.page.consequencesDigest as string)
        : ""
      : ((first as DelegationRefusal).page?.consequencesDigest as string);
    const enabled = first.ok
      ? first
      : await t.service.enable(t.harness, {
          action: "merge",
          terms: { days: 7 },
          consequencesDigest: digest,
          confirm: "codebase-steward",
          proposal,
          actor: OWNER_LOCAL,
          cmd: mintId("cmd"),
        });
    expect(enabled).toMatchObject({ ok: true, proposal });
    const after = readProposals(t.r.harness);
    expect(after.state === "present" && after.rows[0]).toMatchObject({
      state: "granted",
      rule: enabled.ok ? enabled.rule?.id : "",
    });
    expect(enabled.ok && enabled.rule?.decision).toBe(proposal);
    const again = await t.service.enable(t.harness, {
      action: "merge",
      terms: { days: 7 },
      consequencesDigest: digest,
      confirm: "codebase-steward",
      proposal,
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    expect(again).toMatchObject({ ok: false, code: "already-decided" });
    // A request is denied as before.
    await t.service.propose(t.harness, { action: "merge", actor: OWNER_LOCAL, cmd: mintId("cmd") });
    const pending = readProposals(t.r.harness);
    const second =
      pending.state === "present" ? pending.rows.find((r) => r.state === "pending")?.id : undefined;
    expect(
      await t.r.service.decisions.resolve({
        harnessDir: t.r.harness,
        ref: second as string,
        choice: "deny",
        actor: OWNER_LOCAL,
        via: "cli",
      }),
    ).toMatchObject({ outcome: "decided" });
  });
});

describe("a rule stays inside the ceiling", () => {
  test("too long, out of the ceiling, or naming gates is refused, and every required gate is still asked", async () => {
    const t = await setup({ ceiling: { maxDays: 20, merge: {} } });
    for (const terms of [
      { days: 21 },
      { days: 91 },
      { scope: { gates: ["scope"] } },
      { scope: { repositories: ["x"] } },
    ]) {
      expect([JSON.stringify(terms), await enable(t, terms as never)]).toMatchObject([
        JSON.stringify(terms),
        { ok: false, code: "invalid" },
      ]);
    }
    const ruleId = ruleOf(await enable(t, { days: 20 }));
    t.s.verdicts.held_out = { outcome: "fail", reason: "checks_failed" };
    await decision(t.r.harness);
    await apply(t);
    const checked = linesOf(t.r.harness).find((l) => l.event === "checked");
    expect(checked?.gates?.map((g) => g.gate)).toEqual(["scope", "held_out"]);
    expect(ruleState(t.r.harness, ruleId)?.terms).toEqual({ days: 20 });
  });

  test("a ceiling only on a prepared deployment, or none at all, allows nothing", async () => {
    for (const options of [
      { active: false },
      { ceiling: null },
      { ceiling: { maxDays: 30 } },
    ] as const) {
      const t = await setup(options);
      expect(await enable(t)).toMatchObject({ ok: false, code: "not-allowed" });
      const list = t.service.list(t.harness);
      expect(list.offers).toEqual([]);
    }
  });

  test("deployment records that cannot be read say so, never that the agreement forbids it", async () => {
    const t = await setup({ ceiling: null, active: false });
    const file = join(t.r.harness, controlPaths(t.r.harness).deploymentsFile);
    rmSync(file, { recursive: true, force: true });
    mkdirSync(file, { recursive: true });
    const listed = t.service.list(t.harness);
    expect(listed.empty).toMatchObject({
      reason: "unreadable",
      verb: `crewhaus delegations list --harness ${HRN}`,
    });
    expect(listed.empty?.remedy).toContain("cannot be read");
    expect(listed.unreadable.length).toBeGreaterThan(0);
  });

  test("the shipped composition serves no action, so every action is unsupported", async () => {
    const r = rig();
    await deploy(r.harness, {
      ceiling: { maxDays: 30, merge: {} },
      active: true,
      policy: POLICY,
      at: NOW,
    });
    const harness = { dir: r.harness, id: HRN, name: "codebase-steward" };
    for (const action of ["merge", "rollout", "adopt", "assistant"] as const) {
      const answer = await r.service.delegations.preview(harness, { action });
      expect([action, answer]).toMatchObject([action, { ok: false, code: "unsupported" }]);
    }
    expect(
      (await r.service.delegations.preview(harness, { action: "merge" })) as DelegationRefusal,
    ).toMatchObject({
      reason: NOTHING_DELEGABLE,
    });
    expect(r.service.delegations.list(harness)).toMatchObject({
      items: [],
      offers: [],
      empty: { reason: "no-data" },
      ceiling: { present: true, maxDays: 30 },
    });
  });
});

describe("the delegated path", () => {
  test("every gate passing: decided as the rule's, acted once under its authority", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    const summary = await apply(t);
    expect(summary).toMatchObject({ ran: true, decided: 1 });
    const row = decisionRow(t.r.harness, d.id);
    expect(row).toMatchObject({
      state: "consumed",
      decision: "grant",
      resolvedBy: "delegation",
      delegation: { rule: ruleId, revision: 1 },
      appliedBy: "sys:scheduler",
    });
    expect(row).not.toHaveProperty("decidedByPrincipal");
    // The pass that acted opens the action's watch.
    expect(events(t.r.harness)).toEqual([
      "checked",
      "planned",
      "decided",
      "acted",
      "watch-started",
    ]);
    expect(t.s.effects).toBe(1);
    const receipts = rowsOf(commandsLedgerOf(t.r.harness)).filter(
      (r) => r["kind"] === KINDS.execute,
    );
    const final = receipts.at(-1) as Record<string, unknown>;
    expect(final).toMatchObject({
      actor: "sys:executor",
      via: "system",
      target: `${HRN}/decision/${d.id}`,
      state: "succeeded",
      authority: { kind: "delegation", rule: ruleId, revision: 1 },
    });
    // The rollback was planned before the effect, and the next pass opens the watch.
    const planned = linesOf(t.r.harness).find((l) => l.event === "planned");
    expect(planned?.plan).toMatchObject({ kind: "revert" });
    await apply(t);
    expect(events(t.r.harness)).toHaveLength(5);
    const listed = t.service.list(t.harness);
    expect(listed.items[0]).toMatchObject({ id: ruleId, state: "active", uses: 1 });
    const detail = t.service.get(t.harness, ruleId);
    const decided = detail.ok ? detail.detail.log.find((l) => l.event === "decided") : undefined;
    expect(decided?.decidedByText).toContain(
      "Decided by delegation rule Merges its own pull requests (revision 1)",
    );
  });

  test("a failing held-out gate refuses: every verdict but a fresh pass for this revision", async () => {
    const cases: readonly [string, Partial<GateVerdict> | "throw"][] = [
      ["fail", { outcome: "fail", reason: "checks_failed" }],
      ["not-comparable", { outcome: "not-comparable" }],
      ["not-run", { outcome: "not-run" }],
      ["pending", { outcome: "pending" }],
      ["unknown", { outcome: "unknown" }],
      ["stale", { freshUntil: new Date(NOW - 1).toISOString() }],
      ["another revision", { boundTo: `sha256:${"f".repeat(64)}` }],
      ["a gate that throws", "throw"],
    ];
    for (const [name, verdict] of cases) {
      const t = await setup();
      ruleOf(await enable(t));
      t.s.verdicts.held_out = verdict;
      const d = await decision(t.r.harness);
      await apply(t);
      const lines = linesOf(t.r.harness);
      expect([name, lines.map((l) => l.event)]).toEqual([name, ["checked", "refused"]]);
      expect([name, lines[1]?.reason]).toEqual([
        name,
        name === "pending" ? "gates-pending" : "gates-refused",
      ]);
      expect(lines[1]?.gates).toHaveLength(2);
      expect([name, t.s.effects, decisionRow(t.r.harness, d.id)?.state]).toEqual([
        name,
        0,
        "pending",
      ]);
      // Asked again with nothing changed, nothing new is written.
      await apply(t);
      expect(linesOf(t.r.harness)).toHaveLength(2);
    }
  });

  test("first decision wins", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    const granted = await decision(t.r.harness);
    await t.r.service.decisions.resolve({
      harnessDir: t.r.harness,
      ref: granted.id,
      choice: "grant",
      actor: OWNER_LOCAL,
      via: "cli",
    });
    const denied = await decision(t.r.harness);
    await t.r.service.decisions.resolve({
      harnessDir: t.r.harness,
      ref: denied.id,
      choice: "deny",
      actor: OWNER_LOCAL,
      via: "cli",
    });
    await apply(t);
    expect(t.s.effects).toBe(0);
    expect(decisionRow(t.r.harness, granted.id)).toMatchObject({ state: "granted" });
    expect(decisionRow(t.r.harness, granted.id)?.resolvedBy).toBeUndefined();
    expect(decisionRow(t.r.harness, denied.id)).toMatchObject({ state: "denied" });

    const once = await decision(t.r.harness);
    await Promise.all([apply(t), apply(t)]);
    expect(t.s.effects).toBe(1);
    expect(
      linesOf(t.r.harness).filter((l) => l.event === "decided" && l.decision === once.id),
    ).toHaveLength(1);

    const raced = await decision(t.r.harness);
    const rule = readDelegations(t.r.harness);
    const id = rule.state === "present" ? (rule.rows[0]?.id as string) : "";
    const answers = await Promise.all(
      [1, 2].map(() =>
        t.r.service.decisions.resolveDelegated({
          harnessDir: t.r.harness,
          ref: raced.id,
          delegation: { rule: id, revision: 1 },
          appliedBy: "sys:scheduler",
        }),
      ),
    );
    expect(answers.map((a) => a.outcome).sort()).toEqual(["already-decided", "decided"]);
  });
});

describe("expiry", () => {
  test("past the end it is not applied, reads expired, and is recorded once", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const rule = ruleState(t.r.harness, ruleId);
    expect(Date.parse(rule?.expiresAt as string) - NOW).toBe(14 * 86_400_000);
    await decision(t.r.harness);
    t.r.clock.now = Date.parse(rule?.expiresAt as string);
    expect(t.service.list(t.harness).items[0]?.state).toBe("expired");
    await apply(t);
    expect(t.s.effects).toBe(0);
    const file = join(t.r.harness, controlPaths(t.r.harness).delegationsFile);
    const count = () => readFileSync(file, "utf8").trim().split("\n").length;
    expect(ruleState(t.r.harness, ruleId)?.state).toBe("expired");
    const rows = count();
    t.r.clock.now += 2000;
    await apply(t);
    expect(count()).toBe(rows);
  });

  test("at its use cap it is exhausted", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t, { maxUses: 1 }));
    await decision(t.r.harness);
    await apply(t);
    expect(t.s.effects).toBe(1);
    await decision(t.r.harness);
    t.r.clock.now += 2000;
    await apply(t);
    expect(t.s.effects).toBe(1);
    expect(ruleState(t.r.harness, ruleId)?.state).toBe("exhausted");
  });
});

describe("revocation", () => {
  test("revoked, a pass a second later applies nothing", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    await apply(t);
    const d = await decision(t.r.harness);
    expect(
      await t.service.revoke(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") }),
    ).toMatchObject({ ok: true });
    t.r.clock.now += 1000;
    await apply(t);
    expect(t.s.effects).toBe(0);
    expect(decisionRow(t.r.harness, d.id)?.state).toBe("pending");
  });

  test("revoked while a gate answers: the decision is not applied", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    t.s.duringGate = async () => {
      t.s.duringGate = undefined;
      await t.service.revoke(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") });
    };
    await apply(t);
    expect(t.s.effects).toBe(0);
    expect(decisionRow(t.r.harness, d.id)?.state).toBe("pending");
  });

  test("revoked after the grant and before the effect: the effect refuses and a person is asked again", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    t.s.duringPlan = async () => {
      t.s.duringPlan = undefined;
      // A pause the cache has not seen: only the effect's own read sees it.
      await t.service.pause(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") });
    };
    await apply(t);
    expect(t.s.effects).toBe(0);
    const row = decisionRow(t.r.harness, d.id);
    expect(row).toMatchObject({ state: "superseded", supersededReason: "rule-revoked" });
    const fresh = decisionRow(t.r.harness, row?.supersededBy as string);
    expect(fresh).toMatchObject({ state: "pending", kind: "merge", subject: d.subject });
    expect(linesOf(t.r.harness).at(-1)).toMatchObject({ event: "refused", reason: "rule-revoked" });
  });

  test("a subject moved since the grant is asked again at its new revision", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    t.s.duringPlan = async () => {
      t.s.revision = `sha256:${"b".repeat(64)}`;
    };
    await apply(t);
    expect(t.s.effects).toBe(0);
    const row = decisionRow(t.r.harness, d.id);
    expect(row?.supersededReason).toBe("revision-changed");
    expect(decisionRow(t.r.harness, row?.supersededBy as string)?.subject.revision).toBe(
      `sha256:${"b".repeat(64)}`,
    );
  });
});

describe("the effect checks again before it acts", () => {
  /** What changed between the grant and the effect leaves the grant unspent and asks a person. */
  async function refusedAtEffect(
    t: Awaited<ReturnType<typeof setup>>,
    reason: string,
    supersede: string,
  ) {
    const d = await decision(t.r.harness);
    await apply(t);
    expect(t.s.effects).toBe(0);
    const row = decisionRow(t.r.harness, d.id);
    expect(row).toMatchObject({
      state: "superseded",
      resolvedBy: "delegation",
      supersededReason: supersede,
    });
    expect(decisionRow(t.r.harness, row?.supersededBy as string)).toMatchObject({
      state: "pending",
      kind: "merge",
      subject: d.subject,
    });
    const mine = linesOf(t.r.harness).filter((l) => l.decision === d.id);
    expect(mine.at(-1)).toMatchObject({ event: "refused", reason });
    // The executor's refusal is the one answer for the decision.
    expect(mine.filter((l) => l.event === "refused")).toHaveLength(1);
    expect(mine.map((l) => l.event)).not.toContain("acted");
  }

  test("the operator paused intake after the grant: paused", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    t.s.duringPlan = async () => {
      t.s.duringPlan = undefined;
      await writeOperatorRecord(t.r.harness, { intake: { paused: true } });
    };
    await refusedAtEffect(t, "paused", "paused");
  });

  test("the owner was demoted after the grant: the rule no longer holds", async () => {
    const t = await setup();
    const owner = await setUpOwner(t.r.hangarRoot);
    plantProjection(t.r.harness, owner);
    ruleOf(await enable(t));
    t.s.duringPlan = async () => {
      t.s.duringPlan = undefined;
      plantProjection(t.r.harness, mintId("prn"), [{ principal: owner, decide: "maintainer" }]);
    };
    await refusedAtEffect(t, "rule-revoked", "rule-revoked");
  });

  test("another build was activated after the grant: its policy or ceiling no longer binds", async () => {
    for (const ceiling of [
      { maxDays: 30, merge: {} },
      { maxDays: 20, merge: {} },
    ]) {
      const t = await setup();
      ruleOf(await enable(t));
      t.s.duringPlan = async () => {
        t.s.duringPlan = undefined;
        await deploy(t.r.harness, { ceiling, active: true, policy: POLICY_2, at: NOW + 5 });
      };
      await refusedAtEffect(t, "rule-revoked", "rule-revoked");
    }
  });

  test("another action started after the grant: one at a time, a person is asked", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    t.s.duringPlan = async () => {
      t.s.duringPlan = undefined;
      t.s.oneAtATime = false;
    };
    await refusedAtEffect(t, "one-at-a-time", "re-asked");
  });

  test("the rule's last use was spent after the grant: used up, never called revoked", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t, { maxUses: 1 }));
    t.s.duringPlan = async () => {
      t.s.duringPlan = undefined;
      await appendDelegationLog(t.r.harness, {
        v: 1,
        at: new Date(NOW).toISOString(),
        event: "acted",
        rule: ruleId,
        revision: 1,
        cmd: mintId("cmd"),
      });
    };
    await refusedAtEffect(t, "uses-exhausted", "re-asked");
  });
});

describe("a pass sees what it just did", () => {
  test("at a cap of one use, two waiting decisions: one is decided, the other waits", async () => {
    const t = await setup();
    ruleOf(await enable(t, { maxUses: 1 }));
    const a = await decision(t.r.harness);
    const b = await decision(t.r.harness);
    const summary = await apply(t);
    expect(summary).toMatchObject({ decided: 1 });
    expect(t.s.effects).toBe(1);
    expect(decisionRow(t.r.harness, a.id)?.state).toBe("consumed");
    expect(decisionRow(t.r.harness, b.id)).toMatchObject({ state: "pending" });
    expect(decisionRow(t.r.harness, b.id)?.resolvedBy).toBeUndefined();
    // Its rule is used up: no rule applies to it, so nothing is logged against it.
    expect(linesOf(t.r.harness).filter((l) => l.decision === b.id)).toEqual([]);
    expect(linesOf(t.r.harness).filter((l) => l.event === "decided")).toHaveLength(1);
  });

  test("an action that waits for the last one to act runs once per pass", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    const seen: string[][] = [];
    t.s.oneAtATime = (log) => {
      seen.push(log.map((l) => l.event));
      return !log.some((l) => l.event === "acted");
    };
    const a = await decision(t.r.harness);
    const b = await decision(t.r.harness);
    expect(await apply(t)).toMatchObject({ decided: 1 });
    expect(t.s.effects).toBe(1);
    expect(decisionRow(t.r.harness, a.id)?.state).toBe("consumed");
    expect(decisionRow(t.r.harness, b.id)?.state).toBe("pending");
    // The second decision was shown the first one's effect.
    expect(seen.at(-1)).toContain("acted");
  });
});

/**
 * Hold every effect until either pass settles, and for 200 ms at most: a second effect
 * that starts while the first is held shows as a count, never as a timeout.
 */
function holdEffects(t: Awaited<ReturnType<typeof setup>>): () => void {
  const held = deferred();
  const timer = setTimeout(held.open, 200);
  t.s.duringEffect = () => held.promise;
  return () => {
    clearTimeout(timer);
    held.open();
  };
}

/** Two passes at once, each releasing the held effects when it settles. */
async function racedPasses(t: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const release = holdEffects(t);
  await Promise.all([apply(t).finally(release), apply(t).finally(release)]);
}

/** A decision a person decides again: superseded, with a pending one in its place. */
function handedBack(t: Awaited<ReturnType<typeof setup>>, id: string, reason: string): void {
  const row = decisionRow(t.r.harness, id);
  expect(row).toMatchObject({ state: "superseded", supersededReason: reason });
  expect(decisionRow(t.r.harness, row?.supersededBy as string)).toMatchObject({
    state: "pending",
    kind: "merge",
  });
}

describe("a use is counted when it is claimed", () => {
  test("two passes at once under a cap of one use act once, and leave no claim open", async () => {
    const t = await setup();
    ruleOf(await enable(t, { maxUses: 1 }));
    const a = await decision(t.r.harness);
    const b = await decision(t.r.harness);
    await racedPasses(t);
    expect(t.s.effects).toBe(1);
    const lines = linesOf(t.r.harness);
    const acted = lines.filter((l) => l.event === "acted");
    expect(acted).toHaveLength(1);
    const decided = lines.filter((l) => l.event === "decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.decision).toBe(acted[0]?.decision as string);
    const other = acted[0]?.decision === a.id ? b : a;
    expect(decisionRow(t.r.harness, acted[0]?.decision as string)?.state).toBe("consumed");
    const theirs = lines.filter((l) => l.decision === other.id);
    if (theirs.length > 0) {
      expect(theirs.at(-1)).toMatchObject({ event: "refused", reason: "uses-exhausted" });
    }
    const row = decisionRow(t.r.harness, other.id);
    expect(row?.state).not.toBe("consumed");
    if (row?.state === "superseded") handedBack(t, other.id, "re-asked");
    else expect(row?.state).toBe("pending");
  });

  test("two passes at once for a one-at-a-time action act once", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    t.s.oneAtATime = (log) => !log.some((l) => l.event === "acted");
    const a = await decision(t.r.harness);
    const b = await decision(t.r.harness);
    await racedPasses(t);
    expect(t.s.effects).toBe(1);
    const lines = linesOf(t.r.harness);
    expect(lines.filter((l) => l.event === "acted")).toHaveLength(1);
    const states = [a, b].map((d) => decisionRow(t.r.harness, d.id)?.state);
    expect(states.filter((state) => state === "consumed")).toHaveLength(1);
  });

  test("an action whose outcome is unknown keeps its use until it is settled", async () => {
    const outcomes: readonly [string, () => Promise<Settlement>][] = [
      [
        "a run that throws",
        async () => {
          throw new Error("the host stopped answering");
        },
      ],
      ["a run that settles unknown", async () => ({ state: "unknown" })],
    ];
    for (const [name, run] of outcomes) {
      const t = await setup();
      const ruleId = ruleOf(await enable(t, { maxUses: 1 }));
      t.s.run = run;
      const d = await decision(t.r.harness);
      await apply(t);
      expect([
        name,
        linesOf(t.r.harness)
          .filter((l) => l.decision === d.id)
          .map((l) => l.event),
      ]).toEqual([name, ["checked", "planned", "decided", "outcome-unknown"]]);
      expect(events(t.r.harness)).not.toContain("refused");
      expect(events(t.r.harness)).not.toContain("watch-started");
      const unknown = linesOf(t.r.harness).find((l) => l.event === "outcome-unknown");
      expect(unknown?.cmd).toBeDefined();
      expect(unknown?.reason).toBeUndefined();
      const second = await decision(t.r.harness);
      t.r.clock.now += 2000;
      await apply(t);
      expect([name, t.s.effects]).toEqual([name, 1]);
      expect(decisionRow(t.r.harness, second.id)?.state).toBe("pending");
      expect(t.service.list(t.harness).items[0]).toMatchObject({ uses: 1, state: "exhausted" });
      // The rule's row is ended only by settled uses.
      expect(ruleState(t.r.harness, ruleId)?.state).toBe("enabled");
    }
  });

  test("an action whose outcome is unknown holds one at a time", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    t.s.oneAtATime = (log) => !log.some((l) => l.event === "acted");
    t.s.run = async () => ({ state: "unknown" });
    await decision(t.r.harness);
    await apply(t);
    const second = await decision(t.r.harness);
    t.r.clock.now += 2000;
    await apply(t);
    expect(t.s.effects).toBe(1);
    expect(decisionRow(t.r.harness, second.id)?.state).toBe("pending");
  });

  /**
   * Hold every executor where it reads the subject's revision until two have arrived (or
   * 200 ms passed), so both have read everything outside the lock before either claims.
   */
  function meetBeforeClaim(t: Awaited<ReturnType<typeof setup>>): () => number {
    const met = deferred();
    const timer = setTimeout(met.open, 200);
    let arrived = 0;
    t.s.duringRevision = async () => {
      arrived += 1;
      if (arrived >= 2) {
        clearTimeout(timer);
        met.open();
      }
      await met.promise;
    };
    return () => arrived;
  }

  test("two executors that both read before either claims act once, under a cap or one at a time", async () => {
    for (const rule of ["a cap of one use", "one at a time"] as const) {
      const t = await setup();
      ruleOf(await enable(t, rule === "a cap of one use" ? { maxUses: 1 } : {}));
      if (rule === "one at a time") t.s.oneAtATime = (log) => !log.some((l) => l.event === "acted");
      await decision(t.r.harness);
      await decision(t.r.harness);
      const arrived = meetBeforeClaim(t);
      await racedPasses(t);
      expect([rule, arrived()]).toEqual([rule, 2]);
      expect([rule, t.s.effects]).toEqual([rule, 1]);
      const lines = linesOf(t.r.harness);
      expect([rule, lines.filter((l) => l.event === "acted").length]).toEqual([rule, 1]);
      expect([rule, lines.filter((l) => l.event === "decided").length]).toEqual([rule, 1]);
    }
  });

  test("a claim that cannot be written: nothing is spent, nothing acts, and a person decides", async () => {
    if (process.getuid?.() === 0) return; // root writes through a read-only file
    const t = await setup();
    ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    const locked: string[] = [];
    t.s.duringRevision = async () => {
      t.s.duringRevision = undefined;
      lockLog(t.r.harness, locked);
    };
    let summary: Awaited<ReturnType<typeof apply>>;
    try {
      summary = await apply(t);
    } finally {
      for (const file of locked) chmodSync(file, 0o644);
    }
    expect(locked.length).toBeGreaterThan(0);
    expect(t.s.effects).toBe(0);
    expect(summary).toMatchObject({ decided: 1, refused: 1 });
    // The grant was never consumed: it went back to a person.
    handedBack(t, d.id, "re-asked");
    expect(events(t.r.harness)).not.toContain("decided");
  });

  test("a second execute for a claimed decision writes nothing, and its claim still counts", async () => {
    for (const rule of ["a cap of one use", "one at a time"] as const) {
      const t = await setup();
      const ruleId = ruleOf(await enable(t, rule === "a cap of one use" ? { maxUses: 1 } : {}));
      if (rule === "one at a time") t.s.oneAtATime = (log) => !log.some((l) => l.event === "acted");
      const d1 = await decision(t.r.harness);
      const held = deferred();
      // A safety net only: the test opens it itself once the second pass is done.
      const timer = setTimeout(held.open, 2_000);
      let started!: () => void;
      const acting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let running = 0;
      let maxRunning = 0;
      t.s.duringEffect = async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        started();
        await held.promise;
        running -= 1;
      };
      const first = apply(t);
      await acting;
      // The same decision is sent to its executor again while its effect runs.
      const again = await t.r.service.commands.submit({
        kind: KINDS.execute,
        actor: "sys:executor",
        target: `${HRN}/decision/${d1.id}`,
        ledger: { harness: t.r.harness },
        via: "system",
        authority: { kind: "delegation", rule: ruleId, revision: 1 },
      });
      expect(again.ok).toBe(true);
      expect(
        linesOf(t.r.harness)
          .filter((l) => l.decision === d1.id)
          .map((l) => l.event),
      ).toEqual(["checked", "planned", "decided"]);
      const d2 = await decision(t.r.harness);
      t.r.clock.now += 2000;
      await apply(t);
      expect([rule, t.s.effects, maxRunning]).toEqual([rule, 1, 1]);
      expect(decisionRow(t.r.harness, d2.id)?.state).not.toBe("consumed");
      clearTimeout(timer);
      held.open();
      await first;
      expect(
        linesOf(t.r.harness)
          .filter((l) => l.decision === d1.id)
          .map((l) => l.event),
      ).toEqual(["checked", "planned", "decided", "acted", "watch-started"]);
    }
  });

  test("a refusal another pass logs for a claimed decision does not free the cap", async () => {
    const t = await setup();
    ruleOf(await enable(t, { maxUses: 1 }));
    const d1 = await decision(t.r.harness);
    await decision(t.r.harness);
    const release = holdEffects(t);
    const holding = t.s.duringEffect;
    const acting = deferred();
    t.s.duringEffect = async () => {
      acting.open();
      await holding?.();
    };
    const real = t.action.planRollback;
    let d1Plans = 0;
    (t.action as { planRollback: typeof real }).planRollback = async (subject, ctx) => {
      if (subject.ref === d1.subject.ref) {
        d1Plans += 1;
        if (d1Plans === 2) {
          // The other pass plans d1 once d1 is acting, and cannot plan it: it logs a
          // refusal of its own for d1.
          await Promise.race([acting.promise, Bun.sleep(1_000)]);
          return undefined;
        }
      }
      return real(subject, ctx);
    };
    await Promise.all([apply(t).finally(release), apply(t).finally(release)]);
    expect(d1Plans).toBe(2);
    expect(
      linesOf(t.r.harness).some(
        (l) => l.decision === d1.id && l.event === "refused" && l.cmd === undefined,
      ),
    ).toBe(true);
    expect(t.s.effects).toBe(1);
  });
});

describe("a change that lands while the effect reads the subject wins", () => {
  test("a revoke, a member's pause or a new revision of the rule: nothing acts", async () => {
    const changes = {
      revoke: async (t: Awaited<ReturnType<typeof setup>>, rule: string) => {
        expect(
          await t.service.revoke(t.harness, { rule, actor: OWNER_LOCAL, cmd: mintId("cmd") }),
        ).toMatchObject({ ok: true });
      },
      pause: async (t: Awaited<ReturnType<typeof setup>>, rule: string) => {
        expect(
          await t.service.pause(t.harness, { rule, actor: OWNER_LOCAL, cmd: mintId("cmd") }),
        ).toMatchObject({ ok: true });
      },
      change: async (t: Awaited<ReturnType<typeof setup>>, rule: string) => {
        const page = await t.service.previewRule(t.harness, {
          rule,
          mode: "change",
          terms: { days: 3 },
        });
        if (!page.ok) throw new Error("no page");
        expect(
          await t.service.update(t.harness, {
            rule,
            expect: 1,
            terms: { days: 3 },
            consequencesDigest: page.page.consequencesDigest as string,
            confirm: "codebase-steward",
            actor: OWNER_LOCAL,
            cmd: mintId("cmd"),
          }),
        ).toMatchObject({ ok: true });
      },
    } as const;
    for (const [name, land] of Object.entries(changes)) {
      const t = await setup();
      const ruleId = ruleOf(await enable(t, { maxUses: 5 }));
      const d = await decision(t.r.harness);
      let calls = 0;
      t.s.duringRevision = async () => {
        calls += 1;
        await land(t, ruleId);
      };
      await apply(t);
      expect([name, calls]).toEqual([name, 1]);
      expect([name, t.s.effects]).toEqual([name, 0]);
      expect([name, decisionRow(t.r.harness, d.id)?.state]).not.toEqual([name, "consumed"]);
      const mine = linesOf(t.r.harness).filter((l) => l.decision === d.id);
      expect([name, mine.some((l) => l.event === "decided")]).toEqual([name, false]);
      expect([name, mine.at(-1)?.event]).toEqual([name, "refused"]);
    }
  });
});

describe("every grant acts, goes back to a person, or stays counted", () => {
  /** The rig's delegation service with an execute submit that never reaches the executor. */
  function undispatched(t: Awaited<ReturnType<typeof setup>>, answer: "refused" | "accepted") {
    const submit: typeof t.r.service.commands.submit = async (request, effect) => {
      if (request.kind !== KINDS.execute) return t.r.service.commands.submit(request, effect);
      if (answer === "accepted") {
        return t.r.service.commands.submit({ ...request, queued: true }, effect);
      }
      return {
        ok: false,
        refusal: { code: "unavailable", message: "the receipt could not be written" },
      } as never;
    };
    return createDelegations({
      hangarRoot: t.r.hangarRoot,
      identity: IDENTITY,
      now: () => t.r.clock.now,
      decisions: t.r.service.decisions,
      commands: { submit },
      actions: [t.action],
    });
  }

  for (const answer of ["refused", "accepted"] as const) {
    test(`a grant the executor never answered goes back to a person (submit ${answer})`, async () => {
      const t = await setup();
      ruleOf(await enable(t));
      const d = await decision(t.r.harness);
      const summary = await undispatched(t, answer).apply(t.harness, {
        appliedBy: "sys:scheduler",
      });
      expect(summary).toMatchObject({ decided: 1, refused: 1 });
      expect(t.s.effects).toBe(0);
      handedBack(t, d.id, "re-asked");
      const mine = linesOf(t.r.harness).filter((l) => l.decision === d.id);
      expect(mine.at(-1)).toMatchObject({ event: "refused", reason: "not-dispatched" });
      expect(mine.map((l) => l.event)).not.toContain("decided");
    });
  }

  test("a rule that is not on record at the effect: nothing acts and a person decides", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    const ghost = mintId("rule");
    const granted = await t.r.service.decisions.resolveDelegated({
      harnessDir: t.r.harness,
      ref: d.id,
      delegation: { rule: ghost, revision: 1 },
      appliedBy: "sys:scheduler",
    });
    expect(granted.outcome).toBe("decided");
    await t.r.service.commands.submit({
      kind: KINDS.execute,
      actor: "sys:executor",
      target: `${HRN}/decision/${d.id}`,
      ledger: { harness: t.r.harness },
      via: "system",
      authority: { kind: "delegation", rule: ghost, revision: 1 },
    });
    expect(t.s.effects).toBe(0);
    expect(linesOf(t.r.harness).filter((l) => l.decision === d.id)).toEqual([
      expect.objectContaining({ event: "refused", reason: "rule-revoked", rule: ghost }),
    ]);
    handedBack(t, d.id, "rule-revoked");
  });

  test("a decision that is not on record at the effect: nothing acts, and it is logged", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const missing = mintId("dec");
    await t.r.service.commands.submit({
      kind: KINDS.execute,
      actor: "sys:executor",
      target: `${HRN}/decision/${missing}`,
      ledger: { harness: t.r.harness },
      via: "system",
      authority: { kind: "delegation", rule: ruleId, revision: 1 },
    });
    expect(t.s.effects).toBe(0);
    expect(linesOf(t.r.harness)).toEqual([
      expect.objectContaining({
        event: "refused",
        reason: "decision-missing",
        rule: ruleId,
        decision: missing,
      }),
    ]);
  });
});

describe("terms are kept, and a request is answered on its own terms", () => {
  const TERMS_SENTENCE =
    "This request asked for other terms: answer it as asked, or turn on a new rule.";

  test("a change that gives only a length keeps the use cap and the scope", async () => {
    const t = await setup();
    t.s.scopeFields = { branches: () => undefined };
    const ruleId = ruleOf(await enable(t, { maxUses: 3, scope: { branches: ["main"] } }));
    const short = await t.service.previewRule(t.harness, {
      rule: ruleId,
      mode: "change",
      terms: { days: 7 },
    });
    const whole = await t.service.previewRule(t.harness, {
      rule: ruleId,
      mode: "change",
      terms: { days: 7, maxUses: 3, scope: { branches: ["main"] } },
    });
    if (!short.ok || !whole.ok) throw new Error("no page");
    expect(short.page.consequencesDigest).toBeDefined();
    expect(short.page.consequencesDigest).toBe(whole.page.consequencesDigest as string);
    const changed = await t.service.update(t.harness, {
      rule: ruleId,
      expect: 1,
      terms: { days: 7 },
      consequencesDigest: short.page.consequencesDigest as string,
      confirm: "codebase-steward",
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    expect(changed).toMatchObject({ ok: true });
    const row = ruleState(t.r.harness, ruleId);
    expect(row?.revision).toBe(2);
    expect(row?.maxUses).toBe(3);
    expect(row?.terms).toEqual({ days: 7, maxUses: 3, scope: { branches: ["main"] } });
  });

  test("a request is turned on only with the terms it asked for", async () => {
    const t = await setup();
    const proposed = await t.service.propose(t.harness, {
      action: "merge",
      terms: { days: 7, maxUses: 2 },
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    const proposal = proposed.proposal as string;
    expect(t.service.list(t.harness).proposals[0]).toMatchObject({
      id: proposal,
      days: 7,
      maxUses: 2,
    });
    const ask = (consequencesDigest: string) =>
      t.service.enable(t.harness, {
        action: "merge",
        terms: { maxUses: 3 },
        consequencesDigest,
        confirm: "codebase-steward",
        actor: OWNER_LOCAL,
        cmd: mintId("cmd"),
        proposal,
      });
    const first = await ask("0".repeat(64));
    expect(first).toMatchObject({
      ok: false,
      code: "precondition-failed",
      reason: TERMS_SENTENCE,
    });
    const digest = first.ok ? undefined : first.page?.consequencesDigest;
    expect(digest).toBeDefined();
    expect(await ask(digest as string)).toMatchObject({ ok: false, reason: TERMS_SENTENCE });
    const waiting = readProposals(t.r.harness);
    expect(
      waiting.state === "present" ? waiting.rows.find((r) => r.id === proposal)?.state : undefined,
    ).toBe("pending");
    expect(readDelegations(t.r.harness)).toMatchObject({ state: "absent" });

    const answered = await enable(t, { days: 7 }, OWNER_LOCAL, proposal);
    expect(answered).toMatchObject({ ok: true, proposal });
    const ruleId = ruleOf(answered);
    expect(ruleState(t.r.harness, ruleId)).toMatchObject({
      maxUses: 2,
      terms: { days: 7, maxUses: 2 },
    });
    const done = readProposals(t.r.harness);
    expect(
      done.state === "present" ? done.rows.find((r) => r.id === proposal)?.state : undefined,
    ).toBe("granted");
  });

  test("a request's page is drawn from its own terms, and answering it sends none", async () => {
    const t = await setup();
    t.s.scopeFields = { branches: () => undefined };
    const asked = { days: 7, maxUses: 2, scope: { branches: ["release/hotfix"] } };
    const proposed = await t.service.propose(t.harness, {
      action: "merge",
      terms: asked,
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    const proposal = proposed.proposal as string;
    // The first answer makes the harness's digest key; the page is then read with its digest.
    const first = await t.service.enable(t.harness, {
      action: "merge",
      consequencesDigest: "0".repeat(64),
      confirm: "codebase-steward",
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
      proposal,
    });
    expect(first).toMatchObject({ ok: false, code: "precondition-failed" });
    const page = await t.service.preview(t.harness, { action: "merge", proposal });
    const whole = await t.service.preview(t.harness, { action: "merge", terms: asked });
    if (!page.ok || !whole.ok) throw new Error("no page");
    expect(page.page.consequencesDigest).toBeDefined();
    expect(page.page.consequencesDigest).toBe(whole.page.consequencesDigest as string);
    expect(page.page.consequencesDigest).toBe(
      first.ok ? undefined : (first.page?.consequencesDigest as string),
    );
    const answered = await t.service.enable(t.harness, {
      action: "merge",
      consequencesDigest: page.page.consequencesDigest as string,
      confirm: "codebase-steward",
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
      proposal,
    });
    expect(answered).toMatchObject({ ok: true, proposal });
    expect(ruleState(t.r.harness, ruleOf(answered))?.terms).toEqual(asked);
    // An answered request has no page to draw.
    expect(await t.service.preview(t.harness, { action: "merge", proposal })).toMatchObject({
      ok: false,
      code: "already-decided",
    });
    expect(
      await t.service.preview(t.harness, { action: "merge", proposal: mintId("dec") }),
    ).toMatchObject({ ok: false, code: "not-found" });
  });
});

/** Make every segment of the application log read-only; answers the files it locked. */
function lockLog(harness: string, locked: string[]): void {
  const logDir = join(harness, controlPaths(harness).delegationLogDir);
  for (const name of readdirSync(logDir)) {
    const file = join(logDir, name);
    if (!statSync(file).isFile()) continue;
    chmodSync(file, 0o444);
    locked.push(file);
  }
}

describe("the rollback plan is on disk before anything acts", () => {
  test("a plan that cannot be written: nothing is decided and nothing acts", async () => {
    if (process.getuid?.() === 0) return; // root writes through a read-only file
    const t = await setup();
    ruleOf(await enable(t));
    const d = await decision(t.r.harness);
    const locked: string[] = [];
    t.s.duringPlan = async () => {
      t.s.duringPlan = undefined;
      lockLog(t.r.harness, locked);
    };
    let summary: Awaited<ReturnType<typeof apply>>;
    try {
      summary = await apply(t);
    } finally {
      for (const file of locked) chmodSync(file, 0o644);
    }
    expect(locked.length).toBeGreaterThan(0);
    expect(summary).toMatchObject({ decided: 0, refused: 1 });
    expect(t.s.effects).toBe(0);
    expect(decisionRow(t.r.harness, d.id)?.state).toBe("pending");
    expect(events(t.r.harness)).toEqual(["checked"]);
  });

  test("an action whose record could not be written says so on its receipt", async () => {
    if (process.getuid?.() === 0) return; // root writes through a read-only file
    const t = await setup();
    ruleOf(await enable(t));
    await decision(t.r.harness);
    const locked: string[] = [];
    t.s.duringEffect = async () => {
      t.s.duringEffect = undefined;
      lockLog(t.r.harness, locked);
    };
    try {
      await apply(t);
    } finally {
      for (const file of locked) chmodSync(file, 0o644);
    }
    expect(t.s.effects).toBe(1);
    expect(events(t.r.harness)).not.toContain("acted");
    const final = rowsOf(commandsLedgerOf(t.r.harness))
      .filter((r) => r["kind"] === KINDS.execute)
      .at(-1) as Record<string, unknown>;
    expect(final["effects"]).toContainEqual(
      expect.objectContaining({ kind: "delegation.acted", status: "failed" }),
    );
  });

  test("an action whose unknown outcome could not be recorded says so on its receipt", async () => {
    if (process.getuid?.() === 0) return; // root writes through a read-only file
    const t = await setup();
    ruleOf(await enable(t));
    await decision(t.r.harness);
    t.s.run = async () => ({ state: "unknown" });
    const locked: string[] = [];
    t.s.duringEffect = async () => {
      t.s.duringEffect = undefined;
      lockLog(t.r.harness, locked);
    };
    try {
      await apply(t);
    } finally {
      for (const file of locked) chmodSync(file, 0o644);
    }
    expect(t.s.effects).toBe(1);
    expect(events(t.r.harness)).not.toContain("outcome-unknown");
    const final = rowsOf(commandsLedgerOf(t.r.harness))
      .filter((r) => r["kind"] === KINDS.execute)
      .at(-1) as Record<string, unknown>;
    expect(final["effects"]).toContainEqual(
      expect.objectContaining({ kind: "delegation.unknown", status: "failed" }),
    );
  });
});

describe("a page that cannot be drawn", () => {
  test("a name with a space draws, quoted on its CLI line; a broken page answers a sentence", async () => {
    const t = await setup();
    const spaced = await t.service.preview(
      { ...t.harness, name: "Support bot" },
      { action: "merge" },
    );
    if (!spaced.ok) throw new Error(spaced.reason);
    expect(spaced.page.verb).toEndWith("--confirm 'Support bot'");
    t.s.host = [{ template: "does.deploy" }];
    const broken = await t.service.preview(t.harness, { action: "merge" });
    expect(broken).toEqual({
      ok: false,
      code: "invalid",
      reason: "This page could not be built for this harness.",
    });
  });
});

describe("suspension", () => {
  test("an owner demoted, a new policy revision, or a new ceiling suspends in one pass", async () => {
    const t = await setup();
    const owner = await setUpOwner(t.r.hangarRoot);
    plantProjection(t.r.harness, owner);
    const ruleId = ruleOf(await enable(t));
    expect(ruleState(t.r.harness, ruleId)?.owner).toBe(owner);
    plantProjection(t.r.harness, mintId("prn"), [{ principal: owner, decide: "maintainer" }]);
    t.r.clock.now += 1000;
    await apply(t);
    expect(ruleState(t.r.harness, ruleId)).toMatchObject({
      state: "suspended",
      reason: "owner-authority-changed",
    });

    const p = await setup();
    const second = ruleOf(await enable(p));
    await deploy(p.r.harness, {
      ceiling: { maxDays: 30, merge: {} },
      active: true,
      policy: POLICY_2,
      at: NOW + 5,
    });
    p.r.clock.now += 1000;
    await apply(p);
    expect(ruleState(p.r.harness, second)).toMatchObject({
      state: "suspended",
      reason: "policy-changed",
    });

    const c = await setup();
    const third = ruleOf(await enable(c));
    await deploy(c.r.harness, {
      ceiling: { maxDays: 20, merge: {} },
      active: true,
      policy: POLICY_2,
      at: NOW + 5,
    });
    c.r.clock.now += 1000;
    await apply(c);
    expect(ruleState(c.r.harness, third)).toMatchObject({
      state: "suspended",
      reason: "ceiling-changed",
    });
  });

  test("a pass that read an older revision never writes over a newer one", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const change = async (expect: number, days: number) => {
      const page = await t.service.previewRule(t.harness, {
        rule: ruleId,
        mode: "change",
        terms: { days },
      });
      if (!page.ok) throw new Error(page.reason);
      return t.service.update(t.harness, {
        rule: ruleId,
        expect,
        terms: { days },
        consequencesDigest: page.page.consequencesDigest as string,
        confirm: "codebase-steward",
        actor: OWNER_LOCAL,
        cmd: mintId("cmd"),
      });
    };
    expect(await change(1, 10)).toMatchObject({ ok: true });
    // A pass reads revision 2 into its one-second cache.
    await apply(t);
    // Inside that second: the owner narrows the rule, then another ceiling is activated.
    expect(await change(2, 5)).toMatchObject({ ok: true });
    await deploy(t.r.harness, {
      ceiling: { maxDays: 20, merge: {} },
      active: true,
      policy: POLICY_2,
      at: NOW + 5,
    });
    await apply(t);
    expect(ruleState(t.r.harness, ruleId)).toMatchObject({
      state: "suspended",
      reason: "ceiling-changed",
      revision: 3,
      terms: { days: 5 },
    });
  });

  test("two changes made from the same revision: one lands, the other is told to read again", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const pages = await Promise.all(
      [6, 8].map((days) =>
        t.service.previewRule(t.harness, { rule: ruleId, mode: "change", terms: { days } }),
      ),
    );
    const answers = await Promise.all(
      pages.map((page, i) => {
        if (!page.ok) throw new Error(page.reason);
        return t.service.update(t.harness, {
          rule: ruleId,
          expect: 1,
          terms: { days: i === 0 ? 6 : 8 },
          consequencesDigest: page.page.consequencesDigest as string,
          confirm: "codebase-steward",
          actor: OWNER_LOCAL,
          cmd: mintId("cmd"),
        });
      }),
    );
    expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual(["conflict", "ok"]);
    const read = readDelegations(t.r.harness);
    const revisions =
      read.state === "present"
        ? read.rows.filter((r) => r.id === ruleId).map((r) => r.revision)
        : [];
    expect(revisions).toEqual([2]);
  });

  test("resume is the owner's, with a fresh page", async () => {
    const t = await setup();
    const owner = await setUpOwner(t.r.hangarRoot);
    const maintainer = mintId("prn");
    plantProjection(t.r.harness, owner, [{ principal: maintainer, decide: "maintainer" }]);
    const ruleId = ruleOf(await enable(t));
    expect(
      await t.service.pause(t.harness, {
        rule: ruleId,
        actor: { kind: "principal", principal: maintainer },
        cmd: mintId("cmd"),
      }),
    ).toMatchObject({ ok: true });
    expect(ruleState(t.r.harness, ruleId)).toMatchObject({
      state: "suspended",
      reason: "paused-by-member",
    });
    const page = await t.service.previewRule(t.harness, { rule: ruleId, mode: "resume" });
    const digest = page.ok ? (page.page.consequencesDigest as string) : "";
    expect(page.ok && page.page.verb).toContain(`crewhaus delegations resume ${ruleId}`);
    expect(
      await t.service.resume(t.harness, {
        rule: ruleId,
        expect: 1,
        consequencesDigest: digest,
        confirm: "codebase-steward",
        actor: { kind: "principal", principal: maintainer },
        cmd: mintId("cmd"),
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await t.service.resume(t.harness, {
        rule: ruleId,
        expect: 1,
        consequencesDigest: "0".repeat(64),
        confirm: "codebase-steward",
        actor: OWNER_LOCAL,
        cmd: mintId("cmd"),
      }),
    ).toMatchObject({ ok: false, code: "precondition-failed" });
    expect(
      await t.service.resume(t.harness, {
        rule: ruleId,
        expect: 1,
        consequencesDigest: digest,
        confirm: "codebase-steward",
        actor: OWNER_LOCAL,
        cmd: mintId("cmd"),
      }),
    ).toMatchObject({ ok: true });
    expect(ruleState(t.r.harness, ruleId)).toMatchObject({ state: "resumed", revision: 2 });
  });
});

describe("the operator wins", () => {
  test("paused, disabled or unreadable: nothing applied, a not-applied line says why", async () => {
    const plants: readonly [string, (dir: string) => Promise<void>][] = [
      [
        "paused",
        async (dir) => void (await writeOperatorRecord(dir, { intake: { paused: true } })),
      ],
      [
        "disabled",
        async (dir) => void (await writeOperatorRecord(dir, { deployment: { disabled: true } })),
      ],
      [
        "unreadable",
        async (dir) => {
          const file = join(dir, controlPaths(dir).operatorFile);
          mkdirSync(join(file, ".."), { recursive: true });
          writeFileSync(file, "{not json");
        },
      ],
    ];
    for (const [name, plant] of plants) {
      const t = await setup();
      ruleOf(await enable(t));
      const d = await decision(t.r.harness);
      await plant(t.r.harness);
      t.r.clock.now += 2000;
      await apply(t);
      expect([name, t.s.effects, decisionRow(t.r.harness, d.id)?.state]).toEqual([
        name,
        0,
        "pending",
      ]);
      expect([name, linesOf(t.r.harness).map((l) => [l.event, l.reason])]).toEqual([
        name,
        [["not-applied", "operator-closed"]],
      ]);
    }
  });
});

describe("the rollback plan comes first", () => {
  test("planned precedes the effect; a plan that cannot be made refuses with no effect", async () => {
    const t = await setup();
    ruleOf(await enable(t));
    t.s.plan = undefined;
    const d = await decision(t.r.harness);
    await apply(t);
    expect(linesOf(t.r.harness).map((l) => [l.event, l.reason])).toEqual([
      ["checked", undefined],
      ["refused", "rollback_unavailable"],
    ]);
    expect(t.s.effects).toBe(0);
    expect(decisionRow(t.r.harness, d.id)?.state).toBe("pending");
  });
});

describe("watches", () => {
  async function acted() {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    await decision(t.r.harness);
    await apply(t);
    await apply(t);
    expect(events(t.r.harness).at(-1)).toBe("watch-started");
    const cmd = linesOf(t.r.harness).find((l) => l.event === "acted")?.cmd as string;
    return { t, ruleId, cmd };
  }

  test("a regression rolls back once under the rollback clause, and suspends the rule", async () => {
    const { t, ruleId, cmd } = await acted();
    t.s.signal = "regression";
    await apply(t);
    expect(t.s.rollbacks).toBe(1);
    expect(linesOf(t.r.harness).at(-1)).toMatchObject({ event: "rolled-back", cmd });
    expect(ruleState(t.r.harness, ruleId)).toMatchObject({
      state: "suspended",
      reason: "rolled-back",
    });
    const rollback = rowsOf(commandsLedgerOf(t.r.harness))
      .filter((r) => r["kind"] === KINDS.rollback)
      .at(-1);
    expect(rollback).toMatchObject({
      actor: "sys:executor",
      target: `${HRN}/cmd/${cmd}`,
      authority: { kind: "delegation", rule: ruleId, revision: 1, clause: "rollback" },
    });
    await apply(t);
    expect(t.s.rollbacks).toBe(1);
  });

  test("a failing rollback is recorded and never tried again", async () => {
    const { t, ruleId } = await acted();
    t.s.signal = "regression";
    t.s.rollbackOk = false;
    await apply(t);
    await apply(t);
    expect(t.s.rollbacks).toBe(1);
    expect(events(t.r.harness).filter((e) => e === "rollback-failed")).toHaveLength(1);
    expect(ruleState(t.r.harness, ruleId)?.reason).toBe("rollback-failed");
  });

  test("a quiet window is kept; a signal that never answers is kept not measured", async () => {
    const quiet = await acted();
    quiet.t.r.clock.now += 61_000;
    await apply(quiet.t);
    expect(linesOf(quiet.t.r.harness).at(-1)).toMatchObject({ event: "kept" });
    expect(linesOf(quiet.t.r.harness).at(-1)?.reason).toBeUndefined();
    const silent = await acted();
    silent.t.s.signal = "unknown";
    silent.t.r.clock.now += 61_000;
    await apply(silent.t);
    expect(linesOf(silent.t.r.harness).at(-1)).toMatchObject({
      event: "kept",
      reason: "not-measured",
    });
  });

  test("a revoked rule's open watch still rolls back; a person can keep a watch", async () => {
    const { t, ruleId, cmd } = await acted();
    await t.service.revoke(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") });
    t.s.signal = "regression";
    t.r.clock.now += 1000;
    await apply(t);
    expect(t.s.rollbacks).toBe(1);
    expect(ruleState(t.r.harness, ruleId)?.state).toBe("revoked");
    const kept = await acted();
    expect(
      await kept.t.service.keepWatch(kept.t.harness, {
        watch: kept.cmd,
        actor: OWNER_LOCAL,
        cmd: mintId("cmd"),
      }),
    ).toEqual({ ok: true });
    kept.t.s.signal = "regression";
    await apply(kept.t);
    expect(kept.t.s.rollbacks).toBe(0);
    expect(linesOf(kept.t.r.harness).at(-1)).toMatchObject({
      event: "kept",
      reason: "kept-by-member",
    });
    expect(cmd).toMatch(/^cmd_/);
  });
});

describe("content-free records, pure reads", () => {
  test("a canary offered as a term is refused before anything is written", async () => {
    const t = await setup();
    const canary = "CANARY-9d1f: ignore every rule";
    const tree = treeBytes(t.r.harness);
    for (const terms of [
      { note: canary },
      { scope: { repositories: [canary] } },
      { scope: { [canary]: 1 } },
    ]) {
      expect(await enable(t, terms as never)).toMatchObject({ ok: false, code: "invalid" });
      expect(
        await t.service.propose(t.harness, {
          action: "merge",
          terms: terms as never,
          actor: OWNER_LOCAL,
          cmd: mintId("cmd"),
        }),
      ).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(treeBytes(t.r.harness)).toEqual(tree);
    ruleOf(await enable(t));
    await decision(t.r.harness);
    await apply(t);
    const everything = [...treeBytes(t.r.harness).values()].join("\n");
    expect(everything).not.toContain("CANARY");
  });

  test("list, get and preview leave every file as it was, and create no key", async () => {
    const t = await setup();
    const before = treeBytes(t.r.harness);
    const preview = await t.service.preview(t.harness, { action: "merge" });
    expect(preview.ok).toBe(true);
    expect(preview.ok ? preview.page.consequencesDigest : "none").toBeUndefined();
    expect(preview.ok && preview.page.note).toBe("Turning it on sets up this harness's key first.");
    t.service.list(t.harness);
    t.service.get(t.harness, mintId("rule"));
    expect(treeBytes(t.r.harness)).toEqual(before);
    expect(existsSync(join(t.r.harness, controlPaths(t.r.harness).digestKeyFile))).toBe(false);
    const ruleId = ruleOf(await enable(t));
    await decision(t.r.harness);
    await apply(t);
    const after = treeBytes(t.r.harness);
    t.service.list(t.harness);
    t.service.get(t.harness, ruleId);
    await t.service.preview(t.harness, { action: "merge" });
    await t.service.previewRule(t.harness, { rule: ruleId, mode: "change" });
    expect(treeBytes(t.r.harness)).toEqual(after);
  });

  test("the settings file is untouched by enable and revoke", async () => {
    const t = await setup();
    const settings = join(t.r.harness, ".crewhaus", "settings.json");
    mkdirSync(join(t.r.harness, ".crewhaus"), { recursive: true });
    writeFileSync(settings, '{"permissions":{"mode":"default"}}\n');
    const ruleId = ruleOf(await enable(t));
    await t.service.revoke(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") });
    expect(readFileSync(settings, "utf8")).toBe('{"permissions":{"mode":"default"}}\n');
  });

  test("a pause and a revoke land while another process holds the mutating lease", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    const held = await acquireMutatingLease(t.r.harness, { head: "cli", kind: "eval" });
    expect(held.ok).toBe(true);
    try {
      expect(
        await t.service.pause(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") }),
      ).toMatchObject({
        ok: true,
      });
      expect(
        await t.service.revoke(t.harness, { rule: ruleId, actor: OWNER_LOCAL, cmd: mintId("cmd") }),
      ).toMatchObject({
        ok: true,
      });
    } finally {
      if (held.ok) held.release();
    }
    expect(ruleState(t.r.harness, ruleId)?.state).toBe("revoked");
  });
});

describe("retire", () => {
  test("the revoker's plan lists live rules and writes nothing; revoke ends each as retired", async () => {
    const t = await setup();
    const first = ruleOf(await enable(t));
    const second = ruleOf(await enable(t, { days: 3 }));
    await t.service.pause(t.harness, { rule: second, actor: OWNER_LOCAL, cmd: mintId("cmd") });
    const ctx = {
      harnessDir: t.r.harness,
      harnessId: HRN,
      actor: "sys:executor",
      now: NOW,
      cmd: mintId("cmd"),
    };
    const before = treeBytes(t.r.harness);
    expect(await DELEGATIONS_REVOKER.plan(ctx)).toEqual([
      { kind: "retire.delegations", status: "planned", note: "2 delegation rule(s) end" },
    ]);
    expect(treeBytes(t.r.harness)).toEqual(before);
    expect(await DELEGATIONS_REVOKER.revoke(ctx)).toEqual([
      { kind: "retire.delegations", status: "done", observed: "2 revoked" },
    ]);
    for (const id of [first, second]) {
      expect(ruleState(t.r.harness, id)).toMatchObject({
        state: "revoked",
        reason: "retired",
        cmd: ctx.cmd,
      });
    }
    expect(await DELEGATIONS_REVOKER.plan(ctx)).toEqual([]);
    // With nothing left to end it answers no effect, so retire's guidance stands.
    expect(await DELEGATIONS_REVOKER.revoke(ctx)).toEqual([]);
  });
});

describe("decisions a person decides", () => {
  test("a merge decision is a maintainer's; a service never decides one", async () => {
    const t = await setup();
    const owner = await setUpOwner(t.r.hangarRoot);
    const maintainer = mintId("prn");
    const operator = mintId("prn");
    plantProjection(t.r.harness, owner, [
      { principal: maintainer, decide: "maintainer" },
      { principal: operator, decide: "operator" },
    ]);
    const d = await decision(t.r.harness);
    const resolve = (actor: DecisionActor) =>
      t.r.service.decisions.resolve({
        harnessDir: t.r.harness,
        ref: d.id,
        choice: "grant",
        actor,
        via: "home",
      });
    expect(await resolve({ kind: "principal", principal: operator })).toMatchObject({
      outcome: "forbidden",
    });
    expect(
      await resolve({ kind: "principal", principal: maintainer, service: true }),
    ).toMatchObject({
      outcome: "forbidden",
    });
    expect(await resolve({ kind: "principal", principal: maintainer })).toMatchObject({
      outcome: "decided",
      actionDecision: { state: "granted", decidedByPrincipal: maintainer },
    });
    expect(decisionRow(t.r.harness, d.id)?.resolvedBy).toBeUndefined();
    expect(rowsOf(decisionsLedger(t.r.harness)).length).toBeGreaterThan(0);
  });
});

describe("the listings that read requests narrow on the rule's kind", () => {
  test("a request for a delegation rule is listed by delegations, never offered as approvals grant", async () => {
    const t = await setup();
    await t.service.propose(t.harness, {
      action: "merge",
      terms: { days: 5 },
      actor: OWNER_LOCAL,
      cmd: mintId("cmd"),
    });
    const rules = t.r.service.rules.list(t.r.harness);
    expect(rules.proposals).toEqual([]);
    expect(rules.unreadable).toEqual([]);
    const listed = t.service.list(t.harness);
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]?.verb).toContain("crewhaus delegations enable merge --harness");
    expect(listed.proposals[0]?.verb).toContain(`--proposal ${listed.proposals[0]?.id}`);
  });
});

describe("the scheduler's pass settles its own receipt", () => {
  test("a pass that writes a rule row ends its delegations.apply receipt succeeded", async () => {
    const t = await setup();
    const ruleId = ruleOf(await enable(t));
    // Past its end, the pass writes the rule's `expired` row.
    t.r.clock.now = Date.parse(ruleState(t.r.harness, ruleId)?.expiresAt as string);
    const summary = await t.service.apply(t.harness, { appliedBy: "sys:scheduler" });
    expect(ruleState(t.r.harness, ruleId)?.state).toBe("expired");
    const cmd = summary.cmd;
    if (cmd === undefined) throw new Error("the pass wrote no receipt");
    const rows = rowsOf(commandsLedgerOf(t.r.harness)).filter((row) => row["id"] === cmd);
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "succeeded"]);
    expect(rows.at(-1)).toMatchObject({ kind: "delegations.apply", actor: "sys:scheduler" });
  });
});

describe("a receipt's authority", () => {
  test("only a system actor carries one, of a closed kind, and it is fingerprinted", async () => {
    const t = await setup();
    const rule = mintId("rule");
    const submit = (actor: string | undefined, authority: unknown) =>
      t.r.service.commands.submit(
        {
          kind: "delegations.apply",
          ...(actor !== undefined ? { actor } : {}),
          target: `home/harness/${HRN}`,
          ledger: { harness: t.r.harness },
          via: "system",
          authority: authority as never,
        },
        async () => ({ value: undefined, settle: { state: "succeeded" } }),
      );
    for (const [actor, authority] of [
      [undefined, { kind: "delegation", rule, revision: 1 }],
      [mintId("prn"), { kind: "delegation", rule, revision: 1 }],
      ["sys:executor", { kind: "other", rule, revision: 1 }],
      ["sys:executor", { kind: "delegation", rule, revision: 1, note: "x" }],
    ] as const) {
      const answer = await submit(actor, authority);
      expect(answer).toMatchObject({ ok: false, refusal: { code: "invalid" } });
    }
    const a = await submit("sys:executor", { kind: "delegation", rule, revision: 1 });
    const b = await submit("sys:executor", { kind: "delegation", rule, revision: 2 });
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.receipt.authority).toEqual({ kind: "delegation", rule, revision: 1 });
    expect(a.receipt.fingerprint).not.toBe(b.receipt.fingerprint);
  });
});
