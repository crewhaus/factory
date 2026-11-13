/**
 * A Home job in a directory that holds the home directory needs the acknowledgement a start
 * needs, for that one job, and nothing keeps it; a restart Home refuses before it stops
 * anything says the daemon keeps running.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { makeFixtureHarness } from "./fixture";
import { JobRefusedError, createProcessLayer } from "./process";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function jobsLedger(t: TestServer): string {
  const file = join(t.hangarRoot, "jobs.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** A harness whose directory is the server's home directory. */
async function homeHarness(): Promise<{ t: TestServer; home: string; id: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hangar-jobs-home-")));
  const t = bootTestServer({ now: () => NOW, env: { HOME: home } });
  makeFixtureHarness(home, { specName: "jobs-home" });
  return { t, home, id: await register(t, home) };
}

function expectHoldsHome(res: { status: number; body: Record<string, unknown> }): void {
  expect(res.status).toBe(409);
  expect(res.body["reason"]).toBe("preflight-blocked");
  expect(res.body["refused"]).toEqual([
    expect.objectContaining({ id: "workspace.holds-home", acknowledgeable: true }),
  ]);
}

describe("a Home job in a directory that holds the home directory", () => {
  test("needs the acknowledgement for each job, and nothing keeps it", async () => {
    const { t, home, id } = await homeHarness();
    try {
      const refused = await t.api(`/api/h/${id}/jobs`, post({ kind: "doctor" }));
      expectHoldsHome(refused);
      expect(jobsLedger(t)).toBe("");

      const accepted = await t.api(
        `/api/h/${id}/jobs`,
        post({ kind: "doctor", acknowledge: ["workspace.holds-home"] }),
      );
      expect(accepted.status).toBe(202);
      const job = accepted.body["job"] as Record<string, unknown>;
      expect(job["kind"]).toBe("doctor");
      expect(Object.keys(job)).not.toContain("acknowledge");
      expect(jobsLedger(t)).not.toContain("acknowledge");
      expect(jobsLedger(t)).not.toContain("holds-home");

      // The next job asks again.
      expectHoldsHome(await t.api(`/api/h/${id}/jobs`, post({ kind: "doctor" })));
    } finally {
      await t.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("a job route of a Home area answers the same refusal", async () => {
    const { t, home, id } = await homeHarness();
    try {
      const refused = await t.api(`/api/h/${id}/doctor`, post({}));
      expectHoldsHome(refused);
      expect(String(refused.body["error"])).toContain("holds the home directory");
      expect(jobsLedger(t)).toBe("");
      const accepted = await t.api(
        `/api/h/${id}/doctor`,
        post({ acknowledge: ["workspace.holds-home"] }),
      );
      expect(accepted.status).toBe(200);
      expect((accepted.body["job"] as { kind: string }).kind).toBe("doctor");
    } finally {
      await t.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("a refused proposal job leaves no staged proposal behind", async () => {
    const { t, home, id } = await homeHarness();
    try {
      const refused = await t.api(
        `/api/h/${id}/spec/propose`,
        post({ edits: [{ path: "agent.instructions", value: "Hi." }] }),
      );
      expectHoldsHome(refused);
      expect(existsSync(join(home, ".crewhaus", "proposals"))).toBe(false);
      expect(jobsLedger(t)).toBe("");
    } finally {
      await t.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("a directory that holds no home directory needs no acknowledgement", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "hangar-jobs-elsewhere-")));
    const t = bootTestServer({ now: () => NOW, env: { HOME: join(elsewhere, "..", "home") } });
    try {
      const dir = makeFixtureHarness(join(t.harnessesRoot, "plain"), { specName: "plain" });
      const id = await register(t, dir);
      expect((await t.api(`/api/h/${id}/jobs`, post({ kind: "doctor" }))).status).toBe(202);
    } finally {
      await t.stop();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("a job with no harness runs in the server's directory, and is checked there", () => {
  test("the server's directory holding the home directory refuses without the acknowledgement", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hangar-jobs-layer-")));
    const layer = createProcessLayer({
      registry: openHangarRegistry({ root: join(root, "registry"), env: {} }),
      // A home directory beneath the working directory: the working directory holds it.
      env: { HOME: join(process.cwd(), "a-home-beneath") },
      now: () => NOW,
      onWarn: () => {},
      hangarRoot: join(root, "hangar"),
      managerVersion: "test",
      runJob: () => new Promise<{ exitCode?: number }>(() => {}),
      noPreflight: true,
    });
    try {
      let thrown: unknown;
      try {
        layer.jobs.submit({ harnessDir: "", kind: "doctor", argv: ["doctor"] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(JobRefusedError);
      expect((thrown as JobRefusedError).item.id).toBe("workspace.holds-home");
      expect(layer.jobs.pending()).toEqual([]);
      expect(() => layer.jobs.check({ harnessDir: "" })).toThrow(JobRefusedError);
      const record = layer.jobs.submit({
        harnessDir: "",
        kind: "doctor",
        argv: ["doctor"],
        acknowledge: ["workspace.holds-home"],
      });
      expect(Object.keys(record)).not.toContain("acknowledge");
    } finally {
      layer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a restart Home refuses before it stops anything", () => {
  test("answers 409 with running: true, and the daemon keeps running", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "hangar-restart-kept-")));
    const t = bootTestServer({
      now: () => NOW,
      preflight: true,
      env: {
        HOME: home,
        ANTHROPIC_API_KEY: "present",
        KEPT_SLACK_BOT_VALUE: "present",
        KEPT_SLACK_SIGNING_VALUE: "present",
      },
    });
    try {
      makeFixtureHarness(home, {
        specName: "restart-kept",
        target: "channel",
        noSpec: true,
        bundle: { entry: "daemon.ts" },
      });
      writeFileSync(
        join(home, "crewhaus.yaml"),
        [
          "name: restart-kept",
          "target: channel",
          "agent:",
          "  model: anthropic/claude-sonnet-4",
          "  instructions: |",
          "    You are a fixture.",
          "routing:",
          "  sessionKey: channel",
          "channels:",
          "  slack:",
          "    botToken: $KEPT_SLACK_BOT_VALUE",
          "    signingSecret: $KEPT_SLACK_SIGNING_VALUE",
          "",
        ].join("\n"),
      );
      const id = await register(t, home);
      const ack = { acknowledge: ["workspace.holds-home"] };
      expect((await t.api(`/api/h/${id}/proc/start`, post(ack))).status).toBe(200);
      const child = t.ops?.last();

      const refused = await t.api(`/api/h/${id}/proc/restart`, post({}));
      expectHoldsHome(refused);
      expect(refused.body["running"]).toBe(true);
      expect(t.ops?.children.length).toBe(1);
      expect(child?.signals).toEqual([]);

      // A group restart says the same of the member.
      expect((await t.api("/api/registry/groups", post({ name: "g" }))).status).toBe(201);
      await t.api(`/api/h/${id}/groups`, {
        method: "PUT",
        body: JSON.stringify({ groups: ["g"] }),
      });
      expect(
        openHangarRegistry({ root: t.registryRoot, env: {} }).adopt(id, "prn_test"),
      ).toBeDefined();
      const swept = await t.api("/api/registry/groups/g/proc/restart", post({}));
      const members = (swept.body["result"] as { members: Array<Record<string, unknown>> }).members;
      expect(members).toEqual([
        expect.objectContaining({ ok: false, reason: "preflight-blocked", running: true }),
      ]);
      expect(child?.signals).toEqual([]);

      // Acknowledged, the restart goes ahead.
      expect((await t.api(`/api/h/${id}/proc/restart`, post(ack))).status).toBe(200);
      expect(child?.signals).toEqual(["SIGTERM"]);
      expect(t.ops?.children.length).toBe(2);
    } finally {
      await t.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
