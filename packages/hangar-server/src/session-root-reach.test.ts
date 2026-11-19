/**
 * Home reads and writes a harness's sessions only in a sessions folder that belongs to it.
 *
 * A sessions folder that, once every link is followed, lies outside the harness, or inside
 * another harness nested in it, is unreachable: no route shows a session, a transcript,
 * a rating, activity, a cost, a model route or a search result from it (the run stream's
 * case is in `v1/events.test.ts`), no approval is listed or
 * decided there, and no review verdict is written there. Each answer says it is unreachable,
 * and a cost is unknown, never $0.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { resolveContained } from "@crewhaus/harness-supervisor";
import {
  SESSION_DIR_ENV,
  containedSessionRoot,
  resolveHarnessSessionRoot,
} from "@crewhaus/session-store";
import { feedbackRecord, logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;
const SESS = "sess_00000000000000bb";
const APPR = "appr_00000000000000b9";
const ITEM = `rev_rater_disagreement_${SESS}_t1`;
const COMMENT = ["rating", "comment", "marker"].join("-");

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

/** Every file under `dir` with a hash of its bytes, so a later read can prove nothing moved. */
function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** A harness with one session that has a cost, a routing line and a pending approval. */
function sessionsOwner(at: string, name: string): string {
  return makeFixtureHarness(at, {
    specName: name,
    sessions: [
      {
        id: SESS,
        updatedAt: iso(NOW - DAY),
        lastTurnIndex: 1,
        log: [
          logLine("user_message", { content: "do the thing" }, iso(NOW - DAY)),
          logLine(
            "cost_accrual",
            { provider: "anthropic", modelId: "m", costUsdMicros: 5_000 },
            iso(NOW - DAY),
          ),
          logLine("model_route", { chosen: "m" }, iso(NOW - DAY)),
          logLine(
            "user_feedback",
            {
              ...(feedbackRecord(SESS, 1, "down", iso(NOW - DAY)) as Record<string, unknown>),
              comment: COMMENT,
            },
            iso(NOW - DAY),
          ),
        ],
      },
    ],
    approvals: [
      {
        id: APPR,
        toolName: "SendMessage",
        inputHash: "hash-1",
        input: { channel: "ops", text: "ship it" },
        runId: "run_00000000000000b0",
        sessionId: SESS,
        surface: "daemon",
        createdAt: iso(NOW - DAY),
      },
    ],
  });
}

/** A harness whose review queue names a turn of {@link SESS}, with its sessions folder `link`ed. */
function reader(at: string, link: string): string {
  const dir = makeFixtureHarness(at, {
    specName: "reader",
    reviewQueue: [
      {
        schemaVersion: 1,
        id: ITEM,
        kind: "rater_disagreement",
        sourceRef: { sessionId: SESS, turn: 1 },
        ts: iso(NOW - DAY),
        status: "open",
        context: "split verdict — a: up, b: down",
      },
    ],
  });
  const sessions = join(dir, ".crewhaus", "sessions");
  rmSync(sessions, { recursive: true, force: true });
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  symlinkSync(link, sessions);
  return dir;
}

