import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { _setBeforeCopyEntryForTest, copyTreeSafe } from "./copy";
import { caseInsensitive, fixture, mkfifo, posix } from "./test-helpers";

const f = fixture("copy");
afterAll(() => f.cleanup());
afterEach(() => _setBeforeCopyEntryForTest(undefined));

const mode = (p: string): number => statSync(p).mode & 0o777;
const opts = { symlinks: "copy-contained", maxEntries: 1000 } as const;

// src/ : a.txt, bin/run.sh (0755), sub/file.txt
mkdirSync(join(f.ws, "src", "bin"), { recursive: true });
mkdirSync(join(f.ws, "src", "sub"));
writeFileSync(join(f.ws, "src", "a.txt"), "alpha");
writeFileSync(join(f.ws, "src", "bin", "run.sh"), "#!/bin/sh\n");
chmodSync(join(f.ws, "src", "bin", "run.sh"), 0o755);
writeFileSync(join(f.ws, "src", "sub", "file.txt"), "payload");

describe("copyTreeSafe", () => {
  test("copies a tree, keeping execute bits, and reports what it wrote", () => {
    const r = copyTreeSafe(f.ws, "src", f.ws, "copy1", opts);
    expect(r).toMatchObject({ ok: true, dryRun: false, files: 3, directories: 3, symlinks: 0 });
    if (r.ok) expect(r.bytes).toBe(5 + 10 + 7);
    expect(readFileSync(join(f.ws, "copy1", "sub", "file.txt"), "utf8")).toBe("payload");
    expect(mode(join(f.ws, "copy1", "bin", "run.sh")) & 0o111).not.toBe(0);
  });

  test("a single file copies to exactly the destination name", () => {
    expect(copyTreeSafe(f.ws, "src/a.txt", f.ws, "a-copy.txt", opts)).toMatchObject({
      ok: true,
      files: 1,
      entries: [{ rel: "", kind: "file", destination: "a-copy.txt" }],
    });
    expect(readFileSync(join(f.ws, "a-copy.txt"), "utf8")).toBe("alpha");
  });

  test("dryRun plans and checks everything and writes nothing", () => {
    const r = copyTreeSafe(f.ws, "src", f.ws, "dry", { ...opts, dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, files: 3 });
    expect(existsSync(join(f.ws, "dry"))).toBe(false);
  });

  test("existing files are conflicts: refused without overwrite, replaced with it", () => {
    writeFileSync(join(f.ws, "copy1", "a.txt"), "local edit");
    chmodSync(join(f.ws, "copy1", "a.txt"), 0o640);
    const refused = copyTreeSafe(f.ws, "src", f.ws, "copy1", opts);
    expect(refused).toMatchObject({ ok: false, code: "exists" });
    if (!refused.ok) {
      expect(refused.conflicts).toEqual(["copy1/a.txt", "copy1/bin/run.sh", "copy1/sub/file.txt"]);
    }
    expect(readFileSync(join(f.ws, "copy1", "a.txt"), "utf8")).toBe("local edit");
    const replaced = copyTreeSafe(f.ws, "src", f.ws, "copy1", { ...opts, overwrite: true });
    expect(replaced).toMatchObject({
      ok: true,
      replaced: ["copy1/a.txt", "copy1/bin/run.sh", "copy1/sub/file.txt"],
    });
    expect(readFileSync(join(f.ws, "copy1", "a.txt"), "utf8")).toBe("alpha");
    // The replaced file keeps ITS mode, as an overwrite by cp would.
    expect(mode(join(f.ws, "copy1", "a.txt"))).toBe(0o640);
    expect(readdirSync(join(f.ws, "copy1")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  test("budgets fail the copy before anything is written; it is never partial", () => {
    expect(copyTreeSafe(f.ws, "src", f.ws, "over-n", { ...opts, maxEntries: 4 })).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(copyTreeSafe(f.ws, "src", f.ws, "over-b", { ...opts, maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "too-large",
    });
    expect(existsSync(join(f.ws, "over-n"))).toBe(false);
    expect(existsSync(join(f.ws, "over-b"))).toBe(false);
  });

  test("a file larger than one copy chunk arrives byte for byte, with the mode it was given", () => {
    // Several MiB of a pattern that differs chunk to chunk, so a copy that
    // repeated, dropped or reordered a chunk would show.
    const size = 3 * 1024 * 1024 + 17;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >> 20)) & 0xff;
    mkdirSync(join(f.ws, "bigsrc"));
    writeFileSync(join(f.ws, "bigsrc", "blob.bin"), data);
    chmodSync(join(f.ws, "bigsrc", "blob.bin"), 0o666);
    const r = copyTreeSafe(f.ws, "bigsrc", f.ws, "bigdst", opts);
    expect(r).toMatchObject({ ok: true, files: 1, bytes: size });
    const copied = readFileSync(join(f.ws, "bigdst", "blob.bin"));
    expect(copied.length).toBe(size);
    expect(Buffer.compare(copied, Buffer.from(data))).toBe(0);
    // A new file gets the source's bits less the umask, as a plain create does.
    expect(mode(join(f.ws, "bigdst", "blob.bin"))).toBe(0o666 & ~process.umask());
    // An overwrite keeps the replaced file's bits, as `cp` does.
    chmodSync(join(f.ws, "bigdst", "blob.bin"), 0o600);
    writeFileSync(join(f.ws, "bigsrc", "blob.bin"), data.subarray(0, 1000));
    expect(
      copyTreeSafe(f.ws, "bigsrc", f.ws, "bigdst", { ...opts, overwrite: true }),
    ).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(f.ws, "bigdst", "blob.bin")).length).toBe(1000);
    expect(mode(join(f.ws, "bigdst", "blob.bin"))).toBe(0o600);
  });

  test('fileModes "source" gives every copied file the source\'s bits, new or replaced', () => {
    // As fs.copyFileSync (and 0.7.0's CopyPath) did. The default keeps a
    // replaced file's bits, so a 0600 secret copied over a 0644 file became
    // readable by all, and a 0755 script copied over a 0644 one lost its
    // execute bits; a new file lost whatever the umask strips.
    const umask = process.umask(0o022);
    try {
      mkdirSync(join(f.ws, "modes-src"));
      mkdirSync(join(f.ws, "modes-dst"));
      const cases = [
        ["secret.env", 0o600, 0o644],
        ["run.sh", 0o755, 0o644],
        ["shared.txt", 0o664, undefined],
        ["locked.txt", 0o400, 0o666],
      ] as const;
      for (const [name, srcMode, dstMode] of cases) {
        writeFileSync(join(f.ws, "modes-src", name), `new ${name}`);
        chmodSync(join(f.ws, "modes-src", name), srcMode);
        if (dstMode !== undefined) {
          writeFileSync(join(f.ws, "modes-dst", name), "old");
          chmodSync(join(f.ws, "modes-dst", name), dstMode);
        }
      }
      // Set-id bits are never carried over: only the permission bits. (Linux
      // lets the owner set one; macOS clears it here, which leaves that half
      // of the check to CI.)
      chmodSync(join(f.ws, "modes-src", "run.sh"), 0o4755);
      const r = copyTreeSafe(f.ws, "modes-src", f.ws, "modes-dst", {
        ...opts,
        overwrite: true,
        fileModes: "source",
      });
      expect(r).toMatchObject({ ok: true, files: 4 });
      if (r.ok) expect([...r.replaced].sort()).toHaveLength(3);
      for (const [name, srcMode] of cases) {
        expect([name, mode(join(f.ws, "modes-dst", name))]).toEqual([name, srcMode]);
        expect(statSync(join(f.ws, "modes-dst", name)).mode & 0o7000).toBe(0);
        expect(readFileSync(join(f.ws, "modes-dst", name), "utf8")).toBe(`new ${name}`);
      }
    } finally {
      process.umask(umask);
    }
  });

  test("a tree cannot be copied into itself", () => {
    expect(copyTreeSafe(f.ws, "src", f.ws, "src/inner", opts)).toMatchObject({
      ok: false,
      code: "overlaps-source",
    });
    expect(copyTreeSafe(f.ws, "src/sub", f.ws, "src", { ...opts, overwrite: true })).toMatchObject({
      ok: false,
      code: "overlaps-source",
    });
  });

  test("budgets that are not numbers are a programming error, thrown, never obeyed", () => {
    expect(() =>
      copyTreeSafe(f.ws, "src", f.ws, "nan", { ...opts, maxEntries: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => copyTreeSafe(f.ws, "src", f.ws, "nan", { ...opts, maxBytes: -1 })).toThrow(
      "maxBytes must be a number >= 0",
    );
    expect(existsSync(join(f.ws, "nan"))).toBe(false);
  });

  test.if(posix)(
    "a read-only source directory still receives its contents, and keeps its mode",
    () => {
      mkdirSync(join(f.ws, "ro", "inner"), { recursive: true });
      writeFileSync(join(f.ws, "ro", "inner", "f.txt"), "ro");
      chmodSync(join(f.ws, "ro", "inner"), 0o555);
      try {
        expect(copyTreeSafe(f.ws, "ro", f.ws, "ro-copy", opts)).toMatchObject({
          ok: true,
          files: 1,
        });
        expect(readFileSync(join(f.ws, "ro-copy", "inner", "f.txt"), "utf8")).toBe("ro");
        expect(mode(join(f.ws, "ro-copy", "inner"))).toBe(0o555);
      } finally {
        chmodSync(join(f.ws, "ro", "inner"), 0o755);
        if (existsSync(join(f.ws, "ro-copy", "inner")))
          chmodSync(join(f.ws, "ro-copy", "inner"), 0o755);
      }
    },
  );

  test.if(caseInsensitive(f.ws))(
    "on a case-insensitive volume, a destination spelled in another case is still inside the source",
    () => {
      expect(copyTreeSafe(f.ws, "src", f.ws, "SRC/inner", opts)).toMatchObject({
        ok: false,
        code: "overlaps-source",
      });
      expect(existsSync(join(f.ws, "src", "inner"))).toBe(false);
      // And a destination directory spelled in another case is written normally.
      mkdirSync(join(f.ws, "cased"));
      expect(copyTreeSafe(f.ws, "src/a.txt", f.ws, "CASED/a.txt", opts)).toMatchObject({
        ok: true,
      });
      expect(readFileSync(join(f.ws, "cased", "a.txt"), "utf8")).toBe("alpha");
    },
  );

  test("the destination's parent must exist unless createParents", () => {
    expect(copyTreeSafe(f.ws, "src/a.txt", f.ws, "p/q/a.txt", opts)).toMatchObject({
      ok: false,
      code: "parent-missing",
    });
    expect(
      copyTreeSafe(f.ws, "src/a.txt", f.ws, "p/q/a.txt", { ...opts, createParents: true }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(join(f.ws, "p", "q", "a.txt"), "utf8")).toBe("alpha");
  });
});

describe.if(posix)(
  "copyTreeSafe contains every destination path (security-11#0, flag-truth-6#0)",
  () => {
    test("a symlinked directory planted under the destination is refused, with or without overwrite", () => {
      mkdirSync(join(f.ws, "dest"));
      mkdirSync(join(f.outside, "landing"));
      symlinkSync("../../outside/landing", join(f.ws, "dest", "sub"));
      for (const overwrite of [false, true]) {
        const r = copyTreeSafe(f.ws, "src", f.ws, "dest", { ...opts, overwrite });
        expect(r).toMatchObject({ ok: false, code: "is-symlink", path: "dest/sub" });
        if (!r.ok) expect(r.reason).not.toContain(f.outside);
      }
      expect(readdirSync(join(f.outside, "landing"))).toEqual([]);
      // Refused before anything was written: dest holds only the planted link.
      expect(readdirSync(join(f.ws, "dest"))).toEqual(["sub"]);
    });

    test("an in-root link on the destination path is refused too: a copy never writes through a link", () => {
      mkdirSync(join(f.ws, "dest-in"));
      mkdirSync(join(f.ws, "real-sub"));
      symlinkSync("../real-sub", join(f.ws, "dest-in", "sub"));
      expect(copyTreeSafe(f.ws, "src", f.ws, "dest-in", opts)).toMatchObject({
        ok: false,
        code: "is-symlink",
      });
      expect(readdirSync(join(f.ws, "real-sub"))).toEqual([]);
    });

    test("a destination whose own directory leads out is refused", () => {
      symlinkSync(f.outside, join(f.ws, "out"));
      expect(copyTreeSafe(f.ws, "src", f.ws, "out/stolen", opts)).toMatchObject({
        ok: false,
        code: "escapes-root",
      });
      expect(existsSync(join(f.outside, "stolen"))).toBe(false);
    });

    test("a special file at a destination path is refused, not opened", () => {
      mkdirSync(join(f.ws, "dest-fifo"));
      mkfifo(join(f.ws, "dest-fifo", "a.txt"));
      expect(
        copyTreeSafe(f.ws, "src", f.ws, "dest-fifo", { ...opts, overwrite: true }),
      ).toMatchObject({
        ok: false,
        code: "exists",
        kind: "fifo",
      });
    });
  },
);

describe.if(posix)("copy-no-new-reach: a link may lead outside only where its source led", () => {
  const reach = { ...opts, symlinks: "copy-no-new-reach" } as const;
  mkdirSync(join(f.ws, "venv", "bin"), { recursive: true });
  writeFileSync(join(f.outside, "python3"), "#!interpreter\n");
  symlinkSync(join(f.outside, "python3"), join(f.ws, "venv", "bin", "python"));

  test("an absolute outside link is refused by copy-contained, kept and listed by copy-no-new-reach", () => {
    expect(copyTreeSafe(f.ws, "venv", f.ws, "venv-refused", opts)).toMatchObject({
      ok: false,
      code: "escapes-root",
      path: "venv/bin/python",
    });
    expect(existsSync(join(f.ws, "venv-refused"))).toBe(false);
    const r = copyTreeSafe(f.ws, "venv", f.ws, "venv-copy", reach);
    expect(r).toMatchObject({ ok: true, symlinks: 1, outsideLinks: ["venv-copy/bin/python"] });
    expect(readlinkSync(join(f.ws, "venv-copy", "bin", "python"))).toBe(join(f.outside, "python3"));
    // The target's bytes were never copied in.
    expect(readdirSync(join(f.ws, "venv-copy", "bin"))).toEqual(["python"]);
  });

  test("a relative link that already led out is kept at the same depth, refused where it would reach further", () => {
    mkdirSync(join(f.ws, "esc"));
    symlinkSync("../..", join(f.ws, "esc", "up"));
    expect(copyTreeSafe(f.ws, "esc", f.ws, "esc2", reach)).toMatchObject({
      ok: true,
      outsideLinks: ["esc2/up"],
    });
    // At depth 0 the same text leads two levels above ws: new reach.
    expect(copyTreeSafe(f.ws, "esc/up", f.ws, "up0", reach)).toMatchObject({
      ok: false,
      code: "escapes-root",
      path: "esc/up",
    });
    expect(existsSync(join(f.ws, "up0"))).toBe(false);
    // One level deeper it leads inside ws: an ordinary contained link.
    expect(
      copyTreeSafe(f.ws, "esc", f.ws, "deeper/esc", { ...reach, createParents: true }),
    ).toMatchObject({
      ok: true,
      outsideLinks: [],
    });
  });

  test("a link inside the workspace that would leave at the new depth is still refused", () => {
    mkdirSync(join(f.ws, "nr", "d1", "d2"), { recursive: true });
    writeFileSync(join(f.ws, "nr", "target.txt"), "sibling");
    symlinkSync("../../target.txt", join(f.ws, "nr", "d1", "d2", "l"));
    expect(copyTreeSafe(f.ws, "nr/d1/d2", f.ws, "nr-dest", reach)).toMatchObject({
      ok: false,
      code: "escapes-root",
      path: "nr/d1/d2/l",
    });
  });

  test("across roots it keeps nothing: the destination root never had that reach", () => {
    mkdirSync(join(f.ws, "root2"));
    expect(copyTreeSafe(f.ws, "venv", join(f.ws, "root2"), "venv", reach)).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(existsSync(join(f.ws, "root2", "venv"))).toBe(false);
  });

  test("a kept link whose landing moves during the copy is removed after it", () => {
    // pivot is outside the copied tree; t/x leads through it to outside/A/f.
    mkdirSync(join(f.outside, "A"));
    mkdirSync(join(f.outside, "B"));
    symlinkSync(join(f.outside, "A"), join(f.ws, "pivot"));
    mkdirSync(join(f.ws, "t"));
    symlinkSync("../pivot/f", join(f.ws, "t", "x"));
    let swapped = 0;
    _setBeforeCopyEntryForTest((destination) => {
      if (destination !== "u/x") return;
      swapped += 1;
      renameSync(join(f.ws, "pivot"), join(f.ws, "pivot-old"));
      symlinkSync(join(f.outside, "B"), join(f.ws, "pivot"));
    });
    const r = copyTreeSafe(f.ws, "t", f.ws, "u", reach);
    expect(swapped).toBe(1);
    expect(r).toMatchObject({ ok: false, code: "changed", path: "u/x" });
    expect(existsSync(join(f.ws, "u", "x"))).toBe(false);
    expect(() => lstatSync(join(f.ws, "u", "x"))).toThrow();
  });
});

describe.if(posix)("links are judged from their NEW location (security-11#2)", () => {
  test("a relative link inside the workspace that would escape at the new depth is refused", () => {
    // ws/rel/d1/d2/l -> ../../target.txt resolves to ws/rel/target.txt: inside.
    mkdirSync(join(f.ws, "rel", "d1", "d2"), { recursive: true });
    writeFileSync(join(f.ws, "rel", "target.txt"), "sibling");
    symlinkSync("../../target.txt", join(f.ws, "rel", "d1", "d2", "l"));
    const r = copyTreeSafe(f.ws, "rel/d1/d2", f.ws, "dest2", opts);
    expect(r).toMatchObject({ ok: false, code: "escapes-root", path: "rel/d1/d2/l" });
    if (!r.ok) expect(r.reason).toContain('once copied to "dest2/l"');
    expect(existsSync(join(f.ws, "dest2"))).toBe(false);
  });

  test("a link copied one level UP (a/b/up -> ../..) is refused (flag-truth-6#0 step 1)", () => {
    mkdirSync(join(f.ws, "a", "b"), { recursive: true });
    symlinkSync("../..", join(f.ws, "a", "b", "up"));
    mkdirSync(join(f.ws, "dst"));
    expect(copyTreeSafe(f.ws, "a/b/up", f.ws, "dst/sub", opts)).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(existsSync(join(f.ws, "dst", "sub"))).toBe(false);
  });

  test("a chain through ANOTHER link being copied is resolved as the kernel will (security-11#5)", () => {
    // T/a/b/y -> ../.. and T/x -> a/b/y/../.. . At ws/chain/T, x lands at ws.
    // Copied to ws/chainT, y is ws/chainT and x lands at ws/.. — outside.
    // The text folds to chainT/a, so only a resolver that follows y first,
    // using the links it is about to create, sees it.
    mkdirSync(join(f.ws, "chain", "T", "a", "b"), { recursive: true });
    symlinkSync("../..", join(f.ws, "chain", "T", "a", "b", "y"));
    symlinkSync("a/b/y/../..", join(f.ws, "chain", "T", "x"));
    const r = copyTreeSafe(f.ws, "chain/T", f.ws, "chainT", { ...opts, dryRun: true });
    expect(r).toMatchObject({ ok: false, code: "escapes-root", path: "chain/T/x" });
    expect(copyTreeSafe(f.ws, "chain/T", f.ws, "chainT", opts)).toMatchObject({ ok: false });
    expect(existsSync(join(f.ws, "chainT"))).toBe(false);
  });

  test("a link that stays inside from its new location is recreated with the same text", () => {
    mkdirSync(join(f.ws, "ok", "docs"), { recursive: true });
    writeFileSync(join(f.ws, "ok", "docs", "README.md"), "doc");
    symlinkSync("docs/README.md", join(f.ws, "ok", "README.md"));
    const r = copyTreeSafe(f.ws, "ok", f.ws, "ok-copy", opts);
    expect(r).toMatchObject({ ok: true, symlinks: 1, files: 1 });
    expect(readlinkSync(join(f.ws, "ok-copy", "README.md"))).toBe("docs/README.md");
    expect(realpathSync(join(f.ws, "ok-copy", "README.md"))).toBe(
      realpathSync(join(f.ws, "ok-copy", "docs", "README.md")),
    );
  });

  test("an outside link's target is never dereferenced into the copy", () => {
    mkdirSync(join(f.ws, "leaky"));
    symlinkSync(join(f.outside, "secret.txt"), join(f.ws, "leaky", "creds"));
    expect(copyTreeSafe(f.ws, "leaky", f.ws, "leaky-copy", opts)).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    const skipped = copyTreeSafe(f.ws, "leaky", f.ws, "leaky-skip", { ...opts, symlinks: "skip" });
    expect(skipped).toMatchObject({
      ok: true,
      skipped: [{ path: "leaky/creds", kind: "symlink" }],
    });
    expect(readdirSync(join(f.ws, "leaky-skip"))).toEqual([]);
    expect(
      copyTreeSafe(f.ws, "leaky", f.ws, "leaky-refuse", { ...opts, symlinks: "refuse" }),
    ).toMatchObject({
      ok: false,
      code: "is-symlink",
      path: "leaky/creds",
    });
  });

  test("a FIFO in the source is refused or skipped, never opened", () => {
    mkdirSync(join(f.ws, "withpipe"));
    writeFileSync(join(f.ws, "withpipe", "keep.txt"), "k");
    mkfifo(join(f.ws, "withpipe", "pipe"));
    expect(copyTreeSafe(f.ws, "withpipe", f.ws, "wp1", opts)).toMatchObject({
      ok: false,
      code: "not-regular-file",
      kind: "fifo",
      path: "withpipe/pipe",
    });
    expect(
      copyTreeSafe(f.ws, "withpipe", f.ws, "wp2", { ...opts, specials: "skip" }),
    ).toMatchObject({
      ok: true,
      files: 1,
      skipped: [{ path: "withpipe/pipe", kind: "fifo" }],
    });
    expect(lstatSync(join(f.ws, "wp2", "keep.txt")).isFile()).toBe(true);
  });

  test("across roots: every path is checked against the DESTINATION root", () => {
    const other = join(f.base, "other-root");
    mkdirSync(other);
    symlinkSync(join(f.ws, "src", "a.txt"), join(f.ws, "src-link-out"));
    // The link resolves inside ws (the source root) but, copied into
    // other-root, it still leads into ws — outside the destination root.
    mkdirSync(join(other, "sub"));
    expect(copyTreeSafe(f.ws, "src-link-out", other, "sub/l", opts)).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });
});

describe.if(posix)("the tree changing between the plan and the write", () => {
  test("a destination directory swapped for a link out: nothing is left outside", () => {
    mkdirSync(join(f.ws, "swap-src"));
    writeFileSync(join(f.ws, "swap-src", "one.txt"), "1");
    writeFileSync(join(f.ws, "swap-src", "two.txt"), "2");
    mkdirSync(join(f.outside, "landing2"));
    _setBeforeCopyEntryForTest((destination) => {
      if (destination !== "swap-dst/two.txt") return;
      renameSync(join(f.ws, "swap-dst"), join(f.ws, "swap-dst-moved"));
      symlinkSync(join(f.outside, "landing2"), join(f.ws, "swap-dst"));
    });
    const r = copyTreeSafe(f.ws, "swap-src", f.ws, "swap-dst", opts);
    expect(r).toMatchObject({ ok: false, code: "changed", path: "swap-dst/two.txt" });
    if (!r.ok) {
      expect(r.reason).toContain("changed during the copy");
      expect(r.reason).toContain("2 of 3 entries had already been copied");
      expect(r.reason).not.toContain(f.outside);
    }
    // The file the swapped name led to was created outside, and removed again.
    expect(readdirSync(join(f.outside, "landing2"))).toEqual([]);
    expect(readdirSync(join(f.ws, "swap-dst-moved"))).toEqual(["one.txt"]);
  });

  test("a link made after a directory swap is removed, even one whose target is inside", () => {
    // An absolute target inside the root resolves inside from anywhere, so
    // only the check of the directory it was made in catches the link
    // itself sitting outside the workspace.
    mkdirSync(join(f.ws, "lswap-src"));
    symlinkSync(join(f.ws, "src", "a.txt"), join(f.ws, "lswap-src", "l"));
    mkdirSync(join(f.outside, "landing3"));
    _setBeforeCopyEntryForTest((destination) => {
      if (destination !== "lswap-dst/l") return;
      renameSync(join(f.ws, "lswap-dst"), join(f.ws, "lswap-dst-moved"));
      symlinkSync(join(f.outside, "landing3"), join(f.ws, "lswap-dst"));
    });
    const r = copyTreeSafe(f.ws, "lswap-src", f.ws, "lswap-dst", opts);
    expect(r).toMatchObject({ ok: false, code: "changed", path: "lswap-dst/l" });
    if (!r.ok) expect(r.reason).toContain("the directory of");
    expect(readdirSync(join(f.outside, "landing3"))).toEqual([]);
  });

  test("a source file that grows or shrinks is refused, and no half-written copy is left", () => {
    mkdirSync(join(f.ws, "grow-src"));
    writeFileSync(join(f.ws, "grow-src", "big.txt"), "0123456789");
    _setBeforeCopyEntryForTest((destination) => {
      if (destination === "grow-dst/big.txt")
        appendFileSync(join(f.ws, "grow-src", "big.txt"), "more");
    });
    const grew = copyTreeSafe(f.ws, "grow-src", f.ws, "grow-dst", opts);
    expect(grew).toMatchObject({ ok: false, code: "changed", path: "grow-src/big.txt" });
    if (!grew.ok) expect(grew.reason).toContain("grew during the copy");
    expect(readdirSync(join(f.ws, "grow-dst"))).toEqual([]);

    _setBeforeCopyEntryForTest((destination) => {
      if (destination === "shrink-dst/big.txt") truncateSync(join(f.ws, "grow-src", "big.txt"), 3);
    });
    const shrank = copyTreeSafe(f.ws, "grow-src", f.ws, "shrink-dst", opts);
    expect(shrank).toMatchObject({ ok: false, code: "changed" });
    if (!shrank.ok) expect(shrank.reason).toContain("shrank during the copy");
    expect(readdirSync(join(f.ws, "shrink-dst"))).toEqual([]);
  });

  test("a replaced file's temp is removed when the copy fails", () => {
    mkdirSync(join(f.ws, "rep-src"));
    writeFileSync(join(f.ws, "rep-src", "x.txt"), "new content");
    mkdirSync(join(f.ws, "rep-dst"));
    writeFileSync(join(f.ws, "rep-dst", "x.txt"), "old");
    _setBeforeCopyEntryForTest((destination) => {
      if (destination === "rep-dst/x.txt") appendFileSync(join(f.ws, "rep-src", "x.txt"), "!");
    });
    expect(
      copyTreeSafe(f.ws, "rep-src", f.ws, "rep-dst", { ...opts, overwrite: true }),
    ).toMatchObject({ ok: false, code: "changed" });
    expect(readdirSync(join(f.ws, "rep-dst"))).toEqual(["x.txt"]);
    expect(readFileSync(join(f.ws, "rep-dst", "x.txt"), "utf8")).toBe("old");
  });
});

describe.if(posix)("a link is judged with the directories the copy is about to create", () => {
  test("`..` back into a planned directory follows a link planned inside it", () => {
    // Copied to ws/dorm: D/ (new), D/L -> "." and M -> D/x/../L/../../.. .
    // D/x does not exist, so today M dangles; the moment anything creates
    // D/x, M leads through L (= D) and three levels up, out of the root.
    // Folding the `..` after x as text would call M inside.
    mkdirSync(join(f.ws, "dorm-src", "D"), { recursive: true });
    symlinkSync(".", join(f.ws, "dorm-src", "D", "L"));
    symlinkSync("D/x/../L/../../..", join(f.ws, "dorm-src", "M"));
    const r = copyTreeSafe(f.ws, "dorm-src", f.ws, "dorm", { ...opts, dryRun: true });
    expect(r).toMatchObject({ ok: false, code: "escapes-root", path: "dorm-src/M" });
    // The same chain one level shorter stays inside, and is copied.
    mkdirSync(join(f.ws, "dorm-src2", "D"), { recursive: true });
    symlinkSync(".", join(f.ws, "dorm-src2", "D", "L"));
    symlinkSync("D/x/../L/../..", join(f.ws, "dorm-src2", "M"));
    expect(copyTreeSafe(f.ws, "dorm-src2", f.ws, "dorm2", opts)).toMatchObject({
      ok: true,
      symlinks: 2,
    });
    expect(readlinkSync(join(f.ws, "dorm2", "M"))).toBe("D/x/../L/../..");
  });
});
