/**
 * MovePath never loses what it was asked to move, or what it was asked to
 * replace (0.7.1 review).
 *
 *   - A destination that HOLDS the source (`proj/src -> proj`, or the same
 *     pair spelled through a link) was deleted first with `overwrite`, and
 *     the source with it; the rename then failed ENOENT.
 *   - A move that had to cross a filesystem deleted the destination before
 *     the copy it fell back to decided it could not run (a FIFO, an
 *     unreadable file), and dryRun had promised nothing but an overwrite.
 *   - The link check had fixed caps that `maxEntries` could not raise, so a
 *     rename 0.7.0 made in a millisecond was refused with no way through.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
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
import * as path from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  _setMoveCrossesFilesystemForTest,
  _setMoveLinkCapsForTest,
  _setMoveRenameForTest,
  movePath,
} from "./index";

const originalCwd = process.cwd();
let ws: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-move-")));
  process.chdir(ws);
});

afterEach(() => {
  _setMoveRenameForTest(undefined);
  _setMoveCrossesFilesystemForTest(undefined);
  _setMoveLinkCapsForTest(undefined);
  process.chdir(originalCwd);
  rmSync(ws, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = path.join(ws, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

async function call(tool: RegisteredTool, input: unknown): Promise<string> {
  const result = await tool.execute(input);
  if (typeof result !== "string") throw new Error("expected a string result");
  return result;
}

const exdev = (): void => {
  throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
};

/** A FIFO at `rel`, or false on a host without mkfifo. */
function fifo(rel: string): boolean {
  return Bun.spawnSync(["mkfifo", path.join(ws, rel)]).exitCode === 0;
}

describe("a destination that holds the source is refused before anything is touched", () => {
  test("moving a directory onto its own parent, with overwrite", async () => {
    write("proj/README.md", "readme");
    write("proj/src/main.ts", "main");
    for (const dryRun of [true, false]) {
      const result = JSON.parse(
        await call(movePath, { source: "proj/src", destination: "proj", overwrite: true, dryRun }),
      );
      expect(result).toMatchObject({ moved: false, code: "overlaps-source" });
      expect(result.reason).toContain('"proj" holds "proj/src"');
    }
    expect(readFileSync(path.join(ws, "proj/README.md"), "utf8")).toBe("readme");
    expect(readFileSync(path.join(ws, "proj/src/main.ts"), "utf8")).toBe("main");
  });

  test("the same pair spelled through a link", async () => {
    write("p/keep.txt", "keep");
    write("p/q/data.txt", "data");
    symlinkSync("p", path.join(ws, "pl"));
    const result = JSON.parse(
      await call(movePath, { source: "pl/q", destination: "p", overwrite: true }),
    );
    expect(result).toMatchObject({ moved: false, code: "overlaps-source" });
    expect(readdirSync(path.join(ws, "p")).sort()).toEqual(["keep.txt", "q"]);
    expect(readFileSync(path.join(ws, "p/q/data.txt"), "utf8")).toBe("data");
  });

  test("the same entry spelled two ways is 'the same path', not a delete-then-rename", async () => {
    write("p/q.txt", "only copy");
    symlinkSync("p", path.join(ws, "pl"));
    const result = await call(movePath, {
      source: "pl/q.txt",
      destination: "p/q.txt",
      overwrite: true,
    });
    expect(result).toBe("source and destination are the same path");
    expect(readFileSync(path.join(ws, "p/q.txt"), "utf8")).toBe("only copy");
  });

  test("an ordinary overwrite of a sibling still moves", async () => {
    write("a/new.txt", "new");
    write("b/old.txt", "old");
    const result = JSON.parse(
      await call(movePath, { source: "a", destination: "b", overwrite: true }),
    );
    expect(result).toMatchObject({ moved: true, overwrote: true });
    expect(readdirSync(path.join(ws, "b"))).toEqual(["new.txt"]);
    expect(existsSync(path.join(ws, "a"))).toBe(false);
    // Nothing is left behind where the old destination was parked.
    expect(readdirSync(ws).sort()).toEqual(["b"]);
  });
});

