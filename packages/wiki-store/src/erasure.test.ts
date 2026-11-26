import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureGrant } from "@crewhaus/control-contract/knowledge";
import { erase, eraseVersions, versionsWrittenIn } from "./erasure";
import { createWikiStore } from "./index";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wiki-erasure-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SPEC = "bot";
const A = "sess_00000000000000aa";
const B = "sess_00000000000000bb";
const MARKER = ["PLANTED", "person", "4411"].join("-");
const store = () => createWikiStore({ specName: SPEC, rootDir: root });
const at = () => ({ rootDir: root, specName: SPEC });
const grantFor = (
  targets: readonly string[],
  over: Partial<ErasureGrant["scopes"][number]> = {},
): ErasureGrant => ({
  nonce: "n",
  digest: "d",
  scopes: [{ store: "wiki", root, spec: SPEC, targets, ...over }],
});
const path = (...parts: string[]): string => join(root, SPEC, ...parts);

function bytes(dir = root): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const p = join(dir, entry.name);
      return entry.isDirectory() ? bytes(p) : `${p}\n${readFileSync(p, "utf8")}`;
    })
    .join("\n");
}
function snapshot(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    const stats = lstatSync(p);
    return [`${p} ${stats.size} ${stats.mtimeMs}`, ...(entry.isDirectory() ? snapshot(p) : [])];
  });
}

/** An article's versions, one per (body, session) in order. */
async function article(slug: string, versions: readonly (readonly [string, string?])[]) {
  const s = store();
  for (const [i, [body, sessionId]] of versions.entries()) {
    await s.write({
      slug,
      title: `About ${slug}`,
      body,
      ...(i > 0 ? { expectedVersion: i } : {}),
      ...(sessionId !== undefined
        ? { createdBy: { sessionId } }
        : { author: { kind: "operator" as const } }),
    });
  }
}

describe("erase", () => {
  test("removes the article, its versions and its index entry, and nothing else", async () => {
    await article("jane", [
      [`${MARKER} one`, A],
      [`${MARKER} two`, B],
    ]);
    await article("billing", [["refunds", A]]);
    expect(await erase(at(), "jane", grantFor(["jane"]))).toEqual({
      articles: 1,
      versions: 2,
      rolledBack: 0,
    });
    expect(bytes()).not.toContain(MARKER);
    expect(bytes()).not.toContain("jane");
    expect(existsSync(path("versions", "jane"))).toBe(false);
    expect((await store().list()).map((ref) => ref.slug)).toEqual(["billing"]);
    expect(Object.keys(JSON.parse(readFileSync(path("index.json"), "utf8")).articles)).toEqual([
      "billing",
    ]);
  });

  test("a re-run, and an article that is not there, change nothing", async () => {
    await article("jane", [[MARKER, A]]);
    const grant = grantFor(["jane", "absent"]);
    await erase(at(), "jane", grant);
    const before = snapshot();
    for (const slug of ["jane", "absent"]) {
      expect(await erase(at(), slug, grant)).toEqual({ articles: 0, versions: 0, rolledBack: 0 });
    }
    expect(snapshot()).toEqual(before);
    const none = join(root, "elsewhere");
    expect(
      await erase({ rootDir: none, specName: SPEC }, "jane", grantFor(["jane"], { root })).catch(
        (err: Error) => err.message,
      ),
    ).toContain("does not cover");
  });

  test("an index entry left behind without its article goes too", async () => {
    await article("jane", [[MARKER, A]]);
    rmSync(path("articles", "jane.md"));
    await erase(at(), "jane", grantFor(["jane"]));
    expect(readFileSync(path("index.json"), "utf8")).not.toContain("jane");
  });
});

