/**
 * A command a service submits answers to the credential it submitted with: its receipt
 * records that credential, on the versioned API and on a legacy route alike, and a command
 * Home dispatches or recovers runs only while exactly that credential may still do it, as
 * one that waits or one that had started. A receipt that names no credential passes while its service
 * still holds the permission through a live token of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import { type Ledger, append } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { type V1Home, v1Home } from "./__test__/v1-home";
import { startHangarServer } from "./server";

const homes: V1Home[] = [];
afterEach(async () => {
  while (homes.length > 0) await (homes.pop() as V1Home).t.stop();
});

async function home(): Promise<V1Home> {
  const h = await v1Home();
  homes.push(h);
  return h;
}

/** Every row a segmented ledger holds, in order. */
function rowsOf(ledger: Ledger): Record<string, unknown>[] {
  if (!("dir" in ledger.records)) throw new Error("segmented ledgers only");
  const dir = join(ledger.root, ledger.records.dir);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => /^\d{6}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

/**
 * A `controls.stop` from a Home whose process is gone: `accepted`, or `running` when it
 * had started.
 */
function plantStop(
  dir: string,
  harness: string,
  actor: string,
  credentialRef?: string,
  state: "accepted" | "running" = "accepted",
): string {
  const id = mintId("cmd");
  const accepted = {
    v: 1,
    id,
    kind: "controls.stop",
    target: `home/harness/${harness}`,
    actor,
    ...(credentialRef !== undefined ? { credentialRef } : {}),
    via: "api",
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
  };
  const rows =
    state === "running"
      ? [accepted, { ...accepted, state: "running", startedAt: new Date().toISOString() }]
      : [accepted];
  for (const row of rows) {
    const appended = append(commandsLedgerOf(dir), row);
    if (!appended.ok) throw new Error(appended.reason);
  }
  return id;
}

/** One service with two tokens: A (`h.control`) and the broader B (`h.control`, `h.deploy`). */
async function twoTokens(h: V1Home, harness: string) {
  const a = await h.service("portal", [harness], { permissions: ["h.control"] });
  const b = await h.service("portal", [harness], { permissions: ["h.control", "h.deploy"] });
  expect(b.principal).toBe(a.principal);
  return { a, b };
}

async function revoke(h: V1Home, credential: string): Promise<void> {
  const revoked = await openAccess(h.t.hangarRoot).revoke({ principal: h.owner }, credential);
  if (!revoked.ok) throw new Error(revoked.reason);
}

const statesOf = (dir: string, id: string) =>
  rowsOf(commandsLedgerOf(dir)).filter((row) => row["id"] === id);

/** A second Home over the first one's records, booted after it stopped. */
function rebootOver(h: V1Home) {
  return startHangarServer({
    port: 0,
    root: h.t.hangarRoot,
    registryRoot: h.t.registryRoot,
    env: { CREWHAUS_WATCHME_ROOT: join(h.t.workspace, "watchme") },
    onWarn: () => undefined,
  });
}

describe("a receipt records the credential its command was submitted with", () => {
  test("a service's receipt names its token's credential; a session's names none", async () => {
    const h = await home();
    const { id, dir } = await h.harness("submitted");
    const svc = await h.service("portal", [id], { permissions: ["h.control"] });
    const asService = await h.call("POST", `/api/v1/harnesses/${id}/controls/stop`, {
      body: {},
      secret: svc.secret,
    });
    expect(asService.status).toBeLessThan(300);
    const receipt = asService.body["receipt"] as Record<string, unknown>;
    expect([receipt["actor"], receipt["credentialRef"]]).toEqual([svc.principal, svc.credential]);
    const rows = statesOf(dir, receipt["id"] as string);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row["credentialRef"]).toBe(svc.credential);
    // A live credential's command runs: it is not refused at dispatch.
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "running", "succeeded"]);
    expect((rows.at(-1)?.["outcome"] as { code?: string } | undefined)?.code).not.toBe("forbidden");

    const asSession = await h.call("POST", `/api/v1/harnesses/${id}/controls/stop`, { body: {} });
    expect(asSession.status).toBeLessThan(300);
    const sessionReceipt = asSession.body["receipt"] as Record<string, unknown>;
    expect(sessionReceipt["actor"]).toBe(h.owner);
    expect("credentialRef" in sessionReceipt).toBe(false);
    for (const row of statesOf(dir, sessionReceipt["id"] as string)) {
      expect("credentialRef" in row).toBe(false);
    }
  }, 20_000);
});

