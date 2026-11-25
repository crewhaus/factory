/**
 * `crewhaus inbox`'s acts: each goes through the same writers Home's do, under one receipt
 * in the harness's own ledger and one content-free line on its actions ledger; a refusal
 * writes nothing; a command an agent's tool started does nothing; an item about several
 * harnesses is acted on in each; and what a person says in a discussion is kept with the
 * item and nowhere else.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAccessSetUp, openAccess } from "@crewhaus/access-control";
import { createCheckpointStore } from "@crewhaus/checkpoint-store";
import {
  ATTENTION_MESSAGE_MAX_BYTES,
  EXIT_FOR_ERROR,
  OPERATIONS,
  mintRunId,
} from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { append, attentionActionsLedger, readPage, runsLedger } from "@crewhaus/control-records";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { ApiRunInput } from "@crewhaus/harness-supervisor";
import {
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { INBOX_ACTS, INBOX_AGENT_REFUSAL, readSmallFile } from "./inbox-acts";
import { CLI_FAMILY, runInboxCommand } from "./inbox-cmd";

type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const UNTIL = "2026-11-12T09:00:00.000Z";

let base: string;
let env: Record<string, string>;
let starts: ApiRunInput[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-inbox-acts-")));
  env = {
    CREWHAUS_HANGAR_ROOT: join(base, "hangar"),
    CREWHAUS_REGISTRY_ROOT: join(base, "registry"),
    CREWHAUS_WATCHME_ROOT: join(base, "watchme"),
    HOME: base,
  };
  starts = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type Harness = { readonly id: string; readonly dir: string };

function harness(name: string, target = "cli"): Harness {
  const dir = join(base, "harnesses", name);
  mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: ${name}\ntarget: ${target}\nagent:\n  model: claude-opus-5\n  instructions: help\n`,
  );
  const entry = openHangarRegistry({ env }).upsert({ dir, specName: name, target });
  return { id: entry.id, dir };
}

async function park(h: Harness, id = generateApprovalId()): Promise<string> {
  const input = { channel: "ops", text: "ship it" };
  await createPendingApprovalStore({
    rootDir: join(h.dir, ".crewhaus", "sessions"),
    now: () => new Date(NOW - 600_000),
  }).persist({
    id,
    toolName: "SendMessage",
    inputHash: hashApprovalInput("SendMessage", input),
    input,
    runId: mintRunId({ now: NOW - 600_000 }),
    sessionId: `sess_${"a".repeat(16)}`,
    surface: "daemon",
    createdAt: new Date(NOW - 600_000).toISOString(),
  } as never);
  return id;
}

function failRun(h: Harness, failureClass = "auth"): void {
  const id = mintRunId({ now: NOW - 60_000 });
  for (const row of [
    { state: "running", at: new Date(NOW - 120_000).toISOString() },
    { state: "failed", at: new Date(NOW - 60_000).toISOString(), failureClass },
  ]) {
    const written = append(runsLedger(h.dir), { id, trigger: { kind: "api" }, ...row });
    if (!written.ok) throw new Error(written.reason);
  }
}

const SAM = { username: "sam", hostname: "laptop" };

const run = (
  argv: readonly string[],
  over: { env?: Record<string, string>; as?: { username: string; hostname: string } } = {},
) =>
  runInboxCommand(argv, {
    env: { ...env, ...over.env },
    now: () => NOW,
    cwd: base,
    identity: over.as ?? SAM,
    home: () => ({
      startRunJob: async (_dir, apiRun) => {
        starts.push(apiRun);
        return { ok: true, runId: "run_0000000000000001", pid: 1 };
      },
    }),
  });

type Listed = {
  readonly ref: string;
  readonly kind: string;
  readonly state: string;
  readonly choices: ReadonlyArray<{ readonly id: string }>;
  readonly harnesses?: readonly string[];
};

async function items(
  argv: readonly string[] = [],
  as?: { username: string; hostname: string },
): Promise<Listed[]> {
  const out = await run(["list", "--json", ...argv], as !== undefined ? { as } : {});
  return (JSON.parse(out.lines.join("\n")) as { items: Listed[] }).items;
}

const idOf = (item: Pick<Listed, "ref">): string => item.ref.slice(item.ref.lastIndexOf("/") + 1);

async function one(): Promise<string> {
  const listed = await items();
  expect(listed).toHaveLength(1);
  return idOf(listed[0] as Listed);
}

const actions = (h: Harness): Array<Record<string, unknown>> => {
  const at = join(h.dir, ".crewhaus", "run", "control", "attention");
  if (!existsSync(at)) return [];
  return readPage(attentionActionsLedger(h.dir), { limit: 100 })
    .items.map((item) => item.record as Record<string, unknown>)
    .reverse();
};

/** The newest state of each receipt in the harness's own command ledger. */
function receipts(h: Harness): Array<Record<string, unknown>> {
  const at = join(h.dir, ".crewhaus", "run", "control", "commands");
  if (!existsSync(at)) return [];
  const newest = new Map<string, Record<string, unknown>>();
  for (const name of readdirSync(at)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(join(at, name), "utf8").split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      newest.set(String(row["id"]), { ...newest.get(String(row["id"])), ...row });
    }
  }
  return [...newest.values()];
}

