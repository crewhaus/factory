/**
 * The handlers whose permission depends on what is asked: each checks the rest with the
 * rule the choke point uses, and a caller without it is refused 403, naming what is
 * missing, before anything is written.
 *
 * Members are made the way people join: an invite from the owner, accepted through the
 * sign-in route.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import { append, foldStates } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { mergedSpawnEnv } from "@crewhaus/harness-supervisor";
import type { SpecEdit } from "@crewhaus/spec-patch";
import { specRev } from "@crewhaus/spec-patch/commit";
import { acceptInvite, acceptInviteTabOnly, bearer, signInFromBootLink } from "./__test__/browser";
import { makeFixtureHarness } from "./fixture";
import type { M3Context } from "./m3";
import { resolveInside } from "./safety";
import { startHangarServer } from "./server";
import { commitHomeEdits, readSpecFile } from "./spec-edit";
import { type TestServer, bootTestServer } from "./testkit";

const SPEC = (usd: number): string =>
  [
    "name: escalation-fixture",
    "target: cli",
    "agent:",
    "  model: anthropic/claude-sonnet-4",
    "  instructions: |",
    "    You are a fixture. Answer briefly.",
    "permissions:",
    "  mode: default",
    "budget:",
    `  usd: ${usd}`,
    "",
  ].join("\n");

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

type Home = {
  readonly t: TestServer;
  readonly id: string;
  readonly dir: string;
  readonly ownerId: string;
  readonly owner: Record<string, string>;
  member(role: string, scope?: string): Promise<{ headers: Record<string, string>; id: string }>;
};

async function home(options: { readonly lanHost?: string } = {}): Promise<Home> {
  const t = bootTestServer(options.lanHost !== undefined ? { lanHost: options.lanHost } : {});
  servers.push(t);
  const signedIn = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const dir = makeFixtureHarness(join(t.harnessesRoot, "escalation"), {
    specName: "escalation-fixture",
    noSpec: true,
  });
  writeFileSync(join(dir, "crewhaus.yaml"), SPEC(5));
  const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (added.body["entry"] as { id: string }).id;
  const read = loadAccessSnapshot(t.hangarRoot);
  if (read.state !== "present") throw new Error("no access records");
  const ownerId = read.snapshot.owner as string;
  const access = openAccess(t.hangarRoot);
  let n = 0;
  return {
    t,
    id,
    dir,
    ownerId,
    owner: bearer(signedIn.session),
    member: async (role, scope = `harness:${id}`) => {
      const invite = await access.createInvite({ principal: ownerId }, { role, scope });
      if (!invite.ok) throw new Error(invite.reason);
      n += 1;
      const joined = await acceptInvite(t.fetchRaw, invite.result.code, `Member ${n}`);
      return { headers: bearer(joined.session), id: joined.answer["principal"] as string };
    },
  };
}

async function call(
  h: Home,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.t.fetchRaw(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The last segment of `path` under `root`'s parent: the name a listing shows. */
const relativeName = (path: string, root: string): string => path.slice(root.length + 1);

const specText = (h: Home): string => readFileSync(join(h.dir, "crewhaus.yaml"), "utf8");

