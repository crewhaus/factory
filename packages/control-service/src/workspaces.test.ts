/**
 * Publishing a work item from Home: only what a run judged, with the harness's own binding and
 * credential; a lost answer is looked up; the tick tidies; a retire keeps uncommitted work.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandReceipt, mintId } from "@crewhaus/control-contract";
import {
  openWorkStore,
  readAttempts,
  readOutcomes,
  readWorkspaces,
} from "@crewhaus/tool-work/work-items";
import { writeBindings } from "../../tool-work/src/workspace/bindings";
// The package's own test set-up: a harness and a fake host with a real git server half.
import {
  type Bench,
  HARNESS,
  PERSON,
  REPO,
  TOKEN_VARIABLE,
  bench,
  plainGit,
} from "../../tool-work/src/workspace/test-helpers";
import { RUNTIME_RUNTIME } from "./areas/runtime";
import type { WorkHead } from "./work";
import {
  WORKSPACE_REVOKER,
  reconcilePublish,
  settleWorkspaces,
  syncHarnessOutcomes,
  workspaceCommands,
} from "./workspaces";

const SLOW = 60_000; // real git children and a loopback host

const benches: Bench[] = [];
const before = process.env[TOKEN_VARIABLE];
afterEach(async () => {
  if (before === undefined) Reflect.deleteProperty(process.env, TOKEN_VARIABLE);
  else process.env[TOKEN_VARIABLE] = before;
  for (const b of benches.splice(0)) await b.stop();
});

const CALLER = { role: "person" } as const;

function receipt(over: Partial<CommandReceipt> = {}): CommandReceipt {
  return {
    v: 1,
    id: mintId("cmd"),
    kind: "work.publish",
    state: "running",
    actor: PERSON.by,
    via: "home",
    target: "x",
    at: new Date().toISOString(),
    ...over,
  } as unknown as CommandReceipt;
}

/** A harness whose last boot wrote its bindings and whose own .env holds the token. */
async function stewarded() {
  const b = await bench();
  benches.push(b);
  writeBindings(b.dir, b.bindings);
  writeFileSync(join(b.dir, ".env"), `${TOKEN_VARIABLE}=${b.token}\n`, { mode: 0o600 });
  // Home's own environment holds another value under the same name.
  process.env[TOKEN_VARIABLE] = "homes-own-value-never-used";
  const engine = b.engine();
  const wi = await b.item();
  const opened = await engine.open(wi, { actor: HARNESS });
  if (!opened.ok) throw new Error(opened.message);
  b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
  const head: WorkHead = { harnessDir: b.dir, harness: "hrn_00000000000000aa", target: "managed" };
  const publishHome = async (r = receipt()) => {
    const plan = workspaceCommands().publish(head, CALLER, wi);
    if (!plan.ok) return { refusal: plan.refusal };
    return { ...(await plan.effect(r)), receipt: r };
  };
  const posts = () =>
    b.hostWrites().filter((w) => w.method === "POST" && w.path.endsWith("/pulls")).length;
  return { b, engine, wi, opened, head, publishHome, posts };
}

describe("work.publish from Home", () => {
  test(
    "refuses a change no run judged, with no request to open a pull request",
    async () => {
      const t = await stewarded();
      plainGit(join(t.b.dir, t.opened.worktree), ["add", "-A"]);
      plainGit(join(t.b.dir, t.opened.worktree), ["commit", "-q", "-m", "By hand"]);
      const answer = await t.publishHome();
      expect(answer).toMatchObject({ settle: { state: "failed" } });
      if ("value" in answer) {
        expect(answer.value.problem).toContain(`crewhaus work start ${t.wi}`);
        expect(answer.value.attempt).toMatchObject({ state: "failed", code: "gate_failed" });
      }
      expect(t.posts()).toBe(0);
    },
    SLOW,
  );

  test(
    "publishes the change a run judged, with the harness's own token and its words",
    async () => {
      const t = await stewarded();
      t.b.fake.interruptNextCreate("error");
      expect(await t.b.publish(t.engine, t.wi)).toMatchObject({ ok: true, state: "unknown" });
      const answer = await t.publishHome();
      expect(answer).toMatchObject({
        settle: { state: "succeeded", effects: [{ kind: "work", status: "done" }] },
        value: { attempt: { state: "done", pr: 1 } },
      });
      expect(t.posts()).toBe(1);
      if ("receipt" in answer && answer.receipt !== undefined) {
        const made = readAttempts(t.b.dir).get(t.wi)?.at(-1);
        expect(made).toMatchObject({ cmd: answer.receipt.id, by: PERSON.by, via: "home" });
        expect(await reconcilePublish(answer.receipt, t.b.dir)).toBe("done");
      }
    },
    SLOW,
  );

  test(
    "is refused before a receipt for an item that is not open, has no workspace, or no bindings",
    async () => {
      const t = await stewarded();
      const other = await t.b.item({ title: "Another" });
      const none = workspaceCommands().publish(t.head, CALLER, other);
      expect(none).toMatchObject({ ok: false, refusal: { reason: "no_workspace" } });
      expect(workspaceCommands().publish(t.head, CALLER, mintId("wi"))).toMatchObject({
        ok: false,
        refusal: { code: "not_found" },
      });
      writeFileSync(join(t.b.dir, ".crewhaus/run/control/work/bindings.json"), "not json");
      expect(workspaceCommands().publish(t.head, CALLER, t.wi)).toMatchObject({
        ok: false,
        refusal: { code: "unavailable", reason: "no_bindings" },
      });
      await openWorkStore(t.b.dir).transition(t.wi, "closed", { outcome: "done" }, PERSON);
      expect(workspaceCommands().publish(t.head, CALLER, t.wi)).toMatchObject({
        ok: false,
        refusal: { reason: "not_accepted" },
      });
    },
    SLOW,
  );

  test(
    "an answer that was lost is unknown, and its reconciler finds the one pull request",
    async () => {
      const t = await stewarded();
      // The run judged it, and the pull request it made was then closed by hand and its branch kept.
      t.b.fake.interruptNextCreate("error");
      expect(await t.b.publish(t.engine, t.wi)).toMatchObject({ state: "unknown" });
      await t.engine.settle(t.wi, { actor: HARNESS });
      t.b.fake.closePull(REPO, 1);
      t.b.fake.interruptNextCreate("error");
      const answer = await t.publishHome();
      expect(answer).toMatchObject({ settle: { state: "unknown" } });
      if (!("receipt" in answer) || answer.receipt === undefined) throw new Error("no receipt");
      const kind = RUNTIME_RUNTIME.reconcilers?.["work.publish"];
      const settled = await kind?.(answer.receipt, {
        harnessDir: t.b.dir,
        probe: { isAlive: () => true, startTimeMs: () => undefined },
        now: Date.now,
      });
      expect(settled).toBe("done");
      expect(t.posts()).toBe(2);
      expect(await reconcilePublish(receipt(), t.b.dir)).toBe("unknown");
    },
    SLOW,
  );
});

