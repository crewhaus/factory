/**
 * The core's handlers, each answering what its operation row says: every served operation
 * is asked once, and a 2xx answer parses with the row's response schema, any other with
 * the error envelope. A prepared build recorded before its harness was registered, with
 * no harness and no spec hash, is served with its harness filled in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openAccess, openDeviceRequests } from "@crewhaus/access-control";
import { OPERATIONS, mintId, mintRunId } from "@crewhaus/control-contract";
import { makeSeal } from "@crewhaus/control-contract/http";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { casAppend, deploymentsLedger } from "@crewhaus/control-records";
import { appendRunLedger, newRunId } from "@crewhaus/harness-supervisor";
import { type V1Home, v1Home } from "../__test__/v1-home";
import {
  HOME_AREAS,
  HOME_CORE,
  HOME_CREATION,
  SIGN_IN_OPERATIONS,
  V1_NOT_SERVED,
  handlersOf,
} from "./areas";

type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

const APPR = "appr_00000000000000a1";
const STAMP = "2026-11-11T00:00:00.000Z";

let home: V1Home;
let a: { id: string; dir: string };
let dep: string;
let exec: string;
let member: string;
let service: { secret: string; credential: string; principal: string };

/** A build recorded the way compile does, before the directory was registered. */
async function preparedWithoutHarness(dir: string): Promise<string> {
  const id = mintId("dep");
  const answer = await casAppend(deploymentsLedger(dir), id, null, {
    id,
    state: "prepared",
    artifact: { digest: "d".repeat(64), shape: "cli", entry: "dist/agent.ts", bootInputs: [] },
    preparedAt: new Date().toISOString(),
  });
  if (!answer.ok || !answer.applied) throw new Error("not recorded");
  return id;
}

beforeAll(async () => {
  home = await v1Home();
  const pre = (await import("../fixture")).makeFixtureHarness(
    (await import("node:path")).join(home.t.harnessesRoot, "alpha"),
    {
      specName: "alpha",
      approvals: [
        {
          id: APPR,
          toolName: "SendMessage",
          inputHash: "hash-alpha",
          input: { channel: "ops", text: "hello" },
          runId: "run_00000000000000a0",
          sessionId: "sess_00000000000000aa",
          surface: "daemon",
          createdAt: STAMP,
        },
      ],
    },
  );
  dep = await preparedWithoutHarness(pre);
  const res = await home.t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir: pre }),
  });
  a = { id: (res.body["entry"] as { id: string }).id, dir: pre };
  exec = newRunId();
  appendRunLedger(a.dir, {
    runId: exec,
    kind: "daemon",
    argv: ["crewhaus", "run"],
    startedAt: STAMP,
    logFile: `logs/${exec}.log`,
  });
  const granted = await openAccess(home.t.hangarRoot).grant(
    { principal: home.owner },
    { member: "Sam", create: true, role: "viewer", scope: "home" },
  );
  if (!granted.ok) throw new Error(granted.reason);
  member = granted.result.principal;
  service = await home.service("portal", [a.id], { contentRead: true });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe("a build recorded before its harness was registered", () => {
  test("deployments.list and deployments.get fill its harness, and it parses", async () => {
    const list = await home.call("GET", `/api/v1/harnesses/${a.id}/deployments`);
    expect(list.status).toBe(200);
    const row = (list.body["items"] as Record<string, unknown>[]).find((r) => r["id"] === dep);
    expect(row?.["harness"]).toBe(a.id);
    expect((row?.["artifact"] as Record<string, unknown>)["specHash"]).toBeUndefined();
    expect(schemaOf("deploymentList")?.safeParse(list.body).success).toBe(true);
    const one = await home.call("GET", `/api/v1/harnesses/${a.id}/deployments/${dep}`);
    expect(one.status).toBe(200);
    expect(one.body["harness"]).toBe(a.id);
    expect(schemaOf("deployment")?.safeParse(one.body).success).toBe(true);
    // The schema still requires the harness: the fill is what makes the row parse.
    const { harness: _gone, ...unfilled } = one.body;
    expect(schemaOf("deployment")?.safeParse(unfilled).success).toBe(false);
  });
});

