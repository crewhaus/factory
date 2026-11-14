/**
 * A live run stream opened with a browser session closes when that session ends: past
 * its sliding deadline with `event: auth.expired`, on sign-out with `event: auth.revoked`,
 * each just before `done`. A stream whose caller has lost access to it closes with
 * `event: revoked` once the access records move. A stream opened with Home's own key is
 * not tied to a session.
 * A stream's re-check ends with the stream, whatever closed it.
 * The 30-second check is driven by calling it, on a fake clock, never by waiting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { acceptInvite, bearer, signInFromBootLink } from "./__test__/browser";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const MINUTE = 60_000;

type Feed = {
  text(): string;
  until(predicate: (text: string) => boolean): Promise<void>;
  /** Read whatever arrives before `pending` settles. */
  drainWhile(pending: Promise<unknown>): Promise<void>;
  close(): Promise<void>;
};

async function openFeed(t: TestServer, path: string, secret: string): Promise<Feed> {
  const res = await t.fetchRaw(path, { headers: bearer(secret) });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let next: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const read = async (): Promise<boolean> => {
    next ??= reader.read();
    const { value, done } = await next;
    next = undefined;
    if (done) return false;
    seen += decoder.decode(value, { stream: true });
    return true;
  };
  return {
    text: () => seen,
    until: async (predicate) => {
      while (!predicate(seen)) if (!(await read())) return;
    },
    drainWhile: async (pending) => {
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      while (!settled) {
        next ??= reader.read();
        const won = await Promise.race([
          next.then(() => "frame" as const),
          pending.then(() => "done" as const),
        ]);
        if (won === "done") return;
        if (!(await read())) return;
      }
    },
    close: () => reader.cancel(),
  };
}

