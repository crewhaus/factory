import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { restrictToTurns } from "@crewhaus/provability";
import {
  CHILD,
  type Message,
  SESSION,
  assistant,
  callLines,
  callMessages,
  fetched,
  tempDirs,
  user,
  userLine,
  writeLog,
} from "./__fixtures__/helpers";
import {
  currentTurnMessages,
  gateEvidence,
  gateEvidenceScoped,
  startsTurnMessage,
} from "./evidence";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const URL_A = "https://acme.example/a";
const URL_B = "https://acme.example/b";

describe("startsTurnMessage", () => {
  test("a human user message starts a turn; an assistant message does not", () => {
    expect(startsTurnMessage(user("hi"))).toBe(true);
    expect(startsTurnMessage(assistant("hello"))).toBe(false);
    expect(startsTurnMessage({ role: "user", content: [] })).toBe(true);
    expect(startsTurnMessage({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe(true);
  });

  test("the tool-result carrier does not start a turn; text beside a result does", () => {
    const carrier = callMessages("toolu_1", "WebFetch", { url: URL_A }, "x")[1] as Message;
    expect(startsTurnMessage(carrier)).toBe(false);
    expect(
      startsTurnMessage({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "x" },
          { type: "text", text: "and now this" },
        ],
      }),
    ).toBe(true);
  });

  test("a synthetic message does not start a turn; a membership test that throws reads as not synthetic", () => {
    const nudge = user("[retry]");
    expect(startsTurnMessage(nudge, (m) => m === nudge)).toBe(false);
    expect(
      startsTurnMessage(nudge, () => {
        throw new Error("boom");
      }),
    ).toBe(true);
  });
});

describe("currentTurnMessages", () => {
  test("from the last real user message on", () => {
    const first = user("one");
    const second = user("two");
    const tail = callMessages("toolu_2", "WebFetch", { url: URL_B }, "b");
    const messages = [
      first,
      ...callMessages("toolu_1", "WebFetch", { url: URL_A }, "a"),
      second,
      ...tail,
    ];
    expect(currentTurnMessages(messages)).toEqual([second, ...tail]);
  });

  test("no real user message at all: every message counts", () => {
    const messages = callMessages("toolu_1", "WebFetch", { url: URL_A }, "a");
    expect(currentTurnMessages(messages)).toEqual(messages);
    expect(currentTurnMessages([])).toEqual([]);
  });
});

describe("gateEvidence", () => {
  test("merges the log and the transcript into one record per call", async () => {
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userLine("q"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, "alpha body")),
    ]);
    const index = await gateEvidence({
      scope: "session",
      sessionId: SESSION,
      sessionRootDir: sessions,
      workspaceRoot: sessions,
      messages: [
        user("q"),
        ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, "alpha body")),
        ...callMessages("toolu_2", "WebFetch", { url: URL_B }, fetched(URL_B, "beta body")),
      ],
    });
    expect(index.all().map((r) => r.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
    expect(index.bySource(URL_A)).toHaveLength(1);
    expect(index.byToolUseId("toolu_2")?.content).toContain("beta body");
  });

  test("the transcript's text replaces the log's summary of block content", async () => {
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userLine("q"),
      ...callLines("toolu_1", "Lookup", { query: "x" }, "[2 text blocks, 40 chars]"),
    ]);
    const index = await gateEvidence({
      scope: "session",
      sessionId: SESSION,
      sessionRootDir: sessions,
      workspaceRoot: sessions,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Lookup", input: { query: "x" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "first block" },
                { type: "text", text: "second block" },
              ],
            },
          ],
        },
      ],
    });
    expect(index.byToolUseId("toolu_1")?.content).toBe("first block\nsecond block");
  });

  test("a child session's calls (sub_agent_start) count for the parent", async () => {
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userLine("research it"),
      { kind: "sub_agent_start", payload: { childSessionId: CHILD } },
    ]);
    await writeLog(sessions, CHILD, [
      userLine("child task"),
      ...callLines("toolu_c", "WebFetch", { url: URL_B }, fetched(URL_B, "child body")),
    ]);
    for (const scope of ["session", "turn"] as const) {
      const index = await gateEvidence({
        scope,
        sessionId: SESSION,
        sessionRootDir: sessions,
        workspaceRoot: sessions,
      });
      expect(index.bySource(URL_B).map((r) => r.toolUseId)).toEqual(["toolu_c"]);
    }
  });

  test("a `tool:<id>` a child shares with the parent is the parent's, whichever was logged first", async () => {
    // An OpenAI-compatible server numbers ids per conversation, so a child
    // and its parent can share one; the child's bracket logged first must
    // not make the child the session the index answers for.
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userLine("research it"),
      { kind: "sub_agent_start", payload: { childSessionId: CHILD } },
      ...callLines("functions.WebFetch:0", "WebFetch", { url: URL_A }, fetched(URL_A, "parent")),
    ]);
    await writeLog(sessions, CHILD, [
      userLine("child task"),
      ...callLines("functions.WebFetch:0", "WebFetch", { url: URL_B }, fetched(URL_B, "child")),
    ]);
    for (const scope of ["session", "turn"] as const) {
      const index = await gateEvidence({
        scope,
        sessionId: SESSION,
        sessionRootDir: sessions,
        workspaceRoot: sessions,
      });
      expect([scope, index.byToolUseId("functions.WebFetch:0")?.sessionId]).toEqual([
        scope,
        SESSION,
      ]);
    }
  });

  test("scope turn: both sources keep only the current turn's calls", async () => {
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userLine("one"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, "a")),
      userLine("[nudge]", true),
      userLine("two"),
      ...callLines("toolu_2", "WebFetch", { url: URL_B }, fetched(URL_B, "b")),
    ]);
    const messages = [
      user("one"),
      ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, "a")),
      user("two"),
      ...callMessages("toolu_2", "WebFetch", { url: URL_B }, fetched(URL_B, "b")),
    ];
    const index = await gateEvidence({
      scope: "turn",
      sessionId: SESSION,
      sessionRootDir: sessions,
      workspaceRoot: sessions,
      messages,
    });
    expect(index.all().map((r) => r.toolUseId)).toEqual(["toolu_2"]);
  });

  test("scoped for the verifier: under scope turn the whole session in call order, the turn kept by turnNumbers (I9)", async () => {
    const sessions = dirs.make();
    await writeLog(sessions, SESSION, [
      userLine("one"),
      ...callLines("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, "a")),
      userLine("two"),
      ...callLines("toolu_2", "WebFetch", { url: URL_B }, fetched(URL_B, "b")),
    ]);
    const messages = [
      user("one"),
      ...callMessages("toolu_1", "WebFetch", { url: URL_A }, fetched(URL_A, "a")),
      user("two"),
      ...callMessages("toolu_2", "WebFetch", { url: URL_B }, fetched(URL_B, "b")),
    ];
    const input = {
      sessionId: SESSION,
      sessionRootDir: sessions,
      workspaceRoot: sessions,
      messages,
    };
    const { index, turnNumbers } = await gateEvidenceScoped({ ...input, scope: "turn" });
    // Every call, in the order the session made them: the self-written trace reads them all.
    expect(index.all().map((r) => r.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
    // What grounds is the turn's, exactly as gateEvidence scopes it.
    expect(turnNumbers).toBeDefined();
    const kept = restrictToTurns(index, turnNumbers ?? new Set());
    expect(kept.all().map((r) => r.toolUseId)).toEqual(
      (await gateEvidence({ ...input, scope: "turn" })).all().map((r) => r.toolUseId),
    );
    expect(kept.bySource(URL_A)).toEqual([]);
    expect(kept.bySource(URL_B).map((r) => r.toolUseId)).toEqual(["toolu_2"]);
    // Under scope session: gateEvidence's index alone, nothing to restrict.
    const session = await gateEvidenceScoped({ ...input, scope: "session" });
    expect(session.turnNumbers).toBeUndefined();
    expect(session.index.all().map((r) => r.toolUseId)).toEqual(["toolu_1", "toolu_2"]);
  });

  test("no session and no transcript: an empty index; a missing log is no throw", async () => {
    expect((await gateEvidence({ scope: "session", workspaceRoot: "/" })).all()).toEqual([]);
    const index = await gateEvidence({
      scope: "session",
      sessionId: SESSION,
      sessionRootDir: join(dirs.make(), "never-made"),
      workspaceRoot: "/",
    });
    expect(index.all()).toEqual([]);
  });
});
