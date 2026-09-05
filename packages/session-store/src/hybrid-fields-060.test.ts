/**
 * 0.6.0 (design §7.2.1, §8.1) — the additive `pin` / `models` session fields:
 * written and cleared through `update()`, tolerated (never fatal) on load, and
 * read back through the roster-validating `resolveSessionPin` reader. Also
 * pins that a 0.5.x session file is unaffected: `model` stays a plain string
 * and a file without the new keys round-trips unchanged.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, mergeSessionModels, resolveSessionPin } from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-session-store-060-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const ID = "sess_00000000000000a1";

function writeRaw(rootDir: string, raw: Record<string, unknown>): void {
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, `${ID}.json`), JSON.stringify(raw, null, 2));
}

const legacyFile = {
  id: ID,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  name: "support",
  target: "cli",
  model: "claude-opus-5",
  lastTurnIndex: 3,
};

describe("session-store — pin / models are additive", () => {
  test("create writes neither field; update sets, updates and clears the pin", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const created = await store.create({ name: "n", target: "cli", model: "claude-opus-5" });
    expect("pin" in created).toBe(false);
    expect("models" in created).toBe(false);
    // The on-disk file carries no new keys either — byte-for-byte a 0.5.x file.
    const raw = JSON.parse(readFileSync(join(rootDir, `${created.id}.json`), "utf8"));
    expect(Object.keys(raw).sort()).toEqual([
      "createdAt",
      "id",
      "lastTurnIndex",
      "model",
      "name",
      "target",
      "updatedAt",
    ]);

    const pinned = await store.update(created.id, { pin: "fast" });
    expect(pinned.pin).toBe("fast");
    expect(pinned.model).toBe("claude-opus-5"); // the primary is untouched
    expect((await store.get(created.id))?.pin).toBe("fast");

    const repinned = await store.update(created.id, { pin: "strong", lastTurnIndex: 4 });
    expect(repinned.pin).toBe("strong");
    expect(repinned.lastTurnIndex).toBe(4);

    // `undefined` leaves the pin alone; `null` clears it (`/model auto`).
    const untouched = await store.update(created.id, { lastTurnIndex: 5 });
    expect(untouched.pin).toBe("strong");
    const cleared = await store.update(created.id, { pin: null });
    expect("pin" in cleared).toBe(false);
    const rereadRaw = JSON.parse(readFileSync(join(rootDir, `${created.id}.json`), "utf8"));
    expect("pin" in rereadRaw).toBe(false);
  });

  test("models is written through update and folded with mergeSessionModels", async () => {
    const rootDir = newTempRoot();
    const store = createSessionStore({ rootDir });
    const created = await store.create({ name: "n", target: "cli", model: "claude-opus-5" });
    const first = mergeSessionModels(created.models, "claude-haiku-4-5");
    expect(first).toEqual(["claude-haiku-4-5"]);
    const withStrong = mergeSessionModels(first, "claude-opus-5");
    expect(withStrong).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    // A repeat is a no-op that returns the SAME array so writers can skip the round-trip.
    expect(mergeSessionModels(withStrong, "claude-opus-5")).toBe(withStrong);
    // The input is never mutated.
    expect(first).toEqual(["claude-haiku-4-5"]);

    const updated = await store.update(created.id, { models: withStrong });
    expect(updated.models).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    expect((await store.get(created.id))?.models).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
  });

  test("a 0.5.x session file loads unchanged and round-trips through update byte-identically", async () => {
    const rootDir = newTempRoot();
    writeRaw(rootDir, legacyFile);
    const store = createSessionStore({ rootDir, now: () => new Date(legacyFile.updatedAt) });
    const loaded = await store.get(ID);
    expect(loaded).toEqual(legacyFile);
    const before = readFileSync(join(rootDir, `${ID}.json`), "utf8");
    await store.update(ID, {});
    expect(readFileSync(join(rootDir, `${ID}.json`), "utf8")).toBe(before);
  });

  test("a malformed pin or models on disk is dropped on load, never fatal", async () => {
    const rootDir = newTempRoot();
    writeRaw(rootDir, { ...legacyFile, pin: 42, models: ["claude-opus-5", 7, null, "gpt-4o"] });
    const store = createSessionStore({ rootDir });
    const loaded = await store.get(ID);
    expect(loaded).not.toBeNull();
    expect("pin" in (loaded as object)).toBe(false);
    expect(loaded?.models).toEqual(["claude-opus-5", "gpt-4o"]);

    writeRaw(rootDir, { ...legacyFile, models: "claude-opus-5" });
    const notArray = await store.get(ID);
    expect("models" in (notArray as object)).toBe(false);
    // And a `list()` over such a file still returns it.
    expect((await store.list()).map((s) => s.id)).toEqual([ID]);
  });
});

describe("resolveSessionPin — the on-disk pin is untrusted", () => {
  const roster = ["fast", "strong", "anthropic/claude-opus-5"];

  test("absent ⇒ auto with no reason; a roster member is honoured", () => {
    expect(resolveSessionPin({}, roster)).toEqual({ pin: undefined });
    expect(resolveSessionPin({ pin: "strong" }, roster)).toEqual({ pin: "strong" });
    expect(resolveSessionPin({ pin: "anthropic/claude-opus-5" }, roster).pin).toBe(
      "anthropic/claude-opus-5",
    );
  });

  test("an arm outside the roster falls back to auto with a recorded reason", () => {
    const r = resolveSessionPin({ pin: "gpt-4o" }, roster);
    expect(r.pin).toBeUndefined();
    expect(r.reason).toBe('session pin "gpt-4o" is not in the roster — falling back to auto');
  });

  test("a non-string or empty pin (a hand-edited file) falls back to auto", () => {
    expect(resolveSessionPin({ pin: 3 as unknown as string }, roster)).toEqual({
      pin: undefined,
      reason: "session pin is not a string — falling back to auto",
    });
    expect(resolveSessionPin({ pin: "" }, roster).pin).toBeUndefined();
  });

  test("an empty roster honours no pin", () => {
    expect(resolveSessionPin({ pin: "fast" }, []).pin).toBeUndefined();
  });
});