/** A Home on a clock the test moves, with one running daemon whose live feed is open. */
async function liveRun(): Promise<{
  t: TestServer;
  feedPath: string;
  advance(ms: number): void;
  now(): number;
}> {
  let clock = Date.parse("2026-11-11T00:00:00.000Z");
  const t = bootTestServer({ now: () => clock });
  servers.push(t);
  const dir = makeFixtureHarness(join(t.harnessesRoot, "streamer"), {
    specName: "streamer",
    target: "channel",
    bundle: { entry: "daemon.ts" },
  });
  const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (added.body["entry"] as { id: string }).id;
  const started = await t.api(`/api/h/${id}/proc/start`, { method: "POST", body: "{}" });
  expect(started.status).toBe(200);
  return {
    t,
    feedPath: `/api/h/${id}/runs/${started.body["runId"] as string}/events`,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const replayed = (text: string): boolean => text.includes("event: replay");
const ended = (text: string): boolean => text.includes("event: done");

describe("a run stream opened with a session", () => {
  test("closes with auth.expired once the session's hour passes", async () => {
    const { t, feedPath, advance } = await liveRun();
    const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const feed = await openFeed(t, feedPath, browser.session);
    await feed.until(replayed);
    advance(59 * MINUTE);
    t.server.checkSessions();
    expect(ended(feed.text())).toBe(false);
    advance(2 * MINUTE);
    t.server.checkSessions();
    await feed.until(ended);
    const text = feed.text();
    expect(text).toContain("event: auth.expired\ndata: {}\n\n");
    expect(text.indexOf("event: auth.expired")).toBeGreaterThan(-1);
    expect(text.indexOf("event: auth.expired")).toBeLessThan(text.indexOf("event: done"));
    expect(text).not.toContain("event: auth.revoked");
  });

  test("closes with auth.revoked when the session signs out", async () => {
    const { t, feedPath } = await liveRun();
    const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const feed = await openFeed(t, feedPath, browser.session);
    await feed.until(replayed);
    const out = await t.fetchRaw("/api/v1/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(browser.session) },
      body: "{}",
    });
    expect(out.status).toBe(200);
    await feed.until(ended);
    const text = feed.text();
    expect(text.indexOf("event: auth.revoked")).toBeGreaterThan(-1);
    expect(text.indexOf("event: auth.revoked")).toBeLessThan(text.indexOf("event: done"));
  });
});

describe("a run stream opened with Home's own key", () => {
  test("is not tied to a session", async () => {
    const { t, feedPath, advance } = await liveRun();
    const feed = await openFeed(t, feedPath, t.token);
    await feed.until(replayed);
    advance(13 * 60 * MINUTE);
    t.server.checkSessions();
    // A request that answers after the check: anything the stream wrongly sent because
    // of it is read first.
    await feed.drainWhile(t.fetchRaw("/healthz").then((r) => r.text()));
    expect(feed.text()).not.toContain("event: auth.");
    expect(ended(feed.text())).toBe(false);
    await feed.close();
  });
});

describe("a run stream whose caller loses access", () => {
  test("closes with revoked, not with data, once the member's grant is revoked", async () => {
    const { t, feedPath } = await liveRun();
    // The owner signs in first, which sets access up; then a member joins as an operator.
    await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const read = loadAccessSnapshot(t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const owner = { principal: read.snapshot.owner as string };
    const access = openAccess(t.hangarRoot);
    const id = feedPath.split("/")[3] as string;
    const invite = await access.createInvite(owner, { role: "operator", scope: `harness:${id}` });
    if (!invite.ok) throw new Error(invite.reason);
    const member = await acceptInvite(t.fetchRaw, invite.result.code, "Otto");
    const feed = await openFeed(t, feedPath, member.session);
    await feed.until(replayed);
    // The check with nothing moved closes nothing.
    t.server.checkSessions();
    await feed.drainWhile(t.fetchRaw("/healthz").then((r) => r.text()));
    expect(ended(feed.text())).toBe(false);
    const after = loadAccessSnapshot(t.hangarRoot);
    if (after.state !== "present") throw new Error("no access records");
    const grant = after.snapshot.grants.find(
      (g) => g.principal === (member.answer["principal"] as string),
    );
    const revoked = await access.revoke(owner, grant?.id as string);
    if (!revoked.ok) throw new Error(revoked.reason);
    t.server.checkSessions();
    await feed.until(ended);
    const text = feed.text();
    expect(text.indexOf("event: revoked")).toBeGreaterThan(-1);
    expect(text.indexOf("event: revoked")).toBeLessThan(text.indexOf("event: done"));
    expect(text).not.toContain("event: auth.revoked");
    // …and the member's next request is refused.
    const again = await t.fetchRaw(feedPath, { headers: bearer(member.session) });
    expect(again.status).toBe(403);
  });
});

describe("a run stream opened with a token that ends", () => {
  test("closes with revoked once the token's time is up, with nothing in the access records moved", async () => {
    const { t, feedPath, advance, now } = await liveRun();
    await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const read = loadAccessSnapshot(t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const owner = { principal: read.snapshot.owner as string };
    const id = feedPath.split("/")[3] as string;
    const service = await openAccess(t.hangarRoot, { now }).mintServiceToken(owner, {
      service: "portal",
      permissions: [],
      harnesses: [id],
      contentRead: true,
      ttlMs: 20 * MINUTE,
    });
    if (!service.ok) throw new Error(service.reason);
    const epoch = (): unknown => {
      const at = loadAccessSnapshot(t.hangarRoot);
      return at.state === "present" ? at.snapshot.epoch : at.state;
    };
    const before = epoch();
    const feed = await openFeed(t, feedPath, service.result.secret);
    await feed.until(replayed);
    advance(19 * MINUTE);
    t.server.checkSessions();
    await feed.drainWhile(t.fetchRaw("/healthz").then((r) => r.text()));
    expect(ended(feed.text())).toBe(false);
    advance(2 * MINUTE);
    t.server.checkSessions();
    await feed.until(ended);
    const text = feed.text();
    expect(text.indexOf("event: revoked")).toBeGreaterThan(-1);
    expect(text.indexOf("event: revoked")).toBeLessThan(text.indexOf("event: done"));
    expect(epoch()).toEqual(before);
  });
});

describe("a run stream's re-check ends with the stream", () => {
  test("a replay-only stream leaves no check behind; a live one is checked until its grant goes", async () => {
    const { t, feedPath } = await liveRun();
    const runId = "run_00000000000000f1";
    const dir = makeFixtureHarness(join(t.harnessesRoot, "replayer"), {
      specName: "replayer",
      runLedger: [
        {
          runId,
          kind: "daemon",
          argv: ["bun", "dist/daemon.ts"],
          startedAt: "2026-11-10T23:00:00.000Z",
          endedAt: "2026-11-10T23:05:00.000Z",
          exitCode: 0,
          logFile: `logs/${runId}.log`,
        },
      ],
      runLogs: [{ runId, log: "boot\nturn ok\n" }],
    });
    const added = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
    const replayer = (added.body["entry"] as { id: string }).id;
    await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const read = loadAccessSnapshot(t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const owner = { principal: read.snapshot.owner as string };
    const access = openAccess(t.hangarRoot);
    const invite = await access.createInvite(owner, { role: "viewer", scope: "home" });
    if (!invite.ok) throw new Error(invite.reason);
    const member = await acceptInvite(t.fetchRaw, invite.result.code, "Vee");

    // A stream with no live run replays its history and ends; its check ends with it.
    expect(t.server.openStreamChecks()).toBe(0);
    const replay = await openFeed(t, `/api/h/${replayer}/runs/${runId}/events`, member.session);
    await replay.until(ended);
    expect(replay.text().indexOf("event: replay")).toBeGreaterThan(-1);
    expect(t.server.openStreamChecks()).toBe(0);
    t.server.checkSessions();
    expect(t.server.openStreamChecks()).toBe(0);

    // A live stream keeps its check while it is open…
    const live = await openFeed(t, feedPath, member.session);
    await live.until(replayed);
    expect(t.server.openStreamChecks()).toBe(1);
    t.server.checkSessions();
    await live.drainWhile(t.fetchRaw("/healthz").then((r) => r.text()));
    expect(ended(live.text())).toBe(false);
    expect(t.server.openStreamChecks()).toBe(1);

    // …and closes with revoked once the grant goes, after which nothing is checked.
    const after = loadAccessSnapshot(t.hangarRoot);
    if (after.state !== "present") throw new Error("no access records");
    const grant = after.snapshot.grants.find(
      (g) => g.principal === (member.answer["principal"] as string),
    );
    const revoked = await access.revoke(owner, grant?.id as string);
    if (!revoked.ok) throw new Error(revoked.reason);
    t.server.checkSessions();
    await live.until(ended);
    const text = live.text();
    expect(text.indexOf("event: revoked")).toBeGreaterThan(-1);
    expect(text.indexOf("event: revoked")).toBeLessThan(text.indexOf("event: done"));
    expect(t.server.openStreamChecks()).toBe(0);
  });
});
