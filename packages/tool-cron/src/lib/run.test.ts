/**
 * The real runner (C078), driven with `sh` rather than a scheduler, so it
 * asserts the same thing on every machine. `_setRunner(undefined)` restores
 * it; the suite's other files install their own fakes and restore it too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DRAIN_GRACE_MS, MAX_OUTPUT_CHARS, _setRunner, runHost, unreadableReason } from "./run";

afterEach(() => _setRunner(undefined));

describe.skipIf(process.platform === "win32")("the real runner", () => {
  test("output a leftover process holds open is kept, and marked incomplete", async () => {
    _setRunner(undefined);
    const r = await runHost({ argv: ["sh", "-c", "echo row; sleep 5 &"], timeoutMs: 5_000 });
    // 0.7.0: stdout "" and no flag, which every reader took for an empty listing.
    expect(r.stdout).toBe("row\n");
    expect(r.outputIncomplete).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(unreadableReason(r, "sh", 5_000)).toBe(
      `sh exited, but a process it started kept its output open past ${DRAIN_GRACE_MS}ms, so what came back may be incomplete`,
    );
  }, 20_000);

  test("a complete listing is complete, and a long one is a flagged prefix", async () => {
    _setRunner(undefined);
    const ok = await runHost({ argv: ["sh", "-c", "echo one; echo two"] });
    expect(ok).toMatchObject({ exitCode: 0, stdout: "one\ntwo\n", timedOut: false });
    expect(ok.outputIncomplete).toBeUndefined();
    expect(unreadableReason(ok, "sh", 5_000)).toBeUndefined();

    const big = await runHost({
      argv: ["sh", "-c", `head -c ${MAX_OUTPUT_CHARS * 4} /dev/zero | tr '\\0' x`],
    });
    expect(big.stdout.length).toBe(MAX_OUTPUT_CHARS);
    expect(big.stdoutTruncated).toBe(true);
    expect(unreadableReason(big, "sh", 5_000)).toContain("PREFIX");
  }, 20_000);

  test("a command killed at its deadline still returns what it printed", async () => {
    _setRunner(undefined);
    const r = await runHost({ argv: ["sh", "-c", "echo partial; sleep 5"], timeoutMs: 1_000 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("partial\n");
    expect(unreadableReason(r, "sh", 1_000)).toContain("did not finish");
  }, 20_000);
});