describe("eraseVersions", () => {
  test("rolls an article back to its newest remaining version", async () => {
    await article("notes", [
      ["v1 stays", B],
      [`v2 ${MARKER}`, A],
      ["v3 stays", B],
      [`v4 ${MARKER}`, A],
    ]);
    expect(versionsWrittenIn(at(), [A])).toEqual([
      { slug: "notes", version: 4, current: true },
      { slug: "notes", version: 2, current: false },
    ]);
    expect(await eraseVersions(at(), { sessions: [A] }, grantFor([A]))).toEqual({
      articles: 0,
      versions: 2,
      rolledBack: 1,
    });
    const now = await store().get("notes");
    expect([now?.version, now?.body]).toEqual([3, "v3 stays"]);
    expect(readdirSync(path("versions", "notes"))).toEqual(["1.md"]);
    expect(bytes()).not.toContain(MARKER);
    const [ref] = await store().list();
    expect([ref?.slug, ref?.version]).toEqual(["notes", 3]);
    // The next edit carries on from there.
    const written = await store().write({
      slug: "notes",
      title: "Notes",
      body: "v4 again",
      expectedVersion: 3,
    });
    expect(written.version).toBe(4);
  });

  test("an article every version of which goes is removed, with its directory", async () => {
    await article("jane", [
      [`${MARKER} one`, A],
      [`${MARKER} two`, A],
    ]);
    expect(await eraseVersions(at(), { sessions: [A] }, grantFor([A]))).toEqual({
      articles: 1,
      versions: 2,
      rolledBack: 0,
    });
    expect(existsSync(path("articles", "jane.md"))).toBe(false);
    expect(existsSync(path("versions", "jane"))).toBe(false);
    expect(await store().list()).toEqual([]);
    expect(bytes()).not.toContain(MARKER);
  });

  test("a kept current version keeps its place; a person's version is never one of a conversation's", async () => {
    await article("notes", [[`v1 ${MARKER}`, A], ["v2 by a person"]]);
    expect(await eraseVersions(at(), { sessions: [A] }, grantFor([A]))).toEqual({
      articles: 0,
      versions: 1,
      rolledBack: 0,
    });
    const now = await store().get("notes");
    expect([now?.version, now?.body]).toEqual([2, "v2 by a person"]);
    expect(bytes()).not.toContain(MARKER);
  });

  test("a re-run changes nothing, and a conversation that wrote nothing takes no lock", async () => {
    await article("notes", [["v1", B]]);
    const before = snapshot();
    expect(await eraseVersions(at(), { sessions: [A] }, grantFor([A]))).toEqual({
      articles: 0,
      versions: 0,
      rolledBack: 0,
    });
    expect(snapshot()).toEqual(before);
  });
});

describe("an erasure acts only on its own grant", () => {
  test("another root, spec or store, or a target the grant does not name, is refused", async () => {
    await article("jane", [[MARKER, A]]);
    const before = snapshot();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "wiki-erasure-other-")));
    try {
      for (const grant of [
        grantFor(["jane", A], { root: other }),
        grantFor(["jane", A], { spec: "other" }),
        grantFor(["jane", A], { store: "memory" }),
      ]) {
        await expect(erase(at(), "jane", grant)).rejects.toThrow("does not cover");
        await expect(eraseVersions(at(), { sessions: [A] }, grant)).rejects.toThrow(
          "does not cover",
        );
      }
      await expect(erase(at(), "jane", grantFor([A]))).rejects.toThrow("does not name");
      await expect(erase(at(), "../jane", grantFor(["../jane"]))).rejects.toThrow("does not name");
      await expect(eraseVersions(at(), { sessions: [A, B] }, grantFor([A]))).rejects.toThrow(
        "does not name every conversation",
      );
      await expect(
        erase({ rootDir: root, specName: ".." }, "jane", grantFor(["jane"], { spec: ".." })),
      ).rejects.toThrow("invalid specName");
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a directory that leads out of the store is refused, and what it holds is untouched", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wiki-erasure-outside-")));
    try {
      await article("jane", [[MARKER, A]]);
      writeFileSync(join(outside, "1.md"), "theirs");
      mkdirSync(path("versions"), { recursive: true });
      symlinkSync(outside, path("versions", "jane"));
      await expect(erase(at(), "jane", grantFor(["jane"]))).rejects.toThrow("not a directory");
      rmSync(path("versions"), { recursive: true });
      symlinkSync(outside, path("versions"));
      await expect(erase(at(), "jane", grantFor(["jane"]))).rejects.toThrow("refusing to erase");
      await expect(eraseVersions(at(), { sessions: [A] }, grantFor([A]))).rejects.toThrow();
      expect(readFileSync(join(outside, "1.md"), "utf8")).toBe("theirs");
      expect(readFileSync(path("articles", "jane.md"), "utf8")).toContain(MARKER);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a link planted at the article is removed, never what it names", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wiki-erasure-link-")));
    try {
      writeFileSync(join(outside, "theirs.md"), "theirs");
      mkdirSync(path("articles"), { recursive: true });
      symlinkSync(join(outside, "theirs.md"), path("articles", "jane.md"));
      await erase(at(), "jane", grantFor(["jane"]));
      expect(existsSync(path("articles", "jane.md"))).toBe(false);
      expect(readFileSync(join(outside, "theirs.md"), "utf8")).toBe("theirs");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
