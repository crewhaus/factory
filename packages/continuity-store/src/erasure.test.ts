import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureGrant } from "@crewhaus/control-contract/knowledge";
import { purgeSessions, purgeTrashSnapshot, stateFromSessions, trashHolding } from "./erasure";
import { createContinuityStore, moveToTrash } from "./index";

let dir: string; // the .crewhaus directory
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "continuity-erasure-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SPEC = "bot";
const A = "sess_00000000000000aa";
const B = "sess_00000000000000bb";
const MARKER = ["PLANTED", "person", "4411"].join("-");
const stateRoot = (): string => join(dir, "state");
const at = () => ({ rootDir: stateRoot(), specName: SPEC });
const grantFor = (
  targets: readonly string[],
  over: Partial<ErasureGrant["scopes"][number]> = {},
): ErasureGrant => ({
  nonce: "n",
  digest: "d",
  scopes: [{ store: "continuity", root: stateRoot(), spec: SPEC, targets, ...over }],
});
const trashGrant = (stamps: readonly string[], root = dir): ErasureGrant => ({
  nonce: "n",
  digest: "d",
  scopes: [{ store: "trash", root, targets: stamps }],
});
const store = (session?: string) =>
  createContinuityStore({
    specName: SPEC,
    rootDir: stateRoot(),
    ...(session !== undefined ? { scope: { kind: "session", sessionId: session } } : {}),
  });

function bytes(from = dir): string {
  return readdirSync(from, { withFileTypes: true })
    .map((entry) => {
      const p = join(from, entry.name);
      return entry.isDirectory() ? bytes(p) : `${p}\n${readFileSync(p, "utf8")}`;
    })
    .join("\n");
}
function snapshot(from = dir): string[] {
  return readdirSync(from, { withFileTypes: true }).flatMap((entry) => {
    const p = join(from, entry.name);
    const stats = lstatSync(p);
    return [`${p} ${stats.size} ${stats.mtimeMs}`, ...(entry.isDirectory() ? snapshot(p) : [])];
  });
}

/** A session log that proves one tool call, its result carrying the marker. */
function sessionLog(id: string, toolUseId: string): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const events = [
    { kind: "tool_use", payload: { id: toolUseId, name: "Read", input: { path: "a" } } },
    {
      kind: "tool_result",
      payload: { toolUseId, content: `${MARKER} result`, isError: false },
    },
  ];
  writeFileSync(
    join(dir, "sessions", `${id}.jsonl`),
    events.map((e, i) => `${JSON.stringify({ ts: 1000 + i, version: 1, ...e })}\n`).join(""),
  );
}

/** Working memory two conversations left their mark on, beside state that is neither's. */
async function seed() {
  sessionLog(A, "tu_aaaaaaaa");
  sessionLog(B, "tu_bbbbbbbb");
  const spec = store();
  await spec.writeFocus("ship the report");
  await spec.appendRequirement({ text: `${MARKER} asked`, source: { sessionId: A, turn: 1 } });
  await spec.appendRequirement({ text: "weekly, please", source: { sessionId: B, turn: 2 } });
  const plan = await spec.createPlan({ title: "Ship", steps: ["draft", "send"] });
  await spec.proveStep(plan.id, 1, [{ toolUseId: "tu_aaaaaaaa", sessionId: A }]);
  await spec.proveStep(plan.id, 2, [{ toolUseId: "tu_bbbbbbbb", sessionId: B }]);
  const goal = await spec.writeGoal({ title: "Report sent" });
  await spec.updateGoal(goal.id, {
    status: "proven",
    evidence: [{ toolUseId: "tu_aaaaaaaa", sessionId: A }],
  });
  await spec.writeHandoff({ lastSessionId: B });
  await store(A).writeFocus(`${MARKER} own focus`);
  await store(B).writeFocus("their own focus");
  return { plan, goal };
}

