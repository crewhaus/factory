/**
 * Work items through Home's versioned API: the owner adds, reads, accepts, declines, ranks
 * and cancels; who may do which (a viewer reads, a service without content access sees
 * titles and states only, a service is never the one who accepts, declines or ranks, and
 * cancelling needs `h.control`); every read leaves the harness as it was; the masker sees
 * every answer; the stream's frames name ids and states only; the raw browser never serves
 * an item's content; and `runs.create {work}` starts a run for an accepted item.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { IDEMPOTENCY_HEADER, mintId } from "@crewhaus/control-contract";
import { readPage, runsLedger } from "@crewhaus/control-records";
import { openWorkStore, workLedger } from "@crewhaus/tool-work/work-items";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { exclusionFor } from "../inspect";
import { HOME_AREAS, V1_NOT_SERVED, homeCompositionProblems, streamSourcesOf } from "./areas";
import { WORK_PROJECTION, workLineEvent } from "./work";

const TOOLS = "tools: [read, workList, workGet, workPropose, workUpdate]";
const HARNESS = { by: "sys:runtime", via: "tool", role: "harness" } as const;

let home: V1Home;
let h: { id: string; dir: string };

beforeAll(async () => {
  home = await v1Home({
    apiRunLimits: { perHome: Number.MAX_SAFE_INTEGER, perHarness: Number.MAX_SAFE_INTEGER },
  });
  h = await home.harness("work-a", { specExtra: TOOLS });
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const errorOf = (body: Record<string, unknown>) => body["error"] as Record<string, unknown>;
const itemOf = (body: Record<string, unknown>) => body["item"] as Record<string, unknown>;

/** Every file under `dir` with its bytes' hash, so a read that wrote a byte is caught. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function propose(
  dir: string,
  title: string,
  basis: "user-pain" | "speculative" = "speculative",
) {
  const written = await openWorkStore(dir).propose(
    {
      title,
      kind: "fix",
      basis,
      ...(basis === "user-pain"
        ? {
            assessment: {
              problem: "Imports fail on dates.",
              evidence: [
                { label: "reported", kind: "user-report", ref: "ticket-12", note: "Two people." },
              ],
              counterEvidence: [],
            },
          }
        : {}),
    },
    HARNESS,
  );
  if (!written.ok) throw new Error(written.message);
  return written.item.id;
}

async function add(title: string, goal = "Make it pass.") {
  const res = await home.call("POST", `/api/v1/harnesses/${h.id}/work`, {
    body: { title, kind: "fix", goal, acceptance: ["The import test passes."] },
  });
  expect(res.status).toBe(200);
  return String(itemOf(res.body)["id"]);
}

describe("the owner's work", () => {
  test("add, read by every ref form, accept, decline and rank, each answered with its receipt", async () => {
    const wi = await add("Fix the import error");
    const ref = `${h.id}/work/${wi}`;
    const got = await home.call("GET", `/api/v1/work/${ref}`);
    expect(got.status).toBe(200);
    expect(itemOf(got.body)).toMatchObject({ id: wi, state: "open", statusWord: "Up next" });
    expect(got.body["content"]).toMatchObject({
      goal: "Make it pass.",
      acceptance: ["The import test passes."],
    });
    const hinted = await home.call("GET", `/api/v1/work/${wi}?harness=${h.id}`);
    expect(hinted.status).toBe(200);
    const bare = await home.call("GET", `/api/v1/work/${wi}`);
    expect(bare.status).toBe(422);
    expect(errorOf(bare.body)["reason"]).toBe("harness_needed");
    expect(JSON.stringify(bare.body)).toContain(ref);

    const idea = await propose(h.dir, "Add CSV export");
    const pain = await propose(h.dir, "Dates import as text", "user-pain");
    const accepted = await home.call("POST", `/api/v1/work/${h.id}/work/${idea}/accept`, {
      body: {},
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body["receipt"]).toMatchObject({ kind: "work.accept", state: "succeeded" });
    expect(itemOf(accepted.body)).toMatchObject({ id: idea, state: "open" });
    const again = await home.call("POST", `/api/v1/work/${h.id}/work/${idea}/accept`, {
      body: {},
    });
    expect(again.status).toBe(409);
    expect(errorOf(again.body)).toMatchObject({ reason: "not_proposed", current: "open" });
    const unreasoned = await home.call("POST", `/api/v1/work/${h.id}/work/${pain}/decline`, {
      body: {},
    });
    expect(unreasoned.status).toBe(400);
    const declined = await home.call("POST", `/api/v1/work/${h.id}/work/${pain}/decline`, {
      body: { reason: "needs-evidence", note: "Show me the ticket." },
    });
    expect(itemOf(declined.body)).toMatchObject({ state: "closed", outcome: "declined" });
    const ranked = await home.call("POST", `/api/v1/work/${h.id}/work/${idea}/rank`, {
      body: { below: wi, scope: "item" },
    });
    expect(ranked.status).toBe(200);
    expect(itemOf(ranked.body)).toMatchObject({ position: 1, corrected: { scope: "item" } });

    const stale = await home.call("POST", `/api/v1/work/${h.id}/work/${wi}/update`, {
      body: { expect: 9, title: "Later" },
    });
    expect(stale.status).toBe(412);
    expect(errorOf(stale.body)).toMatchObject({ reason: "stale_revision", current: 1 });

    const listed = await home.call("GET", `/api/v1/harnesses/${h.id}/work`);
    expect(listed.status).toBe(200);
    const ids = (listed.body["items"] as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([wi, idea, pain]));
    expect(typeof listed.body["snapshotAt"]).toBe("string");
  });

  test("an issue is not adopted yet, and a continuity goal is adopted once", async () => {
    const issue = await home.call("POST", `/api/v1/harnesses/${h.id}/work/adopt`, {
      body: { source: "github-issue:acme/app#12" },
    });
    expect(issue.status).toBe(501);
    expect(errorOf(issue.body)["reason"]).toBe("not_served");
    const unknown = await home.call("POST", `/api/v1/harnesses/${h.id}/work/adopt`, {
      body: { source: "continuity-goal:goal-0042" },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body["receipt"]).toMatchObject({ state: "rejected" });
  });
});

describe("who may do what", () => {
  test("a viewer lists and reads, and cannot add or cancel", async () => {
    const wi = await add("Viewer target");
    const viewer = await home.member("Vera", "viewer", { scope: `harness:${h.id}` });
    const list = await home.call("GET", `/api/v1/harnesses/${h.id}/work`, {
      secret: viewer.secret,
    });
    expect(list.status).toBe(200);
    const read = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}`, {
      secret: viewer.secret,
    });
    expect(read.status).toBe(200);
    const create = await home.call("POST", `/api/v1/harnesses/${h.id}/work`, {
      secret: viewer.secret,
      body: { title: "No", kind: "fix" },
    });
    expect(create.status).toBe(403);
    expect(errorOf(create.body)["needs"]).toBe("h.run.submit");
    const cancel = await home.call("POST", `/api/v1/work/${h.id}/work/${wi}/cancel`, {
      secret: viewer.secret,
      body: {},
    });
    expect(cancel.status).toBe(403);
  });

  test("a service without content access sees titles and states, never goals, notes or the feed's goals", async () => {
    const wi = await add("Titles only", "A goal a service must not read.");
    const svc = await home.service("titles", [h.id]);
    const read = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}`, {
      secret: svc.secret,
    });
    expect(read.status).toBe(200);
    expect(itemOf(read.body)).toMatchObject({ title: "Titles only", state: "open" });
    expect(read.body["content"]).toBeUndefined();
    expect(read.body["hidden"]).toEqual(["content"]);
    expect(JSON.stringify(read.body)).not.toContain("A goal a service must not read.");
    const feed = await home.call("GET", `/api/v1/harnesses/${h.id}/work/feed`, {
      secret: svc.secret,
    });
    expect(feed.status).toBe(200);
    expect(feed.body["hidden"]).toEqual(["content"]);
    const sections = feed.body["sections"] as Record<string, { empty?: { reason: string } }>;
    expect(sections["goals"]?.empty?.reason).toBe("no-access");
    const reader = await home.service("reader", [h.id], { contentRead: true });
    const full = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}`, {
      secret: reader.secret,
    });
    expect(full.body["content"]).toMatchObject({ goal: "A goal a service must not read." });
  });

  test("a service is never the one who accepts, declines or ranks, and cancels only with h.control", async () => {
    const wi = await add("Service target");
    const p = await propose(h.dir, "Service proposal");
    const svc = await home.service("submitter", [h.id], { permissions: ["h.run.submit"] });
    for (const [act, body] of [
      ["accept", {}],
      ["decline", { reason: "not-now" }],
      ["rank", { below: wi, scope: "all" }],
    ] as const) {
      const res = await home.call("POST", `/api/v1/work/${h.id}/work/${p}/${act}`, {
        secret: svc.secret,
        body,
      });
      expect(`${act} ${res.status} ${errorOf(res.body)["reason"]}`).toBe(`${act} 403 human_only`);
    }
    const cancel = await home.call("POST", `/api/v1/work/${h.id}/work/${wi}/cancel`, {
      secret: svc.secret,
      body: {},
    });
    expect(cancel.status).toBe(403);
    expect(errorOf(cancel.body)["needs"]).toBe("h.control");
    // The service adds work with its idempotency key, and the item records it as an API caller's.
    const added = await home.call("POST", `/api/v1/harnesses/${h.id}/work`, {
      secret: svc.secret,
      headers: { [IDEMPOTENCY_HEADER]: "svc-add-0001" },
      body: { title: "From the app", kind: "request" },
    });
    expect(added.status).toBe(200);
    const id = String(itemOf(added.body)["id"]);
    const read = openWorkStore(h.dir).get(id);
    expect("ok" in read ? undefined : read.revision?.source?.kind).toBe("api");
    expect("ok" in read ? undefined : read.revision?.fieldOrigins.title).toBe("api");
    expect(openWorkStore(h.dir).get(p)).toMatchObject({ item: { state: "proposed" } });
  });
});

describe("reads, the masker, the stream and the raw browser", () => {
  test("every work read leaves the harness byte-identical", async () => {
    const wi = await add("Read me");
    const before = tree(h.dir);
    for (const path of [
      `/api/v1/harnesses/${h.id}/work`,
      `/api/v1/harnesses/${h.id}/work/feed`,
      `/api/v1/work/${h.id}/work/${wi}`,
      `/api/v1/work/${wi}?harness=${h.id}`,
      `/api/v1/harnesses/${h.id}/capabilities`,
    ]) {
      const res = await home.call("GET", path);
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
    }
    expect(tree(h.dir)).toEqual(before);
  });

  test("an answer passes the dispatch-site masker", async () => {
    // Secret-shaped, built from parts so no real-shaped literal is committed.
    const secret = ["xox", "b-", "1234567890", "-", "abcdefghijklmnopqrstuvwx"].join("");
    const wi = await add(`Rotate ${secret} today`);
    const read = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(secret);
  });

  test("a work line's frame names ids and states, never the item's text", async () => {
    const title = `Frame ${crypto.randomUUID()}`;
    const wi = await add(title);
    const opened = readPage(workLedger(h.dir), { limit: 500 }).items.find(
      (item) => item.record["id"] === wi && item.record["event"] === "opened",
    );
    expect(opened).toBeDefined();
    const frame = workLineEvent(opened?.record ?? {}, h.id);
    expect(frame).toMatchObject({ type: "work.opened", work: wi, payload: { state: "open" } });
    expect(JSON.stringify(frame)).not.toContain(title);
    expect(streamSourcesOf(HOME_AREAS).map((s) => s.name)).toContain("work");
  });

  test("the raw browser never serves an item's content", async () => {
    const wi = await add("Raw content");
    const path = `.crewhaus/run/control/work/items/${wi}/1.json`;
    expect(exclusionFor(path.split("/"))?.path).toBe(".crewhaus/run/control/work/items/");
    const res = await home.t.api(`/api/h/${h.id}/inspect/raw?path=${encodeURIComponent(path)}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("Raw content");
  });

  test("the composition stays sound, the work rows are served, and the read model counts by state", () => {
    expect(homeCompositionProblems(HOME_AREAS)).toEqual([]);
    expect(Object.keys(V1_NOT_SERVED).filter((id) => id.startsWith("work."))).toEqual([]);
    let state = WORK_PROJECTION.empty();
    const wi = mintId("wi");
    const line = (record: Record<string, unknown>) =>
      ({
        kind: "line",
        source: "work",
        seg: 0,
        off: 0,
        record,
        after: { seg: 0, off: 0, tail: "" },
      }) as never;
    state = WORK_PROJECTION.fold(state, line({ id: wi, state: "proposed", event: "opened" }));
    state = WORK_PROJECTION.fold(state, line({ id: wi, state: "open", event: "accepted" }));
    state = WORK_PROJECTION.fold(state, line({ id: wi, state: "proposed", event: "updated" }));
    expect(state.counts).toEqual({ proposed: 0, open: 1, closed: 0 });
    expect(state.anomalies).toBe(1);
  });
});

describe("a run for a work item", () => {
  test("runs.create names an accepted item; a proposed one is 409, and nothing is written", async () => {
    const r = await home.harness("work-runs", { specExtra: TOOLS });
    const bin = join(r.dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "crewhaus"), 0o755);
    const added = await home.call("POST", `/api/v1/harnesses/${r.id}/work`, {
      body: { title: "Run me", kind: "fix" },
    });
    const wi = String(itemOf(added.body)["id"]);
    const p = await propose(r.dir, "Not yet");
    const refused = await home.call("POST", `/api/v1/harnesses/${r.id}/runs`, {
      body: { input: "Go.", work: `${r.id}/work/${p}` },
    });
    expect(refused.status).toBe(409);
    expect(errorOf(refused.body)).toMatchObject({ reason: "not_accepted" });
    const foreign = await home.call("POST", `/api/v1/harnesses/${r.id}/runs`, {
      body: { input: "Go.", work: `${h.id}/work/${wi}` },
    });
    expect(foreign.status).toBe(400);
    expect(readPage(runsLedger(r.dir), { limit: 10 }).items).toEqual([]);
    const started = await home.call("POST", `/api/v1/harnesses/${r.id}/runs`, {
      body: { input: "Go.", work: `${r.id}/work/${wi}` },
    });
    expect(started.status).toBe(202);
    const run = started.body["run"] as Record<string, unknown>;
    const rows = readPage(runsLedger(r.dir), { limit: 10 }).items.map((i) => i.record);
    expect(rows.at(-1)).toMatchObject({ id: run["id"], state: "queued", workItem: wi });
    expect(openWorkStore(r.dir).get(wi)).toMatchObject({ item: { runs: [run["id"]] } });
  });

  test("the work.items capability says whether the spec lists a Work tool", async () => {
    const plain = await home.harness("work-none");
    const caps = async (id: string) => {
      const res = await home.call("GET", `/api/v1/harnesses/${id}/capabilities`);
      return JSON.stringify(res.body);
    };
    expect(await caps(h.id)).toContain('"work.items":{"supported":true');
    expect(await caps(plain.id)).toContain('"work.items":{"supported":false');
  });
});
