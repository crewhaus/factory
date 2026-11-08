/**
 * Keep contributors' machine paths out of tracked files (#524).
 *
 * This repository is public, and a path into someone's workspace says more about
 * their machine than it says about the code. Every tracked file that is not
 * binary is scanned for two things:
 *
 *  1. An absolute path into a contributor's workspace: a home directory (`~`, or
 *     a user's directory under the macOS or Linux home root) followed by a
 *     `Developer` directory. The pattern is assembled from parts below, so this
 *     file does not match it. This rule always runs.
 *  2. A maintainer's own list of fragments that must never appear in the
 *     repository. The list is not part of the repository in any form: it is a
 *     local file, one fragment per line, named by the `CREWHAUS_HYGIENE_NEEDLES`
 *     environment variable. Without the variable this check is reported as
 *     skipped; with it set to a file that cannot be read, the test fails rather
 *     than passing on a list it never saw. The scanner splits each file into
 *     tokens (runs of letters, digits and `. _ / ~ -`), and compares, within each
 *     distinct token, every substring of a fragment's length that starts at the
 *     token's start, at one of those separators or right after one, by its
 *     sha256. A hit names the file, never the fragment.
 *
 * The work is counted and asserted rather than timed: how many files, how many
 * distinct tokens, how many candidates were hashed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);

type Needle = { readonly length: number; readonly sha256: string };

/** The environment variable naming the local fragment list (rule 2). */
const NEEDLES_ENV = "CREWHAUS_HYGIENE_NEEDLES";

/** A fragment, lowercase, as the scanner compares it. */
function needleOf(fragment: string): Needle {
  const lower = fragment.toLowerCase();
  return { length: lower.length, sha256: createHash("sha256").update(lower).digest("hex") };
}

/**
 * The local fragment list: `undefined` when the variable is unset. Blank lines
 * and lines starting with `#` are ignored. A set variable whose file cannot be
 * read, or that lists nothing, throws.
 */
function localNeedles(env: Record<string, string | undefined>): Needle[] | undefined {
  const file = env[NEEDLES_ENV];
  if (file === undefined || file === "") return undefined;
  const fragments = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (fragments.length === 0) throw new Error(`${NEEDLES_ENV} names a file that lists nothing`);
  return fragments.map(needleOf);
}

/** Rule 1, from parts: written whole, this line would be its own hit. */
const WORKSPACE_PATH = new RegExp(
  ["(?:~|/", "Users/[^/\\s]+|/", "home/[^/\\s]+)/Devel", "oper/"].join(""),
);

const SEPARATORS = new Set(["/", ".", "_", "-", "~"]);
const TOKEN_SPLIT = /[^A-Za-z0-9._/~-]+/;

type TextFile = { readonly path: string; readonly text: string };

/** Tracked files under `root` that are regular, present and not binary. */
function trackedTexts(root: string): { files: TextFile[]; skipped: number } {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const files: TextFile[] = [];
  let skipped = 0;
  for (const path of listed.stdout.toString().split("\0")) {
    if (path === "") continue;
    const abs = join(root, path);
    let regular = false;
    try {
      regular = lstatSync(abs).isFile();
    } catch {
      regular = false; // deleted from the work tree but still in the index
    }
    if (!regular) {
      skipped += 1;
      continue;
    }
    const bytes = readFileSync(abs);
    if (bytes.subarray(0, 8000).includes(0)) {
      skipped += 1;
      continue;
    }
    files.push({ path, text: bytes.toString("utf8") });
  }
  return { files, skipped };
}

type Scan = {
  readonly pathHits: string[];
  readonly fragmentHits: string[];
  readonly distinctTokens: number;
  readonly candidatesHashed: number;
};

/** Both rules over `files`, with the fragments given as digests. */
function scan(files: readonly TextFile[], needles: readonly Needle[]): Scan {
  const pathHits: string[] = [];
  const tokens = new Set<string>();
  for (const file of files) {
    file.text.split("\n").forEach((line, i) => {
      if (WORKSPACE_PATH.test(line)) pathHits.push(`${file.path}:${i + 1}`);
    });
    for (const token of file.text.split(TOKEN_SPLIT))
      if (token !== "") tokens.add(token.toLowerCase());
  }
  const lengths = [...new Set(needles.map((n) => n.length))];
  if (lengths.length === 0)
    return { pathHits, fragmentHits: [], distinctTokens: tokens.size, candidatesHashed: 0 };
  const wanted = new Set(needles.map((n) => `${n.length}:${n.sha256}`));
  const minLength = Math.min(...lengths);
  // Each distinct candidate is hashed once, however many tokens it occurs in.
  const verdicts = new Map<string, boolean>();
  const hitTokens = new Set<string>();
  for (const token of tokens) {
    if (token.length < minLength) continue;
    const starts = new Set<number>([0]);
    for (let i = 0; i < token.length; i++) {
      if (SEPARATORS.has(token[i] as string)) {
        starts.add(i);
        starts.add(i + 1);
      }
    }
    for (const start of starts) {
      for (const length of lengths) {
        if (start + length > token.length) continue;
        const candidate = token.slice(start, start + length);
        let hit = verdicts.get(candidate);
        if (hit === undefined) {
          const digest = createHash("sha256").update(candidate).digest("hex");
          hit = wanted.has(`${length}:${digest}`);
          verdicts.set(candidate, hit);
        }
        if (hit) hitTokens.add(token);
      }
    }
  }
  const fragmentHits =
    hitTokens.size === 0
      ? []
      : files
          .filter((f) => f.text.split(TOKEN_SPLIT).some((t) => hitTokens.has(t.toLowerCase())))
          .map((f) => f.path)
          .sort();
  return { pathHits, fragmentHits, distinctTokens: tokens.size, candidatesHashed: verdicts.size };
}