describe("spec writes that touch security or spending", () => {
  test("a member without the security permission cannot raise the budget, even with the typed name", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const before = specText(h);
    const raise = {
      edits: [{ path: "budget.usd", value: 50 }],
      confirmName: "escalation-fixture",
      expectedRev: specRev(before),
    };
    const put = await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, raise);
    expect(put.status).toBe(403);
    expect([put.body["code"], put.body["reason"], put.body["needs"]]).toEqual([
      "forbidden",
      "permission",
      "h.spec.edit.security",
    ]);
    expect(put.body["paths"]).toEqual(["budget.usd"]);
    expect(put.body["role"]).toBe("maintainer");
    // …and without the typed name: the same 403, never the 409 that asks for it.
    const { confirmName: _name, ...unnamed } = raise;
    expect((await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, unnamed)).status).toBe(
      403,
    );
    const patch = await call(h, maintainer.headers, "POST", `/api/h/${h.id}/spec/patch`, {
      edit: { path: "budget.usd", value: 50 },
      confirmName: "escalation-fixture",
      expectedRev: specRev(before),
    });
    expect([patch.status, patch.body["needs"]]).toEqual([403, "h.spec.edit.security"]);
    expect(specText(h)).toBe(before);
  });

  test("a member without the security permission cannot change a security surface", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const before = specText(h);
    const answer = await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, {
      edits: [{ path: "permissions.mode", value: "auto" }],
      confirmName: "escalation-fixture",
      expectedRev: specRev(before),
    });
    expect([answer.status, answer.body["needs"]]).toEqual([403, "h.spec.edit.security"]);
    expect(specText(h)).toBe(before);
  });

  test("a security surface inside a replaced block needs the security permission", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const before = specText(h);
    const swap = {
      edits: [
        {
          path: "agent",
          value: {
            model: "anthropic/claude-opus-4",
            instructions: "You are a fixture. Answer briefly.\n",
          },
        },
      ],
      confirmName: "escalation-fixture",
      expectedRev: specRev(before),
    };
    const named = await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, swap);
    expect([named.status, named.body["reason"], named.body["needs"]]).toEqual([
      403,
      "permission",
      "h.spec.edit.security",
    ]);
    expect(named.body["paths"]).toContain("agent.model");
    const { confirmName: _name, ...unnamed } = swap;
    const plain = await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, unnamed);
    expect([plain.status, plain.body["needs"]]).toEqual([403, "h.spec.edit.security"]);
    expect(specText(h)).toBe(before);
    // The same block, its model as it was: only what changes is weighed.
    const kept = await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, {
      edits: [
        {
          path: "agent",
          value: { model: "anthropic/claude-sonnet-4", instructions: "Answer in one line.\n" },
        },
      ],
      confirmName: "escalation-fixture",
      expectedRev: specRev(before),
    });
    expect(kept.status).toBe(200);
    expect(specText(h)).toContain("Answer in one line.");
  });

  test("inside the commit, a security surface inside a replaced block is refused", async () => {
    const h = await home();
    const onDisk = specText(h);
    const ctx = {
      entry: null,
      harnessDir: h.dir,
      adopted: false,
      params: {},
      query: new URLSearchParams(),
      body: {},
      env: {},
      now: Date.now,
      operator: "hangar",
      principal: "prn_01jc0000000000000000000009",
      authorize: (permission: string) => ({ allow: false, needs: permission, role: "maintainer" }),
      contain: (segments: readonly string[]) => resolveInside(h.dir, segments) as string,
      warn: () => undefined,
    } as unknown as M3Context;
    const edits: SpecEdit[] = [
      {
        path: ["agent"],
        value: { model: "anthropic/claude-opus-4", instructions: "Answer briefly.\n" },
      },
    ];
    let thrown: unknown;
    try {
      await commitHomeEdits(ctx, readSpecFile(ctx), edits, {
        writer: "home.spec",
        expectedRev: specRev(onDisk),
        restrict: false,
        confirmName: "escalation-fixture",
      });
    } catch (err) {
      thrown = err;
    }
    const refusal = thrown as { status?: number; body?: Record<string, unknown> };
    expect(refusal?.status).toBe(403);
    expect(refusal?.body?.["needs"]).toBe("h.spec.edit.security");
    expect(refusal?.body?.["paths"]).toContain("agent.model");
    expect(specText(h)).toBe(onDisk);
  });

  test("the owner raises the budget with the typed name; a maintainer edits a human-owned path", async () => {
    const h = await home();
    const owned = await call(h, h.owner, "PUT", `/api/h/${h.id}/spec`, {
      edits: [{ path: "budget.usd", value: 50 }],
      confirmName: "escalation-fixture",
      expectedRev: specRev(specText(h)),
    });
    expect(owned.status).toBe(200);
    expect(specText(h)).toContain("usd: 50");
    const maintainer = await h.member("maintainer");
    // `memory.enabled` is human-owned and on no security surface: the typed name suffices.
    const memory = await call(h, maintainer.headers, "PUT", `/api/h/${h.id}/spec`, {
      edits: [{ path: "memory.enabled", value: false }],
      confirmName: "escalation-fixture",
      expectedRev: specRev(specText(h)),
    });
    expect(memory.status).toBe(200);
    expect(specText(h)).toContain("enabled: false");
  });

  test("inside the commit, the text actually written decides: a raise there is refused", async () => {
    const h = await home();
    const onDisk = specText(h); // budget 5
    const path = join(h.dir, "crewhaus.yaml");
    const ctx = {
      entry: null,
      harnessDir: h.dir,
      adopted: false,
      params: {},
      query: new URLSearchParams(),
      body: {},
      env: {},
      now: Date.now,
      operator: "hangar",
      principal: "prn_01jc0000000000000000000009",
      authorize: (permission: string) => ({ allow: false, needs: permission, role: "maintainer" }),
      contain: (segments: readonly string[]) => resolveInside(h.dir, segments) as string,
      warn: () => undefined,
    } as unknown as M3Context;
    // The caller's read says the budget is 20, so setting 10 reads as a cut; the file says 5.
    const read = { ...readSpecFile(ctx), text: SPEC(20), path };
    const edits: SpecEdit[] = [{ path: ["budget", "usd"], value: 10 }];
    let thrown: unknown;
    try {
      await commitHomeEdits(ctx, read, edits, {
        writer: "home.spec",
        expectedRev: specRev(onDisk),
        restrict: false,
        confirmName: "escalation-fixture",
      });
    } catch (err) {
      thrown = err;
    }
    const refusal = thrown as { status?: number; body?: Record<string, unknown> };
    expect(refusal?.status).toBe(403);
    expect(refusal?.body?.["needs"]).toBe("h.spec.edit.security");
    expect(refusal?.body?.["paths"]).toEqual(["budget.usd"]);
    expect(specText(h)).toBe(onDisk);
  });

  test("synthesized edits and advice that touch a security surface need the security permission", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const before = specText(h);
    // watch on/off is a security surface (watchme), applied through the same spec write.
    const toggle = await call(
      h,
      maintainer.headers,
      "POST",
      `/api/h/${h.id}/memory/watchme/toggle`,
      {
        watching: true,
        confirm: true,
      },
    );
    expect(toggle.status).toBe(403);
    // A planted advice proposal on a security surface.
    const adviceDir = join(h.dir, ".crewhaus", "advice");
    await Bun.write(
      join(adviceDir, "suggestions.json"),
      JSON.stringify({
        suggestions: [
          {
            findingId: "adv_perm",
            severity: "high",
            summary: "loosen permissions",
            patch: { target: "cli", path: ["permissions", "mode"], op: "replace", value: "auto" },
          },
        ],
      }),
    );
    const advice = await call(
      h,
      maintainer.headers,
      "POST",
      `/api/h/${h.id}/feedback/advice/adv_perm/apply`,
      { confirm: true, expectedRev: specRev(before) },
    );
    expect([advice.status, advice.body["needs"]]).toEqual([403, "h.spec.edit.security"]);
    expect(specText(h)).toBe(before);
  });
});

