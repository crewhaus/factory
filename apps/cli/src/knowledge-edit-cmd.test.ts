/**
 * The knowledge-editing verbs, against temp harness directories with an
 * injected clock and confirm: each verb's happy path, and every refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { type ParsedArgs, parseArgs } from "@crewhaus/infra-utils";
import { createMemoryStore } from "@crewhaus/memory-store";
import { createWikiStore } from "@crewhaus/wiki-store";
import * as SCHEMAS from "./arg-schemas";
import {
  KnowledgeEditError,
  type KnowledgeEditIo,
  lessonId,
  readRetiredLessons,
  recordLessonProvenance,
  runLessonsRetire,
  runMemoryCorrect,
  runMemoryMark,
  runStateClear,
  runStateRestoreTrash,
  runStateTrash,
  runWikiArchive,
  runWikiRollback,
  runWikiWrite,
} from "./knowledge-edit-cmd";
import { type Lesson, mergeLessons, parseLessonsMd, renderLessonsMd } from "./lessons";

let cwd: string;
let out: string[];
let asked: string[];
let answer: boolean;
const NOW = new Date("2026-11-11T12:00:00.000Z");

function io(): KnowledgeEditIo {
  return {
    cwd,
    stdout: (line) => out.push(line),
    now: () => NOW,
    confirm: async (prompt) => {
      asked.push(prompt);
      return answer;
    },
  };
}

const memArgs = (argv: string[]): ParsedArgs => parseArgs(argv, SCHEMAS.MEMORY_SCHEMA);
const wikiArgs = (argv: string[]): ParsedArgs => parseArgs(argv, SCHEMAS.WIKI_SCHEMA);
const stateArgs = (argv: string[]): ParsedArgs => parseArgs(argv, SCHEMAS.STATE_SCHEMA);
const lessonArgs = (argv: string[]): ParsedArgs => parseArgs(argv, SCHEMAS.LESSONS_SCHEMA);

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "crewhaus-knowledge-edit-"));
  out = [];
  asked = [];
  answer = true;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function memory() {
  return createMemoryStore({ specName: "bot", rootDir: join(cwd, ".crewhaus", "memories") });
}

describe("memory correct", () => {
  test("asks, then replaces the fact and keeps the old one superseded", async () => {
    const old = await memory().remember("the office is on floor 3", ["office"]);
    const code = await runMemoryCorrect(
      memArgs(["correct", old.id, "--text", "the office is on floor 4", "--reason", "moved"]),
      io(),
    );
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(out.join("\n")).toContain("old: the office is on floor 3");
    expect(out.join("\n")).toContain("new: the office is on floor 4");
    const items = await memory().list();
    expect(items.find((i) => i.entry.id === old.id)?.status).toBe("superseded");
    const live = items.find((i) => i.status === "live");
    expect(live?.entry.text).toBe("the office is on floor 4");
    expect(live?.entry.provenance?.author).toEqual({ kind: "operator", via: "cli" });
  });

  test("--text-file reads the new text; a declined confirm changes nothing", async () => {
    const old = await memory().remember("x");
    writeFileSync(join(cwd, "fix.txt"), "y\n");
    answer = false;
    await runMemoryCorrect(
      memArgs(["correct", old.id, "--text-file", "fix.txt", "--reason", "r"]),
      io(),
    );
    expect(out.at(-1)).toBe("[memory] nothing changed");
    expect(await memory().size()).toBe(1);
    answer = true;
    await runMemoryCorrect(
      memArgs(["correct", old.id, "--text-file", "fix.txt", "--reason", "r", "--yes"]),
      io(),
    );
    expect((await memory().list()).find((i) => i.status === "live")?.entry.text).toBe("y");
  });

  test("refusals: a non-live id, a missing reason, both text flags, neither, a bad id", async () => {
    const old = await memory().remember("x");
    await memory().forget(old.id);
    await expect(
      runMemoryCorrect(memArgs(["correct", old.id, "--text", "y", "--reason", "r", "--yes"]), io()),
    ).rejects.toThrow(`${old.id} is superseded`);
    const live = await memory().remember("z");
    await expect(
      runMemoryCorrect(memArgs(["correct", live.id, "--text", "y"]), io()),
    ).rejects.toThrow("--reason");
    await expect(
      runMemoryCorrect(
        memArgs(["correct", live.id, "--text", "y", "--text-file", "f", "--reason", "r"]),
        io(),
      ),
    ).rejects.toThrow("exactly one of --text or --text-file");
    await expect(
      runMemoryCorrect(memArgs(["correct", live.id, "--reason", "r"]), io()),
    ).rejects.toThrow("exactly one of --text or --text-file");
    await expect(
      runMemoryCorrect(memArgs(["correct", "fact-1", "--text", "y", "--reason", "r"]), io()),
    ).rejects.toBeInstanceOf(KnowledgeEditError);
    await expect(
      runMemoryCorrect(
        memArgs(["correct", "mem_0000000000000000", "--text", "y", "--reason", "r"]),
        io(),
      ),
    ).rejects.toThrow("no fact mem_0000000000000000");
  });
});

describe("memory mark", () => {
  test("marks and unmarks; refuses both flags and an unknown id", async () => {
    const e = await memory().remember("Dana's birthday is in June");
    await runMemoryMark(memArgs(["mark", e.id, "--personal"]), io());
    expect((await memory().list())[0]?.category).toBe("person");
    await runMemoryMark(memArgs(["mark", e.id, "--not-personal"]), io());
    expect((await memory().list())[0]?.category).toBeUndefined();
    await expect(
      runMemoryMark(memArgs(["mark", e.id, "--personal", "--not-personal"]), io()),
    ).rejects.toThrow("exactly one of --personal or --not-personal");
    await expect(
      runMemoryMark(memArgs(["mark", "mem_0000000000000000", "--personal"]), io()),
    ).rejects.toThrow("no fact");
  });
});

describe("wiki write, archive and rollback", () => {
  const wiki = () => createWikiStore({ specName: "bot", rootDir: join(cwd, ".crewhaus", "wiki") });

  test("--expect 0 creates, named by crewhaus.yaml; a person's version carries author", async () => {
    writeFileSync(join(cwd, "crewhaus.yaml"), "name: bot\n");
    writeFileSync(join(cwd, "faq.md"), "Refunds take 30 days.\n");
    expect(
      await runWikiWrite(
        wikiArgs(["write", "faq", "--body-file", "faq.md", "--expect", "0", "--title", "FAQ"]),
        io(),
      ),
    ).toBe(0);
    const a = await wiki().get("faq");
    expect(a?.version).toBe(1);
    expect(a?.author).toEqual({ kind: "operator", via: "cli" });
    writeFileSync(join(cwd, "faq.md"), "Refunds take 14 days.\n");
    expect(
      await runWikiWrite(
        wikiArgs(["write", "faq", "--body-file", "faq.md", "--expect", "1"]),
        io(),
      ),
    ).toBe(0);
    expect((await wiki().get("faq"))?.title).toBe("FAQ");
    expect((await wiki().get("faq"))?.version).toBe(2);
  });

  test("a stale --expect prints the current version and exits 1; a create needs a title", async () => {
    await wiki().write({ slug: "faq", title: "FAQ", body: "v1" });
    await wiki().write({ slug: "faq", title: "FAQ", body: "v2", expectedVersion: 1 });
    writeFileSync(join(cwd, "faq.md"), "mine\n");
    expect(
      await runWikiWrite(
        wikiArgs(["write", "faq", "--body-file", "faq.md", "--expect", "1"]),
        io(),
      ),
    ).toBe(1);
    expect(out.join("\n")).toContain('"faq" is at version 2, not 1');
    expect(out.join("\n")).toContain("--expect 2");
    expect((await wiki().get("faq"))?.body).toBe("v2");
    await expect(
      runWikiWrite(wikiArgs(["write", "new", "--body-file", "faq.md", "--expect", "0"]), io()),
    ).rejects.toThrow("--title");
    await expect(
      runWikiWrite(wikiArgs(["write", "faq", "--body-file", "faq.md"]), io()),
    ).rejects.toThrow("--expect");
  });

  test("archive and --undo change the status only; a stale version exits 1", async () => {
    await wiki().write({ slug: "faq", title: "FAQ", body: "keep these bytes" });
    expect(await runWikiArchive(wikiArgs(["archive", "faq", "--expect", "1"]), io())).toBe(0);
    expect((await wiki().get("faq"))?.status).toBe("archived");
    expect((await wiki().get("faq"))?.body).toBe("keep these bytes");
    expect((await wiki().get("faq"))?.version).toBe(1);
    expect(
      await runWikiArchive(wikiArgs(["archive", "faq", "--expect", "1", "--undo"]), io()),
    ).toBe(0);
    expect((await wiki().get("faq"))?.status).toBe("published");
    expect(await runWikiArchive(wikiArgs(["archive", "faq", "--expect", "4"]), io())).toBe(1);
  });

  test("rollback writes a new version with an older text; refusals name what is there", async () => {
    await wiki().write({ slug: "faq", title: "FAQ one", body: "first", tags: ["t"] });
    await wiki().write({ slug: "faq", title: "FAQ two", body: "second", expectedVersion: 1 });
    expect(
      await runWikiRollback(wikiArgs(["rollback", "faq", "--to", "1", "--expect", "2"]), io()),
    ).toBe(0);
    const now = await wiki().get("faq");
    expect([now?.version, now?.title, now?.body, now?.tags]).toEqual([
      3,
      "FAQ one",
      "first",
      ["t"],
    ]);
    expect(now?.author).toEqual({ kind: "operator", via: "cli" });
    await expect(
      runWikiRollback(wikiArgs(["rollback", "faq", "--to", "9", "--expect", "3"]), io()),
    ).rejects.toThrow('"faq" has no v9');
    await expect(
      runWikiRollback(wikiArgs(["rollback", "faq", "--to", "3", "--expect", "3"]), io()),
    ).rejects.toThrow("already at v3");
    expect(
      await runWikiRollback(wikiArgs(["rollback", "faq", "--to", "1", "--expect", "2"]), io()),
    ).toBe(1);
  });
});

describe("state clear, trash and restore --trash", () => {
  const store = () =>
    createContinuityStore({ specName: "bot", rootDir: join(cwd, ".crewhaus", "state") });

  test("without --yes it lists, prints the command, and moves nothing", async () => {
    await store().writeFocus("ship it");
    await store().createPlan({ title: "p", steps: ["a"] });
    expect(await runStateClear(stateArgs(["clear", "--scope", "all"]), io())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(".crewhaus/state/bot/focus.md");
    expect(text).toContain("They stay in the trash until 2026-11-18");
    expect(text).toMatch(/crewhaus state clear --scope all --spec bot --yes --expect [0-9a-f]{64}/);
    expect(existsSync(join(cwd, ".crewhaus", "state", "bot", "focus.md"))).toBe(true);
    expect(existsSync(join(cwd, ".crewhaus", "trash"))).toBe(false);
  });

  test("--yes with the printed fingerprint clears; a stale one moves nothing and exits 1", async () => {
    await store().writeFocus("ship it");
    await runStateClear(stateArgs(["clear", "--scope", "focus"]), io());
    const fp = /--expect ([0-9a-f]{64})/.exec(out.join("\n"))?.[1] as string;
    await store().writeFocus("changed since the listing");
    out = [];
    expect(
      await runStateClear(stateArgs(["clear", "--scope", "focus", "--yes", "--expect", fp]), io()),
    ).toBe(1);
    expect(out.join("\n")).toContain("Nothing was moved");
    expect(existsSync(join(cwd, ".crewhaus", "state", "bot", "focus.md"))).toBe(true);
    out = [];
    expect(await runStateClear(stateArgs(["clear", "--scope", "focus", "--yes"]), io())).toBe(0);
    expect(existsSync(join(cwd, ".crewhaus", "state", "bot", "focus.md"))).toBe(false);
    const stamp = /--trash (\S+)/.exec(out.join("\n"))?.[1] as string;

    out = [];
    await runStateTrash(stateArgs(["trash"]), io());
    expect(out[0]).toContain(stamp);
    await runStateRestoreTrash(stateArgs(["restore", "--trash", stamp]), io());
    expect(readFileSync(join(cwd, ".crewhaus", "state", "bot", "focus.md"), "utf8")).toContain(
      "changed since the listing",
    );
  });

  test("refusals: a bad scope, no working memory, a bad session, a bad stamp; an empty trash says why", async () => {
    await expect(runStateClear(stateArgs(["clear", "--scope", "kv"]), io())).rejects.toThrow(
      "--scope must be one of",
    );
    await expect(runStateClear(stateArgs(["clear", "--scope", "all"]), io())).rejects.toThrow(
      "no working memory",
    );
    await store().writeFocus("x");
    await expect(
      runStateClear(stateArgs(["clear", "--scope", "all", "--session", "s1"]), io()),
    ).rejects.toThrow("not a session id");
    await runStateTrash(stateArgs(["trash"]), io());
    expect(out.at(-1)).toContain("the trash is empty");
    await expect(
      runStateRestoreTrash(stateArgs(["restore", "--trash", "yesterday"]), io()),
    ).rejects.toThrow("invalid trash timestamp");
  });
});

describe("lessons retire and update provenance", () => {
  const lessons: Lesson[] = [
    { key: "avoid — x", text: "avoid — X", kind: "correction" },
    { key: "watch out: y.", text: "Watch out: Y.", kind: "failure-fix" },
  ];

  test("retire removes the lesson, keeps a record, and update never re-adds it", async () => {
    writeFileSync(join(cwd, "LESSONS.md"), renderLessonsMd(lessons, "# My notes"));
    const id = lessonId(lessons[0] as Lesson);
    expect(id).toMatch(/^l[0-9a-f]{16}$/);
    await runLessonsRetire(lessonArgs(["retire", id, "--reason", "it was wrong"]), io());
    const after = parseLessonsMd(readFileSync(join(cwd, "LESSONS.md"), "utf8"));
    expect(after.preamble).toBe("# My notes");
    expect(after.lessons.map((l) => l.text)).toEqual(["Watch out: Y."]);
    const record = JSON.parse(
      readFileSync(join(cwd, ".crewhaus", "lessons", "retired.jsonl"), "utf8").trim(),
    );
    expect(record).toEqual({ v: 1, at: NOW.toISOString(), lesson: id, reason: "it was wrong" });
    // What `lessons update` does with the retired set: the lesson does not come back.
    const retired = readRetiredLessons(cwd);
    const fresh = lessons.filter((l) => !retired.has(lessonId(l)));
    expect(mergeLessons(after.lessons, fresh).map((l) => l.text)).toEqual(["Watch out: Y."]);
  });

  test("an unknown lesson id is refused, listing the ids there are", async () => {
    writeFileSync(join(cwd, "LESSONS.md"), renderLessonsMd(lessons));
    const err = await runLessonsRetire(lessonArgs(["retire", "l0000000000000000"]), io()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(KnowledgeEditError);
    expect((err as Error).message).toContain("no lesson l0000000000000000");
    expect((err as Error).message).toContain(lessonId(lessons[1] as Lesson));
    await expect(runLessonsRetire(lessonArgs(["retire", "lesson-1"]), io())).rejects.toThrow(
      "not a lesson id",
    );
  });

  test("provenance records the sessions and turns of each new lesson, ids only", () => {
    recordLessonProvenance(
      cwd,
      [
        {
          ...(lessons[0] as Lesson),
          sources: {
            sessions: ["sess_00000000000000a1"],
            turns: [{ sessionId: "sess_00000000000000a1", turnNumber: 2 }],
          },
        },
        { ...(lessons[1] as Lesson), sources: { sessions: ["sess_00000000000000b2"] } },
      ],
      () => NOW,
    );
    const lines = readFileSync(join(cwd, ".crewhaus", "lessons", "provenance.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        v: 1,
        at: NOW.toISOString(),
        lesson: lessonId(lessons[0] as Lesson),
        kind: "correction",
        sessions: ["sess_00000000000000a1"],
        turns: [{ sessionId: "sess_00000000000000a1", turnNumber: 2 }],
      },
      {
        v: 1,
        at: NOW.toISOString(),
        lesson: lessonId(lessons[1] as Lesson),
        kind: "failure-fix",
        sessions: ["sess_00000000000000b2"],
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("avoid");
  });
});