describe("a receipt from a legacy route records the credential too", () => {
  test("a service's drain names its token's credential; a session's names none", async () => {
    const h = await home();
    const { id, dir } = await h.harness("legacy-drain");
    const svc = await h.service("portal", [id], { permissions: ["h.control"] });
    const drains = () =>
      rowsOf(commandsLedgerOf(dir)).filter((row) => row["kind"] === "controls.drain");
    const asService = await h.call("POST", `/api/h/${id}/proc/drain`, {
      body: {},
      secret: svc.secret,
    });
    expect(asService.status).toBeLessThan(500);
    const serviceRows = drains();
    expect(serviceRows.length).toBeGreaterThan(0);
    const serviceId = serviceRows[0]?.["id"] as string;
    for (const row of serviceRows) {
      expect([row["id"], row["actor"], row["credentialRef"]]).toEqual([
        serviceId,
        svc.principal,
        svc.credential,
      ]);
    }
    expect((serviceRows.at(-1)?.["outcome"] as { code?: string } | undefined)?.code).not.toBe(
      "forbidden",
    );

    const asSession = await h.call("POST", `/api/h/${id}/proc/drain`, { body: {} });
    expect(asSession.status).toBeLessThan(500);
    const sessionRows = drains().filter((row) => row["id"] !== serviceId);
    expect(sessionRows.length).toBeGreaterThan(0);
    for (const row of sessionRows) {
      expect(row["actor"]).toBe(h.owner);
      expect("credentialRef" in row).toBe(false);
    }
  }, 20_000);
});

describe("a command Home dispatches or recovers runs only while the credential that submitted it may", () => {
  test("revoked while a sibling token stays live: the live Home's recovery rejects it, unrun", async () => {
    const h = await home();
    const { id, dir } = await h.harness("recover-live");
    const { a, b } = await twoTokens(h, id);
    const cmd = plantStop(dir, id, a.principal, a.credential);
    await revoke(h, a.credential);
    const live = openAccess(h.t.hangarRoot).load();
    if (live.state !== "present") throw new Error("no access records");
    expect(live.snapshot.tokens.find((t) => t.id === b.credential)?.state).toBe("active");

    // Outside any request no harness is visible to "all", so the live Home is asked for this one.
    const counts = await h.t.server.controlService.commands.recover({ harness: dir });
    expect(counts.redispatched).toBe(1);
    const rows = statesOf(dir, cmd);
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
    expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
    expect(rows.some((row) => row["startedAt"] !== undefined)).toBe(false);
  }, 20_000);

  test("revoked while a sibling token stays live: a fresh Home's boot rejects it, unrun", async () => {
    const h = await home();
    const { id, dir } = await h.harness("recover-boot");
    const { a } = await twoTokens(h, id);
    await h.t.server.stop();
    const cmd = plantStop(dir, id, a.principal, a.credential);
    await revoke(h, a.credential);
    const again = rebootOver(h);
    try {
      const booted = await again.ready;
      expect(booted.commands.redispatched).toBe(1);
      const rows = statesOf(dir, cmd);
      expect(rows.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
      expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
      expect(rows.some((row) => row["startedAt"] !== undefined)).toBe(false);
    } finally {
      await again.stop();
    }
  }, 20_000);

  test("a running command a revoked credential submitted is not run again on boot", async () => {
    const h = await home();
    const { id, dir } = await h.harness("recover-running");
    const { a } = await twoTokens(h, id);
    await h.t.server.stop();
    const cmd = plantStop(dir, id, a.principal, a.credential, "running");
    await revoke(h, a.credential);
    const again = rebootOver(h);
    try {
      await again.ready;
      const rows = statesOf(dir, cmd);
      expect(rows.map((row) => row["state"])).toEqual(["accepted", "running", "failed"]);
      expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
      expect(rows.at(-1)?.["credentialRef"]).toBe(a.credential);
    } finally {
      await again.stop();
    }
  }, 20_000);

  test("a command whose credential is still live runs on boot", async () => {
    const h = await home();
    const { id, dir } = await h.harness("recover-held");
    const { a } = await twoTokens(h, id);
    await h.t.server.stop();
    const cmd = plantStop(dir, id, a.principal, a.credential);
    const again = rebootOver(h);
    try {
      const booted = await again.ready;
      expect(booted.commands.redispatched).toBe(1);
      const rows = statesOf(dir, cmd);
      expect(rows.map((row) => row["state"])).toEqual(["accepted", "running", "succeeded"]);
      expect((rows.at(-1)?.["outcome"] as { code?: string } | undefined)?.code).not.toBe(
        "forbidden",
      );
    } finally {
      await again.stop();
    }
  }, 20_000);

  test("a receipt that names no credential runs while its service holds the permission through a live token", async () => {
    const h = await home();
    const { id, dir } = await h.harness("recover-unnamed");
    const { a } = await twoTokens(h, id);
    await h.t.server.stop();
    const cmd = plantStop(dir, id, a.principal);
    await revoke(h, a.credential);
    const again = rebootOver(h);
    try {
      const booted = await again.ready;
      expect(booted.commands.redispatched).toBe(1);
      const rows = statesOf(dir, cmd);
      const last = rows.at(-1) as Record<string, unknown>;
      expect((last["outcome"] as { code?: string } | undefined)?.code).not.toBe("forbidden");
      expect(rows.map((row) => row["state"])).toEqual(["accepted", "running", "succeeded"]);
    } finally {
      await again.stop();
    }
  }, 20_000);
});