describe("handlers that escalate by what is asked", () => {
  test("permission rules, hooks and environment files in settings need the security permission", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const write = (settings: unknown) =>
      call(h, maintainer.headers, "PUT", `/api/h/${h.id}/inspect/settings`, {
        settings,
        confirmName: "escalation-fixture",
      });
    const rules = await write({ permissions: { allow: ["Read(**)"] } });
    expect([rules.status, rules.body["needs"]]).toEqual([403, "h.spec.edit.security"]);
    expect(rules.body["paths"]).toEqual(["permissions"]);
    const hooks = await write({ manager: { hooks: [{ event: "start", command: "true" }] } });
    expect([hooks.status, hooks.body["paths"]]).toEqual([403, ["manager.hooks"]]);
    // The environment files a harness starts with carry credentials: another harness's
    // `.env` is the security permission's to name.
    const otherEnv = join(h.t.harnessesRoot, "bravo", ".env");
    mkdirSync(dirname(otherEnv), { recursive: true });
    writeFileSync(otherEnv, `${["BRAVO", "ONLY"].join("_")}=x1\n`);
    const envFiles = await write({ manager: { envFiles: [otherEnv] } });
    expect([envFiles.status, envFiles.body["needs"], envFiles.body["paths"]]).toEqual([
      403,
      "h.spec.edit.security",
      ["manager.envFiles"],
    ]);
    expect(mergedSpawnEnv({}, h.dir).env[["BRAVO", "ONLY"].join("_")]).toBeUndefined();
    const owner = await call(h, h.owner, "PUT", `/api/h/${h.id}/inspect/settings`, {
      settings: { permissions: { allow: ["Read(**)"] } },
      confirmName: "escalation-fixture",
    });
    expect(owner.status).toBe(200);
  });

  test("the raw transcript is the owner's; the read view is any reader's", async () => {
    const h = await home();
    const viewer = await h.member("viewer");
    const path = `/api/h/${h.id}/sessions/sess_00000000000000aa`;
    const raw = await call(h, viewer.headers, "GET", `${path}?raw=1`);
    expect([raw.status, raw.body["needs"]]).toEqual([403, "h.files.raw"]);
    expect((await call(h, viewer.headers, "GET", path)).status).not.toBe(403);
    expect((await call(h, h.owner, "GET", `${path}?raw=1`)).status).not.toBe(403);
  });

  test("Home's notification settings are Home's: a member changes none of them", async () => {
    const h = await home();
    const viewer = await h.member("viewer", "home");
    const asks: Array<Record<string, unknown>> = [
      { webhookUrl: "https://hooks.example.test/x" },
      { mutedGroups: ["everything"] },
      { rules: [{ kind: "approval-parked", enabled: false, sinks: ["in-app"] }] },
      { quietHours: { enabled: true, startHour: 0, endHour: 23, utcOffsetMinutes: 0 } },
    ];
    const before = (await call(h, h.owner, "GET", "/api/notifications")).body;
    for (const ask of asks) {
      const answer = await call(h, viewer.headers, "PUT", "/api/notifications", ask);
      expect([Object.keys(ask)[0], answer.status, answer.body["needs"]]).toEqual([
        Object.keys(ask)[0],
        403,
        "home.settings.manage",
      ]);
    }
    const after = (await call(h, h.owner, "GET", "/api/notifications")).body;
    for (const field of ["webhookUrl", "mutedGroups", "rules", "quietHours"]) {
      expect(after[field]).toEqual(before[field]);
    }
    // Asking for what is already set changes nothing, and is answered.
    const same = await call(h, viewer.headers, "PUT", "/api/notifications", {
      mutedGroups: before["mutedGroups"],
    });
    expect(same.status).toBe(200);
    const owned = await call(h, h.owner, "PUT", "/api/notifications", {
      webhookUrl: "https://hooks.example.test/x",
      mutedGroups: ["prod"],
    });
    expect(owned.status).toBe(200);
    expect(owned.body["mutedGroups"]).toEqual(["prod"]);
  });

  test("a member of B cannot clear or mute A's notifications", async () => {
    const h = await home();
    const parked = (id: string) => ({
      id,
      toolName: "SendMessage",
      inputHash: `hash-${id}`,
      input: { text: "go" },
      runId: "run_00000000000000b0",
      sessionId: "sess_00000000000000bb",
      surface: "daemon" as const,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const aDir = makeFixtureHarness(join(h.t.harnessesRoot, "alpha"), {
      specName: "alpha",
      approvals: [parked("appr_00000000000000a1")],
    });
    const bDir = makeFixtureHarness(join(h.t.harnessesRoot, "bravo"), {
      specName: "bravo",
      approvals: [parked("appr_00000000000000b1")],
    });
    const register = async (dir: string): Promise<string> =>
      (
        (await h.t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) })).body[
          "entry"
        ] as { id: string }
      ).id;
    const a = await register(aDir);
    const b = await register(bDir);
    const harnessesIn = (body: Record<string, unknown>): string[] =>
      (body["inApp"] as Array<{ harnessId: string }>).map((d) => d.harnessId).sort();
    const first = await call(h, h.owner, "GET", "/api/notifications");
    expect(harnessesIn(first.body)).toEqual([a, b].sort());
    const memberB = await h.member("viewer", `harness:${b}`);
    const mute = await call(h, memberB.headers, "PUT", "/api/notifications", {
      mutedGroups: ["everything"],
    });
    expect([mute.status, mute.body["needs"]]).toEqual([403, "home.settings.manage"]);
    const cleared = await call(h, memberB.headers, "POST", "/api/notifications/clear", {});
    expect(cleared.status).toBe(200);
    expect(harnessesIn((await call(h, memberB.headers, "GET", "/api/notifications")).body)).toEqual(
      [],
    );
    // A's entry stays in Home's queue: B's member cleared only what it may read.
    expect(harnessesIn((await call(h, h.owner, "GET", "/api/notifications")).body)).toEqual([a]);
  });

  test("a tab-only session never changes Home's settings, whatever its role", async () => {
    const h = await home({ lanHost: "127.0.0.1" });
    const invite = await openAccess(h.t.hangarRoot).createInvite(
      { principal: h.ownerId },
      { role: "owner", scope: "home" },
    );
    if (!invite.ok) throw new Error(invite.reason);
    const tab = await acceptInviteTabOnly(h.t.fetchRaw, invite.result.code, "Tab");
    expect(tab.status).toBe(200);
    const hook = await call(h, bearer(tab.session), "PUT", "/api/notifications", {
      webhookUrl: "https://collector.example.invalid/hook",
    });
    expect([hook.status, hook.body["code"], hook.body["reason"]]).toEqual([
      403,
      "forbidden",
      "tab_only",
    ]);
    expect((await call(h, h.owner, "GET", "/api/notifications")).body["webhookUrl"]).toBeNull();
    // The same session reads and acts within its role elsewhere.
    expect((await call(h, bearer(tab.session), "GET", "/api/notifications")).status).toBe(200);
  });

  test("moving a harness is for a person who manages Home's registry, never onto Home's records", async () => {
    const h = await home();
    const elsewhere = join(h.t.harnessesRoot, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const scopedOwner = await h.member("owner");
    const moved = await call(h, scopedOwner.headers, "POST", `/api/h/${h.id}/relocate`, {
      newDir: elsewhere,
    });
    expect([moved.status, moved.body["needs"]]).toEqual([403, "home.registry.manage"]);
    const entryDir = async (): Promise<string> =>
      ((await h.t.api(`/api/h/${h.id}`)).body["entry"] as { dir: string }).dir;
    expect(await entryDir()).toBe(h.dir);
    for (const newDir of [
      h.t.hangarRoot,
      dirname(h.t.hangarRoot),
      join(h.t.hangarRoot, "access"),
    ]) {
      mkdirSync(newDir, { recursive: true });
      const refused = await call(h, h.owner, "POST", `/api/h/${h.id}/relocate`, { newDir });
      expect([newDir, refused.status]).toEqual([newDir, 409]);
    }
    expect(await entryDir()).toBe(h.dir);
  });

  test("the file browser never serves Home's own records through a harness", async () => {
    const h = await home();
    // A harness registered around Home's own directory.
    const around = dirname(h.t.hangarRoot);
    const added = await h.t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: around }),
    });
    const id = (added.body["entry"] as { id: string } | undefined)?.id;
    expect(id).toBeDefined();
    const shown = relativeName(h.t.hangarRoot, around);
    for (const path of [shown, `${shown}/token`, `${shown}/access`]) {
      const res = await h.t.fetchRaw(`/api/h/${id}/inspect/raw?path=${encodeURIComponent(path)}`, {
        headers: h.owner,
      });
      const text = await res.text();
      expect(text).not.toContain(h.t.token);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect([path, body["present"] === true]).toEqual([path, false]);
    }
  });

  test("a job needs its own kind's permission; doctor --fix needs the credential writer's", async () => {
    const h = await home();
    const operator = await h.member("operator");
    const compile = await call(h, operator.headers, "POST", `/api/h/${h.id}/jobs`, {
      kind: "compile",
    });
    expect([compile.status, compile.body["needs"]]).toEqual([403, "h.deploy"]);
    const doctor = await call(h, operator.headers, "POST", `/api/h/${h.id}/jobs`, {
      kind: "doctor",
    });
    expect(doctor.status).toBe(202);
    const fix = await call(h, operator.headers, "POST", `/api/h/${h.id}/doctor`, { fix: true });
    expect([fix.status, fix.body["needs"]]).toEqual([403, "h.secrets.write"]);
    expect((await call(h, operator.headers, "POST", `/api/h/${h.id}/doctor`, {})).status).toBe(200);
  });

  test("calibrating the justification judge is the security permission's", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const path = `/api/h/${h.id}/security/justification/calibrate`;
    const apply = await call(h, maintainer.headers, "POST", path, { apply: true });
    expect([apply.status, apply.body["needs"]]).toEqual([403, "h.spec.edit.security"]);
    expect((await call(h, maintainer.headers, "POST", path, {})).status).toBe(200);
  });

  test("a credential set across harnesses is refused whole when any target is not the caller's", async () => {
    const h = await home();
    const other = makeFixtureHarness(join(h.t.harnessesRoot, "other"), { specName: "other" });
    const added = await h.t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: other }),
    });
    const otherId = (added.body["entry"] as { id: string }).id;
    const maintainer = await h.member("maintainer");
    const key = ["FIXTURE", "VALUE"].join("_");
    const across = await call(h, maintainer.headers, "POST", "/api/credentials/set", {
      key,
      value: "x1",
      harnessIds: [h.id, otherId],
      confirmName: key,
    });
    expect([across.status, across.body["needs"]]).toEqual([403, "h.secrets.write"]);
    for (const dir of [h.dir, other]) {
      let env = "";
      try {
        env = readFileSync(join(dir, ".env"), "utf8");
      } catch {
        env = "";
      }
      expect(env).not.toContain(key);
    }
    const own = await call(h, maintainer.headers, "POST", "/api/credentials/set", {
      key,
      value: "x1",
      harnessIds: [h.id],
      confirmName: key,
    });
    expect(own.status).toBe(200);
  });

  test("a group walk skips, as forbidden, a member the caller may read but not control", async () => {
    const h = await home();
    const other = makeFixtureHarness(join(h.t.harnessesRoot, "other"), {
      specName: "other",
      target: "channel",
      bundle: { entry: "daemon.ts" },
    });
    const added = await h.t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir: other }),
    });
    const otherId = (added.body["entry"] as { id: string }).id;
    await h.t.api("/api/registry/groups", {
      method: "POST",
      body: JSON.stringify({ name: "ops" }),
    });
    for (const hid of [h.id, otherId]) {
      await h.t.api(`/api/h/${hid}/groups`, {
        method: "PUT",
        body: JSON.stringify({ groups: ["ops"] }),
      });
    }
    // A viewer of the first harness who operates the second.
    const viewer = await h.member("viewer");
    const access = openAccess(h.t.hangarRoot);
    const granted = await access.grant(
      { principal: h.ownerId },
      { member: viewer.id, role: "operator", scope: `harness:${otherId}` },
    );
    if (!granted.ok) throw new Error(granted.reason);
    const plan = await call(h, viewer.headers, "GET", "/api/registry/groups/ops/proc/stop");
    const members = (plan.body["plan"] as { members: Array<Record<string, unknown>> }).members;
    const mine = members.find((m) => m["id"] === h.id);
    expect(mine?.["skipCode"]).toBe("forbidden");
    expect(members.find((m) => m["id"] === otherId)?.["skip"]).toBeNull();
    const walked = await call(h, viewer.headers, "POST", "/api/registry/groups/ops/proc/stop", {});
    const result = walked.body["result"] as { members: Array<Record<string, unknown>> };
    const skipped = result.members.find((m) => m["id"] === h.id);
    expect([skipped?.["skipped"], skipped?.["reason"]]).toEqual([true, "forbidden"]);
    // A caller who cannot read a member does not see it in the walk at all.
    const stranger = await h.member("operator", `harness:${otherId}`);
    const theirs = await call(h, stranger.headers, "GET", "/api/registry/groups/ops/proc/stop");
    const ids = (theirs.body["plan"] as { members: Array<{ id: string }> }).members.map(
      (m) => m.id,
    );
    expect(ids).toEqual([otherId]);
  });

  test("loosening a protected criterion needs the security permission; the typed name only confirms", async () => {
    const h = await home();
    const maintainer = await h.member("maintainer");
    const gradersPath = join(h.dir, "eval", "graders.yaml");
    mkdirSync(dirname(gradersPath), { recursive: true });
    const stored = [
      "graders:",
      "  - name: judge",
      "    type: llm_judge",
      "    rubric:",
      "      criteria:",
      "        - name: correct",
      "          description: the answer is correct",
      '          anchors: { "1": a, "2": b, "3": c, "4": d, "5": e }',
      "      passing_score: 4",
      "criteria:",
      "  - id: correct-answers",
      "    protected: true",
      "    measured_by: [judge]",
      "",
    ].join("\n");
    writeFileSync(gradersPath, stored);
    const route = `/api/h/${h.id}/builders/graders`;
    const rev = async (): Promise<string> =>
      String((await call(h, h.owner, "GET", route)).body["hash"]);
    const loosen = [{ op: "setMode", id: "correct-answers", value: "observe" }];

    // A maintainer: 403 naming the permission, with or without the typed name, in either form.
    const unprotected = stored.replace("    protected: true\n", "");
    for (const body of [
      { edits: loosen },
      { edits: loosen, confirmName: "escalation-fixture" },
      { yaml: unprotected, confirmName: "escalation-fixture" },
    ]) {
      const refused = await call(h, maintainer.headers, "POST", route, {
        ...body,
        expectedRev: await rev(),
      });
      expect(refused.status).toBe(403);
      expect([
        refused.body["code"],
        refused.body["reason"],
        refused.body["needs"],
        refused.body["role"],
      ]).toEqual(["forbidden", "permission", "h.spec.edit.security", "maintainer"]);
      expect(refused.body["paths"]).toEqual(["criteria.correct-answers"]);
      expect(readFileSync(gradersPath, "utf8")).toBe(stored);
    }

    // A tightening edit needs no security permission.
    const tighten = await call(h, maintainer.headers, "POST", route, {
      edits: [{ op: "setPassingScore", grader: "judge", value: 5 }],
      expectedRev: await rev(),
    });
    expect(tighten.status).toBe(200);
    expect(readFileSync(gradersPath, "utf8")).toContain("passing_score: 5");

    // The owner: the typed-name interstitial, then the write once the name matches.
    const asked = await call(h, h.owner, "POST", route, {
      edits: loosen,
      expectedRev: String(tighten.body["hash"]),
    });
    expect(asked.status).toBe(409);
    expect(asked.body["needs"]).toBe("h.spec.edit.security");
    expect(asked.body["confirmName"]).toBe("escalation-fixture");
    const confirmed = await call(h, h.owner, "POST", route, {
      edits: loosen,
      expectedRev: String(tighten.body["hash"]),
      confirmName: "escalation-fixture",
    });
    expect(confirmed.status).toBe(200);
    expect(readFileSync(gradersPath, "utf8")).toContain("mode: observe");
  });
});

