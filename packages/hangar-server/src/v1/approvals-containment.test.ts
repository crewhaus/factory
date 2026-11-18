/**
 * A harness's decision log is read from that harness's own records only. With one
 * harness's `.crewhaus/sessions` a link to another's, its event stream, the overview model
 * Home's projector folds for it and the fleet log the projector writes for it carry none
 * of the other harness's decisions.
 *
 * A harness reads and decides only the approvals inside its own folder: with its sessions
 * folder outside it once every link is followed, it lists none of them, answers 404 for
 * one, decides none, and leaves that folder byte for byte as it was. Its approvals are
 * reported as unknown, never as a count: its detail, its fleet rows and the approvals
 * inbox say so, and every decision list names it whether or not anything else is listed.
 * A sessions folder linked to another place inside the harness lists and resolves as usual.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { append, fleetChangesLedger, readPage, runsLedger } from "@crewhaus/control-records";
import { OVERVIEW_PROJECTION, projectOnce, readModel } from "@crewhaus/control-service";
import { approvalsLedger } from "@crewhaus/session-store";
import { bearer } from "../__test__/browser";
import { type V1Home, v1Home } from "../__test__/v1-home";

const AT = "2026-11-14T00:00:00.000Z";
const B_FIRST = "appr_00000000000000b1";
const B_SECOND = "appr_00000000000000b2";
/** B's pending tool approval, in its `approvals.jsonl`. */
const B_PENDING = "appr_00000000000000b9";
/** C's pending tool approval, in a sessions folder linked inside C. */
const C_PENDING = "appr_00000000000000c9";
/** An id no harness holds. */
const NOBODY = "appr_000000000000dead";

let home: V1Home;
let a: { id: string; dir: string };
let b: { id: string; dir: string };
let c: { id: string; dir: string };