describe("the real tree", () => {
  const { files } = trackedTexts(ROOT);
  const needles = localNeedles(process.env);

  test("no tracked file holds a workspace path", () => {
    const r = scan(files, []);
    expect(r.pathHits).toEqual([]);
    // The scan really read the tree.
    expect(files.length).toBeGreaterThanOrEqual(4000);
    // This file is one of them: its own pattern is assembled, so it is no hit.
    expect(files.some((f) => f.path === "scripts/public-hygiene.test.ts")).toBe(true);
  }, 20_000); // every tracked file, line by line

  // Runs only where a maintainer has set the local list; reported as skipped otherwise.
  test.skipIf(needles === undefined)(
    `no tracked file holds a fragment from the local list (${NEEDLES_ENV})`,
    () => {
      const r = scan(files, needles ?? []);
      expect(r.fragmentHits).toEqual([]);
      // The scan really hashed.
      expect(r.distinctTokens).toBeGreaterThan(100_000);
      expect(r.candidatesHashed).toBeGreaterThan(r.distinctTokens);
    },
    20_000, // every tracked file, tokenized and hashed
  );
});

describe("planted", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  /** A temp git tree whose index holds `files`. */
  function plantTree(files: Record<string, string | Uint8Array>): string {
    const root = mkdtempSync(join(tmpdir(), "public-hygiene-"));
    temps.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const env = { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
    for (const argv of [
      ["git", "init", "-q"],
      ["git", "add", "-A"],
    ]) {
      const r = Bun.spawnSync(argv, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString()}`);
    }
    return root;
  }

  // An innocuous stand-in for a listed fragment.
  const FRAGMENT = "zz-planted.fragment";
  const NEEDLE: Needle = needleOf(FRAGMENT);

  test("a planted fragment is found by its digest, whatever its case and wherever it sits in a token", () => {
    const root = plantTree({
      "docs/notes.md": "See /x/ZZ-Planted.Fragment/readme for details.\n",
      "src/clean.ts": "export const fine = 'zz-planted-fragment';\n",
      "src/also.ts": "const p = '~/zz-planted.fragment';\n",
    });
    const { files } = trackedTexts(root);
    const r = scan(files, [NEEDLE]);
    expect(r.fragmentHits).toEqual(["docs/notes.md", "src/also.ts"]);
    expect(r.pathHits).toEqual([]);
    expect(r.candidatesHashed).toBeGreaterThan(0);
  });

  test("a workspace path is found, with its line; a generic one is not", () => {
    const home = ["", "Users", "someone"].join("/");
    const root = plantTree({
      "a.md": `one\nthe env file is at ${home}/Devel${"oper"}/project/.env\n`,
      "b.md": `${["", "home", "ci"].join("/")}/Devel${"oper"}/x\n`,
      "c.md": `a relative Developer/notes path and ${home}/Documents are not workspace paths\n`,
    });
    const { files } = trackedTexts(root);
    expect(scan(files, [NEEDLE]).pathHits).toEqual(["a.md:2", "b.md:1"]);
  });

  test("binary files and files outside the index are not read", () => {
    const binary = new Uint8Array([0, 1, 2, ...new TextEncoder().encode(FRAGMENT)]);
    const root = plantTree({ "img.bin": binary, "ok.txt": "fine\n" });
    writeFileSync(join(root, "untracked.txt"), FRAGMENT);
    const { files, skipped } = trackedTexts(root);
    expect(files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(skipped).toBe(1);
    expect(scan(files, [NEEDLE]).fragmentHits).toEqual([]);
  });

  test("the local list: unset is skipped, a listed fragment is found, an unreadable or empty list fails", () => {
    expect(localNeedles({})).toBeUndefined();
    expect(localNeedles({ [NEEDLES_ENV]: "" })).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "public-hygiene-list-"));
    temps.push(dir);
    const list = join(dir, "list.txt");
    writeFileSync(list, "# a comment\n\nZZ-Planted.Fragment\r\n");
    const needles = localNeedles({ [NEEDLES_ENV]: list });
    expect(needles).toEqual([NEEDLE]);
    const root = plantTree({ "notes.md": "see zz-planted.fragment\n", "ok.md": "fine\n" });
    expect(scan(trackedTexts(root).files, needles ?? []).fragmentHits).toEqual(["notes.md"]);
    expect(() => localNeedles({ [NEEDLES_ENV]: join(dir, "absent.txt") })).toThrow();
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "# nothing listed\n\n");
    expect(() => localNeedles({ [NEEDLES_ENV]: empty })).toThrow("lists nothing");
  });
});
