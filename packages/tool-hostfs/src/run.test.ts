/**
 * `runHostCommand` against real children: what the output cap bounds, and
 * what an answer that could not be read to its end says about itself.
 *
 * The rest of the package drives recorded output through `_setRunner`; these
 * are the only tests that spawn, because the property is about the spawn.
 */
import { describe, expect, test } from "bun:test";
import { runHostCommand } from "./run";

const posix = process.platform !== "win32";

describe("runHostCommand caps output as it arrives (C163)", () => {
  test.if(posix)(
    "256 MiB of output with a 1024-character cap is cut, flagged, and never held",
    async () => {
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 2);
      let r: Awaited<ReturnType<typeof runHostCommand>>;
      try {
        r = await runHostCommand({
          argv: ["/bin/sh", "-c", "head -c 268435456 /dev/zero"],
          timeoutMs: 60_000,
          maxOutputChars: 1024,
        });
      } finally {
        clearInterval(sampler);
      }
      peak = Math.max(peak, process.memoryUsage().rss);
      // The child ran to the end (drained, not killed), so its exit code is
      // the truth, and the cut is reported.
      expect(r.code).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(r.stdout.length).toBe(1024);
      expect(r.stdoutTruncated).toBe(true);
      expect(r.outputIncomplete).toBeUndefined();
      // 0.7.0 held the whole stream, then a string of it: well over 400 MiB
      // here. Capped as it arrives, the process grows by a few chunk buffers.
      expect(peak - before).toBeLessThan(128 * 1024 * 1024);
    },
    60_000,
  );

  test.if(posix)(
    "output a background process kept open is returned as what arrived, and marked incomplete",
    async () => {
      // The shell exits at once; `sleep` inherits its stdout and holds the
      // pipe open past the drain grace. 0.7.0 answered "" here, which reads
      // as a complete, empty listing.
      const r = await runHostCommand({
        argv: ["/bin/sh", "-c", "printf '/w/a\\000/w/b\\000'; sleep 3 &"],
        timeoutMs: 20_000,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("/w/a\u0000/w/b\u0000");
      expect(r.outputIncomplete).toBe(true);
      expect(r.stdoutTruncated).toBe(true);
    },
    20_000,
  );

  test.if(posix)("a complete short answer carries no flags", async () => {
    const r = await runHostCommand({ argv: ["/bin/sh", "-c", "printf ok"], timeoutMs: 20_000 });
    expect(r).toEqual({ code: 0, stdout: "ok", stderr: "", timedOut: false, missing: false });
  });

  test("a program that is not installed is reported missing", async () => {
    const r = await runHostCommand({
      argv: ["crewhaus-no-such-program-c163"],
      timeoutMs: 20_000,
    });
    expect(r.missing).toBe(true);
    expect(r.code).toBe(127);
  });

  test.if(posix)(
    "a child killed at the deadline reports the timeout and 128 + SIGTERM",
    async () => {
      const r = await runHostCommand({ argv: ["/bin/sh", "-c", "exec sleep 30"], timeoutMs: 200 });
      expect(r.timedOut).toBe(true);
      expect(r.code).toBe(143);
    },
    20_000,
  );
});