/** Every path under `root` with its bytes, for a no-write check. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        out[`${path}/`] = String(st.mtimeMs);
        walk(path);
      } else out[path] = `${readFileSync(path).toString("base64")}@${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

/** Home's members, with `sam@laptop` its owner. */
async function members(list: readonly Harness[]) {
  const root = env["CREWHAUS_HANGAR_ROOT"] as string;
  const now = () => NOW - 86_400_000;
  const set = await ensureAccessSetUp(root, { localActor: "local:sam@laptop", now });
  if (!set.ok) throw new Error(set.reason);
  const access = openAccess(root, {
    now,
    harnesses: () => list.map((h) => ({ ...h, groups: [] })),
  });
  const owner = set.result.owner;
  const add = async (member: string, role: string): Promise<string> => {
    const done = await access.grant(
      { principal: owner },
      { member, create: true, role, scope: "home" },
    );
    if (!done.ok) throw new Error(done.reason);
    return done.result.principal;
  };
  return { owner, operator: await add("Olly", "operator"), viewer: await add("Vic", "viewer") };
}

describe("every act", () => {
  test("is a verb of the family, and the operation Home has", () => {
    const { list, show, stats, ...acts } = CLI_FAMILY.sub;
    expect([list, show, stats].length).toBe(3);
    expect(Object.keys(INBOX_ACTS)).toEqual(Object.keys(acts));
    const operations = new Set(OPERATIONS.map((op) => op.id));
    for (const kind of Object.values(INBOX_ACTS)) {
      expect(`${kind}: ${operations.has(kind)}`).toBe(`${kind}: true`);
    }
  });

  test("does nothing when an agent's tool started it", async () => {
    const a = harness("alpha");
    await park(a);
    failRun(a);
    const id = idOf((await items())[0] as Listed);
    writeFileSync(join(base, "note.txt"), "hello");
    const argvs: Record<keyof typeof INBOX_ACTS, readonly string[]> = {
      decide: [id, "grant"],
      assign: [id, "--to", `prn_${"0".repeat(26)}`],
      unassign: [id],
      defer: [id, "--until", UNTIL, "--reason", "scheduled"],
      undefer: [id],
      snooze: [id, "--until", UNTIL],
      dismiss: [id, "--reason", "known"],
      reopen: [id],
      acknowledge: [id],
      discuss: [id, "--file", "note.txt"],
    };
    const before = treeOf(base);
    for (const [verb, argv] of Object.entries(argvs)) {
      const out = await run([verb, ...argv], { env: { [AGENT_TOOL_ENV]: "1" } });
      expect(`${verb}: ${out.exitCode} ${out.lines.join(" ")}`).toBe(
        `${verb}: ${EXIT_FOR_ERROR.forbidden} ${INBOX_AGENT_REFUSAL}`,
      );
    }
    expect(treeOf(base)).toEqual(before);
  });

  test("names what its own words miss before it reads anything", async () => {
    const id = `att_${"0".repeat(26)}`;
    for (const [argv, says] of [
      [["decide"], "name an item, att_…"],
      [["decide", "nope", "grant"], "name an item, att_…"],
      [["decide", id], "name the choice"],
      [["decide", id, "grant", "more"], 'unexpected "more"'],
      [["assign", id], "name the member with --to"],
      [["defer", id, "--reason", "scheduled"], "say until when with --until"],
      [
        ["defer", id, "--until", UNTIL, "--reason", "bored"],
        "--reason is one of awaiting-information",
      ],
      [["snooze", id], "say until when with --until"],
      [["dismiss", id, "--reason", "bored"], "--reason is one of not-a-problem"],
      [["discuss", id], "name the message's file with --file"],
      [["discuss", id, "--file", "gone.txt"], "gone.txt could not be read (ENOENT)"],
    ] as const) {
      const out = await run(argv);
      expect(`${argv.join(" ")}: ${out.exitCode}`).toBe(
        `${argv.join(" ")}: ${EXIT_FOR_ERROR.invalid}`,
      );
      expect(out.lines.join("\n")).toContain(says);
    }
    const unknown = await run(["decide", id, "grant"]);
    expect(unknown.exitCode).toBe(EXIT_FOR_ERROR.not_found);
    expect(unknown.lines.join("\n")).toContain("crewhaus inbox list");
  });
});