describe("a move that crosses a filesystem never loses the destination it replaces", () => {
  test("a copy that refuses (a FIFO) puts the destination back, and says so", async () => {
    write("src/a.txt", "source");
    if (!fifo("src/pipe")) return;
    write("dst/precious.txt", "the only copy");
    _setMoveRenameForTest(exdev);
    const result = await call(movePath, { source: "src", destination: "dst", overwrite: true });
    expect(JSON.parse(result)).toMatchObject({ moved: false, code: "not-regular-file" });
    expect(result).toContain("dst was left as it was");
    expect(readdirSync(path.join(ws, "dst"))).toEqual(["precious.txt"]);
    expect(readFileSync(path.join(ws, "dst/precious.txt"), "utf8")).toBe("the only copy");
    expect(readdirSync(path.join(ws, "src")).sort()).toEqual(["a.txt", "pipe"]);
    expect(readdirSync(ws).sort()).toEqual(["dst", "src"]);
  });

  test("a predicted crossing is planned first: dryRun gives the refusal the real call gives", async () => {
    write("src/a.txt", "source");
    if (!fifo("src/pipe")) return;
    write("dst/precious.txt", "the only copy");
    _setMoveCrossesFilesystemForTest(() => true);
    let renamed = 0;
    _setMoveRenameForTest(() => {
      renamed += 1;
      exdev();
    });
    const dry = JSON.parse(
      await call(movePath, { source: "src", destination: "dst", overwrite: true, dryRun: true }),
    );
    expect(dry).toMatchObject({ moved: false, code: "not-regular-file" });
    const real = JSON.parse(
      await call(movePath, { source: "src", destination: "dst", overwrite: true }),
    );
    expect(real).toEqual(dry);
    // Refused before the destination was set aside or a rename was tried.
    expect(renamed).toBe(0);
    expect(readdirSync(ws).sort()).toEqual(["dst", "src"]);
  });

  test("a predicted crossing that the copy can make says so in dryRun", async () => {
    write("src/a.txt", "source");
    _setMoveCrossesFilesystemForTest(() => true);
    const dry = JSON.parse(
      await call(movePath, { source: "src", destination: "dst", dryRun: true }),
    );
    expect(dry).toMatchObject({ dryRun: true, moved: false, crossesFilesystem: true });
    expect(existsSync(path.join(ws, "dst"))).toBe(false);
  });

  // Root reads a mode-000 file anyway.
  test.if((process.getuid?.() ?? 0) !== 0)(
    "a copy that fails part-way is removed, and the destination put back",
    async () => {
      write("src/a.txt", "readable");
      write("src/z.txt", "unreadable");
      chmodSync(path.join(ws, "src/z.txt"), 0o000);
      write("dst/precious.txt", "the only copy");
      _setMoveRenameForTest(exdev);
      try {
        const result = await call(movePath, {
          source: "src",
          destination: "dst",
          overwrite: true,
        });
        expect(JSON.parse(result)).toMatchObject({ moved: false });
        expect(readdirSync(path.join(ws, "dst"))).toEqual(["precious.txt"]);
        expect(readdirSync(ws).sort()).toEqual(["dst", "src"]);
      } finally {
        chmodSync(path.join(ws, "src/z.txt"), 0o600);
      }
    },
  );

  test("a rename that fails for another reason puts the destination back, and names no host path", async () => {
    write("src/a.txt", "source");
    write("dst/precious.txt", "the only copy");
    _setMoveRenameForTest(() => {
      throw Object.assign(new Error(`EACCES: permission denied, rename '${ws}/src'`), {
        code: "EACCES",
      });
    });
    const result = await call(movePath, { source: "src", destination: "dst", overwrite: true });
    expect(result).toBe("could not move src to dst: EACCES; dst was left as it was");
    expect(result).not.toContain(ws);
    expect(readdirSync(path.join(ws, "dst"))).toEqual(["precious.txt"]);
  });
});

describe("maxEntries raises the link check's caps", () => {
  function sixLinks(): void {
    write("tree/d/t.txt", "x");
    for (let i = 0; i < 6; i++) symlinkSync("d/t.txt", path.join(ws, `tree/l${i}`));
  }

  // Each move below goes one level down, to a new depth: a rename within one
  // directory does not walk the tree at all (see the next describe).
  test("past the base cap the move is refused, and the refusal says how to go on", async () => {
    sixLinks();
    _setMoveLinkCapsForTest({ maxLinks: 5, maxVisited: 1_000 });
    const result = JSON.parse(await call(movePath, { source: "tree", destination: "sub/moved" }));
    expect(result).toMatchObject({ moved: false, code: "too-large" });
    expect(result.reason).toContain("holds more than 5 links");
    expect(result.reason).toContain("raise maxEntries (up to 500000)");
    expect(existsSync(path.join(ws, "tree/l0"))).toBe(true);
  });

  test("a maxEntries above the cap lets the same move through", async () => {
    sixLinks();
    _setMoveLinkCapsForTest({ maxLinks: 5, maxVisited: 1_000 });
    const result = JSON.parse(
      await call(movePath, { source: "tree", destination: "sub/moved", maxEntries: 6 }),
    );
    expect(result).toMatchObject({ moved: true });
    expect(readFileSync(path.join(ws, "sub/moved/l5"), "utf8")).toBe("x");
  });

  test("the entry cap is raised too, at twenty entries for each one allowed", async () => {
    write("tree/d/t.txt", "x");
    for (let i = 0; i < 30; i++) write(`tree/f${i}.txt`, "x");
    _setMoveLinkCapsForTest({ maxLinks: 5, maxVisited: 10 });
    const refused = JSON.parse(await call(movePath, { source: "tree", destination: "sub/moved" }));
    expect(refused).toMatchObject({ moved: false, code: "too-large" });
    expect(refused.reason).toContain("has more than 10 entries");
    const moved = JSON.parse(
      await call(movePath, { source: "tree", destination: "sub/moved", maxEntries: 2 }),
    );
    expect(moved).toMatchObject({ moved: true });
  });
});

