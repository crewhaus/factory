/**
 * Acting on an inbox item through the API: each write answers the fields the view reads and
 * one receipt; the router checks the harness the path names, and an item about another
 * harness, an unknown one and one the caller cannot see answer alike; a refused request
 * writes nothing; what a choice starts is a closed command carrying the receipt, checked
 * for the permission it needs; a repeated key does nothing twice; and each act is one event
 * on the harness's stream, with no text in it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import {
  advisorSnapshotRecord,
  advisorSnapshotRel,
  approvalItemRef,
  attRefOf,
  checkpointKeyOf,
} from "@crewhaus/attention";
import { ATTENTION_MODULE, mintId, mintRunId } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import {
  append,
  attentionActionsLedger,
  decisionsLedger,
  readDeployQuorums,
  readPage,
  runsLedger,
  writeIndexRecord,
} from "@crewhaus/control-records";
import type { JobRecord } from "@crewhaus/harness-supervisor";
import { foldReadOnly } from "@crewhaus/session-store";
import { bearer } from "../__test__/browser";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { makeFixtureHarness } from "../fixture";
import { adjudicateReview } from "../review";
import { bootTestServer } from "../testkit";

type Schema = { safeParse(value: unknown): { success: boolean } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

const SAID = "please refund jane example";
const AGO = (ms: number) => new Date(Date.now() - ms).toISOString();
const AHEAD = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;
const HASH = `sha256:${"ab".repeat(32)}`;

const approval = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  toolName: "SendMessage",
  inputHash: `hash-${id}`,
  input: { channel: "ops", text: SAID },
  runId: "run_00000000000000a0",
  sessionId: "sess_00000000000000aa",
  surface: "daemon",
  createdAt: AGO(60_000),
  ...extra,
});

let home: V1Home;
let a: { id: string; dir: string };
let b: { id: string; dir: string };
let operator: { principal: string; secret: string };
let maintainer: { principal: string; secret: string };
let viewer: { principal: string; secret: string };
const jobs: JobRecord[] = [];
let n = 0;

/** A harness of its own, so one test's acts never change another's. */
async function harness(
  opts: { approvals?: unknown[]; target?: string; bundle?: boolean } = {},
): Promise<{ id: string; dir: string }> {
  n += 1;
  return home.harness(`acts-${n}`, {
    ...(opts.approvals !== undefined ? { approvals: opts.approvals as never } : {}),
    ...(opts.target !== undefined ? { target: opts.target as never } : {}),
    ...(opts.bundle === true
      ? { bundle: { entry: "agent.ts", specHash: "x", compiledWith: "0.9.0" } }
      : {}),
  });
}

/** Write the harness's own list of who may approve, as an access change does. */
async function governed(h: { id: string; dir: string }): Promise<void> {
  const access = openAccess(home.t.hangarRoot, {
    harnesses: () => [{ id: h.id, dir: h.dir, groups: [] }],
  });
  const done = await access.grant(
    { principal: home.owner },
    { member: `Looker ${h.id}`, create: true, role: "viewer", scope: `harness:${h.id}` },
  );
  if (!done.ok) throw new Error(done.reason);
}

/** An Advisor finding with a job of its own, as Home last gathered it. */
const FINDING: { readonly id: string } & Readonly<Record<string, unknown>> = {
  id: "evals-none",
  severity: "suggestion",
  screen: "evals",
  source: "evals",
  action: { kind: "job", label: "Run", cliTwin: "crewhaus eval", jobKind: "eval" },
  status: "open",
};

/** One failed run, whose group is a problem item. */
function failRun(dir: string): void {
  const id = mintRunId();
  const trigger = { kind: "api" };
  append(runsLedger(dir), { id, state: "running", at: AGO(120_000), trigger });
  append(runsLedger(dir), {
    id,
    state: "failed",
    at: AGO(60_000),
    trigger,
    failureClass: "tool_error",
  });
}

const path = (h: string, ref: string, verb: string) =>
  `/api/v1/harnesses/${h}/attention/${ref}/${verb}`;

async function itemOf(h: string, kind: string, secret?: string): Promise<Record<string, unknown>> {
  const res = await home.call("GET", `/api/v1/attention?harness=${h}&state=all`, {
    ...(secret !== undefined ? { secret } : {}),
  });
  const items = res.body["items"] as Record<string, unknown>[];
  const found = items.find((i) => i["kind"] === kind);
  if (found === undefined) throw new Error(`no ${kind} in ${JSON.stringify(items)}`);
  return found;
}