describe("every served operation answers its row's shape", () => {
  test("each handler, asked once", async () => {
    const seal = async () => (await makeSeal()).seal;
    const devices = openDeviceRequests(home.t.hangarRoot);
    const started = await devices.start({});
    if (!started.ok) throw new Error(started.reason);
    const invited = await openAccess(home.t.hangarRoot).createInvite(
      { principal: home.owner },
      { role: "viewer", scope: "home" },
    );
    if (!invited.ok) throw new Error(invited.reason);
    const grants = (await home.call("GET", "/api/v1/access/grants")).body["items"] as {
      id: string;
      principal: string;
    }[];
    const memberGrant = grants.find((g) => g.principal === member)?.id as string;
    const ref = `${a.id}/decision/${APPR}`;
    const until = new Date(Date.now() + 86_400_000).toISOString();
    type Ask = { path: string; body?: unknown; secret?: string };
    const firstRun = async (): Promise<string> => {
      const list = await home.call("GET", `/api/v1/harnesses/${a.id}/runs?limit=1`);
      return ((list.body["items"] as { id: string }[])[0]?.id ?? mintRunId()) as string;
    };
    const asks: Record<string, Ask | (() => Promise<Ask>)> = {
      "meta.discover": { path: "/api/v1" },
      "me.get": { path: "/api/v1/me" },
      "refs.resolve": { path: `/api/v1/refs/home/harness/${a.id}` },
      "harnesses.list": { path: "/api/v1/harnesses" },
      "harnesses.get": { path: `/api/v1/harnesses/${a.id}` },
      "harnesses.capabilities": { path: `/api/v1/harnesses/${a.id}/capabilities` },
      "harnesses.health": { path: `/api/v1/harnesses/${a.id}/health` },
      "specs.schema": { path: `/api/v1/harnesses/${a.id}/spec/schema` },
      "deployments.list": { path: `/api/v1/harnesses/${a.id}/deployments` },
      "deployments.get": { path: `/api/v1/harnesses/${a.id}/deployments/${dep}` },
      "deployments.activate": {
        path: `/api/v1/harnesses/${a.id}/deployments`,
        body: { deployment: dep },
      },
      "controls.pause": { path: `/api/v1/harnesses/${a.id}/controls/pause`, body: { quiet: true } },
      "controls.resume": { path: `/api/v1/harnesses/${a.id}/controls/resume`, body: {} },
      "controls.disable": { path: `/api/v1/harnesses/${a.id}/controls/disable`, body: {} },
      "controls.enable": { path: `/api/v1/harnesses/${a.id}/controls/enable`, body: {} },
      "controls.drain": { path: `/api/v1/harnesses/${a.id}/controls/drain`, body: {} },
      "controls.stop": { path: `/api/v1/harnesses/${a.id}/controls/stop`, body: {} },
      "controls.start": { path: `/api/v1/harnesses/${a.id}/controls/start`, body: {} },
      "controls.restart": { path: `/api/v1/harnesses/${a.id}/controls/restart`, body: {} },
      "controls.retire": { path: `/api/v1/harnesses/${a.id}/controls/retire`, body: {} },
      "decisions.list": { path: "/api/v1/decisions" },
      "decisions.get": { path: `/api/v1/decisions/${ref}` },
      "decisions.defer": {
        path: `/api/v1/decisions/${ref}/defer`,
        body: { until, reason: "scheduled" },
      },
      "decisions.resolve": { path: `/api/v1/decisions/${ref}/resolve`, body: { choice: "grant" } },
      "decisions.supersede": {
        path: `/api/v1/decisions/${ref}/supersede`,
        body: { reason: "other" },
      },
      "rules.list": { path: `/api/v1/harnesses/${a.id}/standing-rules` },
      "rules.create": {
        path: `/api/v1/harnesses/${a.id}/standing-rules`,
        body: {
          tool: "SendMessage",
          pattern: "SendMessage(ops)",
          derivedFrom: APPR,
          reason: "other",
        },
      },
      "rules.revoke": {
        path: `/api/v1/harnesses/${a.id}/standing-rules/${mintId("rule")}/revoke`,
        body: {},
      },
      "commands.list": { path: `/api/v1/harnesses/${a.id}/commands` },
      "commands.get": async () => {
        const list = await home.call("GET", `/api/v1/harnesses/${a.id}/commands?limit=1`);
        const first = (list.body["items"] as { id: string }[])[0];
        return { path: `/api/v1/commands/${first?.id ?? mintId("cmd")}` };
      },
      "access.members.list": { path: "/api/v1/access/members" },
      "access.invites.list": { path: "/api/v1/access/invites" },
      "access.grants.list": { path: "/api/v1/access/grants" },
      "access.tokens.list": { path: "/api/v1/access/tokens" },
      "access.links.list": { path: "/api/v1/access/links" },
      "access.devices.list": { path: "/api/v1/access/devices" },
      "access.invites.create": async () => ({
        path: "/api/v1/access/invites",
        body: { role: "viewer", scope: "home", seal: await seal() },
      }),
      "access.grants.create": {
        path: "/api/v1/access/grants",
        body: { principal: member, role: "operator", scope: `harness:${a.id}` },
      },
      "access.tokens.mint": async () => ({
        path: "/api/v1/access/tokens",
        body: { principal: service.principal, harnesses: [a.id], seal: await seal() },
      }),
      "access.links.create": {
        path: "/api/v1/access/links",
        body: { subject: "github:4242", principal: member },
      },
      "access.invites.revoke": {
        path: `/api/v1/access/invites/${invited.result.invite.id}/revoke`,
        body: {},
      },
      "access.grants.revoke": { path: `/api/v1/access/grants/${memberGrant}/revoke`, body: {} },
      "access.tokens.revoke": { path: `/api/v1/access/tokens/${mintId("crd")}/revoke`, body: {} },
      "access.links.revoke": { path: `/api/v1/access/links/${mintId("lnk")}/revoke`, body: {} },
      "access.devices.revoke": { path: `/api/v1/access/devices/${mintId("dev")}/revoke`, body: {} },
      "access.scopedTokens.mint": async () => ({
        path: "/api/v1/access/scoped-tokens",
        body: { refs: [`${a.id}/exec/${exec}`], acts: ["run.result.read"], seal: await seal() },
        secret: service.secret,
      }),
      "runs.create": {
        path: `/api/v1/harnesses/${a.id}/runs`,
        body: { input: "Summarise the report." },
      },
      "runs.list": { path: `/api/v1/harnesses/${a.id}/runs` },
      "runs.get": async () => ({ path: `/api/v1/runs/${await firstRun()}` }),
      "runs.result": async () => ({ path: `/api/v1/runs/${await firstRun()}/result` }),
      "runs.cancel": async () => ({ path: `/api/v1/runs/${await firstRun()}/cancel`, body: {} }),
      "runs.resume": async () => ({ path: `/api/v1/runs/${await firstRun()}/resume`, body: {} }),
      "auth.device.lookup": {
        path: "/api/v1/access/device-requests/lookup",
        body: { code: started.userCode },
      },
      "auth.device.decide": {
        path: "/api/v1/access/device-requests/decide",
        body: { code: started.userCode, choice: "deny" },
      },
      // No plugin is installed here: each answers the error envelope.
      "plugins.review": { path: "/api/v1/plugins/notes-pane/review" },
      "plugins.grant": {
        path: "/api/v1/plugins/notes-pane/grant",
        body: { harnesses: [a.id], panes: [], events: [], reads: [], net: [], tools: [] },
      },
      "plugins.revoke": { path: "/api/v1/plugins/notes-pane/revoke", body: {} },
    };
    // The core's handlers and creation's; delegation's are asked in its own contract test.
    const served = [...handlersOf([HOME_CORE, HOME_CREATION]).keys()];
    expect(served.filter((id) => !(id in asks))).toEqual([]);
    const shapes: string[] = [];
    const ok: string[] = [];
    const answers: Record<string, string> = {};
    // In the order written above: a deferral before the decision that settles it.
    for (const id of Object.keys(asks).filter((key) => served.includes(key))) {
      const op = OPERATIONS.find((o) => o.id === id);
      if (op === undefined) throw new Error(`no operation ${id}`);
      const given = asks[id] as Ask | (() => Promise<Ask>);
      const ask = typeof given === "function" ? await given() : given;
      const res = await home.call(op.method, ask.path, {
        ...(ask.body !== undefined ? { body: ask.body } : {}),
        ...(ask.secret !== undefined ? { secret: ask.secret } : {}),
      });
      const schema = res.status < 300 ? schemaOf(op.response) : schemaOf("errorEnvelope");
      const parsed = schema?.safeParse(res.body);
      if (parsed?.success !== true) {
        shapes.push(`${id} ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      }
      if (res.status < 300) ok.push(id);
      answers[id] = `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`;
    }
    expect(shapes).toEqual([]);
    // Most of them succeed: the test is about answers, not only refusals.
    for (const id of [
      "meta.discover",
      "me.get",
      "refs.resolve",
      "harnesses.list",
      "harnesses.get",
      "harnesses.capabilities",
      "harnesses.health",
      "specs.schema",
      "deployments.list",
      "deployments.get",
      "controls.pause",
      "controls.resume",
      "controls.retire",
      "decisions.list",
      "decisions.get",
      "decisions.defer",
      "decisions.resolve",
      "commands.list",
      "commands.get",
      "runs.list",
      "runs.get",
      "runs.result",
      "access.members.list",
      "access.tokens.list",
      "access.invites.create",
      "access.grants.create",
      "access.tokens.mint",
      "access.scopedTokens.mint",
      "auth.device.lookup",
      "auth.device.decide",
    ]) {
      expect(`${id} ${ok.includes(id) ? "ok" : answers[id]}`).toBe(`${id} ok`);
    }
  }, 60_000);

  test("the not-served map and the sign-in rows are the rest", () => {
    const served = new Set(handlersOf(HOME_AREAS).keys());
    for (const op of OPERATIONS) {
      const ways = [served.has(op.id), op.id in V1_NOT_SERVED, SIGN_IN_OPERATIONS.includes(op.id)];
      expect(`${op.id} ${ways.filter(Boolean).length}`).toBe(`${op.id} 1`);
    }
  });
});