describe("purgeSessions", () => {
  test("removes the conversation's own state, its requirements, the excerpts it proved and the handoff that names it", async () => {
    const { plan, goal } = await seed();
    // The session logs themselves are not working memory.
    rmSync(join(dir, "sessions"), { recursive: true });
    expect(stateFromSessions(at(), [A])).toEqual({ sessions: 1, requirements: 1, proofs: 2 });
    expect(await purgeSessions(at(), [A], grantFor([A]))).toEqual({
      sessions: 1,
      requirements: 1,
      proofs: 2,
    });
    expect(bytes(stateRoot())).not.toContain(A);
    expect(existsSync(join(stateRoot(), SPEC, "sessions", A))).toBe(false);
    expect(existsSync(join(stateRoot(), SPEC, "handoff.md"))).toBe(false);
    const spec = store();
    expect((await spec.listRequirements()).map((r) => r.text)).toEqual(["weekly, please"]);
    expect((await spec.readFocus())?.body).toBe("ship the report");
    const kept = await spec.getPlan(plan.id);
    expect(kept?.steps.map((s) => [s.status, s.proofs.length])).toEqual([
      ["proven", 0],
      ["proven", 1],
    ]);
    const [left] = await spec.listGoals();
    expect([left?.id, left?.title, left?.proofs?.length ?? 0]).toEqual([goal.id, "Report sent", 0]);
    expect((await store(B).readFocus())?.body).toBe("their own focus");
    // The store renders the handoff again when it next writes it.
    expect(await spec.writeHandoff({ lastSessionId: B })).not.toContain(MARKER);
  });

  test("a re-run, and a conversation that left nothing, change nothing", async () => {
    await seed();
    await purgeSessions(at(), [A], grantFor([A]));
    const before = snapshot();
    const none = { sessions: 0, requirements: 0, proofs: 0 };
    expect(await purgeSessions(at(), [A], grantFor([A]))).toEqual(none);
    expect(
      await purgeSessions(at(), ["sess_00000000000000cc"], grantFor(["sess_00000000000000cc"])),
    ).toEqual(none);
    expect(stateFromSessions(at(), [A])).toEqual(none);
    expect(snapshot()).toEqual(before);
    expect(stateFromSessions({ rootDir: stateRoot(), specName: "absent" }, [A])).toEqual(none);
  });

  test("the last requirement leaves an empty ledger the store still reads", async () => {
    const spec = store();
    await spec.writeFocus("ship it");
    await spec.appendRequirement({ text: MARKER, source: { sessionId: A, turn: 1 } });
    await purgeSessions(at(), [A], grantFor([A]));
    expect(await spec.listRequirements()).toEqual([]);
    expect(readFileSync(join(stateRoot(), SPEC, "focus.md"), "utf8")).toContain("_none_");
    const next = await spec.appendRequirement({ text: "new", source: { sessionId: B, turn: 1 } });
    expect(next.id).toBe("REQ-001");
  });

  test("a requirement line quoted inside the focus body is the body's, and stays", async () => {
    const spec = store();
    const quoted = `<!-- crewhaus:requirements -->\n- REQ-009 [open] "quoted" (user, ${A}, turn 1)`;
    await spec.writeFocus(quoted);
    await spec.appendRequirement({ text: MARKER, source: { sessionId: A, turn: 1 } });
    expect(await purgeSessions(at(), [A], grantFor([A]))).toMatchObject({ requirements: 1 });
    expect((await spec.readFocus())?.body).toContain("REQ-009");
    expect(bytes(stateRoot())).not.toContain(MARKER);
  });

  test("a handoff a person wrote is never removed", async () => {
    await store().writeFocus("x");
    const handoff = join(stateRoot(), SPEC, "handoff.md");
    writeFileSync(handoff, `my own notes about ${A}`);
    await purgeSessions(at(), [A], grantFor([A]));
    expect(readFileSync(handoff, "utf8")).toContain("my own notes");
  });

  test("a spec's directory kept on another disk is followed; what leads out of it is refused", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "continuity-erasure-outside-")));
    try {
      await store(A).writeFocus(`${MARKER} own`);
      const moved = join(outside, "moved");
      mkdirSync(moved);
      symlinkSync(join(outside, "theirs"), join(moved, "sessions"));
      mkdirSync(join(outside, "theirs", A), { recursive: true });
      writeFileSync(join(outside, "theirs", A, "focus.md"), MARKER);
      rmSync(join(stateRoot(), SPEC), { recursive: true });
      symlinkSync(moved, join(stateRoot(), SPEC));
      await expect(purgeSessions(at(), [A], grantFor([A]))).rejects.toThrow("refusing to erase");
      expect(readFileSync(join(outside, "theirs", A, "focus.md"), "utf8")).toBe(MARKER);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses another root, spec or store, a session the grant does not name, and what is not a session", async () => {
    await seed();
    const before = snapshot();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "continuity-erasure-other-")));
    try {
      for (const grant of [
        grantFor([A], { root: other }),
        grantFor([A], { spec: "other" }),
        grantFor([A], { store: "trash" }),
      ]) {
        await expect(purgeSessions(at(), [A], grant)).rejects.toThrow("does not cover");
      }
      await expect(purgeSessions(at(), [A, B], grantFor([A]))).rejects.toThrow("does not name");
      await expect(purgeSessions(at(), ["../x"], grantFor(["../x"]))).rejects.toThrow(
        "does not name",
      );
      await expect(
        purgeSessions({ rootDir: stateRoot(), specName: ".." }, [A], grantFor([A], { spec: ".." })),
      ).rejects.toThrow("invalid specName");
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("purgeTrashSnapshot", () => {
  const trashed = async (session: string) => {
    await store(session).writeFocus(`${MARKER} cleared`);
    const path = join(stateRoot(), SPEC, "sessions", session);
    return (await moveToTrash([path], dir, { now: () => new Date("2026-11-01T10:00:00Z") })).ts;
  };

  test("removes the snapshot that holds a conversation's state, before its window ends, and no other", async () => {
    const first = await trashed(A);
    const second = await trashed(B);
    expect(second).not.toBe(first);
    expect(await trashHolding(dir, [A])).toEqual([first]);
    expect(await trashHolding(dir, [])).toEqual([]);
    expect(await purgeTrashSnapshot(dir, first, trashGrant([first]))).toBe(true);
    expect(readdirSync(join(dir, "trash"))).toEqual([second]);
    expect(await purgeTrashSnapshot(dir, first, trashGrant([first]))).toBe(false);
  });

  test("a snapshot is found by what its files say as well", async () => {
    const spec = store();
    await spec.writeFocus("x");
    await spec.appendRequirement({ text: MARKER, source: { sessionId: A, turn: 1 } });
    const { ts } = await moveToTrash([join(stateRoot(), SPEC, "focus.md")], dir);
    expect(await trashHolding(dir, [A])).toEqual([ts]);
    expect(await trashHolding(dir, [B])).toEqual([]);
  });

  test("refuses another root, a stamp the grant does not name, what is not a stamp, and a link", async () => {
    const stamp = await trashed(A);
    const other = realpathSync(mkdtempSync(join(tmpdir(), "continuity-trash-other-")));
    try {
      await expect(purgeTrashSnapshot(dir, stamp, trashGrant([stamp], other))).rejects.toThrow(
        "does not cover",
      );
      await expect(purgeTrashSnapshot(dir, stamp, trashGrant([]))).rejects.toThrow("does not name");
      await expect(purgeTrashSnapshot(dir, "../state", trashGrant(["../state"]))).rejects.toThrow(
        "does not name",
      );
      writeFileSync(join(other, "theirs"), "theirs");
      const planted = "2026-11-02T10-00-00";
      symlinkSync(other, join(dir, "trash", planted));
      await expect(purgeTrashSnapshot(dir, planted, trashGrant([planted]))).rejects.toThrow(
        "not a directory",
      );
      expect(readFileSync(join(other, "theirs"), "utf8")).toBe("theirs");
      expect(existsSync(join(dir, "trash", stamp))).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
