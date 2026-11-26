/**
 * `crewhaus work`: each sub-verb against a temp harness, through a direct control service
 * as the CLI runs it. A stale `--expect` exits with the precondition code and names the
 * current revision; `decline` needs `--reason`; adopting an issue says it is not served
 * yet and a Thredz task names Home's verb; every change refuses under an agent's tool;
 * `start` starts a run whose queued row names the item.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_FOR_ERROR, mintId } from "@crewhaus/control-contract";
import { readPage, runsLedger, writeHarnessIdentity } from "@crewhaus/control-records";
import { AREA_RUNTIMES, type ControlService, wireControl } from "@crewhaus/control-service";
import type { ApiRunInput } from "@crewhaus/harness-supervisor";
import { openWorkStore } from "@crewhaus/tool-work/work-items";
// The package's own test set-up: a fake code host with a real git server half.
import { writeBindings } from "../../../packages/tool-work/src/workspace/bindings";
import {
  type Bench,
  HARNESS,
  TOKEN_VARIABLE,
  bench,
  plainGit,
} from "../../../packages/tool-work/src/workspace/test-helpers";
import { runWorkCommand } from "./work-cmd";

const HRN = "hrn_00000000000000e1";
const IDENTITY = { username: "sam", hostname: "laptop" } as const;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

function world(spec = "tools: [read, workList, workGet, workPropose, workUpdate]") {
  const hangarRoot = tmp("work-cmd-home-");
  const harness = tmp("work-cmd-harness-");
  writeFileSync(join(harness, "crewhaus.yaml"), `name: tasks\ntarget: cli\n${spec}\n`);
  const written = writeHarnessIdentity(harness, { id: HRN, slug: "tasks" });
  if (!written.ok) throw new Error(written.reason);
  const service: ControlService = wireControl(
    {
      hangarRoot,
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: IDENTITY,
      probe: { isAlive: () => true, startTimeMs: () => Date.now() - 1000 },
    },
    { mode: "direct", areas: AREA_RUNTIMES },
  );
  const env = {
    CREWHAUS_REGISTRY_ROOT: join(hangarRoot, "registry"),
    CREWHAUS_HANGAR_ROOT: hangarRoot,
    HOME: hangarRoot,
  };
  const starts: ApiRunInput[] = [];
  const run = (argv: readonly string[], extra: Record<string, string> = {}) =>
    runWorkCommand([...argv, "--harness", harness], {
      env: { ...env, ...extra },
      cwd: harness,
      control: () => service,
      home: () => ({
        startRunJob: async (_dir, apiRun) => {
          starts.push(apiRun);
          return { ok: true, runId: "run_0000000000000001", pid: 77 };
        },
      }),
    });
  return { harness, run, starts };
}

const PERSON_ACTOR = { by: mintId("prn"), via: "cli", role: "person" } as const;

const idOf = (lines: readonly string[]) => /\b(wi_[0-9a-z]{26})\b/.exec(lines[0] ?? "")?.[1] ?? "";

describe("crewhaus work", () => {
  test("add, list, show, edit, accept, decline, reopen, rank, cancel", async () => {
    const w = world();
    const goal = join(w.harness, "goal.md");
    writeFileSync(goal, "Imports keep the date column as a date.\n");
    const added = await w.run([
      "add",
      "--title",
      "Fix the date parser",
      "--goal-file",
      goal,
      "--kind",
      "fix",
    ]);
    expect(added.exitCode).toBe(0);
    const wi = idOf(added.lines);
    expect(wi).toMatch(/^wi_/);
    const store = openWorkStore(w.harness);
    const read = store.get(wi);
    expect("ok" in read ? undefined : read.revision?.goal).toContain("date column");

    const listed = await w.run(["list"]);
    expect(listed.lines.join("\n")).toContain("Up next");
    const json = JSON.parse((await w.run(["list", "--json"])).lines.join("\n")) as {
      items: Array<{ id: string }>;
    };
    expect(json.items.map((i) => i.id)).toEqual([wi]);
    const shown = await w.run(["show", wi]);
    expect(shown.lines.join("\n")).toContain("What's asked:");

    const stale = await w.run(["edit", wi, "--expect", "7", "--title", "Later"]);
    expect(stale.exitCode).toBe(EXIT_FOR_ERROR.precondition_failed);
    expect(stale.lines.join("\n")).toContain("revision 1");
    const edited = await w.run(["edit", wi, "--expect", "1", "--note", "Seen twice."]);
    expect(edited.exitCode).toBe(0);

    const proposed = await store.propose(
      { title: "Add CSV export", kind: "fix", basis: "speculative" },
      { by: "sys:runtime", via: "tool", role: "harness" },
    );
    if (!proposed.ok) throw new Error(proposed.message);
    const p = proposed.item.id;
    const noReason = await w.run(["decline", p]);
    expect(noReason.exitCode).toBe(EXIT_FOR_ERROR.invalid);
    expect(noReason.lines.join("\n")).toContain("--reason is required");
    const declined = await w.run(["decline", p, "--reason", "not-now"]);
    expect(declined.exitCode).toBe(0);
    expect(declined.lines[0]).toContain("closed");
    const twice = await w.run(["decline", p, "--reason", "not-now"]);
    expect(twice.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(twice.lines[0]).toContain("now: closed");
    expect((await w.run(["reopen", p])).exitCode).toBe(0);
    const ranked = await w.run(["rank", p, "--above", wi, "--scope", "item"]);
    expect(ranked.exitCode).toBe(0);
    const order = JSON.parse((await w.run(["list", "--json"])).lines.join("\n")) as {
      items: Array<{ id: string; position?: number }>;
    };
    expect(order.items.find((i) => i.id === p)?.position).toBe(1);
    const cancelled = await w.run(["cancel", wi]);
    expect(cancelled.exitCode).toBe(0);
    expect(store.get(wi)).toMatchObject({ item: { state: "closed", outcome: "cancelled" } });
  });

  test("start: a run whose queued row names the item", async () => {
    const w = world();
    const wi = idOf((await w.run(["add", "--title", "Answer the March question"])).lines);
    const started = await w.run(["start", wi]);
    expect(started.exitCode).toBe(0);
    expect(started.lines[0]).toContain("started");
    const rows = readPage(runsLedger(w.harness), { limit: 10 }).items.map((i) => i.record);
    expect(rows[0]).toMatchObject({ state: "queued", workItem: wi });
    expect(w.starts).toHaveLength(1);
  });

  test("adopting an issue is not served yet, and a Thredz task needs Home", async () => {
    const w = world();
    const issue = await w.run(["adopt", "--from", "github-issue:acme/app#12"]);
    expect(issue.exitCode).toBe(EXIT_FOR_ERROR.unsupported);
    expect(issue.lines.join("\n")).toContain("needs a repository connection");
    const task = await w.run(["adopt", "--from", "thredz-task:t1"]);
    expect(task.exitCode).toBe(EXIT_FOR_ERROR.unsupported);
    expect(task.lines.join("\n")).toContain("crewhaus hangar serve");
    expect((await w.run(["adopt", "stray", "--from", "continuity-goal:goal-0001"])).lines[0]).toBe(
      "work adopt: unexpected argument",
    );
  });

  test("every change refuses under an agent's tool, and writes nothing", async () => {
    const w = world();
    const wi = mintId("wi");
    for (const argv of [
      ["add", "--title", "x"],
      ["accept", wi],
      ["decline", wi, "--reason", "other"],
      ["rank", wi, "--above", mintId("wi"), "--scope", "all"],
      ["start", wi],
      ["publish", wi],
    ]) {
      const out = await w.run(argv, { CREWHAUS_AGENT_TOOL: "Bash" });
      expect(`${argv[0]} ${out.exitCode}`).toBe(`${argv[0]} ${EXIT_FOR_ERROR.forbidden}`);
      expect(out.lines[0]).toContain("a person does this");
    }
    expect(openWorkStore(w.harness).list().items).toEqual([]);
    // A read still answers.
    expect((await w.run(["list"], { CREWHAUS_AGENT_TOOL: "Bash" })).exitCode).toBe(0);
  });

  test("a harness that lists no Work tool says so, and refuses to start an item it cannot read safely", async () => {
    const w = world("tools: [read]");
    expect((await w.run(["list"])).lines[0]).toContain("doesn't keep a work list");
    const proposed = await openWorkStore(w.harness).propose(
      { title: "Harness words", kind: "fix", basis: "speculative" },
      { by: "sys:runtime", via: "tool", role: "harness" },
    );
    if (!proposed.ok) throw new Error(proposed.message);
    expect((await w.run(["accept", proposed.item.id])).exitCode).toBe(0);
    const start = await w.run(["start", proposed.item.id]);
    expect(start.exitCode).toBe(EXIT_FOR_ERROR.unsupported);
    expect(start.lines[0]).toContain("Turn on the Work tools");
  });
});

describe("crewhaus work publish", () => {
  const benches: Bench[] = [];
  afterEach(async () => {
    for (const b of benches.splice(0)) await b.stop();
  });

  /** A harness with a change in a workspace, its bindings and its own token on disk. */
  async function delivering() {
    const w = world("tools: [read, workList, workGet, workspaceOpen, workspacePublish]");
    const b = await bench(w.harness);
    benches.push(b);
    writeBindings(w.harness, b.bindings);
    writeFileSync(join(w.harness, ".env"), `${TOKEN_VARIABLE}=${b.token}\n`, { mode: 0o600 });
    const engine = b.engine();
    const wi = await b.item();
    const opened = await engine.open(wi, { actor: HARNESS });
    if (!opened.ok) throw new Error(opened.message);
    b.write(opened.worktree, "src/dates.ts", "export const parse = 2;\n");
    return { ...w, b, engine, wi };
  }

  test("publishes what a run judged, names the pull request, and says where to look", async () => {
    const t = await delivering();
    // A run judged the change, and the answer to its create was lost.
    t.b.fake.interruptNextCreate("error");
    expect(await t.b.publish(t.engine, t.wi)).toMatchObject({ state: "unknown" });
    const out = await t.run(["publish", t.wi]);
    expect(`${out.exitCode} ${out.lines[0]}`).toBe(`0 ${t.wi} published as pull request #1`);
    expect(out.lines).toContain(`  see: crewhaus workspace show ${t.wi}`);
    expect(out.lines.at(-1)).toMatch(/^ {2}receipt cmd_/);
    const json = JSON.parse((await t.run(["publish", t.wi, "--json"])).lines.join("\n")) as {
      receipt: { kind: string; via: string; state: string };
      attempt: { pr: number; state: string };
    };
    expect(json.receipt).toMatchObject({ kind: "work.publish", via: "cli", state: "succeeded" });
    expect(json.attempt).toMatchObject({ pr: 1, state: "done" });
  }, 60_000); // real git children and a loopback host

  test("a change no run judged is not published, and the next step is named", async () => {
    const t = await delivering();
    plainGit(join(t.harness, ".crewhaus/workspaces/app/wt", t.wi.slice(3, 13).toLowerCase()), [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "By hand",
    ]);
    const out = await t.run(["publish", t.wi]);
    expect(out.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(out.lines[0]).toStartWith("work publish: not published: ");
    expect(t.b.hostWrites().filter((x) => x.path.endsWith("/pulls"))).toEqual([]);
    const bare = await t.b.item({ title: "Nothing yet" });
    const none = await t.run(["publish", bare]);
    expect(none.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(none.lines.join("\n")).toContain(`crewhaus work start ${bare}`);
    expect((await t.run(["publish", "wi_nope"])).exitCode).toBe(EXIT_FOR_ERROR.invalid);
  }, 60_000); // real git children and a loopback host
});

