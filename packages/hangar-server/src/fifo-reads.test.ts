/**
 * A named pipe reads as nothing, at once: Home opens a harness's files without waiting
 * and reads only regular files. Each case runs in a child process (`__test__/fifo-reads.ts`)
 * that this test kills at its deadline, so a read that waited fails the test instead of
 * freezing the runner. No process ever writes to the pipes.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "__test__", "fifo-reads.ts");
/** How long a child may take to boot a Home and answer, on a loaded runner. */
const CHILD_DEADLINE_MS = 25_000;

/** Run one scenario; its statuses, or `"timed out"` when it was killed at the deadline. */
async function probe(scenario: string): Promise<Record<string, number> | "timed out"> {
  const child = Bun.spawn([process.execPath, PROBE, scenario], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, CHILD_DEADLINE_MS);
  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (killed) return "timed out";
    const line = out.trim().split("\n").at(-1) ?? "";
    if (child.exitCode !== 0 || line === "") {
      throw new Error(`probe ${scenario} exited ${child.exitCode}: ${err.slice(-2000)}`);
    }
    return JSON.parse(line) as Record<string, number>;
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.platform === "win32")("a named pipe in a harness", () => {
  test("a named pipe reads as no runfile, and a harness answers", async () => {
    expect(await probe("runfile")).toEqual({ harness: 200, capabilities: 200 });
  }, 40_000); // a child that boots a Home; bounded by CHILD_DEADLINE_MS

  test("a named pipe reads as no run records, and a harness answers", async () => {
    expect(await probe("ledger")).toEqual({ harness: 200, capabilities: 200 });
  }, 40_000); // a child that boots a Home; bounded by CHILD_DEADLINE_MS

  test("a named pipe reads as empty content in the wiki, continuity and settings routes", async () => {
    const answered = await probe("capped");
    expect(answered).not.toBe("timed out");
    const statuses = answered as Record<string, number>;
    expect(statuses["wiki"]).toBe(200);
    expect(statuses["continuity"]).toBe(200);
    // A settings file that is not a regular file is neither shown nor replaced.
    expect(statuses["settings"]).toBe(409);
  }, 40_000); // a child that boots a Home; bounded by CHILD_DEADLINE_MS

  test("a named pipe beside the settings file never holds up a settings write", async () => {
    expect(await probe("settings-beside")).toEqual({ settings: 200 });
  }, 40_000); // a child that boots a Home; bounded by CHILD_DEADLINE_MS
});
