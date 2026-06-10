/**
 * Coverage for the production `defaultOsascript` path — the branch that
 * dynamically `import("node:child_process")` and spawns the real `osascript`.
 *
 * Calling `sendReply` without an injected `osascript` runner exercises that
 * default. To keep the test deterministic (no real process, no real iMessage
 * send) we replace `node:child_process` with a fake `spawn` via `mock.module`.
 *
 * This lives in its own file so only these tests see the mock — but Bun does
 * NOT reset module mocks at the file boundary: `bun test` runs every file in
 * one process, file order is nondeterministic, and a `mock.module` persists
 * until overwritten. The `afterAll` below re-mocks the real module so the
 * fake `spawn` cannot leak into files that happen to run later.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildFixtureChatDb } from "./fixtures/build-chat-db";

// Captured BEFORE the mock below so afterAll can reinstall the real module.
const realChildProcess = require("node:child_process") as typeof import("node:child_process");

/** Records the scripts handed to the fake `osascript` across the file. */
const writtenScripts: string[] = [];
let nextExit = 0;

mock.module("node:child_process", () => ({
  spawn: (command: string, args: readonly string[], options: unknown) => {
    // Sanity-check the default runner invokes osascript reading from stdin.
    expect(command).toBe("osascript");
    expect(args).toEqual(["-"]);
    expect(options).toEqual({ stdio: ["pipe", "ignore", "pipe"] });
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdin: { write(s: string): void; end(): void };
    };
    child.stderr = new EventEmitter();
    child.stdin = {
      write: (s: string) => writtenScripts.push(s),
      end: () => {},
    };
    queueMicrotask(() => {
      if (nextExit === 0) {
        child.emit("close", 0);
      } else {
        child.stderr.emit("data", Buffer.from("osascript boom", "utf8"));
        child.emit("close", nextExit);
      }
    });
    return child;
  },
}));

afterAll(() => {
  // Bun has no mock.module restore API; re-mocking with the real exports is
  // the documented way to undo a module mock. Without this, the fake `spawn`
  // (which asserts it is called as `osascript`) stays registered for every
  // test file that runs after this one.
  mock.module("node:child_process", () => realChildProcess);
});

// Import AFTER registering the mock so the dynamic import inside
// defaultOsascript resolves to the fake.
const { createIMessageAdapter } = await import("./index");

function makeAdapter() {
  const dbPath = buildFixtureChatDb();
  const cursorPath = join(dirname(dbPath), "cursor.json");
  const adapter = createIMessageAdapter({
    chatDbPath: dbPath,
    cursorPath,
    requireHostOptIn: false,
  });
  return { adapter, cleanup: () => rmSync(dirname(dbPath), { recursive: true, force: true }) };
}

const baseEvent = {
  idempotencyKey: "imsg:1",
  workspaceId: "imessage",
  channelId: "alice@example.com",
  userId: "alice@example.com",
  ts: "0",
  text: "in",
  subtype: "message",
} as const;

describe("defaultOsascript (real-runner branch, child_process mocked)", () => {
  test("sendReply with no injected runner spawns osascript and writes the script", async () => {
    nextExit = 0;
    writtenScripts.length = 0;
    const { adapter, cleanup } = makeAdapter();
    try {
      await adapter.sendReply({ event: baseEvent, text: "hello from default" });
      expect(writtenScripts.length).toBe(1);
      expect(writtenScripts[0]).toContain('tell application "Messages"');
      expect(writtenScripts[0]).toContain('send "hello from default"');
    } finally {
      cleanup();
    }
  });

  test("sendReply rejects when the spawned osascript exits non-zero", async () => {
    nextExit = 3;
    writtenScripts.length = 0;
    const { adapter, cleanup } = makeAdapter();
    try {
      await expect(adapter.sendReply({ event: baseEvent, text: "x" })).rejects.toThrow(
        /osascript exited with 3: osascript boom/,
      );
    } finally {
      cleanup();
    }
  });
});
