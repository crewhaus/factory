import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeFsError } from "./failure";
import { assertRegularFile, probeKind } from "./kind";
import { fixture, mkfifo, posix } from "./test-helpers";

const f = fixture("kind");
afterAll(() => f.cleanup());

describe("probeKind / assertRegularFile", () => {
  test("files, directories and missing paths", () => {
    writeFileSync(join(f.ws, "a.txt"), "a");
    mkdirSync(join(f.ws, "d"));
    expect(probeKind(join(f.ws, "a.txt"))).toMatchObject({ ok: true, kind: "file" });
    expect(probeKind(join(f.ws, "d"))).toMatchObject({ ok: true, kind: "directory" });
    expect(probeKind(join(f.ws, "none"), { given: "none" })).toMatchObject({
      ok: false,
      code: "not-found",
      path: "none",
    });
    expect(assertRegularFile(join(f.ws, "a.txt")).size).toBe(1);
    try {
      assertRegularFile(join(f.ws, "d"), { given: "d" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SafeFsError);
      expect(err).toMatchObject({ code: "not-regular-file", kind: "directory", path: "d" });
    }
  });

  test.if(posix)("a link is reported as a link unless asked to follow", () => {
    symlinkSync("a.txt", join(f.ws, "l"));
    expect(probeKind(join(f.ws, "l"))).toMatchObject({ ok: true, kind: "symlink" });
    expect(probeKind(join(f.ws, "l"), { followSymlinks: true })).toMatchObject({
      ok: true,
      kind: "file",
    });
    expect(() => assertRegularFile(join(f.ws, "l"))).toThrow(SafeFsError);
    expect(assertRegularFile(join(f.ws, "l"), { followSymlinks: true }).isFile()).toBe(true);
  });

  test.if(posix)(
    "a FIFO is identified without opening it: a blocked writer stays blocked",
    async () => {
      const fifo = join(f.ws, "p.xml");
      mkfifo(fifo);
      const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await Bun.sleep(100);
        expect(probeKind(fifo)).toMatchObject({ ok: true, kind: "fifo" });
        expect(() => assertRegularFile(fifo, { given: "p.xml" })).toThrow(
          '"p.xml" is a fifo, not a regular file',
        );
        await Bun.sleep(200);
        expect(writer.exitCode).toBeNull();
      } finally {
        writer.kill("SIGKILL");
        await writer.exited;
      }
    },
    10_000,
  );
});
