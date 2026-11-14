/**
 * The delegation area's handlers, each answering what its operation row says, the fields
 * Setup › Delegations reads, the reads that write nothing, the minute sweep, and the ref a
 * delegation rule resolves to. With the shipped composition no action is served, so every
 * request to turn a rule on answers `unsupported`, and the sweep applies nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DELEGATION_MODULE, OPERATIONS, mintId } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { casAppend, delegationsLedger, deploymentsLedger } from "@crewhaus/control-records";
import { type V1Home, v1Home } from "../__test__/v1-home";
import type { HomePorts } from "../sweeps";
import { HOME_AREAS, handlersOf, sweepsOf } from "./areas";
import { DELEGATIONS_SWEEP, HOME_DELEGATION } from "./delegations";
import { fleetSnapshot } from "./lists";

type Schema = {
  safeParse(value: unknown): { success: boolean; error?: unknown };
  shape?: Record<string, unknown>;
};
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

const POLICY = `sha256:${"1".repeat(64)}`;

let home: V1Home;
let a: { id: string; dir: string };
let bare: { id: string; dir: string };

async function activate(dir: string, harness: string, ceiling: Record<string, unknown> | null) {
  const id = mintId("dep");
  const row = {
    id,
    harness,
    artifact: { digest: "d".repeat(64), shape: "cli", entry: "dist/agent.ts", bootInputs: [] },
    policyRevision: POLICY,
    ...(ceiling !== null ? { delegation: ceiling } : {}),
  };
  await casAppend(deploymentsLedger(dir), id, null, { ...row, state: "prepared" });
  await casAppend(deploymentsLedger(dir), id, "prepared", {
    ...row,
    state: "active",
    activatedAt: new Date().toISOString(),
  });
}

/** Every file under a directory with its bytes: what "nothing changed" compares. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  home = await v1Home();
  a = await home.harness("alpha");
  bare = await home.harness("bravo");
  await activate(a.dir, a.id, { maxDays: 30 });
  await activate(bare.dir, bare.id, null);
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe("every delegation operation answers its row's shape", () => {
  test("each handler, asked once", async () => {
    const rule = mintId("rule");
    const digest = "0".repeat(64);
    const base = `/api/v1/harnesses/${a.id}/delegations`;
    const asks: Record<string, { path: string; body?: unknown; status: number }> = {
      "delegations.list": { path: base, status: 200 },
      "delegations.get": { path: `${base}/${rule}`, status: 404 },
      "delegations.preview": { path: `${base}/preview`, body: { action: "merge" }, status: 501 },
      "delegations.enable": {
        path: base,
        body: { action: "merge", consequencesDigest: digest, confirm: "alpha" },
        status: 501,
      },
      "delegations.propose": { path: `${base}/proposals`, body: { action: "merge" }, status: 501 },
      "delegations.update": {
        path: `${base}/${rule}/update`,
        body: { expect: 1, consequencesDigest: digest, confirm: "alpha" },
        status: 404,
      },
      "delegations.resume": {
        path: `${base}/${rule}/resume`,
        body: { expect: 1, consequencesDigest: digest, confirm: "alpha" },
        status: 404,
      },
      "delegations.revoke": { path: `${base}/${rule}/revoke`, body: {}, status: 404 },
      "delegations.pause": { path: `${base}/${rule}/pause`, body: {}, status: 404 },
      "delegations.apply": { path: `${base}/apply`, body: {}, status: 200 },
      "delegations.watches.keep": {
        path: `${base}/watches/${mintId("cmd")}/keep`,
        body: {},
        status: 404,
      },
    };
    const served = [...handlersOf([HOME_DELEGATION]).keys()];
    expect(served.sort()).toEqual(Object.keys(asks).sort());
    expect(served).toHaveLength(DELEGATION_MODULE.operations.length);
    const wrong: string[] = [];
    for (const [id, ask] of Object.entries(asks)) {
      const op = OPERATIONS.find((o) => o.id === id);
      if (op === undefined) throw new Error(`no operation ${id}`);
      const res = await home.call(
        op.method,
        ask.path,
        ask.body !== undefined ? { body: ask.body } : {},
      );
      const schema = res.status < 300 ? schemaOf(op.response) : schemaOf("errorEnvelope");
      if (schema?.safeParse(res.body).success !== true || res.status !== ask.status) {
        wrong.push(`${id} ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  test("the list carries every field the view reads, and says why it is empty", async () => {
    const allowed = await home.call("GET", `/api/v1/harnesses/${a.id}/delegations`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({
      items: [],
      offers: [],
      proposals: [],
      ceiling: { present: true, maxDays: 30 },
      empty: { reason: "no-data" },
    });
    expect(typeof allowed.body["note"]).toBe("string");
    expect(String(allowed.body["note"])).toContain("crewhaus delegations apply");
    const none = await home.call("GET", `/api/v1/harnesses/${bare.id}/delegations`);
    expect(none.body).toMatchObject({
      ceiling: { present: false },
      empty: { reason: "not-allowed" },
    });
    expect(schemaOf("delegationList")?.safeParse(none.body).success).toBe(true);
  });

  test("a refusal to turn a rule on says why, and nothing can be delegated yet", async () => {
    const res = await home.call("POST", `/api/v1/harnesses/${a.id}/delegations/preview`, {
      body: { action: "merge" },
    });
    expect(res.status).toBe(501);
    expect(res.body["error"]).toMatchObject({
      code: "unsupported",
      message: "Nothing can be delegated this way yet.",
    });
    const strict = await home.call("POST", `/api/v1/harnesses/${a.id}/delegations/preview`, {
      body: { action: "merge", terms: { note: "x" } },
    });
    expect(strict.status).toBe(400);
  });

  test("the page and the rule view carry the fields the view dereferences", () => {
    const page = schemaOf("delegationPage") as unknown as { shape: Record<string, unknown> };
    for (const field of [
      "title",
      "sections",
      "text",
      "consequencesDigest",
      "confirmName",
      "verb",
      "note",
    ]) {
      expect(Object.hasOwn(page.shape, field)).toBe(true);
    }
    const view = schemaOf("delegationRuleView") as unknown as { shape: Record<string, unknown> };
    for (const field of [
      "id",
      "action",
      "state",
      "label",
      "endsAt",
      "uses",
      "suspendedReason",
      "lastAction",
    ]) {
      expect(Object.hasOwn(view.shape, field)).toBe(true);
    }
    // The list's own fields: why it is empty and what to run, what could not be read, and
    // each maintainer's request an owner reviews.
    const list = schemaOf("delegationList") as unknown as { shape: Record<string, unknown> };
    for (const field of ["empty", "unreadable", "truncated", "proposals", "you", "offers"]) {
      expect([field, Object.hasOwn(list.shape, field)]).toEqual([field, true]);
    }
    const unreadable = {
      items: [],
      snapshotAt: fleetSnapshot(0),
      offers: [],
      proposals: [
        {
          id: mintId("dec"),
          action: "merge",
          days: 7,
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
          verb: "crewhaus delegations enable merge --harness hrn_1 --days 7",
        },
      ],
      ceiling: { present: false },
      empty: { reason: "unreadable", remedy: "Its deployment records cannot be read.", verb: "x" },
      unreadable: ["The deployment records cannot be read: bad"],
      note: "n",
    };
    expect(schemaOf("delegationList")?.safeParse(unreadable).success).toBe(true);
    expect(
      schemaOf("delegationList")?.safeParse({ ...unreadable, empty: { reason: "broken" } }).success,
    ).toBe(false);
  });

  test("the reads and the preview leave the harness byte-identical", async () => {
    const before = tree(a.dir);
    await home.call("GET", `/api/v1/harnesses/${a.id}/delegations`);
    await home.call("GET", `/api/v1/harnesses/${a.id}/delegations/${mintId("rule")}`);
    await home.call("POST", `/api/v1/harnesses/${a.id}/delegations/preview`, {
      body: { action: "merge" },
    });
    expect(tree(a.dir)).toEqual(before);
  });
});

describe("a delegation rule resolves as a rule ref", () => {
  test("refs.resolve answers its state and closed label, never its terms", async () => {
    const id = mintId("rule");
    const cmd = mintId("cmd");
    await casAppend(delegationsLedger(a.dir), id, null, {
      v: 1,
      at: new Date().toISOString(),
      id,
      state: "enabled",
      kind: "delegate",
      action: "merge",
      revision: 1,
      scope: { harness: a.id },
      terms: { days: 14 },
      termsDigest: "a".repeat(64),
      ceilingDigest: POLICY,
      policyRevision: POLICY,
      consequencesDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      owner: home.owner,
      cmd,
    });
    const res = await home.call("GET", `/api/v1/refs/${a.id}/rule/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "rule",
      rev: "enabled:1",
      summary: "A enabled delegation rule: Merges its own pull requests",
    });
  });
});

describe("the minute sweep", () => {
  test("registered once, every 60 seconds, applying each live harness as the scheduler", async () => {
    const named = sweepsOf(HOME_AREAS).filter((sweep) => sweep.name === "delegations");
    expect(named).toEqual([DELEGATIONS_SWEEP]);
    expect(DELEGATIONS_SWEEP.everyMs).toBe(60_000);
    const calls: unknown[] = [];
    const ports = {
      liveHarnesses: () => [
        { id: a.id, dir: a.dir },
        { id: bare.id, dir: bare.dir },
      ],
      delegations: {
        apply: async (harness: unknown, options: unknown) => {
          calls.push([harness, options]);
          return {} as never;
        },
      },
    } as unknown as HomePorts;
    const warnings: string[] = [];
    await DELEGATIONS_SWEEP.run({
      now: Date.now(),
      jobs: {} as never,
      home: ports,
      warn: (m) => warnings.push(m),
    });
    expect(calls).toEqual([
      [{ dir: a.dir, id: a.id }, { appliedBy: "sys:scheduler" }],
      [{ dir: bare.dir, id: bare.id }, { appliedBy: "sys:scheduler" }],
    ]);
    expect(warnings).toEqual([]);
  });

  test("no read calls the sweep's port", async () => {
    let applied = 0;
    const control = HOME_DELEGATION;
    expect(control.handlers?.["delegations.list"]).toBeDefined();
    // The read handlers reach the control service's list, get and preview only.
    const fake = {
      list: () => ({
        items: [],
        offers: [],
        proposals: [],
        ceiling: { present: false },
        note: "",
        unreadable: [],
      }),
      get: () => ({ ok: false, code: "not-found", reason: "none" }),
      preview: async () => ({ ok: false, code: "unsupported", reason: "none" }),
      apply: async () => {
        applied += 1;
        return {};
      },
    };
    const ctx = (id: string, body: Record<string, unknown> = {}) =>
      ({
        params: { h: a.id, rule: mintId("rule") },
        query: {},
        body,
        op: OPERATIONS.find((o) => o.id === id),
        access: {
          caller: { principal: home.owner, actor: { principal: home.owner }, via: "session" },
        },
        deps: {
          registry: {
            get: () => ({ id: a.id, dir: a.dir, missingSince: null, specName: "alpha" }),
            list: () => [],
          },
          control: { delegations: fake },
        },
        via: "home",
      }) as never;
    for (const id of ["delegations.list", "delegations.get", "delegations.preview"]) {
      try {
        await control.handlers?.[id]?.(
          ctx(id, id === "delegations.preview" ? { action: "merge" } : {}),
        );
      } catch {
        // A refusal is an answer: what matters is that nothing applied.
      }
    }
    expect(applied).toBe(0);
  });
});
