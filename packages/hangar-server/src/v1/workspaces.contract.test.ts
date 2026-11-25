/**
 * A steward's workspaces through Home's versioned API: the list and one item's workspace, who
 * sees the checks' logs and the judge's reasons, that every read leaves the harness as it was
 * and asks the code host nothing, the publish command and its receipt, the stream's frames,
 * the raw browser, and the two sweeps on Home's tick.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { IDEMPOTENCY_HEADER } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import {
  openWorkStore,
  publishLedger,
  readAttempts,
  readOutcomes,
  readWorkspaces,
} from "@crewhaus/tool-work/work-items";
import { readLedgerLines } from "../../../tool-work/src/work-items/delivery";
// The package's own test set-up: a fake code host with a real git server half.
import { writeBindings } from "../../../tool-work/src/workspace/bindings";
import {
  type Bench,
  HARNESS,
  TOKEN_VARIABLE,
  bench,
  hostRunner,
  judgeThat,
} from "../../../tool-work/src/workspace/test-helpers";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { exclusionFor } from "../inspect";
import { HOME_AREAS, V1_NOT_SERVED, homeCompositionProblems, sweepsOf } from "./areas";
import {
  outcomeLineEvent,
  publishLineEvent,
  workspaceLineEvent,
  workspaceSweeps,
} from "./workspaces";

const TOOLS = "tools: [read, workList, workGet, workspaceOpen, workspaceCheck, workspacePublish]";
const SLOW = 60_000; // real git children and a loopback host

let home: V1Home;
let h: { id: string; dir: string };
let b: Bench;

beforeAll(async () => {
  home = await v1Home();
  h = await home.harness("steward-a", { specExtra: TOOLS });
  b = await bench(h.dir);
  b.bindings = {
    ...b.bindings,
    repositories: [
      b.binding({
        checks: [["test", "-f", "README.md"]],
        pullRequests: { require: ["checks", "acceptance"] } as never,
      }),
    ],
  };
  writeBindings(h.dir, b.bindings);
  writeFileSync(join(h.dir, ".env"), `${TOKEN_VARIABLE}=${b.token}\n`, { mode: 0o600 });
}, SLOW);

afterAll(async () => {
  await b?.stop();
  await home?.t.stop();
});

/** What an answer's own schema says is wrong with it. */
function problemsOf(schema: string, body: unknown): readonly string[] {
  const read = SCHEMAS[schema]?.safeParse(body);
  if (read === undefined) return [`no schema is called ${schema}`];
  return read.success ? [] : read.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

const errorOf = (body: Record<string, unknown>) => body["error"] as Record<string, unknown>;

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stats = statSync(path, { throwIfNoEntry: false });
      if (stats === undefined) continue;
      if (stats.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const REASON = "Because the dates parse now.";

/** An item with a workspace and a change a run judged; its pull request's answer was lost. */
async function judged(title: string) {
  const engine = b.engine({ checkRunner: hostRunner() });
  const wi = await b.item({ title });
  const opened = await engine.open(wi, { actor: HARNESS });
  if (!opened.ok) throw new Error(opened.message);
  b.write(opened.worktree, "src/dates.ts", `export const parse = "${wi}";\n`);
  b.fake.interruptNextCreate("error");
  const answer = await b.publish(engine, wi, { judge: judgeThat("meets", false, REASON).judge });
  expect(answer).toMatchObject({ state: "unknown" });
  return { wi, opened, engine };
}

describe("reading workspaces", () => {
  test(
    "the list and one workspace answer their schemas, and say what is there",
    async () => {
      const { wi, opened } = await judged("Read the workspace");
      const list = await home.call("GET", `/api/v1/harnesses/${h.id}/workspaces`);
      expect(list.status).toBe(200);
      expect(problemsOf("workspaceList", list.body)).toEqual([]);
      const row = (list.body["items"] as Array<Record<string, unknown>>).find(
        (i) => i["work"] === wi,
      );
      expect(row).toMatchObject({
        binding: "app",
        branch: opened.branch,
        state: "open",
        baseSha: opened.baseSha,
        publish: "unknown",
      });
      const one = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}/workspace`);
      expect(one.status).toBe(200);
      expect(problemsOf("workspaceAnswer", one.body)).toEqual([]);
      const ws = one.body["workspace"] as Record<string, unknown>;
      expect(ws["checks"]).toEqual([{ name: "test -f README.md", exit: 0, passed: true }]);
      expect(ws["attempts"]).toMatchObject([
        { attempt: 1, state: "unknown", verdict: { checks: "pass", acceptance: "pass" } },
      ]);
      expect(ws["reasons"]).toContain(REASON);
      expect(ws["logs"]).toMatchObject([{ name: "test -f README.md" }]);
    },
    SLOW,
  );

  test(
    "a caller without content access gets the words, never the logs or the judge's reasons",
    async () => {
      const { wi } = await judged("Words only");
      const svc = await home.service("status-board", [h.id]);
      const one = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}/workspace`, {
        secret: svc.secret,
      });
      expect(one.status).toBe(200);
      const ws = one.body["workspace"] as Record<string, unknown>;
      expect(ws["hidden"]).toEqual(["content"]);
      expect(ws["checks"]).toMatchObject([{ passed: true }]);
      expect(ws["reasons"]).toBeUndefined();
      expect(ws["logs"]).toBeUndefined();
      expect(JSON.stringify(one.body)).not.toContain(REASON);
    },
    SLOW,
  );

  test(
    "an item with none, and a harness that declares no repositories, say so",
    async () => {
      const wi = await b.item({ title: "No workspace" });
      const none = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}/workspace`);
      expect(none.status).toBe(404);
      expect(errorOf(none.body)["reason"]).toBe("no_workspace");
      const other = await home.harness("plain-a", { specExtra: "tools: [read]" });
      const empty = await home.call("GET", `/api/v1/harnesses/${other.id}/workspaces`);
      expect(empty.body).toMatchObject({ items: [], empty: { reason: "unsupported" } });
      const caps = await home.call("GET", `/api/v1/harnesses/${h.id}/capabilities`);
      expect(JSON.stringify(caps.body)).toContain("work.workspaces");
    },
    SLOW,
  );

  test("a harness whose folder is gone answers an empty list that says so", async () => {
    const away = await home.harness("moved-away", { specExtra: TOOLS });
    rmSync(away.dir, { recursive: true, force: true });
    const answer = await home.call("GET", `/api/v1/harnesses/${away.id}/workspaces`);
    expect(answer.status).toBe(200);
    expect(problemsOf("workspaceList", answer.body)).toEqual([]);
    expect(answer.body).toMatchObject({ items: [], empty: { reason: "unreachable" } });
  });

  test(
    "every read leaves the harness byte-identical and asks the code host nothing",
    async () => {
      const { wi } = await judged("Read only");
      const before = tree(h.dir);
      const asked = b.fake.requests().length;
      for (const path of [
        `/api/v1/harnesses/${h.id}/workspaces`,
        `/api/v1/work/${h.id}/work/${wi}/workspace`,
        `/api/v1/work/${wi}/workspace?harness=${h.id}`,
        `/api/v1/work/${h.id}/work/${wi}`,
        `/api/v1/harnesses/${h.id}/capabilities`,
      ]) {
        const res = await home.call("GET", path);
        expect(`${path} ${res.status}`).toBe(`${path} 200`);
      }
      expect(tree(h.dir)).toEqual(before);
      expect(b.fake.requests().length).toBe(asked);
    },
    SLOW,
  );

  test(
    "a delivered item reads as in review on every surface",
    async () => {
      const { wi, engine } = await judged("Deliver it");
      await engine.settle(wi, { actor: HARNESS });
      const got = await home.call("GET", `/api/v1/work/${h.id}/work/${wi}`);
      expect(got.body["item"]).toMatchObject({ status: "in-review", statusWord: "In review" });
      expect(got.body["content"]).toMatchObject({ delivered: [{ kind: "pr" }] });
    },
    SLOW,
  );

  test(
    "the raw browser serves neither the check logs nor the clones",
    async () => {
      const { wi } = await judged("Raw");
      for (const path of [
        `.crewhaus/run/control/work/checks/${wi}/1-acceptance.log`,
        ".crewhaus/workspaces/app/repo/config",
      ]) {
        expect(exclusionFor(path.split("/"))).toBeDefined();
        const res = await home.t.api(`/api/h/${h.id}/inspect/raw?path=${encodeURIComponent(path)}`);
        expect(res.status).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain(REASON);
      }
    },
    SLOW,
  );
});

describe("publishing", () => {
  test(
    "a judged change goes out once; the receipt and the attempt are answered, and a replay is the same",
    async () => {
      const { wi } = await judged("Publish from Home");
      const posts = () =>
        b.fake.writes().filter((w) => w.method === "POST" && w.path.endsWith("/pulls")).length;
      const before = posts();
      const key = { [IDEMPOTENCY_HEADER]: `publish-${wi}` };
      const done = await home.call("POST", `/api/v1/work/${h.id}/work/${wi}/publish`, {
        body: {},
        headers: key,
      });
      expect(done.status).toBe(200);
      expect(done.body["receipt"]).toMatchObject({ kind: "work.publish", state: "succeeded" });
      expect(done.body["attempt"]).toMatchObject({ state: "done" });
      expect(posts()).toBe(before);
      const again = await home.call("POST", `/api/v1/work/${h.id}/work/${wi}/publish`, {
        body: {},
        headers: key,
      });
      expect((again.body["receipt"] as { id: string }).id).toBe(
        (done.body["receipt"] as { id: string }).id,
      );
      expect(readAttempts(h.dir).get(wi)?.length).toBe(2);
    },
    SLOW,
  );

  test(
    "needs h.run.submit, and is refused before a receipt when there is nothing to publish",
    async () => {
      const { wi } = await judged("Who may");
      const viewer = await home.member("Vi", "viewer", { scope: `harness:${h.id}` });
      const refused = await home.call("POST", `/api/v1/work/${h.id}/work/${wi}/publish`, {
        secret: viewer.secret,
        body: {},
      });
      expect(refused.status).toBe(403);
      expect(errorOf(refused.body)["needs"]).toBe("h.run.submit");
      const bare = await b.item({ title: "Nothing yet" });
      const none = await home.call("POST", `/api/v1/work/${h.id}/work/${bare}/publish`, {
        body: {},
        headers: { [IDEMPOTENCY_HEADER]: `publish-${bare}` },
      });
      expect(none.status).toBe(409);
      expect(errorOf(none.body)["reason"]).toBe("no_workspace");
      expect(readAttempts(h.dir).get(bare)).toBeUndefined();
    },
    SLOW,
  );
});

describe("the stream and the sweeps", () => {
  test(
    "a line's frame names ids, states and SHAs only",
    async () => {
      const { wi, opened } = await judged("Frames");
      const line = readLedgerLines(publishLedger(h.dir))
        .lines.filter((l) => l["wi"] === wi)
        .at(-1) as Record<string, unknown>;
      expect(publishLineEvent(line, h.id)).toMatchObject({
        type: "work.publish.unknown",
        work: wi,
        payload: { attempt: 1 },
      });
      expect(publishLineEvent({ ...line, state: "not-done" }, h.id)).toBeUndefined();
      expect(
        workspaceLineEvent(
          { id: wi, event: "opened", binding: "app", branch: opened.branch, at: line["at"] },
          h.id,
        ),
      ).toMatchObject({ type: "workspace.opened", payload: { binding: "app" } });
      expect(workspaceLineEvent({ id: wi, event: "checked" }, h.id)).toBeUndefined();
      expect(
        outcomeLineEvent({ id: wi, pr: 3, state: "merged", at: line["at"] }, h.id),
      ).toMatchObject({ type: "work.outcome", payload: { pr: 3, state: "merged" } });
      expect(JSON.stringify(publishLineEvent(line, h.id))).not.toContain("Frames");
    },
    SLOW,
  );

  test(
    "are on Home's tick, and a pass settles, tracks and closes without a second pull request",
    async () => {
      expect(homeCompositionProblems(HOME_AREAS)).toEqual([]);
      expect(Object.keys(V1_NOT_SERVED).filter((id) => id.startsWith("work"))).toEqual([]);
      const names = sweepsOf(HOME_AREAS).map((s) => s.name);
      expect(names).toContain("work-outcomes");
      expect(names).toContain("work-cleanup");
      const { wi } = await judged("Swept");
      const warned: string[] = [];
      const ctx = {
        now: Date.now(),
        jobs: {} as never,
        home: { liveHarnesses: () => [{ id: h.id, dir: h.dir }] } as never,
        warn: (m: string) => warned.push(m),
      };
      const [outcomes, cleanup] = workspaceSweeps();
      await outcomes.run(ctx);
      const pr = readAttempts(h.dir).get(wi)?.at(-1)?.pr;
      expect(pr).toBeDefined();
      b.fake.mergePull("acme/app", pr as number);
      await outcomes.run({ ...ctx, now: ctx.now + 1000 });
      expect(readOutcomes(h.dir).get(wi)).toMatchObject({ state: "merged" });
      const item = openWorkStore(h.dir).get(wi);
      expect("ok" in item ? undefined : item.item.outcome).toBe("done");
      await cleanup.run({ ...ctx, now: ctx.now + 2000 });
      expect(readWorkspaces(h.dir).get(wi)?.state).toBe("closed");
      expect(warned).toEqual([]);
      // A harness that cannot be read is warned about by its id, and stops no other.
      const broken = await home.harness("steward-broken", { specExtra: TOOLS });
      writeBindings(broken.dir, b.bindings);
      writeFileSync(join(broken.dir, ".crewhaus/run/control/work/bindings.json"), "not json");
      const { wi: next } = await judged("After a broken one");
      await outcomes.run({
        ...ctx,
        home: {
          liveHarnesses: () => [
            { id: broken.id, dir: broken.dir },
            { id: h.id, dir: h.dir },
          ],
        } as never,
      });
      expect(warned.length).toBe(1);
      expect(warned[0]).toContain(broken.id);
      expect(readAttempts(h.dir).get(next)?.at(-1)?.state).toBe("done");
    },
    SLOW,
  );
});