describe("inbox decide", () => {
  test("decides a request through its own record, with one receipt and one line", async () => {
    const a = harness("alpha");
    const appr = await park(a);
    const id = await one();
    const out = await run(["decide", id, "grant"]);
    expect(out.exitCode).toBe(0);
    expect(out.lines[0]).toBe(`Recorded: grant on ${id}.`);
    const record = foldReadOnly(join(a.dir, ".crewhaus", "sessions")).records.find(
      (r) => r.id === appr,
    );
    expect(record).toMatchObject({ decision: "grant", decidedVia: "cli" });
    const [receipt, ...more] = receipts(a);
    expect(more).toEqual([]);
    expect(receipt).toMatchObject({ kind: "attention.resolve", state: "succeeded", via: "cli" });
    expect(out.lines[1]).toBe(`  receipt ${String(receipt?.["id"])}`);
    const lines = actions(a);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id,
      event: "resolved",
      state: "resolved",
      how: "decided",
      choice: "grant",
      via: "cli",
      cmd: receipt?.["id"],
      by: receipt?.["actor"],
    });
    expect(await items()).toEqual([]);
  });

  test("a second decision, and one made on something that changed, write nothing", async () => {
    const a = harness("alpha");
    await park(a);
    const id = await one();
    await run(["decide", id, "deny"]);
    const before = treeOf(base);
    const again = await run(["decide", id, "grant", "--json"]);
    expect(again.exitCode).toBe(EXIT_FOR_ERROR.already_decided);
    expect(JSON.parse(again.lines.join("\n"))).toMatchObject({
      harness: a.id,
      error: { code: "already_decided", reason: "already_decided" },
    });
    expect(treeOf(base)).toEqual(before);

    const b = harness("beta");
    await park(b);
    const other = (await items(["--harness", "beta"])).map(idOf)[0] as string;
    const stale = await run(["decide", other, "grant", "--expect", "resolved"]);
    expect(stale.exitCode).toBe(EXIT_FOR_ERROR.precondition_failed);
    const unoffered = await run(["decide", other, "approve"]);
    expect(unoffered.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(unoffered.lines[0]).toBe("inbox decide: This item does not offer that choice.");
    expect(receipts(b)).toEqual([]);
    expect(actions(b)).toEqual([]);
  });

  test("an item it is not about names no harness to act in", async () => {
    const a = harness("alpha");
    harness("beta");
    await park(a);
    const id = await one();
    const before = treeOf(base);
    const out = await run(["decide", id, "grant", "--harness", "beta"]);
    expect(out.exitCode).toBe(EXIT_FOR_ERROR.not_found);
    expect((await run(["decide", id, "grant", "--harness", "gone"])).exitCode).toBe(
      EXIT_FOR_ERROR.not_found,
    );
    expect(treeOf(base)).toEqual(before);
  });

  test("a paused graph run is resumed with the word, under its own run", async () => {
    const a = harness("gina", "graph");
    mkdirSync(join(a.dir, "dist"), { recursive: true });
    writeFileSync(join(a.dir, "dist", "agent.ts"), "// bundle\n");
    writeFileSync(
      join(a.dir, "dist", "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith: "0.9.0" },
      }),
    );
    const grun = "grun_0123456789abcdef";
    const store = createCheckpointStore({ rootDir: join(a.dir, ".crewhaus", "graphs") });
    const saved = await store.save({ graphRunId: grun, nodeName: "review", state: {} });
    await store.markWaiting(grun, {
      checkpointId: saved.id,
      nodeName: "review",
      prompt: "Ship it?",
    });
    const id = await one();
    const out = await run(["decide", id, "approve"]);
    expect(out.exitCode).toBe(0);
    expect(starts.map((s) => s.graphResume)).toEqual([{ grun, decision: "approve" }]);
    expect(out.lines[0]).toBe(
      `Recorded: approve on ${id}. It resumes as run ${String(starts[0]?.runId)}.`,
    );
    expect(
      receipts(a)
        .map((r) => r["kind"])
        .sort(),
    ).toEqual(["attention.resolve", "graphs.resume"]);
    // The pause itself is settled by the run, so the item waits until it is.
    expect(actions(a).map((l) => [l["event"], l["state"], l["choice"]])).toEqual([
      ["resolved", "open", "approve"],
    ]);
  });

  test("a review is settled by its claimed writer, with a note from a file", async () => {
    const a = harness("alpha");
    mkdirSync(join(a.dir, ".crewhaus", "review"), { recursive: true });
    const queue = join(a.dir, ".crewhaus", "review", "queue.jsonl");
    writeFileSync(
      queue,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "rev_abstained_run_1-s1",
        kind: "abstained",
        sourceRef: { runId: "run_1", sampleId: "s1" },
        ts: new Date(NOW - 60_000).toISOString(),
        status: "open",
      })}\n`,
    );
    writeFileSync(join(base, "note.txt"), "the citation is right");
    const id = await one();
    const out = await run(["decide", id, "pass", "--note-file", "note.txt"]);
    expect(out.lines[0]).toBe(`Recorded: pass on ${id}.`);
    const last = JSON.parse(readFileSync(queue, "utf8").trim().split("\n").at(-1) as string);
    expect(last).toMatchObject({
      status: "resolved",
      resolution: "the citation is right",
      via: "cli",
    });
    expect(last.resolvedBy).toMatch(/^local:#[0-9a-f]{64}$/);
    // The note is the review's own; the act's records do not hold it.
    expect(JSON.stringify([actions(a), receipts(a)])).not.toContain("citation");
  });

  test("what this terminal cannot start names the command that does", async () => {
    const a = harness("alpha");
    failRun(a, "crewhaus_budget");
    const listed = (await items()).find((i) => i.kind === "budget");
    if (listed === undefined) throw new Error("no budget item");
    // Raising it is the person's own amount: a place to go, never a choice made here.
    const out = await run(["decide", idOf(listed), "raise-period"]);
    expect(out.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    const wait = await run(["decide", idOf(listed), "wait-for-renewal"]);
    expect(wait.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(wait.lines[0]).toContain("does not renew on its own");
    expect(actions(a)).toEqual([]);
  });
});

describe("inbox assign, defer and snooze", () => {
  test("a member whose class reaches it is given it, and --mine lists what is theirs", async () => {
    const a = harness("alpha");
    await park(a);
    const people = await members([a]);
    const id = await one();
    const before = actions(a).length;
    const viewer = await run(["assign", id, "--to", people.viewer]);
    expect(viewer.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(viewer.lines[0]).toContain("It needs an operator.");
    expect(actions(a)).toHaveLength(before);

    const given = await run(["assign", id, "--to", people.operator]);
    expect(given.lines[0]).toBe(`Gave ${id} to ${people.operator}.`);
    expect(await items(["--mine"])).toEqual([]);
    const shown = await run(["show", id]);
    expect(shown.lines.join("\n")).toContain(`With ${people.operator}`);

    await run(["assign", id, "--to", people.owner]);
    expect((await items(["--mine"])).map(idOf)).toEqual([id]);
    const back = await run(["unassign", id]);
    expect(back.exitCode).toBe(0);
    expect(await items(["--mine"])).toEqual([]);
    expect(actions(a).map((l) => l["event"])).toEqual(["assigned", "assigned", "unassigned"]);
  });

  test("a problem put off leaves the list until its time, and comes back when taken up", async () => {
    const a = harness("alpha");
    failRun(a);
    const id = await one();
    const out = await run(["defer", id, "--until", UNTIL, "--reason", "scheduled"]);
    expect(out.lines[0]).toBe(`Put off ${id}.`);
    expect(await items()).toEqual([]);
    const shown = (await run(["show", id])).lines.join("\n");
    expect(shown).toContain(`Put off until ${UNTIL}`);
    expect((await run(["undefer", id])).lines[0]).toBe(`${id} is back in the inbox.`);
    expect((await items()).map(idOf)).toEqual([id]);
    const twice = await run(["undefer", id]);
    expect(twice.exitCode).toBe(EXIT_FOR_ERROR.conflict);
  });

  test("a request's own deadline moves with it", async () => {
    const a = harness("alpha");
    await park(a);
    const id = await one();
    const out = await run(["defer", id, "--until", UNTIL, "--reason", "awaiting-information"]);
    expect(out.lines[0]).toBe(`Put off ${id}. Its deadline moved with it.`);
    expect((await items())[0]?.state).toBe("deferred");
  });

  test("a snooze hides it from the one who asked, and from no one else", async () => {
    const a = harness("alpha");
    failRun(a);
    const id = await one();
    expect((await run(["snooze", id, "--until", UNTIL])).lines[0]).toBe(
      `Hid ${id} from you for now.`,
    );
    expect(await items()).toEqual([]);
    expect((await items([], { username: "olly", hostname: "laptop" })).map(idOf)).toEqual([id]);
    expect((await run(["show", id])).lines.join("\n")).toContain(`Hidden from you until ${UNTIL}`);
  });
});

describe("inbox dismiss, acknowledge and reopen", () => {
  test("a problem is set aside and taken up again; a request is not", async () => {
    const a = harness("alpha");
    failRun(a);
    const id = await one();
    expect((await run(["dismiss", id, "--reason", "known"])).lines[0]).toBe(`Set ${id} aside.`);
    expect(await items()).toEqual([]);
    expect((await run(["reopen", id])).lines[0]).toBe(`Took ${id} up again.`);
    expect((await items()).map(idOf)).toEqual([id]);
    expect((await run(["acknowledge", id])).lines[0]).toBe(`Acknowledged ${id}.`);
    expect(await items()).toEqual([]);
    expect(actions(a).map((l) => [l["event"], l["how"] ?? null, l["reasonCode"] ?? null])).toEqual([
      ["dismissed", "dismissed", "known"],
      ["reopened", null, null],
      ["acknowledged", "acted", null],
    ]);

    const b = harness("beta");
    await park(b);
    const request = (await items(["--harness", "beta"])).map(idOf)[0] as string;
    const refused = await run(["dismiss", request, "--reason", "known"]);
    expect(refused.exitCode).toBe(EXIT_FOR_ERROR.conflict);
    expect(receipts(b)).toEqual([]);
  });

  test("an item about several harnesses is acted on in each, or in the one named", async () => {
    const a = harness("alpha");
    const b = harness("beta");
    failRun(a, "rate_limit");
    failRun(b, "rate_limit");
    const [group, ...others] = await items();
    expect(others).toEqual([]);
    expect([...(group?.harnesses ?? [])].sort()).toEqual([a.id, b.id].sort());
    const id = idOf(group as Listed);

    const inOne = await run(["acknowledge", id, "--harness", "alpha"]);
    expect(inOne.lines[0]).toBe(`Acknowledged ${id}.`);
    expect([actions(a).length, actions(b).length]).toEqual([1, 0]);
    // Set aside in one place, it still needs someone in the other.
    expect((await items()).map(idOf)).toEqual([id]);

    const both = await run(["acknowledge", id]);
    expect(both.exitCode).toBe(0);
    expect(both.lines.filter((l) => !l.startsWith("  receipt")).sort()).toEqual([
      `alpha: Acknowledged ${id}.`,
      `beta: Acknowledged ${id}.`,
    ]);
    expect([receipts(a).length, receipts(b).length]).toEqual([2, 1]);
    expect(await items()).toEqual([]);
  });
});

describe("inbox discuss", () => {
  test("keeps what was said with the item, shows it masked, and prints no control character", async () => {
    const a = harness("alpha");
    await park(a);
    const id = await one();
    // Shaped like a credential, and built from parts.
    const secret = ["sk", "ant", "k".repeat(28)].join("-");
    const said = `Ask ops first\n${String.fromCharCode(27)}[2Jthen ${secret}`;
    writeFileSync(join(base, "said.txt"), said);
    const out = await run(["discuss", id, "--file", "said.txt"]);
    expect(out.lines[0]).toBe(`Added your message to ${id}.`);
    const before = treeOf(base);
    const shown = await run(["show", id, "--messages"]);
    const text = shown.lines.join("\n");
    expect(text).toContain("Ask ops first");
    expect(text).toContain("via cli");
    expect(text).not.toContain(secret);
    expect(text.includes(String.fromCharCode(27))).toBe(false);
    const json = JSON.parse((await run(["show", id, "--messages", "--json"])).lines.join("\n"));
    expect(schemaOf("attentionMessages")?.safeParse(json).success).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(treeOf(base)).toEqual(before);

    const thread = join(a.dir, ".crewhaus", "run", "attention", "threads", `${id}.jsonl`);
    expect(JSON.parse(readFileSync(thread, "utf8")).text).toBe(said);
    expect(statSync(thread).mode & 0o777).toBe(0o600);
    expect(actions(a).map((l) => l["event"])).toEqual(["message"]);
    for (const [path, bytes] of Object.entries(before)) {
      if (path === thread || path === join(base, "said.txt")) continue;
      const held = Buffer.from(bytes.split("@")[0] ?? "", "base64").toString("utf8");
      expect(`${path}: ${held.includes("Ask ops first")}`).toBe(`${path}: false`);
    }
  });

  test("an item nobody said anything about says so", async () => {
    const a = harness("alpha");
    await park(a);
    const id = await one();
    expect((await run(["show", id, "--messages"])).lines).toEqual([
      "No one has said anything here yet.",
    ]);
    expect(existsSync(join(a.dir, ".crewhaus", "run", "attention"))).toBe(false);
  });

  test("a message is a plain file of at most 8 KiB, reached through no link", () => {
    const text = (name: string, body: string) => {
      writeFileSync(join(base, name), body);
      return name;
    };
    const read = (name: string) => readSmallFile(name, ATTENTION_MESSAGE_MAX_BYTES, base);
    expect(read(text("ok.txt", "hello"))).toEqual({ ok: true, text: "hello" });
    const big = text("big.txt", "x".repeat(ATTENTION_MESSAGE_MAX_BYTES + 1));
    expect(read(big)).toEqual({ ok: false, reason: "big.txt is larger than 8 KiB" });
    expect(read(text("full.txt", "x".repeat(ATTENTION_MESSAGE_MAX_BYTES))).ok).toBe(true);
    symlinkSync(join(base, "ok.txt"), join(base, "link.txt"));
    expect(read("link.txt")).toEqual({ ok: false, reason: "link.txt is not a plain file" });
    mkdirSync(join(base, "folder"));
    expect(read("folder")).toEqual({ ok: false, reason: "folder is not a plain file" });
    const pipe = join(base, "pipe");
    expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
    expect(read("pipe")).toEqual({ ok: false, reason: "pipe is not a plain file" });
  });

  test("an item about several harnesses is discussed in the one named", async () => {
    const a = harness("alpha");
    const b = harness("beta");
    failRun(a, "rate_limit");
    failRun(b, "rate_limit");
    const id = await one();
    writeFileSync(join(base, "said.txt"), "rotated the login");
    const vague = await run(["discuss", id, "--file", "said.txt"]);
    expect(vague.exitCode).toBe(EXIT_FOR_ERROR.invalid);
    expect(vague.lines[0]).toContain("name one with --harness");
    const named = await run(["discuss", id, "--file", "said.txt", "--harness", "beta"]);
    expect(named.exitCode).toBe(0);
    expect([actions(a).length, actions(b).length]).toEqual([0, 1]);
    expect((await run(["show", id, "--messages"])).lines.join("\n")).toContain("beta");
  });
});