const reasonOf = (body: Record<string, unknown>) =>
  (body["error"] as Record<string, unknown> | undefined)?.["reason"];

/** Every file under a folder, with its bytes. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const at = join(d, name);
      if (statSync(at).isDirectory()) {
        out.set(`${at}/`, "");
        walk(at);
      } else out.set(at, readFileSync(at).toString("base64"));
    }
  };
  walk(dir);
  return out;
}

const lines = (dir: string) =>
  readPage(attentionActionsLedger(dir), { limit: 200 })
    .items.map((i) => i.record)
    .reverse();

beforeAll(async () => {
  home = await v1Home({
    streamTimings: { pollMs: 10, heartbeatMs: 60_000 },
    runJob: async (job) => {
      jobs.push(job);
      return await new Promise(() => {});
    },
  });
  a = await harness({ approvals: [approval("appr_00000000000000a1")] });
  b = await harness({ approvals: [approval("appr_00000000000000b1")] });
  operator = await home.member("Olly", "operator");
  maintainer = await home.member("Mel", "maintainer");
  viewer = await home.member("Vic", "viewer");
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe("every write answers one receipt and the fields the view reads", () => {
  test("assign, unassign, snooze, discuss and decide a request", async () => {
    const h = await harness({ approvals: [approval("appr_00000000000000a2")] });
    const ref = (await itemOf(h.id, "permission"))["ref"] as string;
    const acted = async (verb: string, body: unknown, at = path(h.id, ref, verb)) => {
      const res = await home.call("POST", at, { body, secret: operator.secret });
      expect([verb, res.status]).toEqual([verb, 200]);
      expect([verb, schemaOf("attentionActed")?.safeParse(res.body).success]).toEqual([verb, true]);
      for (const field of ["receipt", "ref", "harness", "event", "state"]) {
        expect(`${verb} ${field} ${field in res.body}`).toBe(`${verb} ${field} true`);
      }
      expect(res.body["ref"]).toBe(ref);
      expect(res.body["harness"]).toBe(h.id);
      expect((res.body["receipt"] as { state: string }).state).toBe("succeeded");
      return res.body;
    };
    expect((await acted("assign", { to: maintainer.principal }))["state"]).toBe("assigned");
    expect((await itemOf(h.id, "permission"))["assignee"]).toBe(maintainer.principal);
    expect((await acted("unassign", {}))["state"]).toBe("open");
    await acted("messages", { text: SAID });
    await acted(
      "snooze",
      { harness: h.id, until: AHEAD(DAY) },
      `/api/v1/me/attention/${ref}/snooze`,
    );
    const decided = await acted("resolve", { choice: "deny", expect: "open" });
    expect(decided["event"]).toBe("resolved");
    expect(decided["state"]).toBe("resolved");
    const record = foldReadOnly(join(h.dir, ".crewhaus", "sessions")).records[0];
    expect(record?.decision).toBe("deny");
    expect(record?.decidedByPrincipal).toBe(operator.principal);
    expect(lines(h.dir).map((l) => l["event"])).toEqual([
      "assigned",
      "unassigned",
      "message",
      "snoozed",
      "resolved",
    ]);
    for (const line of lines(h.dir)) {
      expect(line["by"]).toBe(operator.principal);
      expect(String(line["cmd"])).toStartWith("cmd_");
    }
    // The discussion is read back by whoever may read the harness's content.
    const said = await home.call("GET", path(h.id, ref, "messages"));
    expect(said.status).toBe(200);
    expect(schemaOf("attentionMessages")?.safeParse(said.body).success).toBe(true);
    expect(said.body["items"]).toMatchObject([{ text: SAID, by: operator.principal, via: "sdk" }]);
  });

  test("defer, undefer, dismiss, reopen and acknowledge a problem", async () => {
    const h = await harness();
    failRun(h.dir);
    const ref = (await itemOf(h.id, "run-failures"))["ref"] as string;
    const states: unknown[] = [];
    for (const [verb, body] of [
      ["defer", { until: AHEAD(DAY), reason: "awaiting-someone" }],
      ["undefer", {}],
      ["dismiss", { reasonCode: "known" }],
      ["reopen", {}],
      ["acknowledge", {}],
    ] as const) {
      const res = await home.call("POST", path(h.id, ref, verb), { body });
      expect([verb, res.status]).toEqual([verb, 200]);
      expect(schemaOf("attentionActed")?.safeParse(res.body).success).toBe(true);
      states.push(res.body["state"]);
    }
    expect(states).toEqual(["deferred", "open", "resolved", "open", "resolved"]);
    const open = await home.call("GET", `/api/v1/attention?harness=${h.id}`);
    expect(open.body["items"]).toEqual([]);
  });

  test("the list says what its reader may do in each harness, and no more than they may", async () => {
    const h = await harness({ approvals: [approval("appr_00000000000000a3")] });
    append(runsLedger(h.dir), {
      id: mintRunId(),
      state: "failed",
      at: AGO(60_000),
      trigger: { kind: "api" },
      failureClass: "crewhaus_budget",
    });
    await governed(h);
    const youFor = async (secret?: string) => {
      const res = await home.call("GET", `/api/v1/attention?harness=${h.id}`, {
        ...(secret !== undefined ? { secret } : {}),
      });
      expect(schemaOf("attentionList")?.safeParse(res.body).success).toBe(true);
      const rows = res.body["you"] as Record<string, unknown>[];
      expect(rows.map((r) => r["harness"])).toEqual([h.id]);
      const { act, class: reach, content, can } = rows[0] as Record<string, unknown>;
      return { act, reach, content, can: [...(can as string[])].sort() };
    };
    expect(await youFor()).toEqual({
      act: true,
      reach: "owner",
      content: true,
      can: ["h.budget.extend", "h.spec.edit"],
    });
    expect(await youFor(maintainer.secret)).toMatchObject({ act: true, reach: "maintainer" });
    expect(await youFor(operator.secret)).toMatchObject({ act: true, reach: "operator", can: [] });
    expect(await youFor(viewer.secret)).toMatchObject({ act: false, reach: null, can: [] });
  });

  test("a snooze hides it from its own caller's list only", async () => {
    const h = await harness();
    failRun(h.dir);
    const ref = (await itemOf(h.id, "run-failures"))["ref"] as string;
    const res = await home.call("POST", `/api/v1/me/attention/${ref}/snooze`, {
      body: { harness: h.id, until: AHEAD(DAY) },
      secret: operator.secret,
    });
    expect(res.status).toBe(200);
    const mine = await home.call("GET", `/api/v1/attention?harness=${h.id}`, {
      secret: operator.secret,
    });
    expect(mine.body["items"]).toEqual([]);
    const theirs = await home.call("GET", `/api/v1/attention?harness=${h.id}`, {
      secret: maintainer.secret,
    });
    expect((theirs.body["items"] as unknown[]).length).toBe(1);
  });
});

describe("who may act, and on what", () => {
  const WRITES: ReadonlyArray<readonly [string, unknown]> = [
    ["resolve", { choice: "deny" }],
    ["assign", { to: "prn_00000000000000000000000000" }],
    ["unassign", {}],
    ["defer", { until: AHEAD(DAY), reason: "scheduled" }],
    ["undefer", {}],
    ["dismiss", { reasonCode: "known" }],
    ["reopen", {}],
    ["acknowledge", {}],
    ["messages", { text: "hello" }],
  ];

  test("a viewer gets 403 on every write that decides, and nothing is written", async () => {
    const ref = (await itemOf(a.id, "permission"))["ref"] as string;
    const declared = ATTENTION_MODULE.operations.filter(
      (op) => op.method === "POST" && op.path.startsWith("/api/v1/harnesses/"),
    );
    expect(WRITES.map(([verb]) => verb).sort()).toEqual(
      declared.map((op) => op.path.slice(op.path.lastIndexOf("/") + 1)).sort(),
    );
    const before = tree(a.dir);
    for (const [verb, body] of WRITES) {
      const res = await home.call("POST", path(a.id, ref, verb), { body, secret: viewer.secret });
      expect([verb, res.status]).toEqual([verb, 403]);
      expect((res.body["error"] as Record<string, unknown>)["needs"]).toBe("h.decision.resolve");
    }
    expect(tree(a.dir)).toEqual(before);
    // Their own list is theirs to arrange.
    const snoozed = await home.call("POST", `/api/v1/me/attention/${ref}/snooze`, {
      body: { harness: a.id, until: AHEAD(DAY) },
      secret: viewer.secret,
    });
    expect(snoozed.status).toBe(200);
  });

  test("an item about another harness, an unknown one, and one the caller cannot see answer alike", async () => {
    const theirs = (await itemOf(b.id, "permission"))["ref"] as string;
    const unknown = `home/attention/att_${"0".repeat(26)}`;
    const scoped = await home.member("Sol", "operator", { scope: `harness:${a.id}` });
    const before = [tree(a.dir), tree(b.dir)];
    for (const [verb, body] of WRITES) {
      const wrong = await home.call("POST", path(a.id, theirs, verb), { body });
      const none = await home.call("POST", path(a.id, unknown, verb), { body });
      const unseen = await home.call("POST", path(a.id, theirs, verb), {
        body,
        secret: scoped.secret,
      });
      expect([verb, wrong.status, none.status, unseen.status]).toEqual([verb, 404, 404, 404]);
      expect(wrong.body).toEqual(none.body);
      expect(unseen.body).toEqual(none.body);
    }
    const messages = await home.call("GET", path(a.id, theirs, "messages"));
    expect(messages.status).toBe(404);
    // A harness the caller may not read takes no snooze either.
    const snooze = await home.call("POST", `/api/v1/me/attention/${theirs}/snooze`, {
      body: { harness: b.id, until: AHEAD(DAY) },
      secret: scoped.secret,
    });
    expect(snooze.status).toBe(404);
    expect([tree(a.dir), tree(b.dir)]).toEqual(before);
  });

  test("an operator does not decide a maintainer's request, and is not given one", async () => {
    const h = await harness({
      approvals: [approval("appr_00000000000000a3", { requiredClass: "maintainer" })],
    });
    await governed(h);
    const ref = (await itemOf(h.id, "permission"))["ref"] as string;
    const before = tree(h.dir);
    const decided = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "grant" },
      secret: operator.secret,
    });
    expect(decided.status).toBe(403);
    expect(reasonOf(decided.body)).toBe("class");
    const given = await home.call("POST", path(h.id, ref, "assign"), {
      body: { to: operator.principal },
      secret: maintainer.secret,
    });
    expect(given.status).toBe(409);
    expect(reasonOf(given.body)).toBe("assignee_class");
    expect(tree(h.dir)).toEqual(before);
  });

  test("an item about people answers the unknown ref's 404 to every write", async () => {
    const h = await harness({
      approvals: [approval("appr_00000000000000a4", { sensitivity: "people" })],
    });
    const ref = approvalItemRef(h.id, { id: "appr_00000000000000a4", kind: "tool" });
    for (const [verb, body] of WRITES) {
      const res = await home.call("POST", path(h.id, ref, verb), { body });
      expect([verb, res.status]).toEqual([verb, 404]);
    }
  });
});

describe("a refused request writes nothing", () => {
  test("a stale read, a choice it does not offer, a word that is not one, a late decision", async () => {
    const h = await harness({ approvals: [approval("appr_00000000000000a5")] });
    const item = await itemOf(h.id, "permission");
    const ref = item["ref"] as string;
    const before = tree(h.dir);
    const cases: ReadonlyArray<readonly [string, unknown, number]> = [
      ["resolve", { choice: "grant", expect: "0000000000000000" }, 412],
      ["resolve", { choice: "approve" }, 409],
      ["resolve", { choice: "inspect" }, 400],
      ["resolve", { choice: "grant", note: "a note" }, 400],
      ["resolve", { choice: "grant", extra: 1 }, 400],
      ["dismiss", { reasonCode: "known" }, 409],
      ["dismiss", { reasonCode: "because" }, 400],
      ["defer", { until: AGO(DAY), reason: "scheduled" }, 400],
      ["defer", { until: AHEAD(120 * DAY), reason: "scheduled" }, 400],
      ["assign", { to: "local:sam@laptop" }, 400],
      ["unassign", {}, 409],
      ["undefer", {}, 409],
      ["reopen", {}, 409],
      ["messages", { text: "x".repeat(9000) }, 400],
      ["messages", { text: "é".repeat(5000) }, 400],
    ];
    for (const [verb, body, status] of cases) {
      const res = await home.call("POST", path(h.id, ref, verb), { body });
      expect([verb, JSON.stringify(body).slice(0, 40), res.status]).toEqual([
        verb,
        JSON.stringify(body).slice(0, 40),
        status,
      ]);
    }
    expect(tree(h.dir)).toEqual(before);
    const stale = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "grant", expect: "0000000000000000" },
    });
    expect((stale.body["error"] as Record<string, unknown>)["current"]).toEqual({
      state: "open",
      evidenceRev: item["evidenceRev"],
    });
  });
});

describe("what a choice starts", () => {
  /** A paused run of a graph harness, as its store writes it. */
  function pause(dir: string): { grun: string; ckpt: string } {
    const grun = "grun_0123456789abcdef";
    const ckpt = "ckpt_0123456789abcdef";
    const folder = join(dir, ".crewhaus", "graphs", grun);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "_meta.json"),
      JSON.stringify({
        version: 1,
        graphRunId: grun,
        head: ckpt,
        createdAt: AGO(60_000),
        pendingHitl: { checkpointId: ckpt, nodeName: "ship", prompt: SAID, at: AGO(60_000) },
      }),
    );
    return { grun, ckpt };
  }

  test("a paused run's verdict queues one closed resume, carrying the receipt", async () => {
    const h = await harness({ target: "graph", bundle: true });
    const { grun, ckpt } = pause(h.dir);
    const ref = attRefOf(h.id, "checkpoint", checkpointKeyOf({ grun, ckpt }));
    const before = jobs.length;
    const res = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "approve" },
      headers: { "Idempotency-Key": "resume-once" },
      secret: operator.secret,
    });
    expect([res.status, res.body["error"] ?? null]).toEqual([202, null]);
    expect(schemaOf("attentionActed")?.safeParse(res.body).success).toBe(true);
    const receipt = res.body["receipt"] as { id: string; state: string };
    const job = jobs.slice(before)[0];
    expect(jobs.length).toBe(before + 1);
    expect(job?.kind).toBe("runs-resume");
    expect(job?.argv).toEqual(["runs", "resume", grun, "--decision", "approve"]);
    expect(job?.commandId).toBe(receipt.id);
    expect(job?.harnessDir).toBe(h.dir);
    expect(res.body["job"]).toBe(job?.jobId as string);
    // The job ends the receipt; the pause is settled by the run itself.
    expect(receipt.state).not.toBe("succeeded");
    expect((await itemOf(h.id, "checkpoint"))["state"]).toBe("open");
    // The same key again starts nothing more.
    const again = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "approve" },
      headers: { "Idempotency-Key": "resume-once" },
      secret: operator.secret,
    });
    expect((again.body["receipt"] as { id: string }).id).toBe(receipt.id);
    expect(schemaOf("attentionActed")?.safeParse(again.body).success).toBe(true);
    expect(jobs.length).toBe(before + 1);
    expect(lines(h.dir).map((l) => [l["event"], l["choice"]])).toEqual([["resolved", "approve"]]);
  });

  test("any other word is refused, and so is a build that cannot resume; nothing is queued", async () => {
    const h = await harness({ target: "graph", bundle: true });
    const { grun, ckpt } = pause(h.dir);
    const ref = attRefOf(h.id, "checkpoint", checkpointKeyOf({ grun, ckpt }));
    const before = jobs.length;
    for (const choice of ["ship it", "approve; id", "grant"]) {
      const res = await home.call("POST", path(h.id, ref, "resolve"), { body: { choice } });
      expect([choice, [400, 409].includes(res.status)]).toEqual([choice, true]);
    }
    const old = await harness({ target: "graph" });
    const paused = pause(old.dir);
    const oldRef = attRefOf(old.id, "checkpoint", checkpointKeyOf(paused));
    const res = await home.call("POST", path(old.id, oldRef, "resolve"), {
      body: { choice: "approve" },
    });
    expect(res.status).toBe(501);
    expect((res.body["error"] as Record<string, unknown>)["verb"]).toBe("crewhaus compile");
    expect(jobs.length).toBe(before);
    expect(lines(old.dir)).toEqual([]);
  });

  test("an approved version's move is the deploy's own permission, and a closed pin", async () => {
    const h = await harness();
    writeFileSync(
      join(h.dir, ".crewhaus", "environments.json"),
      JSON.stringify({ environments: { prod: { requireApproval: true, minApprovals: 1 } } }),
    );
    const asked = append(decisionsLedger(h.dir), {
      id: mintId("dec"),
      kind: "deploy-quorum",
      state: "pending",
      createdAt: AGO(60_000),
      expiresAt: AHEAD(DAY),
      requiredClass: "maintainer",
      subject: { spec: "support-bot", environment: "prod", version: "v2", specHash: HASH },
    });
    expect(asked.ok).toBe(true);
    const ref = (await itemOf(h.id, "deploy-approval"))["ref"] as string;
    const vote = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "approve" },
      secret: maintainer.secret,
    });
    expect([vote.status, vote.body["state"]]).toEqual([200, "resolved"]);
    const quorums = readDeployQuorums(h.dir);
    expect(quorums.state === "present" && quorums.rows[0]?.state).toBe("granted");
    // The approvals file every release reads names the member, not a label.
    const file = JSON.parse(
      readFileSync(join(h.dir, ".crewhaus", "approvals", "support-bot__prod.json"), "utf8"),
    ) as Record<string, unknown>[];
    expect(file).toMatchObject([
      { approver: "Mel", principal: maintainer.principal, version: "v2", specHash: HASH },
    ]);
    const decider = await home.service("decider", [h.id], {
      permissions: ["home.read", "h.read", "h.decision.resolve"],
    });
    const before = jobs.length;
    const refused = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "promote" },
      secret: decider.secret,
    });
    expect(refused.status).toBe(403);
    const moved = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "promote" },
      secret: maintainer.secret,
    });
    expect(moved.status).toBe(202);
    const job = jobs.slice(before)[0];
    expect(job?.argv).toEqual(["spec", "pin", "support-bot", "prod", "v2"]);
    expect(job?.needs).toEqual(["h.deploy"]);
  });

  test("an Advisor finding's job is its own closed command, at that job's permission", async () => {
    const h = await harness();
    writeIndexRecord(
      home.t.hangarRoot,
      advisorSnapshotRel(h.id),
      advisorSnapshotRecord(new Date().toISOString(), [
        {
          id: "optimize-me",
          severity: "suggestion",
          screen: "evals",
          source: "evals",
          action: {
            kind: "job",
            label: "Optimize",
            cliTwin: "crewhaus optimize",
            jobKind: "optimize",
          },
          status: "open",
        } as never,
      ]),
    );
    const ref = (await itemOf(h.id, "setup"))["ref"] as string;
    const before = jobs.length;
    const low = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "act" },
      secret: operator.secret,
    });
    expect(low.status).toBe(403);
    expect((low.body["error"] as Record<string, unknown>)["needs"]).toBe("h.quality.edit");
    expect(jobs.length).toBe(before);
    expect(lines(h.dir)).toEqual([]);
    const ran = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "act" },
      secret: maintainer.secret,
    });
    expect(ran.status).toBe(202);
    const job = jobs.slice(before)[0];
    expect(job?.kind).toBe("optimize");
    expect(job?.needs).toEqual(["h.quality.edit"]);
    const ledger = readFileSync(join(h.dir, ".crewhaus", "advisor", "decisions.jsonl"), "utf8");
    expect(JSON.parse(ledger)).toMatchObject({ v: 2, action: "acted", jobId: job?.jobId });
  });
});

