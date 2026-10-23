/**
 * The default evidence builder: the run's session log, children included,
 * scoped to the session or to the current turn the way the gate scopes it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { currentTurn, sessionEvidence, startsTurn } from "./index";
import {
  CHILD,
  GRANDCHILD,
  SESSION,
  call,
  fetched,
  subAgent,
  tempDirs,
  userMessage,
  writeLog,
} from "./test-helpers";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const A = "https://a.example/one";
const B = "https://b.example/two";
const C = "https://c.example/three";

describe("startsTurn", () => {
  test("the user's own message starts a turn", () => {
    expect(startsTurn({ content: "what is the refund window?" })).toBe(true);
    expect(startsTurn({ content: [{ type: "text", text: "hi" }] })).toBe(true);
    expect(startsTurn({ content: [] })).toBe(true);
    // A directive-bearing message is still the user's.
    expect(startsTurn({ content: "/model fast", directive: true })).toBe(true);
  });

  test("runtime-injected messages and tool-result carriers do not", () => {
    expect(startsTurn({ content: "the gate did not accept…", synthetic: true })).toBe(false);
    expect(
      startsTurn({ content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }),
    ).toBe(false);
    expect(startsTurn(null)).toBe(false);
    expect(startsTurn("text")).toBe(false);
  });

  test("a message mixing text and tool results is the user's", () => {
    expect(
      startsTurn({
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "and also" },
        ],
      }),
    ).toBe(true);
  });
});

describe("currentTurn", () => {
  test("the calls and sub-agents after the last real user message", async () => {
    const root = dirs.make();
    await writeLog(root, SESSION, [
      userMessage("first question"),
      ...call("t1", "WebFetch", { url: A }, fetched(A, "one")),
      subAgent(GRANDCHILD),
      userMessage("second question"),
      ...call("t2", "WebFetch", { url: B }, fetched(B, "two")),
      userMessage("the gate did not accept your last answer", true),
      ...call("t3", "WebFetch", { url: C }, fetched(C, "three")),
      subAgent(CHILD),
    ]);
    const turn = await currentTurn({ sessionId: SESSION, rootDir: root });
    expect([...turn.toolUseIds].sort()).toEqual(["t2", "t3"]);
    expect(turn.children).toEqual([CHILD]);
  });

  test("a missing log is an empty turn, and reading creates nothing", async () => {
    const root = join(dirs.make(), "sessions");
    const turn = await currentTurn({ sessionId: SESSION, rootDir: root });
    expect(turn.toolUseIds.size).toBe(0);
    expect(turn.children).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });
});

describe("sessionEvidence", () => {
  async function scenario(root: string): Promise<void> {
    await writeLog(root, SESSION, [
      userMessage("first question"),
      ...call("t1", "WebFetch", { url: A }, fetched(A, "Refunds are accepted within 14 days.")),
      subAgent(GRANDCHILD),
      userMessage("second question"),
      ...call("t2", "WebFetch", { url: B }, fetched(B, "Shipping takes 5 days.")),
      subAgent(CHILD),
    ]);
    await writeLog(root, GRANDCHILD, [
      ...call("g1", "WebFetch", { url: C }, fetched(C, "Old research.")),
    ]);
    await writeLog(root, CHILD, [
      ...call("c1", "WebFetch", { url: C }, fetched(C, "New research.")),
    ]);
  }

  test("no session id: an empty index and a note saying why", async () => {
    const { index, notes } = await sessionEvidence({ scope: "session" });
    expect(index.all()).toEqual([]);
    expect(notes[0]).toContain("no session log is reachable");
    const bad = await sessionEvidence({ scope: "session", sessionId: "../../x" });
    expect(bad.index.all()).toEqual([]);
  });

  test("scope session: every call the run made, children included, in call order", async () => {
    const root = dirs.make();
    await scenario(root);
    const { index, notes } = await sessionEvidence({
      scope: "session",
      sessionId: SESSION,
      rootDir: root,
    });
    expect(index.all().map((r) => r.toolUseId)).toEqual(["t1", "g1", "t2", "c1"]);
    expect(index.bySource(A)).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  test("scope turn: only this turn's calls, and the sub-agents it started", async () => {
    const root = dirs.make();
    await scenario(root);
    const { index } = await sessionEvidence({ scope: "turn", sessionId: SESSION, rootDir: root });
    expect(index.all().map((r) => r.toolUseId)).toEqual(["t2", "c1"]);
    expect(index.bySource(A)).toEqual([]);
    expect(index.byToolUseId("t1")).toBeUndefined();
    expect(index.bySource(C).map((r) => r.content)).toEqual([fetched(C, "New research.")]);
  });

  test("a child's own children ride along with it", async () => {
    const root = dirs.make();
    await writeLog(root, SESSION, [userMessage("q"), subAgent(CHILD)]);
    await writeLog(root, CHILD, [subAgent(GRANDCHILD)]);
    await writeLog(root, GRANDCHILD, [...call("g1", "WebFetch", { url: C }, fetched(C, "deep"))]);
    const { index } = await sessionEvidence({ scope: "turn", sessionId: SESSION, rootDir: root });
    expect(index.all().map((r) => r.toolUseId)).toEqual(["g1"]);
  });

  test("a log torn mid-line keeps what came before, and says so once", async () => {
    const root = dirs.make();
    await writeLog(root, SESSION, [
      userMessage("q"),
      ...call("t1", "WebFetch", { url: A }, fetched(A, "body")),
    ]);
    appendFileSync(join(root, `${SESSION}.jsonl`), '{"ts":1,"version":1,"kind":"tool_us');
    const seen: string[] = [];
    for (const scope of ["session", "turn"] as const) {
      const { index, notes } = await sessionEvidence({
        scope,
        sessionId: SESSION,
        rootDir: root,
        onUnreadable: (info) => seen.push(info.sessionId),
      });
      expect(index.all().map((r) => r.toolUseId)).toEqual(["t1"]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("could not be read to its end");
    }
    expect(seen.every((id) => id === SESSION)).toBe(true);
  });

  test("many torn logs are one note that counts them, naming the first few; each is still reported", async () => {
    // Sub-agents that crashed mid-append: every child log ends in a torn line.
    const root = dirs.make();
    const kids = Array.from(
      { length: 60 },
      (_, i) => `sess_${(0x1000 + i).toString(16).padStart(16, "0")}`,
    );
    await writeLog(root, SESSION, [userMessage("q"), ...kids.map((k) => subAgent(k))]);
    for (const k of kids) {
      await writeLog(root, k, [userMessage("child")]);
      appendFileSync(join(root, `${k}.jsonl`), '{"ts":1,"version":1,"kind":"tool_use","payl');
    }
    for (const scope of ["session", "turn"] as const) {
      const seen = new Set<string>();
      const { notes } = await sessionEvidence({
        scope,
        sessionId: SESSION,
        rootDir: root,
        onUnreadable: (info) => seen.add(info.sessionId),
      });
      expect(seen).toEqual(new Set(kids));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toStartWith("60 session logs could not be read to their end (");
      expect(notes[0]).toContain(`${kids[0]}, ${kids[1]}, ${kids[2]}, and 57 more`);
      expect(notes[0]).not.toContain(kids[3] as string);
      expect(notes[0]?.length ?? 0).toBeLessThan(500);
    }
  });
});
