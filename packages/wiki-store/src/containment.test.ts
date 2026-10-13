/**
 * security-2#0: every file the wiki store writes went through
 * `writeFile(`${absPath}.tmp`)` + rename, following links. A symlink planted
 * at `articles/<slug>.md.tmp` or the fixed `index.json.tmp` — dangling or
 * not — created or truncated a file anywhere the process could write, and a
 * symlinked `versions/<slug>` directory took the snapshot out of the store.
 * Reads followed links too. These cases each failed before the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { ARTICLE_MAX_BYTES, WikiLockError, WikiStoreError, createWikiStore } from "./index";

let tmp: string;
let outside: string;
let store: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wiki-contain-"));
  outside = join(tmp, "outside");
  store = join(tmp, "root", "spec");
  mkdirSync(outside);
  mkdirSync(join(store, "articles"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeStore(rootDir = join(tmp, "root")) {
  return createWikiStore({ specName: "spec", rootDir });
}

describe("the store writes nothing through a planted link", () => {
  test("a dangling link at the article's old temp name creates nothing outside", async () => {
    symlinkSync(join(outside, "planted.sh"), join(store, "articles", "notes.md.tmp"));
    const wiki = makeStore();
    await wiki.write({ slug: "notes", title: "N", body: "payload" });
    expect(existsSync(join(outside, "planted.sh"))).toBe(false);
    expect(lstatSync(join(store, "articles", "notes.md")).isFile()).toBe(true);
    expect((await wiki.get("notes"))?.body).toBe("payload");
  });

  test("a link at index.json's old temp name leaves the file it points at untouched", async () => {
    const victim = join(outside, "rc");
    writeFileSync(victim, "ORIGINAL");
    symlinkSync(victim, join(store, "index.json.tmp"));
    await makeStore().write({ slug: "any", title: "A", body: "b" });
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
    expect(lstatSync(join(store, "index.json")).isFile()).toBe(true);
  });

  test("a link at a version snapshot's old temp name creates nothing outside", async () => {
    const wiki = makeStore();
    await wiki.write({ slug: "doc", title: "D", body: "v1 body" });
    mkdirSync(join(store, "versions", "doc"), { recursive: true });
    symlinkSync(join(outside, "ver"), join(store, "versions", "doc", "1.md.tmp"));
    await wiki.write({ slug: "doc", title: "D", body: "v2 body", expectedVersion: 1 });
    expect(existsSync(join(outside, "ver"))).toBe(false);
    expect(readFileSync(join(store, "versions", "doc", "1.md"), "utf8")).toContain("v1 body");
  });

  test("a versions/<slug> directory linked out of the store is refused, and the article stays", async () => {
    const wiki = makeStore();
    await wiki.write({ slug: "notes", title: "N", body: "v1 body" });
    mkdirSync(join(outside, "d"));
    mkdirSync(join(store, "versions"), { recursive: true });
    symlinkSync(join(outside, "d"), join(store, "versions", "notes"));
    const err = await wiki
      .write({ slug: "notes", title: "N", body: "v2 body", expectedVersion: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikiStoreError);
    expect((err as Error).message).toContain("refusing to write versions/notes/1.md");
    expect((err as Error).message).toContain("resolves outside the wiki store");
    expect(readdirSync(join(outside, "d"))).toEqual([]);
    expect((await wiki.get("notes"))?.version).toBe(1);
  });

  test("a symlinked article is neither read through nor written through", async () => {
    const target = join(outside, "b");
    writeFileSync(
      target,
      "---\nslug: b\ntitle: stolen\ntags: []\nconfidence: 0.5\nverified: false\nversion: 1\nsources: []\nstatus: published\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\nSECRET\n",
    );
    symlinkSync(target, join(store, "articles", "b.md"));
    const wiki = makeStore();
    const read = await wiki.get("b").catch((e: unknown) => e);
    expect(read).toBeInstanceOf(WikiStoreError);
    expect((read as Error).message).toContain("refusing to read articles/b.md");
    expect((read as Error).message).not.toContain("SECRET");
    const write = await wiki.write({ slug: "b", title: "B", body: "x" }).catch((e: unknown) => e);
    expect(write).toBeInstanceOf(WikiStoreError);
    expect(readFileSync(target, "utf8")).toContain("SECRET");
    // And the rest of the wiki is not blocked by it.
    await wiki.write({ slug: "c", title: "C", body: "fine" });
    expect((await wiki.list()).map((r) => r.slug)).toEqual(["c"]);
  });

  test("a symlink planted AS index.json is replaced by the rebuilt index, never written through", async () => {
    const victim = join(outside, "idx");
    writeFileSync(victim, "ORIGINAL");
    symlinkSync(victim, join(store, "index.json"));
    const wiki = makeStore();
    await wiki.write({ slug: "a", title: "A", body: "b" });
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
    expect(lstatSync(join(store, "index.json")).isFile()).toBe(true);
    expect((await wiki.list()).map((r) => r.slug)).toEqual(["a"]);
  });

  test("an operator's symlinked wiki root keeps working", async () => {
    const real = join(tmp, "elsewhere");
    mkdirSync(real);
    const linkedRoot = join(tmp, "linked-root");
    symlinkSync(real, linkedRoot);
    const wiki = makeStore(linkedRoot);
    await wiki.write({ slug: "notes", title: "N", body: "hello" });
    expect(lstatSync(join(real, "spec", "articles", "notes.md")).isFile()).toBe(true);
    expect((await wiki.get("notes"))?.body).toBe("hello");
  });

  test("an articles/ directory linked out of the store is refused by every operation, naming the store", async () => {
    const wiki0 = makeStore();
    await wiki0.write({ slug: "alpha", title: "Alpha", body: "widgets are blue" });
    // Move the articles out and link them back in, as a store written by
    // 0.7.0 with articles/ linked to a tracked folder would look.
    rmSync(join(store, "articles"), { recursive: true, force: true });
    mkdirSync(join(outside, "docs"));
    writeFileSync(
      join(outside, "docs", "alpha.md"),
      "---\nslug: alpha\ntitle: Alpha\nversion: 1\n---\nwidgets are blue\n",
    );
    symlinkSync(join(outside, "docs"), join(store, "articles"));
    const wiki = makeStore();
    const outcomes: Record<string, string> = {};
    for (const [name, op] of Object.entries({
      list: () => wiki.list(),
      search: () => wiki.search("widgets"),
      recall: () => wiki.recall("widgets"),
      stats: () => wiki.stats(),
      get: () => wiki.get("alpha"),
      write: () => wiki.write({ slug: "beta", title: "B", body: "x" }),
    })) {
      const err = await (op as () => Promise<unknown>)().catch((e: unknown) => e);
      outcomes[name] = err instanceof WikiStoreError ? err.message : "did not refuse";
    }
    for (const [name, message] of Object.entries(outcomes)) {
      expect(`${name}: ${message.includes("resolves outside the wiki store")}`).toBe(
        `${name}: true`,
      );
      expect(message).not.toContain("workspace");
      expect(message).toContain("link the store's own directory instead");
    }
    expect(readdirSync(join(outside, "docs"))).toEqual(["alpha.md"]);
  });

  test("an articles/ directory linked to a directory inside the store keeps working", async () => {
    rmSync(join(store, "articles"), { recursive: true, force: true });
    // A name that starts with two dots is still inside.
    mkdirSync(join(store, "..kept"));
    symlinkSync(join(store, "..kept"), join(store, "articles"));
    const wiki = makeStore();
    await wiki.write({ slug: "notes", title: "N", body: "hello" });
    expect(lstatSync(join(store, "..kept", "notes.md")).isFile()).toBe(true);
    expect((await wiki.list()).map((r) => r.slug)).toEqual(["notes"]);
    expect((await wiki.get("notes"))?.body).toBe("hello");
  });

  test("stats() does not count version files through a linked versions/<slug> directory", async () => {
    const wiki = makeStore();
    await wiki.write({ slug: "a", title: "A", body: "b" });
    mkdirSync(join(outside, "v"));
    writeFileSync(join(outside, "v", "1.md"), "x");
    writeFileSync(join(outside, "v", "2.md"), "x");
    mkdirSync(join(store, "versions"), { recursive: true });
    symlinkSync(join(outside, "v"), join(store, "versions", "linked"));
    expect((await wiki.stats()).priorVersions).toBe(0);
  });

  test("an article larger than the read cap is refused at write, not written and then unreadable", async () => {
    const wiki = makeStore();
    const err = await wiki
      .write({ slug: "huge", title: "H", body: "x".repeat(ARTICLE_MAX_BYTES + 1) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WikiStoreError);
    expect((err as Error).message).toContain("larger than");
    expect(existsSync(join(store, "articles", "huge.md"))).toBe(false);
  });
});

// C070 residual (attacker review): the write path takes <store>/.lock, and
// on contention the lock policy followed a link there and opened a FIFO
// there, so a FIFO planted at .lock made every wiki_write hang for ever.
describe.skipIf(process.platform === "win32")("the store's .lock leaf", () => {
  test("a FIFO planted at .lock is refused at once, naming the store's lock", async () => {
    const s = makeStore();
    await s.write({ slug: "coffee", title: "Coffee", body: "grind size" });
    execFileSync("mkfifo", [join(store, ".lock")]);
    const err = await s.write({ slug: "tea", title: "Tea", body: "steep" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(WikiLockError);
    expect(err?.message).toContain(`wiki-store: ${join(store, ".lock")} is a FIFO`);
    expect(existsSync(join(store, "articles", "tea.md"))).toBe(false);
  });

  test("a link planted at .lock is neither followed nor removed", async () => {
    const s = makeStore();
    await s.write({ slug: "coffee", title: "Coffee", body: "grind size" });
    writeFileSync(join(outside, "victim"), "keep");
    symlinkSync(join(outside, "victim"), join(store, ".lock"));
    await expect(s.setSignals("coffee", { verified: true })).rejects.toThrow(
      /is a symbolic link, not a lock file/,
    );
    expect(lstatSync(join(store, ".lock")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe("keep");
  });
});
