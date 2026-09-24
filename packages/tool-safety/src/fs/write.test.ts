import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { caseInsensitive, fixture, mkfifo, posix } from "./test-helpers";
import {
  _setLinkForTest,
  _setTempSuffixForTest,
  beginAtomicWrite,
  createExclusive,
  ensureDirContained,
  writeFileSafe,
} from "./write";

const f = fixture("write");
afterAll(() => f.cleanup());
afterEach(() => {
  _setTempSuffixForTest(undefined);
  _setLinkForTest(undefined);
});

const mode = (p: string): number => statSync(p).mode & 0o7777;
const noTemps = (dir: string): boolean => !readdirSync(dir).some((n) => n.endsWith(".tmp"));

describe("writeFileSafe", () => {
  test("creates a new file with the mode a plain write would give it", () => {
    const r = writeFileSafe(f.ws, "new.txt", "one", { overwrite: false });
    expect(r).toMatchObject({ ok: true, created: true, bytes: 3, rel: "new.txt" });
    expect(readFileSync(join(f.ws, "new.txt"), "utf8")).toBe("one");
    writeFileSync(join(f.ws, "control.txt"), "c");
    expect(mode(join(f.ws, "new.txt"))).toBe(mode(join(f.ws, "control.txt")));
    expect(noTemps(f.ws)).toBe(true);
  });

  test("an explicit mode applies to a new file", () => {
    writeFileSafe(f.ws, "private.txt", "p", { overwrite: false, mode: 0o600 });
    expect(mode(join(f.ws, "private.txt"))).toBe(0o600);
  });

  test("an existing file is refused without overwrite and replaced with it", () => {
    expect(writeFileSafe(f.ws, "new.txt", "two", { overwrite: false })).toMatchObject({
      ok: false,
      code: "exists",
      path: "new.txt",
    });
    expect(readFileSync(join(f.ws, "new.txt"), "utf8")).toBe("one");
    expect(writeFileSafe(f.ws, "new.txt", "two", { overwrite: true })).toMatchObject({
      ok: true,
      created: false,
    });
    expect(readFileSync(join(f.ws, "new.txt"), "utf8")).toBe("two");
  });

  test.if(posix)(
    "an overwrite keeps the permission bits: +x survives an edit (security-6#11)",
    () => {
      const cases: Array<[string, number, number]> = [
        ["run.sh", 0o755, 0o755],
        ["secret.env", 0o600, 0o600],
        ["odd.bin", 0o640, 0o640],
        // setuid is dropped, as an in-place write by an unprivileged user
        // drops it (setgid and sticky go too: see PRESERVED_MODE_BITS).
        ["suid.sh", 0o4755, 0o755],
      ];
      for (const [name, before, after] of cases) {
        const p = join(f.ws, name);
        writeFileSync(p, "old");
        // chmod(1), because Bun's chmodSync drops the special bits.
        expect(Bun.spawnSync(["chmod", before.toString(8), p]).exitCode).toBe(0);
        expect(mode(p)).toBe(before);
        const r = writeFileSafe(f.ws, name, "new", { overwrite: true });
        expect(r).toMatchObject({ ok: true, mode: after });
        expect(mode(p)).toBe(after);
        expect(readFileSync(p, "utf8")).toBe("new");
      }
    },
  );

  test("the destination's directory must exist unless createParents", () => {
    expect(writeFileSafe(f.ws, "deep/er/x.json", "{}", { overwrite: false })).toMatchObject({
      ok: false,
      code: "parent-missing",
    });
    expect(
      writeFileSafe(f.ws, "deep/er/x.json", "{}", { overwrite: false, createParents: true }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(join(f.ws, "deep", "er", "x.json"), "utf8")).toBe("{}");
  });

  test("a long name in a multi-byte script still fits its temp name under NAME_MAX", () => {
    // 80 CJK characters are 240 bytes of UTF-8: a legal name on a volume
    // that counts bytes (ext4: 255). A temp name built from the first 100
    // UTF-16 units of it was 266 bytes, and every write of it failed there.
    // APFS counts characters, so the property is asserted on the name.
    const name = `${"界".repeat(80)}.txt`;
    const begun = beginAtomicWrite(f.ws, name, { overwrite: false });
    if (!begun.ok) throw new Error(begun.reason);
    const temp = readdirSync(f.ws).find((n) => n.startsWith(".界") && n.endsWith(".tmp"));
    expect(temp).toBeDefined();
    expect(Buffer.byteLength(temp as string)).toBeLessThanOrEqual(128);
    begun.writer.write("wide");
    expect(begun.writer.commit()).toMatchObject({ ok: true });
    expect(readFileSync(join(f.ws, name), "utf8")).toBe("wide");
    expect(writeFileSafe(f.ws, name, "wider", { overwrite: true })).toMatchObject({ ok: true });
    expect(noTemps(f.ws)).toBe(true);
  });

  test.if(caseInsensitive(f.ws))(
    "on a case-insensitive volume, a directory named in another case is the same directory",
    () => {
      mkdirSync(join(f.ws, "cased"));
      expect(writeFileSafe(f.ws, "CASED/w.txt", "w", { overwrite: false })).toMatchObject({
        ok: true,
      });
      expect(readFileSync(join(f.ws, "cased", "w.txt"), "utf8")).toBe("w");
      const made = createExclusive(f.ws, "Cased/part0001");
      expect(made.ok).toBe(true);
      if (made.ok) closeSync(made.fd);
      expect(existsSync(join(f.ws, "cased", "part0001"))).toBe(true);
    },
  );

  test("the root itself, a directory and a lexical escape are refused", () => {
    expect(writeFileSafe(f.ws, ".", "x", { overwrite: true })).toMatchObject({
      ok: false,
      code: "invalid-path",
    });
    mkdirSync(join(f.ws, "adir"));
    expect(writeFileSafe(f.ws, "adir", "x", { overwrite: true })).toMatchObject({
      ok: false,
      code: "not-regular-file",
      kind: "directory",
    });
    expect(writeFileSafe(f.ws, "../outside/x.txt", "x", { overwrite: true })).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(existsSync(join(f.outside, "x.txt"))).toBe(false);
  });
});

describe.if(posix)("writeFileSafe never writes through a planted link", () => {
  test("a dangling leaf link out is refused and its target never created (security-7#0)", () => {
    mkdirSync(join(f.ws, ".crewhaus", "evals"), { recursive: true });
    symlinkSync("../../../outside/pwned.json", join(f.ws, ".crewhaus", "evals", "baselines.json"));
    for (const leafSymlink of ["refuse", "follow-contained"] as const) {
      for (const overwrite of [false, true]) {
        const r = writeFileSafe(f.ws, ".crewhaus/evals/baselines.json", '{"$(touch x)":1}', {
          overwrite,
          leafSymlink,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe(leafSymlink === "refuse" ? "is-symlink" : "escapes-root");
          expect(r.reason).toContain('".crewhaus/evals/baselines.json"');
          expect(r.reason).not.toContain(f.outside);
        }
        expect(existsSync(join(f.outside, "pwned.json"))).toBe(false);
      }
    }
    expect(noTemps(join(f.ws, ".crewhaus", "evals"))).toBe(true);
  });

  test("an existing outside file behind a leaf link is left untouched (flag-truth-4#3)", () => {
    writeFileSync(join(f.outside, "settings.json"), '{"editor.fontSize": 14}');
    symlinkSync("../outside/settings.json", join(f.ws, "settings.json"));
    const r = writeFileSafe(f.ws, "settings.json", "{}", { overwrite: true });
    expect(r).toMatchObject({ ok: false, code: "is-symlink" });
    expect(readFileSync(join(f.outside, "settings.json"), "utf8")).toBe('{"editor.fontSize": 14}');
  });

  test("an in-root leaf link is written through only when asked, and stays a link", () => {
    mkdirSync(join(f.ws, "docs"));
    writeFileSync(join(f.ws, "docs", "README.md"), "old");
    symlinkSync("docs/README.md", join(f.ws, "README.md"));
    expect(writeFileSafe(f.ws, "README.md", "new", { overwrite: true })).toMatchObject({
      ok: false,
      code: "is-symlink",
    });
    const r = writeFileSafe(f.ws, "README.md", "new", {
      overwrite: true,
      leafSymlink: "follow-contained",
    });
    expect(r).toMatchObject({ ok: true, created: false, rel: "README.md" });
    expect(readFileSync(join(f.ws, "docs", "README.md"), "utf8")).toBe("new");
    expect(lstatSync(join(f.ws, "README.md")).isSymbolicLink()).toBe(true);
  });

  test("a symlinked directory under the root is not written into (security-6#7, flag-truth-3#3)", () => {
    mkdirSync(join(f.ws, "datasets"));
    mkdirSync(join(f.outside, "ds"));
    symlinkSync(join(f.outside, "ds"), join(f.ws, "datasets", "evil"));
    for (const createParents of [false, true]) {
      const r = writeFileSafe(f.ws, "datasets/evil/v1.json", "{}", {
        overwrite: false,
        createParents,
      });
      expect(r).toMatchObject({ ok: false, code: "escapes-root" });
      if (!r.ok) expect(r.reason).toContain("resolves outside the workspace root");
    }
    // A dangling directory link out: createParents must not create its target.
    symlinkSync("../../outside/made-by-write", join(f.ws, "datasets", "evil2"));
    expect(
      writeFileSafe(f.ws, "datasets/evil2/v1.json", "{}", {
        overwrite: false,
        createParents: true,
      }),
    ).toMatchObject({ ok: false, code: "escapes-root" });
    expect(readdirSync(join(f.outside, "ds"))).toEqual([]);
    expect(existsSync(join(f.outside, "made-by-write"))).toBe(false);
  });

  test("a link planted at the temp name is neither followed nor removed (security-9#3, security-8#13)", () => {
    _setTempSuffixForTest(() => "planted");
    mkdirSync(join(f.ws, "goldens"));
    symlinkSync("../../outside/golden-pwned.txt", join(f.ws, "goldens", ".out.txt.planted.tmp"));
    const r = writeFileSafe(f.ws, "goldens/out.txt", "attacker-chosen bytes\n", {
      overwrite: true,
    });
    expect(r).toMatchObject({ ok: false, code: "changed" });
    if (!r.ok) expect(r.reason).toContain("temporary name");
    expect(existsSync(join(f.outside, "golden-pwned.txt"))).toBe(false);
    expect(lstatSync(join(f.ws, "goldens", ".out.txt.planted.tmp")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(f.ws, "goldens", "out.txt"))).toBe(false);
  });

  test("temp names are unpredictable, and never the pid-derived names the audit exploited", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const begun = beginAtomicWrite(f.ws, "probe.txt", { overwrite: true });
      if (!begun.ok) throw new Error(begun.reason);
      const temps = readdirSync(f.ws).filter((n) => n.startsWith(".probe.txt."));
      expect(temps).toHaveLength(1);
      const temp = temps[0] as string;
      expect(temp).toMatch(/^\.probe\.txt\.[0-9a-f]{16}\.tmp$/);
      expect(temp).not.toContain(String(process.pid));
      seen.add(temp);
      begun.writer.abort();
    }
    expect(seen.size).toBe(3);
    expect(noTemps(f.ws)).toBe(true);
  });

  test("a stale planted .tmp beside a wiki article does not matter (security-2#0)", () => {
    mkdirSync(join(f.ws, "articles"));
    symlinkSync("../../outside/planted-target.sh", join(f.ws, "articles", "notes.md.tmp"));
    const r = writeFileSafe(f.ws, "articles/notes.md", "---\ntitle: Notes\n---\nhello\n", {
      overwrite: true,
    });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(existsSync(join(f.outside, "planted-target.sh"))).toBe(false);
    expect(lstatSync(join(f.ws, "articles", "notes.md")).isFile()).toBe(true);
  });

  test("a leaf swapped for a link during a streamed write is not replaced", () => {
    writeFileSync(join(f.ws, "swap.txt"), "orig");
    writeFileSync(join(f.outside, "victim.txt"), "victim");
    const begun = beginAtomicWrite(f.ws, "swap.txt", { overwrite: true });
    if (!begun.ok) throw new Error(begun.reason);
    begun.writer.write("part one, ");
    rmSync(join(f.ws, "swap.txt"));
    symlinkSync(join(f.outside, "victim.txt"), join(f.ws, "swap.txt"));
    begun.writer.write("part two");
    const r = begun.writer.commit();
    expect(r).toMatchObject({ ok: false, code: "is-symlink" });
    expect(readFileSync(join(f.outside, "victim.txt"), "utf8")).toBe("victim");
    expect(noTemps(f.ws)).toBe(true);
  });

  test("a directory swapped for a link during the write stops the commit", () => {
    mkdirSync(join(f.ws, "moving"));
    const begun = beginAtomicWrite(f.ws, "moving/out.bin", { overwrite: false });
    if (!begun.ok) throw new Error(begun.reason);
    begun.writer.write("ATTACKER CONTENT\n");
    renameSync(join(f.ws, "moving"), join(f.ws, "moved"));
    symlinkSync(f.outside, join(f.ws, "moving"));
    expect(begun.writer.commit()).toMatchObject({ ok: false, code: "changed" });
    expect(existsSync(join(f.outside, "out.bin"))).toBe(false);
  });

  test("a FIFO at the destination is refused before anything opens it", () => {
    mkfifo(join(f.ws, "out.pipe"));
    expect(writeFileSafe(f.ws, "out.pipe", "x", { overwrite: true })).toMatchObject({
      ok: false,
      code: "not-regular-file",
      kind: "fifo",
    });
  });
});

