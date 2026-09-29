/**
 * 0.7.1 — reading a session while it is being saved never fails.
 *
 * `update()` replaces the record by renaming a new file over it. The first
 * 0.7.1 read checked the name, opened it, and refused the file it opened as
 * "replaced while it was being opened" (code `changed`) whenever a save landed
 * in between, which a legitimate save always can. A channel gateway reads the
 * session for the next message on a thread while the runtime saves the last
 * turn, so a `get()` threw at random and the message got no reply; `list()`
 * dropped the session with a misleading "malformed" line.
 *
 * Both tests assert the property over a fixed number of operations (no
 * deadline): every read returns the session, and none fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-read-race-"));
  ROOTS.push(dir);
  return dir;
}

describe("a session read that overlaps a save (0.7.1)", () => {
  test("in one process: every get() while another task saves the session returns it", async () => {
    const store = createSessionStore({ rootDir: root() });
    const session = await store.create({ name: "s", target: "channel", model: "m" });
    const failures: string[] = [];
    let reads = 0;
    let done = false;
    // Two tasks, as a gateway runs them: one saves each turn, one reads for
    // the next message. The reads are bounded by the saves, not by a clock.
    const saver = (async () => {
      for (let n = 0; n < 1500; n++) await store.update(session.id, { lastTurnIndex: n });
      done = true;
    })();
    while (!done) {
      try {
        if ((await store.get(session.id))?.id === session.id) reads += 1;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    await saver;
    expect(failures).toEqual([]);
    // Hit count: the reads interleaved with the saves.
    expect(reads).toBeGreaterThan(100);
    expect((await store.get(session.id))?.lastTurnIndex).toBe(1499);
  }, 60_000);

  test("across processes: reads while another process saves the session all succeed", async () => {
    const dir = root();
    const store = createSessionStore({ rootDir: dir });
    const session = await store.create({ name: "s", target: "channel", model: "m" });
    const writer = join(dir, "writer.ts");
    const index = join(import.meta.dir, "index.ts");
    writeFileSync(
      writer,
      [
        `const { createSessionStore } = await import(${JSON.stringify(index)});`,
        `const store = createSessionStore({ rootDir: ${JSON.stringify(dir)} });`,
        `for (let n = 0; n < 3000; n++) await store.update(${JSON.stringify(session.id)}, { lastTurnIndex: n });`,
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, writer], { stdout: "ignore", stderr: "pipe" });
    let done = false;
    const exited = child.exited.then((code) => {
      done = true;
      return code;
    });
    const failures: string[] = [];
    let reads = 0;
    while (!done) {
      try {
        if ((await store.get(session.id))?.id === session.id) reads += 1;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    expect(await exited).toBe(0);
    expect(failures).toEqual([]);
    // Hit count: the reads overlapped the saves.
    expect(reads).toBeGreaterThan(100);
    expect((await store.get(session.id))?.lastTurnIndex).toBe(2999);
  }, 60_000);
});
