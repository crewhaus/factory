import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdirSync,
  readSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { _setDescriptorPathSupportForTest } from "./descriptor";
import { _setOpenHooksForTest, openForRead, openForReadFd, openForReadSync } from "./read";
import { joinRel } from "./resolve";
import { fixture, mkfifo, posix } from "./test-helpers";
import { writeFileSafe } from "./write";

const f = fixture("read");
afterAll(() => f.cleanup());

const readers = [
  ["async", openForRead],
  [
    "sync",
    async (root: string, given: string, o: Parameters<typeof openForReadSync>[2]) =>
      openForReadSync(root, given, o),
  ],
] as const;

writeFileSync(join(f.ws, "note.txt"), "hello");

describe("openForRead", () => {
  for (const [name, read] of readers) {
    test(`${name}: reads a contained file, capped`, async () => {
      const big = join(f.ws, `big-${name}.log`);
      writeFileSync(big, "head\n");
      truncateSync(big, 4 * 1024 * 1024 * 1024);
      const r = await read(f.ws, `big-${name}.log`, { maxBytes: 5 });
      expect(r).toMatchObject({
        ok: true,
        text: "head\n",
        truncated: true,
        rel: `big-${name}.log`,
      });
      expect(await read(f.ws, "note.txt", { maxBytes: 100 })).toMatchObject({
        ok: true,
        text: "hello",
        truncated: false,
      });
    });

    test(`${name}: a budget that is not a number is thrown, not read as "empty"`, async () => {
      // NaN compares false with everything: the reader stopped at once and
      // returned "" with truncated:false, as if the file were empty.
      await expect(read(f.ws, "note.txt", { maxBytes: Number.NaN })).rejects.toThrow(RangeError);
      await expect(read(f.ws, "note.txt", { maxBytes: -1 })).rejects.toThrow(
        "maxBytes must be a number >= 0",
      );
    });

    test(`${name}: missing and directory are named in the caller's words`, async () => {
      expect(await read(f.ws, "nope.txt", { maxBytes: 5 })).toMatchObject({
        ok: false,
        code: "not-found",
        path: "nope.txt",
      });
      mkdirSync(join(f.ws, `d-${name}`));
      expect(await read(f.ws, `d-${name}`, { maxBytes: 5 })).toMatchObject({
        ok: false,
        code: "not-regular-file",
        kind: "directory",
      });
      expect(await read(f.ws, "../outside/secret.txt", { maxBytes: 100 })).toMatchObject({
        ok: false,
        code: "escapes-root",
      });
    });
  }
});