describe.if(posix)("the no-clobber step", () => {
  test("something created at the name during the write is kept, not clobbered", () => {
    _setLinkForTest((from, to) => {
      writeFileSync(to, "racer");
      linkSync(from, to);
    });
    expect(writeFileSafe(f.ws, "raced.txt", "mine", { overwrite: false })).toMatchObject({
      ok: false,
      code: "exists",
    });
    expect(readFileSync(join(f.ws, "raced.txt"), "utf8")).toBe("racer");
    expect(noTemps(f.ws)).toBe(true);
  });

  test("a filesystem without hard links falls back to check-then-rename", () => {
    _setLinkForTest(() => {
      throw Object.assign(new Error("no hard links here"), { code: "EPERM" });
    });
    expect(writeFileSafe(f.ws, "nolinks.txt", "ok", { overwrite: false })).toMatchObject({
      ok: true,
      created: true,
    });
    expect(readFileSync(join(f.ws, "nolinks.txt"), "utf8")).toBe("ok");
    expect(noTemps(f.ws)).toBe(true);
  });
});

describe("beginAtomicWrite", () => {
  test("streams chunks and commits once", () => {
    const begun = beginAtomicWrite(f.ws, "stream.bin", { overwrite: false });
    if (!begun.ok) throw new Error(begun.reason);
    begun.writer.write("ab");
    begun.writer.write(new Uint8Array([0x63, 0x64]));
    expect(begun.writer.commit()).toMatchObject({ ok: true, bytes: 4 });
    expect(readFileSync(join(f.ws, "stream.bin"), "utf8")).toBe("abcd");
    expect(begun.writer.commit()).toMatchObject({ ok: false, code: "changed" });
    expect(() => begun.writer.write("more")).toThrow("already finished");
  });

  test("abort leaves nothing behind", () => {
    const begun = beginAtomicWrite(f.ws, "aborted.bin", { overwrite: false });
    if (!begun.ok) throw new Error(begun.reason);
    begun.writer.write("half");
    begun.writer.abort();
    begun.writer.abort();
    expect(existsSync(join(f.ws, "aborted.bin"))).toBe(false);
    expect(noTemps(f.ws)).toBe(true);
  });
});