type WorkPage = {
  actionsFor(
    item: Record<string, unknown>,
    can: Record<string, boolean>,
    hrn: string,
  ): ReadonlyArray<{ readonly id: string; readonly twin: string }>;
  declineTwin(wi: string, reason: string, hrn: string): string;
  rankTwin(wi: string, above: string, scope: string, hrn: string): string;
};

/** A twin as argv for `runWorkCommand`: no `crewhaus work`, no `--harness` (the world adds it). */
function argvOf(twin: string, fill: Readonly<Record<string, string>> = {}): string[] {
  const words = twin.split(" ").map((w) => fill[w] ?? w);
  expect(words.slice(0, 2)).toEqual(["crewhaus", "work"]);
  const at = words.indexOf("--harness");
  expect(at).toBeGreaterThan(-1);
  return [...words.slice(2, at), ...words.slice(at + 2)];
}

describe("the Work page's twins, run", () => {
  test("Add note, Decline and Move above… do what the page does", async () => {
    const url = new URL("../../../packages/hangar-ui/assets/js/views/work.js", import.meta.url)
      .href;
    const page = (await import(url)) as WorkPage;
    const w = world();
    const store = openWorkStore(w.harness);
    const a = await store.create({ title: "Fix the date parser", kind: "fix" }, PERSON_ACTOR);
    if (!a.ok) throw new Error(a.message);
    const b = await store.create({ title: "Update the parser", kind: "fix" }, PERSON_ACTOR);
    if (!b.ok) throw new Error(b.message);
    const can = { "h.run.submit": true, "h.control": true };
    const edit = page.actionsFor(a.item, can, HRN).find((x) => x.id === "edit")?.twin ?? "";
    const noted = await w.run(argvOf(edit, { "<text>": "Seen twice." }));
    expect(`${noted.exitCode} ${noted.lines.join(" ")}`).toStartWith("0");
    const read = store.get(a.item.id);
    expect("ok" in read ? undefined : read.item.rev).toBe(2);

    const ranked = await w.run(argvOf(page.rankTwin(b.item.id, a.item.id, "item", HRN)));
    expect(ranked.exitCode).toBe(0);

    const proposed = await store.propose(
      { title: "Add CSV export", kind: "fix", basis: "speculative" },
      { by: "sys:runtime", via: "tool", role: "harness" },
    );
    if (!proposed.ok) throw new Error(proposed.message);
    const declined = await w.run(argvOf(page.declineTwin(proposed.item.id, "not-now", HRN)));
    expect(declined.exitCode).toBe(0);
    expect(store.get(proposed.item.id)).toMatchObject({
      item: { state: "closed", outcome: "declined" },
    });
  });
});
