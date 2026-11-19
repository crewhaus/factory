import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { mintId, mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import { type ThredzTasksAnswer, workFeed } from "./feed";
import type { WorkActor } from "./records";
import { openWorkStore } from "./store";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-work-feed-"));
  dirs.push(dir);
  return dir;
}

const PERSON: WorkActor = { by: mintId("prn"), via: "home", role: "person" };
const HARNESS: WorkActor = { by: "sys:runtime", via: "tool", role: "harness" };
const NOW = () => Date.parse("2026-11-18T12:00:00.000Z");
const OBSERVED = {
  problem: "Imports fail.",
  evidence: [{ label: "observed", kind: "observed-usage", ref: "run:1", note: "Seen." }],
  counterEvidence: [],
};

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function running(dir: string, trigger: string, more: Record<string, unknown> = {}): string {
  const id = mintRunId();
  append(runsLedger(dir), {
    id,
    state: "running",
    at: new Date(NOW()).toISOString(),
    trigger: { kind: trigger },
    ...more,
  });
  return id;
}

describe("the Work feed", () => {
  test("an empty harness says why each section is empty and what fills it", async () => {
    const dir = harness();
    const feed = await workFeed(dir, { now: NOW, tools: false, content: true });
    expect(feed.freshness).toBe("direct-fold");
    expect(feed.sections.upNext?.empty).toEqual({
      reason: "no-data",
      remedy: "Nothing to do yet. Add work, or let the harness propose some.",
      verb: "crewhaus work add --title <title>",
    });
    expect(feed.sections.proposed?.empty?.reason).toBe("unsupported");
    expect(feed.sections.fromThredz?.empty).toEqual({
      reason: "unsupported",
      remedy: "Connect Thredz to see its tasks here.",
      verb: "crewhaus services setup",
    });
    expect(feed.sections.scheduled?.empty?.remedy).toBe("No scheduled work.");
    expect(existsSync(join(dir, ".crewhaus"))).toBe(false);
  });

  test("items land in their sections, proposals grouped by basis, runs without items by trigger", async () => {
    const dir = harness();
    const store = openWorkStore(dir, { now: NOW });
    const open = await store.create({ title: "Update the date parser", kind: "fix" }, PERSON);
    const pain = await store.propose(
      { title: "CSV export", kind: "fix", basis: "user-pain", assessment: OBSERVED },
      HARNESS,
    );
    const idea = await store.propose(
      { title: "Dark mode", kind: "other", basis: "speculative" },
      HARNESS,
    );
    if (!open.ok || !pain.ok || !idea.ok) throw new Error("seed failed");
    const linkedRun = running(dir, "api", { workItem: open.item.id });
    await store.link(open.item.id, linkedRun, PERSON);
    const chat = running(dir, "channel");
    running(dir, "eval");
    running(dir, "rehearsal");
    const feed = await workFeed(dir, { now: NOW, tools: true, content: true });
    expect(feed.sections.needsYou?.items?.map((e) => e.id).sort()).toEqual(
      [pain.item.id, idea.item.id].sort(),
    );
    const working = feed.sections.workingNow?.items ?? [];
    expect(working.find((e) => e.kind === "item")?.id).toBe(open.item.id);
    const groups = working.filter((e) => e.kind === "runs");
    expect(groups).toEqual([
      {
        kind: "runs",
        id: "trigger:channel",
        label: "Conversations",
        trigger: "channel",
        count: 1,
        runs: [chat],
        statusWord: "Working",
      },
    ]);
    expect(feed.sections.proposed?.groups).toEqual([
      { basis: "user-pain", items: [pain.item.id] },
      { basis: "speculative", items: [idea.item.id] },
    ]);
  });

  test("goals with progress and the active plan, read without writing a byte", async () => {
    const dir = harness();
    const continuity = createContinuityStore({
      specName: "support",
      rootDir: join(dir, ".crewhaus", "state"),
    });
    await continuity.writeGoal({ title: "Reduce open bugs", target: 10, current: 4 });
    const plan = await continuity.createPlan({
      title: "Clear the backlog",
      steps: ["Triage", "Fix"],
    });
    await continuity.setActivePlan(plan.id);
    const before = tree(dir);
    const feed = await workFeed(dir, { now: NOW, tools: true, content: true, specName: "support" });
    expect(tree(dir)).toEqual(before);
    const goals = feed.sections.goals?.items ?? [];
    expect(goals[0]).toMatchObject({
      kind: "goal",
      label: "Reduce open bugs",
      progress: { current: 4, target: 10 },
    });
    expect(goals[1]).toMatchObject({ kind: "plan", label: "Clear the backlog" });
    expect(goals[1]?.steps?.map((s) => s.title)).toEqual(["Triage", "Fix"]);
    const hidden = await workFeed(dir, {
      now: NOW,
      tools: true,
      content: false,
      specName: "support",
    });
    expect(hidden.sections.goals?.empty?.reason).toBe("no-access");
    expect(hidden.hidden).toEqual(["content"]);
  });

  test("Thredz: one call, and an unreachable workspace shows nothing rather than old data", async () => {
    const dir = harness();
    let calls = 0;
    const answer = (value: ThredzTasksAnswer) => async () => {
      calls += 1;
      return value;
    };
    const down = await workFeed(dir, {
      now: NOW,
      tools: true,
      content: true,
      thredz: answer({ state: "unreachable", remedy: "Couldn't reach Thredz." }),
    });
    expect(calls).toBe(1);
    expect(down.sections.fromThredz).toEqual({
      empty: { reason: "unreachable", remedy: "Couldn't reach Thredz.", verb: null },
    });
    const up = await workFeed(dir, {
      now: NOW,
      tools: true,
      content: true,
      thredz: answer({
        state: "ok",
        tasks: [{ id: "t1", title: "Triage the March reports", status: "open" }],
      }),
    });
    expect(calls).toBe(2);
    expect(up.sections.fromThredz?.items?.[0]).toMatchObject({
      kind: "task",
      id: "t1",
      label: "Triage the March reports",
    });
  });
});