function approval(id: string) {
  return {
    id,
    toolName: "SendMessage",
    inputHash: `hash-${id}`,
    input: { channel: "ops", text: `content of ${id}` },
    runId: "run_00000000000000b0",
    sessionId: "sess_00000000000000bb",
    surface: "daemon",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

function receiptLines(dir: string, kind: string): Record<string, unknown>[] {
  const at = join(dir, ".crewhaus", "run", "control", "commands");
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readFileSync(join(at, name), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row["kind"] === kind);
}

/** Every path under `root`, recursively, with its bytes, its link target, or `dir`. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const key = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
      else if (st.isDirectory()) {
        out[key] = "dir";
        walk(path, key);
      } else out[key] = `file:${readFileSync(path).toString("base64")}`;
    }
  };
  walk(root, "");
  return out;
}

function rowsOf(body: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  return body[key] as Array<Record<string, unknown>>;
}

/** The refs a decision list names, `<harness>/decision/<id>`. */
function refsOf(body: Record<string, unknown>): string[] {
  return rowsOf(body, "items").map((item) => `${item["harness"]}/decision/${item["id"]}`);
}

function park(dir: string, decision: string): void {
  const sessions = join(dir, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  const written = append(approvalsLedger(sessions), {
    v: 1,
    at: AT,
    event: "park",
    decision,
    sessionId: "sess_00000000000000bb",
  });
  if (!written.ok) throw new Error(written.reason);
}

beforeAll(async () => {
  home = await v1Home({ streamTimings: { pollMs: 10, heartbeatMs: 60_000 } });
  a = await home.harness("linked-a");
  b = await home.harness("parked-b", { approvals: [approval(B_PENDING)] });
  park(b.dir, B_FIRST);
  rmSync(join(a.dir, ".crewhaus", "sessions"), { recursive: true, force: true });
  symlinkSync(join(b.dir, ".crewhaus", "sessions"), join(a.dir, ".crewhaus", "sessions"));
  c = await home.harness("inside-c", { approvals: [approval(C_PENDING)] });
  mkdirSync(join(c.dir, "state"));
  renameSync(join(c.dir, ".crewhaus", "sessions"), join(c.dir, "state", "sessions"));
  symlinkSync(join(c.dir, "state", "sessions"), join(c.dir, ".crewhaus", "sessions"));
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

describe.skipIf(process.platform === "win32")("a linked sessions folder", () => {
  test("the harness's stream sends its own lines and none of the other harness's decisions", async () => {
    const controller = new AbortController();
    const res = await fetch(`${home.t.base}/api/v1/harnesses/${a.id}/events`, {
      headers: bearer(home.session),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      // Give the stream a first batch from now, then write: the other harness's decision
      // first, then a run of this harness's own, so any batch that holds the run holds both.
      const opened = await reader.read();
      text += decoder.decode(opened.value, { stream: true });
      park(b.dir, B_SECOND);
      const run = mintRunId();
      const written = append(runsLedger(a.dir), {
        id: run,
        state: "queued",
        at: AT,
        trigger: { kind: "api" },
      });
      if (!written.ok) throw new Error(written.reason);
      while (!text.includes(run)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      expect(text).toContain("event: run.queued");
      expect(text).not.toContain(B_FIRST);
      expect(text).not.toContain(B_SECOND);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 20_000); // a stream over a booted Home; slow on a loaded runner

  test("its projected overview holds no decision of the other harness, and the fleet log names none for it", async () => {
    const harnesses = [{ id: a.id, dir: a.dir }];
    const B_THIRD = "appr_00000000000000b3";
    await projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, now: Date.now() });
    park(b.dir, B_THIRD);
    await projectOnce({ hangarRoot: home.t.hangarRoot, harnesses, now: Date.now() });
    // The other harness's own model holds the decision, so the fixture parks where the
    // projector reads.
    const own = readModel(home.t.hangarRoot, b.id, b.dir, OVERVIEW_PROJECTION, Date.now());
    expect(Object.keys(own.state.open)).toContain(B_THIRD);
    const model = readModel(home.t.hangarRoot, a.id, a.dir, OVERVIEW_PROJECTION, Date.now());
    expect(Object.keys(model.state.open).filter((id) => id.startsWith("appr_"))).toEqual([]);
    const lines = readPage(fleetChangesLedger(home.t.hangarRoot), { limit: 1000 }).items.map(
      (item) => item.record,
    );
    const forA = lines.filter((line) => line["harness"] === a.id);
    expect(JSON.stringify(forA)).not.toContain("appr_00000000000000b");
  });
});

describe.skipIf(process.platform === "win32")(
  "a harness whose sessions folder lies outside it",
  () => {
    let viewer: { secret: string };
    let decider: { secret: string };

    beforeAll(async () => {
      viewer = await home.member("Vi", "viewer", { scope: `harness:${a.id}` });
      decider = await home.member("Dee", "operator", { scope: `harness:${a.id}` });
    }, 60_000);

    test("reports its approvals as unknown, with no count, in its detail and its fleet row", async () => {
      const own = await home.call("GET", `/api/v1/harnesses/${b.id}`);
      expect(own.status).toBe(200);
      expect(own.body["openDecisions"] as number).toBeGreaterThanOrEqual(1);
      expect(own.body["approvalsUnreachable"]).toBeUndefined();
      const got = await home.call("GET", `/api/v1/harnesses/${a.id}`, { secret: viewer.secret });
      expect(got.status).toBe(200);
      expect(got.body["approvalsUnreachable"]).toBe(true);
      expect("openDecisions" in got.body).toBe(false);
      const list = await home.call("GET", "/api/v1/harnesses");
      const row = rowsOf(list.body, "items").find((r) => r["id"] === a.id);
      expect(row?.["approvalsUnreachable"]).toBe(true);
      expect(row !== undefined && "openDecisions" in row).toBe(false);
      const ownRow = rowsOf(list.body, "items").find((r) => r["id"] === b.id);
      expect(ownRow?.["openDecisions"] as number).toBeGreaterThanOrEqual(1);
    });

    test("lists none of the folder's decisions and names the harness, listed beside others or alone", async () => {
      const own = await home.call("GET", "/api/v1/decisions");
      expect(refsOf(own.body)).toContain(`${b.id}/decision/${B_PENDING}`);
      expect(own.body["unreachable"]).toEqual([a.id]);
      expect(own.body["empty"]).toBeUndefined();
      const got = await home.call("GET", "/api/v1/decisions", { secret: viewer.secret });
      expect(got.status).toBe(200);
      expect(JSON.stringify(got.body["items"])).not.toContain(B_PENDING);
      expect(rowsOf(got.body, "items")).toEqual([]);
      expect(got.body["unreachable"]).toEqual([a.id]);
      expect((got.body["empty"] as Record<string, unknown>)["reason"]).toBe("unreachable");
    });

    test("the approvals inbox names it, so the inbox never reads as complete", async () => {
      const inbox = await home.call("GET", "/api/approvals");
      expect(inbox.status).toBe(200);
      const named = inbox.body["unreachableHarnesses"] as Array<{ id: string }>;
      expect(named.map((h) => h.id)).toEqual([a.id]);
      expect(JSON.stringify(inbox.body["approvals"])).toContain(B_PENDING);
    });

    test("a decision or ref in that folder answers 404, as an unknown id does", async () => {
      for (const path of ["/api/v1/decisions", "/api/v1/refs"]) {
        const got = await home.call("GET", `${path}/${a.id}/decision/${B_PENDING}`, {
          secret: viewer.secret,
        });
        const unknown = await home.call("GET", `${path}/${a.id}/decision/${NOBODY}`, {
          secret: viewer.secret,
        });
        expect({ path, status: got.status }).toEqual({ path, status: 404 });
        expect(JSON.stringify(got.body)).toBe(JSON.stringify(unknown.body));
      }
    });

    test("a decision in such a folder is refused and its files are unchanged", async () => {
      const sessions = join(b.dir, ".crewhaus", "sessions");
      const before = treeOf(sessions);
      expect(Object.keys(before)).toContain("approvals.jsonl");
      const target = `/api/v1/decisions/${a.id}/decision/${B_PENDING}/resolve`;
      const asDecider = await home.call("POST", target, {
        body: { choice: "grant" },
        secret: decider.secret,
      });
      expect(asDecider.status).toBe(404);
      const asOwner = await home.call("POST", target, { body: { choice: "grant" } });
      expect(asOwner.status).toBe(404);
      // Refused before a command is submitted: no receipt is written for either.
      expect(receiptLines(a.dir, "decisions.resolve")).toEqual([]);
      const legacy = await home.call("POST", `/api/h/${a.id}/approvals/${B_PENDING}/grant`, {
        body: {},
      });
      expect(legacy.status).toBe(409);
      expect(treeOf(sessions)).toEqual(before);
      // The receipted route records its refusal in the harness's own ledger; nothing succeeded.
      const named = receiptLines(a.dir, "decisions.resolve").filter((row) =>
        String(row["target"]).endsWith(B_PENDING),
      );
      expect(named.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
    });

    test("the legacy fleet row says its approvals are unknown, never 0", async () => {
      const legacy = await home.call("GET", "/api/harnesses");
      const rows = rowsOf(legacy.body, "harnesses");
      const own = rows.find((r) => r["id"] === b.id);
      expect(own?.["pendingApprovals"] as number).toBeGreaterThanOrEqual(1);
      expect(own?.["approvalsUnreachable"]).toBeUndefined();
      const linked = rows.find((r) => r["id"] === a.id);
      expect(linked?.["pendingApprovals"]).toBeNull();
      expect(linked?.["approvalsUnreachable"]).toBe(true);
    });

    test("a harness whose sessions folder is its own, or linked inside it, lists and resolves as before", async () => {
      const listed = await home.call("GET", "/api/v1/decisions");
      const refs = refsOf(listed.body);
      expect(refs).toContain(`${b.id}/decision/${B_PENDING}`);
      expect(refs).toContain(`${c.id}/decision/${C_PENDING}`);
      const own = `${b.id}/decision/${B_PENDING}`;
      expect((await home.call("GET", `/api/v1/decisions/${own}`)).status).toBe(200);
      expect((await home.call("GET", `/api/v1/refs/${own}`)).status).toBe(200);
      const decided = await home.call("POST", `/api/v1/decisions/${own}/resolve`, {
        body: { choice: "grant" },
      });
      expect(decided.status).toBe(200);
      const inside = await home.call(
        "POST",
        `/api/v1/decisions/${c.id}/decision/${C_PENDING}/resolve`,
        { body: { choice: "grant" } },
      );
      expect(inside.status).toBe(200);
      expect((inside.body["decision"] as Record<string, unknown>)["state"]).toBe("granted");
    });
  },
);
