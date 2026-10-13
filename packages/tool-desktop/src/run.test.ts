/**
 * `runHostCommand` against real children: what the output cap bounds, and
 * what an answer that could not be read to its end says about itself (C163).
 *
 * The rest of the package drives recorded output through `_setRunner`. These
 * tests spawn, because the property is about the spawn, but they touch no
 * desktop state: every child is `head` or this Bun binary (one starts a
 * shell loop), never a clipboard, notifier, opener or printer, so house
 * rule 4 (one real-DESKTOP test, in integration.test.ts) is unaffected. The
 * gate is opened per test and shut again after.
 */
import { heapSize } from "bun:jsc";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _allowRealHost, _resetRunSeams, runHostCommand } from "./run";

const posix = process.platform !== "win32";
const bun = process.execPath;

const PIECE_BYTES = 64 * 1024;

/**
 * Spies on `Bun.spawn` so each child's stdout reaches `runHostCommand` in
 * 64 KiB pieces of a Uint8Array subclass, each one (and each `slice()` or
 * `subarray()` made of one) kept as a WeakRef. When the stream ends, after a
 * full collection, it counts the pieces still alive: code that keeps only
 * its cap holds a handful, code that reads to the end before capping holds
 * every one. Code that copies the bytes out of the pieces first (into one
 * growing buffer, or a decoded string) lets every piece go but holds the
 * whole stream all the same, so it also reads the bytes of live JS objects
 * gained since the spawn (`heapGainAtEnd`), both after a full collection:
 * what is still reachable, not the process's RSS, which moves with the
 * allocator, with Bun's own pipe buffering and with every other test.
 * Neither sees bytes held outside the JS heap (a `Bun.ArrayBufferSink`).
 */
function countHeldPieces(): {
  seen: { delivered: number; heldAtEnd: number; heapGainAtEnd: number };
  restore: () => void;
} {
  const real = Bun.spawn.bind(Bun);
  const pieces: WeakRef<Uint8Array>[] = [];
  class Piece extends Uint8Array {
    constructor(...args: unknown[]) {
      super(...(args as [ArrayBuffer]));
      pieces.push(new WeakRef(this));
    }
  }
  // Both -1/NaN until the stream ends.
  const seen = { delivered: 0, heldAtEnd: -1, heapGainAtEnd: Number.NaN };
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    Bun.gc(true);
    const heapAtSpawn = heapSize();
    const proc = real(...args);
    const source = proc.stdout;
    if (!(source instanceof ReadableStream)) return proc;
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    let cancelled = false;
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) {
          // A WeakRef keeps its target until the job that made it ends.
          await new Promise((resolve) => setTimeout(resolve, 0));
          Bun.gc(true);
          seen.heldAtEnd = pieces.filter((ref) => ref.deref() !== undefined).length;
          seen.heapGainAtEnd = heapSize() - heapAtSpawn;
          controller.close();
          return;
        }
        for (let at = 0; at < next.value.length; at += PIECE_BYTES) {
          controller.enqueue(new Piece(next.value.subarray(at, at + PIECE_BYTES)));
          seen.delivered += 1;
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    });
    Object.defineProperty(proc, "stdout", { value: counted });
    return proc;
  }) as typeof Bun.spawn);
  return { seen, restore: () => spy.mockRestore() };
}

/**
 * A pipe holder the test lets go of: `loop` is shell that runs while the file
 * named by its `$1` exists, and `release` removes that file. The loop also
 * gives up after 1 200 turns of 50 ms, at least a minute and past every
 * budget here, so a run that never returns cannot leave it behind; that cap
 * never decides a result.
 */
function holdPipe(): { file: string; loop: string; release: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "desktop-run-hold-"));
  const file = join(dir, "hold");
  writeFileSync(file, "");
  return {
    file,
    loop: 'i=0; while [ -e "$1" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done',
    release: () => rmSync(dir, { recursive: true, force: true }),
  };
}

