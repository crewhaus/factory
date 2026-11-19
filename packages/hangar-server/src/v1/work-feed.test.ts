/**
 * The Work feed through Home's versioned API: the continuity goals (with progress) and the
 * active plan; the harness's Thredz tasks with exactly one upstream call, nothing shown when
 * Thredz fails, and the verb that connects it when the spec declares none; runs that serve
 * no item grouped by what started them, with evaluation and rehearsal runs left out. Every
 * read leaves the harness byte-identical.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import { type FakeThredz, fakeThredz } from "service-fakes";
import { type V1Home, v1Home } from "../__test__/v1-home";

const TOOLS = "tools: [read, workList, workGet, workPropose, workUpdate]";
const KEY = ["thredz", "feed", "fixture"].join("-");

let home: V1Home;
const fakes: FakeThredz[] = [];

beforeAll(async () => {
  home = await v1Home();
}, 60_000);

afterAll(async () => {
  for (const fake of fakes) await fake.stop();
  await home?.t.stop();
});

type Section = {
  readonly items?: ReadonlyArray<Record<string, unknown>>;
  readonly empty?: {
    readonly reason: string;
    readonly remedy: string;
    readonly verb: string | null;
  };
};

async function feedOf(id: string): Promise<Record<string, Section>> {
  const res = await home.call("GET", `/api/v1/harnesses/${id}/work/feed`);
  expect(res.status).toBe(200);
  expect(res.body["freshness"]).toBe("direct-fold");
  return res.body["sections"] as Record<string, Section>;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function thredzHarness(name: string, fake: FakeThredz) {
  return home.harness(name, {
    specExtra: [TOOLS, "thredz:", "  api_key: $THREDZ_API_KEY", `  base_url: ${fake.baseUrl}`].join(
      "\n",
    ),
    envLines: [`THREDZ_API_KEY=${KEY}`],
  });
}

describe("the Work feed", () => {
  test("continuity goals with progress and the active plan, and the harness byte-identical after", async () => {
    const h = await home.harness("feed-goals", { specExtra: TOOLS });
    const continuity = createContinuityStore({
      specName: "feed-goals",
      rootDir: join(h.dir, ".crewhaus", "state"),
    });
    await continuity.writeGoal({ title: "Reduce open bugs", target: 10, current: 4 });
    const plan = await continuity.createPlan({
      title: "Clear the backlog",
      steps: ["Triage", "Fix"],
    });
    await continuity.setActivePlan(plan.id);
    const before = tree(h.dir);
    const sections = await feedOf(h.id);
    const goals = sections["goals"]?.items ?? [];
    expect(goals[0]).toMatchObject({
      kind: "goal",
      label: "Reduce open bugs",
      progress: { current: 4, target: 10 },
    });
    expect(goals[1]).toMatchObject({ kind: "plan", label: "Clear the backlog" });
    expect(tree(h.dir)).toEqual(before);
    // No work at all says what fills it.
    expect(sections["upNext"]?.empty).toMatchObject({
      reason: "no-data",
      verb: "crewhaus work add --title <title>",
    });
  });

  test("no thredz: block says how to connect it", async () => {
    const h = await home.harness("feed-local", { specExtra: TOOLS });
    const sections = await feedOf(h.id);
    expect(sections["fromThredz"]?.empty).toMatchObject({
      reason: "unsupported",
      verb: "crewhaus services setup",
    });
  });

  test("Thredz failing shows nothing, after exactly one upstream call", async () => {
    const fake = fakeThredz({
      routes: { "GET /tasks": { status: 503, body: { message: "down for maintenance" } } },
    });
    fakes.push(fake);
    const h = await thredzHarness("feed-thredz-down", fake);
    const before = fake.calls().length;
    const sections = await feedOf(h.id);
    expect(sections["fromThredz"]?.empty?.reason).toBe("unreachable");
    expect(sections["fromThredz"]?.items).toBeUndefined();
    const calls = fake.calls().slice(before);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /tasks"]);
    expect(calls[0]?.authorization).toBe("present");
  });

  test("Thredz tasks are listed, and one is tracked as work once, at origin mcp", async () => {
    const fake = fakeThredz({
      routes: {
        "GET /tasks": {
          status: 200,
          body: {
            tasks: [
              {
                id: "task-1",
                title: "Triage the March reports",
                status: "open",
                description: "All of them.",
              },
            ],
          },
        },
      },
    });
    fakes.push(fake);
    const h = await thredzHarness("feed-thredz-up", fake);
    const sections = await feedOf(h.id);
    expect(sections["fromThredz"]?.items?.[0]).toMatchObject({
      kind: "task",
      id: "task-1",
      label: "Triage the March reports",
    });
    const adopt = () =>
      home.call("POST", `/api/v1/harnesses/${h.id}/work/adopt`, {
        body: { source: "thredz-task:task-1" },
      });
    const first = await adopt();
    expect(first.status).toBe(200);
    const item = first.body["item"] as Record<string, unknown>;
    expect(item).toMatchObject({ state: "open", sourceKind: "thredz-task" });
    const workDir = join(h.dir, ".crewhaus", "run", "control", "work");
    const before = tree(workDir);
    const second = await adopt();
    expect((second.body["item"] as Record<string, unknown>)["id"]).toBe(item["id"]);
    expect(tree(workDir)).toEqual(before);
    const got = await home.call("GET", `/api/v1/work/${h.id}/work/${String(item["id"])}`);
    expect(got.body["content"]).toMatchObject({ goal: "All of them." });
  });

  test("runs that serve no item are grouped by what started them; evaluation and rehearsal runs are left out", async () => {
    const h = await home.harness("feed-runs", { specExtra: TOOLS });
    const at = new Date().toISOString();
    const plant = (trigger: Record<string, unknown>) => {
      const id = mintRunId();
      const written = append(runsLedger(h.dir), { id, state: "running", at, trigger });
      if (!written.ok) throw new Error(written.reason);
      return id;
    };
    const chat = plant({ kind: "channel", channel: "slack" });
    plant({ kind: "eval" });
    plant({ kind: "rehearsal" });
    const sections = await feedOf(h.id);
    const working = sections["workingNow"]?.items ?? [];
    expect(working).toEqual([
      expect.objectContaining({ kind: "runs", trigger: "channel", runs: [chat], count: 1 }),
    ]);
  });
});
