import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureGrant } from "@crewhaus/control-contract/knowledge";
import { createMemoryStore } from "@crewhaus/memory-store";
import { eraseShared } from "./erasure";
import {
  type SharedMemory,
  applyPull,
  memoryContentHash,
  planPull,
  pulledMemoryId,
  readRetractions,
  readSharedMemories,
  validateRetraction,
} from "./knowledge-sync";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-erase-shared-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = (): Date => new Date("2026-11-01T00:00:00.000Z");
const shared = (text: string, harness = "support"): SharedMemory => ({
  contentHash: memoryContentHash(text, ["crm"]),
  text,
  tags: ["crm"],
  provenance: { harness, pushedAt: "2026-10-01T00:00:00.000Z" },
  origin: { harness, fact: "mem_0123456789abcdef" },
});
const write = (...memories: readonly SharedMemory[]): void =>
  writeFileSync(
    join(dir, "memories.jsonl"),
    memories.map((m) => `${JSON.stringify(m)}\n`).join(""),
    { mode: 0o600 },
  );
const grantFor = (hashes: readonly string[], root = dir): ErasureGrant => ({
  nonce: "n",
  digest: "d",
  scopes: [{ store: "shared", root, targets: hashes }],
});
const raw = (file: string): string => readFileSync(join(dir, file), "utf8");

// A marker built from parts, so no test file holds it whole.
const MARKER = ["PLANTED", "person", "4411"].join("-");

describe("eraseShared", () => {
  test("removes the line, keeps the others byte for byte, and retracts the copies without the text", async () => {
    const gone = shared(`${MARKER} likes calls after noon`);
    const kept = shared("refunds over 500 need a manager");
    write(kept, gone);
    const keptLine = `${JSON.stringify(kept)}\n`;
    const done = await eraseShared(dir, [gone.contentHash], grantFor([gone.contentHash]), now);
    expect(done).toEqual({ removed: 1, retracted: 1 });
    expect(raw("memories.jsonl")).toBe(keptLine);
    expect(readRetractions(dir)).toEqual([
      {
        contentHash: gone.contentHash,
        harness: "support",
        at: "2026-11-01T00:00:00.000Z",
        reason: "erased",
      },
    ]);
    expect(raw("retractions.jsonl")).not.toContain(MARKER);
  });

  test("a re-run removes and appends nothing", async () => {
    const gone = shared(MARKER);
    write(gone);
    const grant = grantFor([gone.contentHash]);
    await eraseShared(dir, [gone.contentHash], grant, now);
    const before = [raw("memories.jsonl"), raw("retractions.jsonl")];
    expect(await eraseShared(dir, [gone.contentHash], grant, now)).toEqual({
      removed: 0,
      retracted: 0,
    });
    expect([raw("memories.jsonl"), raw("retractions.jsonl")]).toEqual(before);
  });

  test("a crash after the retraction leaves the line for the re-run, which retracts once", async () => {
    const gone = shared(MARKER);
    write(gone);
    writeFileSync(
      join(dir, "retractions.jsonl"),
      JSON.stringify({
        contentHash: gone.contentHash,
        harness: "support",
        at: "2026-11-01T00:00:00.000Z",
        reason: "erased",
      }),
    );
    const done = await eraseShared(dir, [gone.contentHash], grantFor([gone.contentHash]), now);
    expect(done).toEqual({ removed: 1, retracted: 0 });
    expect(readRetractions(dir)).toHaveLength(1);
    expect(raw("memories.jsonl")).toBe("");
  });

  test("a retraction lands on a line of its own whatever the file ended with", async () => {
    const gone = shared(MARKER);
    write(gone);
    writeFileSync(
      join(dir, "retractions.jsonl"),
      JSON.stringify({ contentHash: "a".repeat(64), harness: "x", at: "y", reason: "expired" }),
    );
    await eraseShared(dir, [gone.contentHash], grantFor([gone.contentHash]), now);
    expect(readRetractions(dir).map((r) => r.reason)).toEqual(["expired", "erased"]);
  });

  test("refuses a grant for another store, another root or another hash, and changes nothing", async () => {
    const gone = shared(MARKER);
    write(gone);
    const before = raw("memories.jsonl");
    const other = mkdtempSync(join(tmpdir(), "crewhaus-erase-other-"));
    try {
      const wrongStore: ErasureGrant = {
        nonce: "n",
        digest: "d",
        scopes: [{ store: "memory", root: dir, spec: "bot", targets: [gone.contentHash] }],
      };
      for (const grant of [wrongStore, grantFor([gone.contentHash], other)]) {
        await expect(eraseShared(dir, [gone.contentHash], grant, now)).rejects.toThrow(
          "does not cover the shared store",
        );
      }
      await expect(
        eraseShared(dir, [gone.contentHash], grantFor(["b".repeat(64)]), now),
      ).rejects.toThrow("does not name every shared memory");
      await expect(eraseShared(dir, ["../x"], grantFor(["../x"]), now)).rejects.toThrow(
        "does not name every shared memory",
      );
      expect(raw("memories.jsonl")).toBe(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a link planted at the file is refused, and what it names is untouched", async () => {
    const outside = mkdtempSync(join(tmpdir(), "crewhaus-erase-outside-"));
    try {
      const gone = shared(MARKER);
      writeFileSync(join(outside, "theirs.jsonl"), `${JSON.stringify(gone)}\n`);
      symlinkSync(join(outside, "theirs.jsonl"), join(dir, "memories.jsonl"));
      await expect(
        eraseShared(dir, [gone.contentHash], grantFor([gone.contentHash]), now),
      ).rejects.toThrow("refusing to read the shared memories");
      expect(readFileSync(join(outside, "theirs.jsonl"), "utf8")).toContain(MARKER);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a store with no memories has nothing to erase", async () => {
    expect(await eraseShared(dir, ["a".repeat(64)], grantFor(["a".repeat(64)]), now)).toEqual({
      removed: 0,
      retracted: 0,
    });
  });
});

describe("an erased retraction", () => {
  test("is a retraction, and an unknown reason is still refused", () => {
    const rec = { contentHash: "a".repeat(64), harness: "support", at: "t" };
    expect(validateRetraction({ ...rec, reason: "erased" })).toEqual({
      ok: true,
      retraction: { ...rec, reason: "erased" },
    });
    expect(validateRetraction({ ...rec, reason: "hidden" })).toEqual({
      ok: false,
      reason: "reason is not superseded | expired | erased",
    });
  });

  test("drops the pulled copy at the next pull, and keeps it from coming back", async () => {
    const harness = join(dir, "harness");
    mkdirSync(harness);
    const memory = shared(MARKER);
    write(memory);
    const pull = () =>
      planPull({
        sharedMemories: readSharedMemories(dir),
        sharedFragments: [],
        harnessMemoryHashes: new Set(),
        harnessFragmentHashes: new Set(),
      });
    await applyPull(harness, pull(), now, { specName: "bot" });
    const store = createMemoryStore({
      specName: "bot",
      rootDir: join(harness, ".crewhaus/memories"),
    });
    expect((await store.list()).map((i) => i.status)).toEqual(["live"]);
    await eraseShared(dir, [memory.contentHash], grantFor([memory.contentHash]), now);
    const outcome = await applyPull(harness, pull(), now, {
      specName: "bot",
      retractions: readRetractions(dir),
    });
    expect(outcome).toEqual({ added: [], retracted: [pulledMemoryId(memory.contentHash)] });
    expect((await store.list()).map((i) => i.status)).toEqual(["superseded"]);
  });
});