describe("between runs", () => {
  test(
    "an attempt a stopped process left is settled, and a running one is left alone",
    async () => {
      const t = await stewarded();
      t.b.fake.interruptNextCreate("error");
      await t.b.publish(t.engine, t.wi);
      expect(readAttempts(t.b.dir).get(t.wi)?.at(-1)?.state).toBe("unknown");
      expect(await settleWorkspaces(t.b.dir)).toEqual({ settled: 1, closed: 0 });
      expect(readAttempts(t.b.dir).get(t.wi)?.at(-1)).toMatchObject({ state: "done", pr: 1 });
      expect(await settleWorkspaces(t.b.dir)).toEqual({ settled: 0, closed: 0 });
    },
    SLOW,
  );

  test(
    "a closed item's worktree is closed, its uncommitted work kept on the branch",
    async () => {
      const t = await stewarded();
      await openWorkStore(t.b.dir).transition(t.wi, "closed", { outcome: "cancelled" }, PERSON);
      expect(await settleWorkspaces(t.b.dir)).toEqual({ settled: 0, closed: 1 });
      expect(existsSync(join(t.b.dir, t.opened.worktree))).toBe(false);
      expect(readWorkspaces(t.b.dir).get(t.wi)).toMatchObject({ state: "closed", wip: true });
    },
    SLOW,
  );

  test(
    "the tracker reads with the harness's own token",
    async () => {
      const t = await stewarded();
      expect(await t.b.publish(t.engine, t.wi)).toMatchObject({ ok: true, state: "done" });
      t.b.fake.mergePull(REPO, 1);
      expect(await syncHarnessOutcomes(t.b.dir)).toMatchObject({ checked: 1, wrote: 1, moved: 1 });
      expect(readOutcomes(t.b.dir).get(t.wi)).toMatchObject({ state: "merged" });
    },
    SLOW,
  );

  test(
    "a harness with no workspaces asks nothing",
    async () => {
      const b = await bench();
      benches.push(b);
      expect(await settleWorkspaces(b.dir)).toEqual({ settled: 0, closed: 0 });
      expect(await syncHarnessOutcomes(b.dir)).toEqual({ checked: 0, wrote: 0, moved: 0 });
      expect(await WORKSPACE_REVOKER.plan({ harnessDir: b.dir, actor: "x", now: 0 })).toEqual([]);
      expect(await WORKSPACE_REVOKER.revoke({ harnessDir: b.dir, actor: "x", now: 0 })).toEqual([]);
    },
    SLOW,
  );

  test(
    "a retire closes the worktrees and says how many",
    async () => {
      const t = await stewarded();
      const ctx = { harnessDir: t.b.dir, actor: PERSON.by, now: Date.now(), cmd: mintId("cmd") };
      expect(await WORKSPACE_REVOKER.plan(ctx)).toEqual([
        { kind: "workspace", status: "planned", note: `app: ${t.opened.branch}` },
      ]);
      expect(await WORKSPACE_REVOKER.revoke(ctx)).toEqual([
        { kind: "retire.workspaces", status: "done", observed: "1 of 1 closed" },
      ]);
      expect(existsSync(join(t.b.dir, t.opened.worktree))).toBe(false);
      const repo = join(t.b.dir, ".crewhaus/workspaces/app/repo");
      expect(plainGit(repo, ["--git-dir", repo, "log", "-1", "--format=%s", t.opened.branch])).toBe(
        "crewhaus: work in progress",
      );
    },
    SLOW,
  );
});