describe("who a record names as its actor", () => {
  test("an approval records the signed-in principal; a by in the body is not who decided", async () => {
    const t = bootTestServer();
    servers.push(t);
    await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "decide"), {
      specName: "decide",
      sessions: [],
      approvals: [
        {
          id: "appr_00000000000000f1",
          toolName: "SendMessage",
          inputHash: "hash-f",
          input: { text: "go" },
          runId: "run_00000000000000f0",
          sessionId: "sess_00000000000000aa",
          surface: "daemon",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
    const id = (added.body["entry"] as { id: string }).id;
    const read = loadAccessSnapshot(t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const invite = await openAccess(t.hangarRoot).createInvite(
      { principal: read.snapshot.owner as string },
      { role: "operator", scope: `harness:${id}` },
    );
    if (!invite.ok) throw new Error(invite.reason);
    const operator = await acceptInvite(t.fetchRaw, invite.result.code, "Otto");
    const granted = await t.fetchRaw(`/api/h/${id}/approvals/appr_00000000000000f1/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(operator.session) },
      body: JSON.stringify({ by: "x@example.invalid" }),
    });
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as { approval: { decidedBy: string } };
    expect(body.approval.decidedBy).toBe(operator.answer["principal"] as string);
    const receiptActor = (body as unknown as { receipt: { actor: string } }).receipt.actor;
    expect(receiptActor).toBe(operator.answer["principal"] as string);
  });

  test("a queued command from a member whose grant was revoked is rejected, not run, when Home recovers it", async () => {
    const t = bootTestServer();
    servers.push(t);
    await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "queued"), { specName: "queued" });
    const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
    const id = (added.body["entry"] as { id: string }).id;
    const read = loadAccessSnapshot(t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const owner = { principal: read.snapshot.owner as string };
    const access = openAccess(t.hangarRoot);
    const granted = await access.grant(owner, {
      member: "Otto",
      create: true,
      role: "operator",
      scope: `harness:${id}`,
    });
    if (!granted.ok) throw new Error(granted.reason);
    const member = granted.result.principal;
    await t.server.stop();
    // Accepted from the member by a Home that then stopped; the grant is revoked before it runs.
    const appended = append(commandsLedgerOf(dir), {
      v: 1,
      id: mintId("cmd"),
      kind: "controls.stop",
      target: `home/harness/${id}`,
      actor: member,
      via: "home",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: new Date().toISOString(),
      executor: {
        pid: 2_147_483_000,
        startedAt: new Date().toISOString(),
        host: hostname(),
        head: "server",
      },
      effects: [],
      retry: { retryable: true, safety: "idempotent" },
    });
    if (!appended.ok) throw new Error(appended.reason);
    const revoked = await access.revoke(owner, granted.result.grant.id);
    if (!revoked.ok) throw new Error(revoked.reason);
    const again = startHangarServer({
      port: 0,
      root: t.hangarRoot,
      registryRoot: t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
      onWarn: () => undefined,
    });
    try {
      const booted = await again.ready;
      expect(booted.commands.redispatched).toBe(1);
      const fold = foldStates(commandsLedgerOf(dir));
      if (!fold.ok) throw new Error(fold.reason);
      const last = [...fold.objects.values()][0]?.record as Record<string, unknown>;
      expect([last["state"], (last["outcome"] as { code: string }).code]).toEqual([
        "rejected",
        "forbidden",
      ]);
    } finally {
      await again.stop();
    }
  }, 20_000);
});