describe.if(posix)("openForRead contains the leaf, not just the directory", () => {
  for (const [name, read] of readers) {
    test(`${name}: a fixed-name leaf linked out of a contained directory is refused (security-9#2, security-7#1)`, async () => {
      // A cloned project commits requirements.txt -> ~/.aws/credentials; the
      // tool contained `proj` and joined the leaf onto it.
      const proj = join(f.ws, `proj-${name}`);
      mkdirSync(proj);
      symlinkSync(join(f.outside, "secret.txt"), join(proj, "requirements.txt"));
      symlinkSync("../../outside/secret.txt", join(proj, "package.json"));
      for (const leaf of ["requirements.txt", "package.json"]) {
        const r = await read(f.ws, `proj-${name}/${leaf}`, { maxBytes: 1000 });
        expect(r).toMatchObject({ ok: false, code: "escapes-root", path: `proj-${name}/${leaf}` });
        if (!r.ok) {
          expect(r.reason).not.toContain("TOP-SECRET");
          expect(r.reason).not.toContain(f.outside);
        }
      }
    });

    test(`${name}: an in-root link reads normally unless links are refused at the leaf`, async () => {
      symlinkSync("note.txt", join(f.ws, `alias-${name}`));
      expect(await read(f.ws, `alias-${name}`, { maxBytes: 100 })).toMatchObject({
        ok: true,
        text: "hello",
      });
      const refused = await read(f.ws, `alias-${name}`, {
        maxBytes: 100,
        followLeafSymlink: false,
      });
      expect(refused).toMatchObject({ ok: false, code: "is-symlink", path: `alias-${name}` });
    });

    test(`${name}: a dangling in-root link is not-found, an escaping one is refused`, async () => {
      symlinkSync("absent.txt", join(f.ws, `dangle-${name}`));
      expect(await read(f.ws, `dangle-${name}`, { maxBytes: 10 })).toMatchObject({
        ok: false,
        code: "not-found",
      });
    });

    test(`${name}: a FIFO is refused without being opened, so the call returns (flag-truth-6#3)`, async () => {
      const fifo = join(f.ws, `pipe-${name}.csv`);
      mkfifo(fifo);
      const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await Bun.sleep(100);
        const r = await read(f.ws, `pipe-${name}.csv`, { maxBytes: 10 });
        expect(r).toMatchObject({ ok: false, code: "not-regular-file", kind: "fifo" });
        if (!r.ok) expect(r.reason).toContain(`"pipe-${name}.csv" is a fifo`);
        await Bun.sleep(200);
        // The writer is still blocked in open(): nobody opened the FIFO.
        expect(writer.exitCode).toBeNull();
      } finally {
        writer.kill("SIGKILL");
        await writer.exited;
      }
    }, 10_000);
  }

  test("a device behind an in-root link is refused as what it is", async () => {
    symlinkSync("/dev/zero", join(f.ws, "zero.bin"));
    // /dev is outside the root, so containment refuses it first.
    expect(await openForRead(f.ws, "zero.bin", { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    // Rooted where the device lives, the kind check is what refuses it.
    expect(await openForRead("/dev", "zero", { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "not-regular-file",
      kind: "character-device",
    });
  });
});

/**
 * The review's race, made deterministic: `sub` is swapped for a link to
 * outside after the path was resolved and before it is opened, so the open
 * (and the pre-open lstat, and the fstat) all go through the swap. A second
 * process renaming `sub` back and forth leaked the outside file in 262 of
 * 52 230 reads before the descriptor was checked.
 */
describe.if(posix)("a directory swapped between the resolution and the open", () => {
  const ws = join(f.base, "swap-ws");
  const out = join(f.base, "swap-out");
  mkdirSync(join(ws, "sub"), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(ws, "sub", "t.txt"), "inside-ok");
  writeFileSync(join(out, "t.txt"), "OUTSIDE-SECRET");
  symlinkSync(out, join(ws, ".lnk"));
  const swapIn = (): void => {
    renameSync(join(ws, "sub"), join(ws, ".subtmp"));
    renameSync(join(ws, ".lnk"), join(ws, "sub"));
  };
  const swapBack = (): void => {
    renameSync(join(ws, "sub"), join(ws, ".lnk"));
    renameSync(join(ws, ".subtmp"), join(ws, "sub"));
  };
  let swappedIn = false;
  afterEach(() => {
    _setOpenHooksForTest({});
    _setDescriptorPathSupportForTest(undefined);
    if (swappedIn) swapBack();
    swappedIn = false;
  });

  const cases: Array<[string, boolean | undefined, boolean]> = [
    // [label, descriptor path support, swap back before the check]
    ["checked through the descriptor, swapped back before the check", undefined, true],
    ["checked through the descriptor, still swapped", undefined, false],
    ["without the descriptor: directory identities", false, false],
    ["without the descriptor: the leaf's identity", false, true],
  ];
  for (const [label, support, back] of cases) {
    for (const [name, read] of readers) {
      test(`${name}, ${label}: refused, and nothing outside is read`, async () => {
        _setDescriptorPathSupportForTest(support);
        _setOpenHooksForTest({
          beforeOpen: () => {
            swapIn();
            swappedIn = true;
          },
          afterOpen: () => {
            if (!back) return;
            swapBack();
            swappedIn = false;
          },
        });
        const r = await read(ws, "sub/t.txt", { maxBytes: 100 });
        expect(r).toMatchObject({ ok: false, code: "changed", path: "sub/t.txt" });
        expect(JSON.stringify(r)).not.toContain("OUTSIDE");
        expect(JSON.stringify(r)).not.toContain(out);
      });
    }
  }

  test("with nothing swapped, the same read succeeds either way", async () => {
    for (const support of [undefined, false]) {
      _setDescriptorPathSupportForTest(support);
      expect(openForReadSync(ws, "sub/t.txt", { maxBytes: 100 })).toMatchObject({
        ok: true,
        text: "inside-ok",
      });
    }
  });
});

describe("openForReadFd and position", () => {
  test("hands over the checked descriptor of a contained file", () => {
    const opened = openForReadFd(f.ws, "note.txt");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const buf = new Uint8Array(5);
      expect(readSync(opened.fd, buf, 0, 5, 0)).toBe(5);
      expect(new TextDecoder().decode(buf)).toBe("hello");
      expect(opened.rel).toBe("note.txt");
    } finally {
      closeSync(opened.fd);
    }
    expect(openForReadFd(f.ws, "../outside/secret.txt")).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });

  test("position reads from an offset", async () => {
    for (const [, read] of readers) {
      expect(await read(f.ws, "note.txt", { maxBytes: 3, position: 2 })).toMatchObject({
        ok: true,
        text: "llo",
        truncated: false,
      });
    }
  });
});

describe("a leaf joined onto a directory that is the root itself", () => {
  test("joinRel works where a template string gave an absolute path", async () => {
    // A resolver's `rel` is "" for the root: `${rel}/package.json` is "/package.json".
    const dirRel = "";
    expect(joinRel(dirRel, "note.txt")).toBe("note.txt");
    expect(joinRel("a/b", "package.json")).toBe("a/b/package.json");
    expect(await openForRead(f.ws, joinRel(dirRel, "note.txt"), { maxBytes: 10 })).toMatchObject({
      ok: true,
      text: "hello",
    });
    expect(
      writeFileSafe(f.ws, joinRel(dirRel, "baselines.json"), "{}", { overwrite: true }),
    ).toMatchObject({
      ok: true,
      rel: "baselines.json",
    });
  });

  test("the absolute path the template made is refused, and the reason says why", () => {
    const r = openForReadSync(f.ws, `${""}/note.txt`, { maxBytes: 10 });
    expect(r).toMatchObject({ ok: false, code: "escapes-root", path: "/note.txt" });
    if (!r.ok) {
      expect(r.reason).toContain("absolute path");
      expect(r.reason).toContain("escapes the workspace");
    }
    expect(writeFileSafe(f.ws, "/baselines.json", "{}", { overwrite: true })).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
  });
});