describe.if(posix)("createExclusive", () => {
  test("creates a new file and hands back a descriptor", () => {
    const r = createExclusive(f.ws, "part0001", { mode: 0o640 });
    if (!r.ok) throw new Error(r.reason);
    writeFileSync(r.fd, "l1\n");
    closeSync(r.fd);
    expect(readFileSync(join(f.ws, "part0001"), "utf8")).toBe("l1\n");
    expect(mode(join(f.ws, "part0001")) & 0o640).toBe(mode(join(f.ws, "part0001")));
    expect(createExclusive(f.ws, "part0001")).toMatchObject({ ok: false, code: "exists" });
  });

  test("a dangling link at a part name is refused and its target not created (flag-truth-6#1, security-11#1)", () => {
    symlinkSync("../outside/created.txt", join(f.ws, "data.txt.part0001"));
    const r = createExclusive(f.ws, "data.txt.part0001");
    expect(r).toMatchObject({ ok: false, code: "is-symlink", path: "data.txt.part0001" });
    expect(existsSync(join(f.outside, "created.txt"))).toBe(false);
  });

  test("its directory is contained", () => {
    symlinkSync(f.outside, join(f.ws, "outdir"));
    expect(createExclusive(f.ws, "outdir/part0001")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(existsSync(join(f.outside, "part0001"))).toBe(false);
  });
});

describe.if(posix)("ensureDirContained", () => {
  test("creates each missing component and reports them", () => {
    const r = ensureDirContained(f.ws, "e1/e2/e3");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created.map((p) => p.split("/").pop())).toEqual(["e1", "e2", "e3"]);
    expect(ensureDirContained(f.ws, "e1/e2/e3")).toMatchObject({ ok: true, created: [] });
  });

  test("follows an in-root link, refuses one leading out, and never creates outside", () => {
    symlinkSync("e1", join(f.ws, "e-alias"));
    expect(ensureDirContained(f.ws, "e-alias/e2/new")).toMatchObject({ ok: true });
    expect(existsSync(join(f.ws, "e1", "e2", "new"))).toBe(true);
    symlinkSync("../outside/trash", join(f.ws, "trash-out"));
    expect(ensureDirContained(f.ws, "trash-out/files")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    expect(existsSync(join(f.outside, "trash"))).toBe(false);
  });

  test("symlinks:'refuse' refuses ANY link component, for layouts that must be real (security-10#2)", () => {
    mkdirSync(join(f.ws, ".Trash"));
    mkdirSync(join(f.ws, "elsewhere"));
    symlinkSync("../elsewhere", join(f.ws, ".Trash", "501"));
    const r = ensureDirContained(f.ws, ".Trash/501/files", { symlinks: "refuse" });
    expect(r).toMatchObject({ ok: false, code: "is-symlink" });
    expect(existsSync(join(f.ws, "elsewhere", "files"))).toBe(false);
  });

  test("a file in the way is reported as not a directory", () => {
    writeFileSync(join(f.ws, "blocker"), "x");
    expect(ensureDirContained(f.ws, "blocker/sub")).toMatchObject({
      ok: false,
      code: "not-directory",
      kind: "file",
    });
  });
});

test.if(posix)("readlink of the planted links still shows the attacker's text (sanity)", () => {
  expect(readlinkSync(join(f.ws, "data.txt.part0001"))).toBe("../outside/created.txt");
});