describe("a Home nobody has signed in to", () => {
  test("its one user hides an item from their own list, and acts on the Advisor's screen as the same person", async () => {
    const t = bootTestServer({ runJob: async () => await new Promise(() => {}) });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "alone"), { specName: "alone" });
      const entry = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (entry.body["entry"] as { id: string }).id;
      failRun(dir);
      writeIndexRecord(
        t.hangarRoot,
        advisorSnapshotRel(id),
        advisorSnapshotRecord(new Date().toISOString(), [FINDING as never]),
      );
      const items = async () =>
        (await t.api(`/api/v1/attention?harness=${id}`)).body["items"] as {
          kind: string;
          ref: string;
        }[];
      const before = tree(dir);
      const failing = (await items()).find((i) => i.kind === "run-failures");
      // Reading makes no key: nothing is written until someone acts.
      expect(tree(dir)).toEqual(before);
      const snoozed = await t.api(`/api/v1/me/attention/${failing?.ref}/snooze`, {
        method: "POST",
        body: JSON.stringify({ harness: id, until: AHEAD(DAY) }),
      });
      expect(snoozed.status).toBe(200);
      expect((await items()).map((i) => i.kind)).toEqual(["setup"]);

      const path = `/api/h/${id}/advisor/${FINDING.id}`;
      for (const [verb, body] of [
        ["act", {}],
        ["dismiss", { reason: SAID }],
        ["reopen", {}],
      ] as const) {
        const res = await t.api(`${path}/${verb}`, { method: "POST", body: JSON.stringify(body) });
        expect([verb, res.status]).toEqual([verb, 200]);
      }
      const acts = lines(dir);
      expect(acts.map((l) => [l["event"], l["state"], l["how"], l["choice"]])).toEqual([
        ["snoozed", "open", undefined, undefined],
        ["resolved", "open", "acted", "act"],
        ["dismissed", "resolved", "dismissed", undefined],
        ["reopened", "open", undefined, undefined],
      ]);
      // One person, as the harness's records hold one, and never their name.
      expect(new Set(acts.map((l) => l["by"])).size).toBe(1);
      expect(String(acts[0]?.["by"])).toMatch(/^local:#[0-9a-f]{64}$/);
      expect(JSON.stringify(acts)).not.toContain(SAID);
      const ledger = readFileSync(join(dir, ".crewhaus", "advisor", "decisions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const rev = acts[1]?.["evidenceRev"];
      expect(ledger.map((l) => [l["v"], l["action"], l["via"], l["evidenceRev"]])).toEqual([
        [2, "acted", "home", rev],
        [2, "dismissed", "home", rev],
        [2, "reopened", "home", rev],
      ]);
      expect(ledger[1]?.["reason"]).toBe(SAID);
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("a review", () => {
  test("is settled through Home's claimed path, and a verdict made elsewhere first is the one that stands", async () => {
    const h = await harness();
    const queue = join(h.dir, ".crewhaus", "review");
    mkdirSync(queue, { recursive: true });
    const id = "rev_abstained_run_00000000000000aa_s1";
    writeFileSync(
      join(queue, "queue.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id,
        kind: "abstained",
        sourceRef: { runId: "run_00000000000000aa", sampleId: "s1" },
        ts: AGO(60_000),
        status: "open",
      })}\n`,
    );
    const ref = (await itemOf(h.id, "review"))["ref"] as string;
    const read = (await itemOf(h.id, "review"))["evidenceRev"];
    await adjudicateReview({
      harnessDir: h.dir,
      itemId: id,
      verdict: "pass",
      by: "elsewhere",
      nowIso: new Date().toISOString(),
    });
    const late = await home.call("POST", path(h.id, ref, "resolve"), {
      body: { choice: "fail", expect: read },
    });
    expect([409, 412]).toContain(late.status);
    expect(lines(h.dir)).toEqual([]);
  });
});

describe("attention.* on the harness's stream", () => {
  test("each act is one event carrying the ref, with no text; the rest of the stream is as it was", async () => {
    const h = await harness({ approvals: [approval("appr_00000000000000a6")] });
    const ref = (await itemOf(h.id, "permission"))["ref"] as string;
    const controller = new AbortController();
    const res = await fetch(`${home.t.base}/api/v1/harnesses/${h.id}/events`, {
      headers: bearer(home.session),
      signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const frames = () =>
      text
        .split("\n\n")
        .flatMap((block) => {
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          return event === undefined || data === undefined
            ? []
            : [{ event, data: JSON.parse(data) as Record<string, unknown> }];
        })
        .filter((f) => f.event.startsWith("attention."));
    const act = async (verb: string, body: unknown) => {
      const before = frames().length;
      const done = await home.call("POST", path(h.id, ref, verb), {
        body,
        secret: operator.secret,
      });
      expect([verb, done.status]).toEqual([verb, 200]);
      for (let i = 0; i < 200 && frames().length === before; i++) {
        const got = await reader.read();
        if (got.done) break;
        text += decoder.decode(got.value, { stream: true });
      }
      expect([verb, frames().length]).toEqual([verb, before + 1]);
    };
    // The stream answers once it is live; everything after is sent on it.
    await act("messages", { text: SAID });
    await act("assign", { to: maintainer.principal });
    await act("resolve", { choice: "deny" });
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const seen = frames();
    expect(seen.map((f) => f.event)).toEqual([
      "attention.message",
      "attention.assigned",
      "attention.resolved",
    ]);
    for (const { data } of seen) {
      expect(schemaOf("eventEnvelope")?.safeParse(data).success).toBe(true);
      expect(data["attention"]).toBe(ref);
      expect(data["actor"]).toBe(operator.principal);
      expect(data["harness"]).toBe(h.id);
    }
    const all = JSON.stringify(seen);
    for (const plant of [SAID, "jane", "SendMessage", maintainer.principal, mintId("prn")]) {
      expect(all.includes(plant)).toBe(false);
    }
  }, 20_000);
});