describe("a rename within one directory is a rename (0.7.1 review)", () => {
  test("it does not walk the tree: its links keep their text and depth", async () => {
    // Caps a walk would hit at once. 0.7.1 before this walked a 67 000-entry
    // node_modules for 735 ms before renaming it in place (1 ms on 0.7.0),
    // and a tree past the caps was refused.
    write("tree/d/t.txt", "x");
    for (let i = 0; i < 6; i++) symlinkSync("d/t.txt", path.join(ws, `tree/l${i}`));
    symlinkSync("../tree-sibling.txt", path.join(ws, "tree/up"));
    write("tree-sibling.txt", "beside");
    _setMoveLinkCapsForTest({ maxLinks: 1, maxVisited: 1 });
    for (const dryRun of [true, false]) {
      const result = JSON.parse(
        await call(movePath, { source: "tree", destination: "renamed", dryRun }),
      );
      expect(result).toMatchObject({ moved: !dryRun, dryRun });
      expect("outsideLinks" in result).toBe(false);
    }
    expect(readFileSync(path.join(ws, "renamed/l5"), "utf8")).toBe("x");
    expect(readFileSync(path.join(ws, "renamed/up"), "utf8")).toBe("beside");
    // One level down is a new depth: the same caps refuse it.
    const deeper = JSON.parse(
      await call(movePath, { source: "renamed", destination: "sub/renamed" }),
    );
    expect(deeper).toMatchObject({ moved: false, code: "too-large" });
  });

  test("a link that would lead out from one level up is still refused", async () => {
    // a/esc/up -> ../.. is the workspace root where it is; renamed within
    // a/ it still is, and moved to the root it would be the parent.
    mkdirSync(path.join(ws, "a/esc"), { recursive: true });
    symlinkSync("../..", path.join(ws, "a/esc/up"));
    const inPlace = JSON.parse(await call(movePath, { source: "a/esc", destination: "a/esc2" }));
    expect(inPlace).toMatchObject({ moved: true });
    const up = JSON.parse(await call(movePath, { source: "a/esc2", destination: "esc" }));
    expect(up).toMatchObject({ moved: false, code: "escapes-root" });
  });

  test("two hard links to one file are two entries: the move is an ordinary overwrite", async () => {
    write("a.txt", "shared");
    linkSync(path.join(ws, "a.txt"), path.join(ws, "b.txt"));
    const refused = JSON.parse(await call(movePath, { source: "a.txt", destination: "b.txt" }));
    expect(refused).toMatchObject({ moved: false, reason: "destination exists" });
    const moved = JSON.parse(
      await call(movePath, { source: "a.txt", destination: "b.txt", overwrite: true }),
    );
    expect(moved).toMatchObject({ moved: true, overwrote: true });
    expect(readdirSync(ws)).toEqual(["b.txt"]);
    expect(readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("shared");
  });

  // APFS and NTFS fold case by default; Linux filesystems do not, and there
  // README.md and readme.md are two names.
  test.if(caseFolds())("a case-only rename renames, where the filesystem folds case", async () => {
    write("README.md", "hello\n");
    write("Src/a.ts", "x");
    // 0.7.1 before this: "destination exists"; with overwrite it failed
    // ENOENT and said readme.md "was left as it was" after renaming it.
    const dry = JSON.parse(
      await call(movePath, { source: "README.md", destination: "readme.md", dryRun: true }),
    );
    expect(dry).toMatchObject({ dryRun: true, moved: false, wouldOverwrite: false });
    expect(readdirSync(ws)).toContain("README.md");
    for (const [from, to] of [
      ["README.md", "readme.md"],
      ["Src", "src"],
    ] as const) {
      const result = JSON.parse(await call(movePath, { source: from, destination: to }));
      expect(result).toMatchObject({ moved: true, overwrote: false });
    }
    expect(readdirSync(ws).sort()).toEqual(["readme.md", "src"]);
    expect(readFileSync(path.join(ws, "readme.md"), "utf8")).toBe("hello\n");
    expect(readdirSync(path.join(ws, "src"))).toEqual(["a.ts"]);
    // With overwrite too, and back: nothing is set aside or lost.
    const back = JSON.parse(
      await call(movePath, { source: "readme.md", destination: "README.md", overwrite: true }),
    );
    expect(back).toMatchObject({ moved: true, overwrote: false });
    expect(readdirSync(ws).sort()).toEqual(["README.md", "src"]);
  });
});

/** Whether this host's temp directory folds case (APFS and NTFS by default). */
function caseFolds(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-fsx-case-"));
  try {
    writeFileSync(path.join(dir, "probe"), "");
    return existsSync(path.join(dir, "PROBE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