beforeEach(() => _allowRealHost(true));
afterEach(() => _resetRunSeams());

describe("runHostCommand caps output as it arrives (C163)", () => {
  test.if(posix)(
    "256 MiB of output with a 1024-character cap is cut, flagged, and never held",
    async () => {
      const { seen, restore } = countHeldPieces();
      let r: Awaited<ReturnType<typeof runHostCommand>>;
      try {
        r = await runHostCommand({
          argv: ["head", "-c", String(256 * 1024 * 1024), "/dev/zero"],
          timeoutMs: 60_000,
          maxOutputChars: 1024,
        });
      } finally {
        restore();
      }
      // The child ran to the end (drained, not killed), so its exit code is
      // the truth, and the cut is reported.
      expect(r.code).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(r.stdout.length).toBe(1024);
      expect(r.stdoutTruncated).toBe(true);
      expect(r.outputIncomplete).toBeUndefined();
      // 0.7.0 held the whole stream, then a string of it: every one of the
      // 4 096 pieces was alive at its end. Capped as it arrives, the reader
      // keeps a copy of the first piece's head and lets the rest go.
      expect(seen.delivered).toBeGreaterThanOrEqual(4_096);
      expect(seen.heldAtEnd).toBeGreaterThanOrEqual(0);
      expect(seen.heldAtEnd).toBeLessThanOrEqual(64);
      // Copying the bytes out of the pieces into one buffer, or decoding them
      // into a string, before cutting lets every piece go and still holds
      // the 256 MiB: live objects gain about 1 MB here, a read-everything
      // 256 MB or more.
      expect(seen.heapGainAtEnd).toBeLessThan(32 * 1024 * 1024);
    },
    60_000,
  );

  test.if(posix)(
    "output a background process kept open is returned as what arrived, and marked incomplete",
    async () => {
      // The child exits at once; the shell loop it started inherits its
      // stdout and holds the pipe open, as `xclip -i`'s holder does, until
      // this test lets it go: the drain grace ends the read however long
      // this machine takes to reach it (a `sleep 3` raced the grace). 0.7.0
      // answered "" here.
      const held = holdPipe();
      try {
        const holder = JSON.stringify(["/bin/sh", "-c", held.loop, "sh", held.file]);
        const r = await runHostCommand({
          argv: [
            bun,
            "-e",
            `Bun.spawn(${holder}, { stdout: "inherit", stderr: "ignore" }).unref(); process.stdout.write("win-a\\nwin-b\\n");`,
          ],
          timeoutMs: 20_000,
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe("win-a\nwin-b\n");
        expect(r.outputIncomplete).toBe(true);
        expect(r.stdoutTruncated).toBe(true);
      } finally {
        held.release();
      }
    },
    20_000,
  );

  test.if(posix)(
    "a complete short answer carries no flags, and stdin reaches the child",
    async () => {
      const r = await runHostCommand({
        argv: [bun, "-e", "process.stdout.write(await Bun.stdin.text())"],
        stdin: "clip-text",
        timeoutMs: 20_000,
      });
      expect(r).toEqual({
        code: 0,
        stdout: "clip-text",
        stderr: "",
        timedOut: false,
        missing: false,
      });
    },
  );

  test("a program that is not installed is reported missing", async () => {
    const r = await runHostCommand({ argv: ["crewhaus-no-such-program-c163"], timeoutMs: 20_000 });
    expect(r.missing).toBe(true);
    expect(r.code).toBe(127);
  });

  test.if(posix)(
    "a child killed at the deadline reports the timeout and 128 + SIGTERM",
    async () => {
      const r = await runHostCommand({
        argv: [bun, "-e", "setTimeout(() => {}, 30_000)"],
        timeoutMs: 300,
      });
      expect(r.timedOut).toBe(true);
      expect(r.code).toBe(143);
    },
    20_000,
  );
});