describe.skipIf(process.platform === "win32")(
  "a sessions folder that is not the harness's own",
  () => {
    test("a folder that links to another harness's is read and written by no route", async () => {
      const t = bootTestServer({ now: () => NOW });
      try {
        const b = sessionsOwner(join(t.workspace, "elsewhere", "b"), "owner-b");
        const a = reader(join(t.harnessesRoot, "a"), join(b, ".crewhaus", "sessions"));
        const id = await register(t, a);
        const before = treeHashes(b);

        const verdict = await t.api(`/api/h/${id}/review/${ITEM}`, {
          method: "POST",
          body: JSON.stringify({ verdict: "up" }),
        });
        expect(JSON.stringify(verdict.body)).toContain("unreachable");
        expect(verdict.body["adjudicated"]).not.toBe(true);

        const list = await t.api(`/api/h/${id}/sessions`);
        expect(list.status).toBe(200);
        expect(list.body["sessions"]).toEqual([]);
        expect(String(list.body["note"])).toContain("unreachable");

        const transcript = await t.api(`/api/h/${id}/sessions/${SESS}`);
        expect(transcript.status).toBe(409);
        expect(String(transcript.body["error"])).toContain("unreachable");

        const activity = await t.api("/api/activity?since=30d");
        expect(activity.status).toBe(200);
        expect(activity.body["sessionsUnreachable"]).toEqual([
          { harnessId: id, note: expect.stringContaining("unreachable") },
        ]);

        const costs = await t.api(`/api/h/${id}/costs`);
        const fold = costs.body["costs"] as Record<string, unknown>;
        expect(String(fold["unknown"])).toContain("unreachable");
        expect(fold["calls"]).toBe(0);

        const route = await t.api(`/api/h/${id}/models/routes/${SESS}`);
        expect(String(route.body["note"])).toContain("unreachable");
        expect(route.body["entries"]).toEqual([]);
        const models = await t.api(`/api/h/${id}/models`);
        expect(models.body["sessions"]).toEqual([]);
        expect(String(models.body["sessionsNote"])).toContain("unreachable");

        const fleet = await t.api("/api/harnesses?hydrate=1");
        const row = (fleet.body["harnesses"] as Array<Record<string, unknown>>).find(
          (h) => (h["entry"] as { id?: string } | undefined)?.id === id || h["id"] === id,
        );
        const rollup = (row?.["rollup"] ?? null) as Record<string, unknown> | null;
        expect(rollup?.["sessionCount"]).toBeNull();
        expect(rollup?.["spend7d"]).toBeNull();

        const search = await t.api(`/api/search?q=${SESS}`);
        expect(search.status).toBe(200);
        const ratings = await t.api(`/api/h/${id}/feedback`);
        expect(ratings.status).toBe(200);
        expect(ratings.body["sessionsScanned"]).toBe(0);
        expect(ratings.body["items"]).toEqual([]);
        expect(String(ratings.body["note"])).toContain("unreachable");
        const approvals = await t.api("/api/approvals?all=1");
        expect(approvals.status).toBe(200);
        // Nothing of the other harness's sessions reaches any of these answers (the
        // routing timeline and the search name only the id they were asked about).
        for (const answer of [list, transcript, activity, costs, models, approvals, ratings]) {
          expect(JSON.stringify(answer.body)).not.toContain(SESS);
          expect(JSON.stringify(answer.body)).not.toContain(COMMENT);
        }
        for (const answer of [
          list,
          transcript,
          activity,
          costs,
          route,
          models,
          search,
          approvals,
        ]) {
          expect(JSON.stringify(answer.body)).not.toContain(APPR);
        }
        expect(JSON.stringify(search.body)).not.toContain(`"kind":"session"`);
        expect(treeHashes(b)).toEqual(before);
      } finally {
        await t.stop();
      }
    }, 30_000); // a Home and a dozen requests; slow on a loaded runner

    test("a folder that links into a harness nested in this one lists and decides none of its approvals", async () => {
      const t = bootTestServer({ now: () => NOW });
      try {
        const p = makeFixtureHarness(join(t.harnessesRoot, "p"), { specName: "outer" });
        const b = sessionsOwner(join(p, "b"), "nested-b");
        const sessions = join(p, ".crewhaus", "sessions");
        rmSync(sessions, { recursive: true, force: true });
        symlinkSync(join(b, ".crewhaus", "sessions"), sessions);
        expect(containedSessionRoot(p, {})).toBeUndefined();
        expect(
          containedSessionRoot(p, { [SESSION_DIR_ENV]: "b/.crewhaus/sessions" }),
        ).toBeUndefined();
        const id = await register(t, p);
        const before = treeHashes(b);

        const ratings = await t.api(`/api/h/${id}/feedback`);
        expect(ratings.status).toBe(200);
        expect(ratings.body["sessionsScanned"]).toBe(0);
        expect(JSON.stringify(ratings.body)).not.toContain(SESS);
        expect(JSON.stringify(ratings.body)).not.toContain(COMMENT);
        expect(String(ratings.body["note"])).toContain("unreachable");

        const approvals = await t.api("/api/approvals?all=1");
        expect(approvals.status).toBe(200);
        expect(JSON.stringify(approvals.body)).not.toContain(APPR);
        const grant = await t.api(`/api/h/${id}/approvals/${APPR}/grant`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        expect(grant.status).toBeGreaterThanOrEqual(400);
        expect(treeHashes(b)).toEqual(before);

        // Moved there by the override instead, the folder is ignored the same way.
        writeFileSync(join(p, ".env"), `${SESSION_DIR_ENV}=b/.crewhaus/sessions\n`);
        const again = await t.api("/api/approvals?all=1");
        expect(JSON.stringify(again.body)).not.toContain(APPR);
        expect(treeHashes(b)).toEqual(before);
      } finally {
        await t.stop();
      }
    }, 30_000); // a Home and several requests; slow on a loaded runner
  },
);

describe.skipIf(process.platform === "win32")("the two containment walks", () => {
  test("Home's path check and the session root's agree on every kind of name", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = join(t.harnessesRoot, "walks");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "ok.txt"), "fine");
      const outside = join(t.workspace, "outside");
      mkdirSync(outside, { recursive: true });
      mkdirSync(`${dir}b`, { recursive: true });
      symlinkSync(outside, join(dir, "lout"));
      symlinkSync(join(dir, "sub"), join(dir, "lin"));
      symlinkSync(join(dir, "sub", "missing"), join(dir, "din"));
      symlinkSync(join(outside, "missing"), join(dir, "dout"));
      const names = [
        "sub/ok.txt",
        "sub/new.txt",
        "later/deeper",
        "../outside",
        outside,
        "../walksb/x",
        "lout",
        "lout/x",
        "lin",
        "lin/ok.txt",
        "din",
        "dout",
        "dout/x",
      ];
      const answers = names.map((name) => {
        const home = resolveContained(dir, name) !== undefined;
        const sessions = resolveHarnessSessionRoot(dir, { [SESSION_DIR_ENV]: name }).overrideActive;
        return `${name}: ${home}/${sessions}`;
      });
      expect(answers).toEqual(
        names.map((name) => {
          const kept = ["sub/ok.txt", "sub/new.txt", "later/deeper", "lin", "lin/ok.txt"];
          const both = kept.includes(name);
          return `${name}: ${both}/${both}`;
        }),
      );
    } finally {
      await t.stop();
    }
  });
});
