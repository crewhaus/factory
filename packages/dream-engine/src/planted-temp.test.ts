/**
 * 0.7.1 — the dream schedule's state.json and idempotency.json are replaced
 * through a random O_EXCL|O_NOFOLLOW temp. 0.7.0 wrote the fixed `<file>.tmp`
 * through any link planted there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_IDEMPOTENCY_FILENAME,
  DREAM_STATE_FILENAME,
  type DreamState,
  createFileIdempotencyStore,
  writeDreamState,
} from "./state";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function layout(): { dreamDir: string; victim: string } {
  const base = mkdtempSync(join(tmpdir(), "dream-links-"));
  ROOTS.push(base);
  const dreamDir = join(base, "ws", ".crewhaus", "dream", "spec");
  mkdirSync(dreamDir, { recursive: true });
  mkdirSync(join(base, "outside"));
  const victim = join(base, "outside", "victim");
  writeFileSync(victim, "ORIGINAL\n");
  return { dreamDir, victim };
}

const STATE = {
  schemaVersion: 1,
  lastRunAt: "2026-09-29T00:00:00.000Z",
  lastOutcome: "ok",
  phase1Counts: {},
  lastEvidence: [],
} as unknown as DreamState;

describe("dream state writes never go through a planted link (0.7.1)", () => {
  test("state.json ignores a link at state.json.tmp", async () => {
    const { dreamDir, victim } = layout();
    symlinkSync(victim, join(dreamDir, `${DREAM_STATE_FILENAME}.tmp`));
    await writeDreamState(dreamDir, STATE);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(join(dreamDir, DREAM_STATE_FILENAME)).isSymbolicLink()).toBe(false);
  });

  test("a link AT state.json is refused, naming the reason", async () => {
    const { dreamDir, victim } = layout();
    symlinkSync(victim, join(dreamDir, DREAM_STATE_FILENAME));
    await expect(writeDreamState(dreamDir, STATE)).rejects.toThrow(/\(code is-symlink\)/);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
  });

  test("idempotency.json ignores a link at idempotency.json.tmp", async () => {
    const { dreamDir, victim } = layout();
    const path = join(dreamDir, DREAM_IDEMPOTENCY_FILENAME);
    symlinkSync(victim, `${path}.tmp`);
    const store = createFileIdempotencyStore(path);
    await store.put({ key: "k", completedAt: "2026-09-29T00:00:00.000Z" } as never);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect((await store.get("k"))?.key).toBe("k");
  });
});
