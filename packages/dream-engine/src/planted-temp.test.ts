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
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDreamEngine } from "./index";
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

/**
 * 0.7.1 — the writes are rooted at `.crewhaus`, not at the lazily created
 * `dream/` or `dream/<spec>/` directory. Rooted at its own directory, a write
 * followed a link planted there as the root, and state.json, idempotency.json
 * and the run lock landed wherever the link pointed.
 */
function dirLinkLayout(link: "dream" | "spec"): { crewhaus: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "dream-dirlinks-"));
  ROOTS.push(base);
  const crewhaus = join(base, "ws", ".crewhaus");
  const outside = join(base, "outside");
  mkdirSync(crewhaus, { recursive: true });
  mkdirSync(join(outside, "spec"), { recursive: true });
  if (link === "dream") symlinkSync(outside, join(crewhaus, "dream"));
  else {
    mkdirSync(join(crewhaus, "dream"));
    symlinkSync(join(outside, "spec"), join(crewhaus, "dream", "spec"));
  }
  return { crewhaus, outside };
}

const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }) as string[];

describe("a directory link planted in .crewhaus/dream is refused (0.7.1)", () => {
  for (const link of ["dream", "spec"] as const) {
    test(`state.json, with the link at ${link === "dream" ? ".crewhaus/dream" : ".crewhaus/dream/<spec>"}`, async () => {
      const { crewhaus, outside } = dirLinkLayout(link);
      await expect(writeDreamState(join(crewhaus, "dream", "spec"), STATE)).rejects.toThrow(
        /\(code escapes-root\)/,
      );
      expect(listing(outside)).toEqual(["spec"]);
    });

    test(`idempotency.json and its lock, with the link at ${link === "dream" ? ".crewhaus/dream" : ".crewhaus/dream/<spec>"}`, async () => {
      const { crewhaus, outside } = dirLinkLayout(link);
      const store = createFileIdempotencyStore(
        join(crewhaus, "dream", "spec", DREAM_IDEMPOTENCY_FILENAME),
      );
      await expect(
        store.put({ key: "k", completedAt: "2026-09-29T00:00:00.000Z" } as never),
      ).rejects.toThrow(/\(code escapes-root\)/);
      expect(listing(outside)).toEqual(["spec"]);
    });
  }

  test("a dream run refuses before its run lock is taken, and writes nothing outside", async () => {
    const { crewhaus, outside } = dirLinkLayout("dream");
    const engine = createDreamEngine({
      specName: "spec",
      crewhausDir: crewhaus,
      dream: { everyMs: 86_400_000, mode: "deterministic" },
    });
    await expect(engine.run()).rejects.toThrow(/refusing to use .*\(code escapes-root\)/);
    expect(listing(outside)).toEqual(["spec"]);
  });

  test("control: an ordinary run writes its state under .crewhaus/dream/<spec>", async () => {
    const base = mkdtempSync(join(tmpdir(), "dream-dirlinks-"));
    ROOTS.push(base);
    const crewhaus = join(base, ".crewhaus");
    const engine = createDreamEngine({
      specName: "spec",
      crewhausDir: crewhaus,
      dream: { everyMs: 86_400_000, mode: "deterministic" },
    });
    await engine.run();
    expect(lstatSync(join(crewhaus, "dream", "spec", DREAM_STATE_FILENAME)).isFile()).toBe(true);
  });
});
