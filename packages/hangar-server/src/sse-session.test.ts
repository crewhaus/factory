/**
 * A live run stream opened with a browser session closes when that session ends: past
 * its sliding deadline with `event: auth.expired`, on sign-out with `event: auth.revoked`,
 * each just before `done`. A stream opened with Home's own key is not tied to a session.
 * The 30-second check is driven by calling it, on a fake clock, never by waiting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bearer, signInFromBootLink } from "./__test__/browser";
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
async function liveRun(): Promise<{ t: TestServer; feedPath: string; advance(ms: number): void }> {
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
