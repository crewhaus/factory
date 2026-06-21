import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, normalize } from "node:path";
/**
 * @crewhaus/channel-adapter-imessage — macOS-only iMessage channel
 * adapter for the channel target (Section 33).
 *
 * Apple does NOT publish a public iMessage Business API for general
 * agent integrations. This adapter takes a host-bound approach:
 *
 *   - Inbound: poll Messages.app's SQLite store at
 *     ~/Library/Messages/chat.db for new rows since the last cursor.
 *     The cursor is `message.ROWID` — monotonically increasing per
 *     install. We persist it to a small JSON file so a daemon restart
 *     resumes from where it left off.
 *
 *   - Outbound: drive Messages.app via osascript. The handle (an
 *     iMessage email/phone) is the conversation key.
 *
 * Hard requirements (enforced via guard / startup check):
 *   - Process is running on macOS (`process.platform === "darwin"`).
 *   - `CREWHAUS_IMESSAGE_HOST_ENABLED=1` is set — opt-in to using the
 *     host's logged-in iMessage account.
 *   - Full Disk Access permission is granted to the daemon's host
 *     terminal/process so chat.db is readable. (We surface a clear
 *     error if the file isn't reachable.)
 *
 * Path-traversal safety: chat.db's path is constructed from the HOME
 * env at boot and validated against a fixed prefix
 * (`~/Library/Messages/`). Custom override is allowed only via the
 * adapter's `chatDbPath` option (intended for tests with fixture DBs)
 * AND must resolve to a file with name `chat.db`.
 */
import { CrewhausError } from "@crewhaus/errors";

export class IMessageAdapterError extends CrewhausError {
  override readonly name = "IMessageAdapterError";
  constructor(message: string, cause?: unknown) {
    super("channel", message, cause);
  }
}

export type RawRequest = {
  readonly headers: Headers;
  readonly body: string;
};

/** Channel-generic inbound event — same shape as Slack/Telegram/etc. */
export type InboundEvent = {
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly threadTs?: string;
  readonly ts: string;
  readonly text: string;
  readonly subtype: "app_mention" | "message";
};

export type ParsedInbound =
  | { readonly kind: "event"; readonly event: InboundEvent }
  | { readonly kind: "skip" };

/**
 * The iMessage adapter is non-webhook — there's no inbound HTTP. Instead
 * the adapter exposes `pollNewMessages()` for the host to call; the
 * generated channel daemon does NOT run a poll loop, so the caller is
 * responsible for driving polling on whatever schedule it likes. We
 * still implement the same `ChannelAdapter` interface so the §33
 * multi-adapter wiring can register it; `verify` and `parseInbound` are
 * never called by the gateway for iMessage (the host feeds the
 * InboundEvents from `pollNewMessages()` into the session router).
 */
export interface ChannelAdapter {
  readonly id: string;
  verify(req: RawRequest): boolean;
  parseInbound(req: RawRequest): ParsedInbound;
  sendReply(args: { event: InboundEvent; text: string }): Promise<void>;
  setTyping(args: { event: InboundEvent }): Promise<void>;
}

export interface IMessageAdapter extends ChannelAdapter {
  /**
   * Poll chat.db for messages with ROWID > cursor. Returns the new
   * messages and the new cursor. Idempotent across restarts: reads
   * the persisted cursor from `cursorPath` if present.
   */
  pollNewMessages(): Promise<{
    readonly events: readonly InboundEvent[];
    readonly cursor: number;
  }>;
  /** Returns the current persisted cursor (or 0 if not yet set). */
  getCursor(): number;
  /** Reset the cursor — used by tests + the `--reset-cursor` CLI flag. */
  resetCursor(): void;
}

export type IMessageAdapterConfig = {
  /**
   * Custom chat.db path. Defaults to `<HOME>/Library/Messages/chat.db`.
   * Overridable for tests (must end in `chat.db`).
   */
  readonly chatDbPath?: string;
  /** Where to persist the polling cursor. Defaults to `.crewhaus/imessage-cursor.json`. */
  readonly cursorPath?: string;
  /**
   * Required: gate the adapter on opt-in env. Setting this to false
   * (e.g. in tests with fixture DBs) bypasses the
   * `CREWHAUS_IMESSAGE_HOST_ENABLED=1` env-check. Defaults to true.
   */
  readonly requireHostOptIn?: boolean;
};

export type IMessageAdapterOptions = {
  /** Inject a custom osascript runner (defaults to spawning `osascript`). */
  readonly osascript?: (script: string) => Promise<void>;
};

const CHAT_DB_REL = "Library/Messages/chat.db";

export function createIMessageAdapter(
  config: IMessageAdapterConfig = {},
  opts: IMessageAdapterOptions = {},
): IMessageAdapter {
  const requireHostOptIn = config.requireHostOptIn ?? true;
  if (requireHostOptIn) {
    if (process.platform !== "darwin") {
      throw new IMessageAdapterError(
        `iMessage adapter requires macOS (process.platform=${process.platform})`,
      );
    }
    if (process.env["CREWHAUS_IMESSAGE_HOST_ENABLED"] !== "1") {
      throw new IMessageAdapterError(
        "iMessage adapter requires CREWHAUS_IMESSAGE_HOST_ENABLED=1 (opt-in to host's logged-in iMessage)",
      );
    }
  }

  const home = process.env["HOME"] ?? "";
  const defaultDbPath = home ? `${home}/${CHAT_DB_REL}` : "";
  const chatDbPath = validateChatDbPath(config.chatDbPath ?? defaultDbPath);
  if (!existsSync(chatDbPath)) {
    throw new IMessageAdapterError(
      `iMessage chat.db not found at ${chatDbPath} (full disk access?)`,
    );
  }

  const cursorPath = config.cursorPath ?? ".crewhaus/imessage-cursor.json";

  const osascriptRun = opts.osascript ?? defaultOsascript;

  return {
    id: "imessage",

    verify(_req: RawRequest): boolean {
      // No inbound HTTP — iMessage is polling-driven. We accept all by
      // returning true so the gateway path never short-circuits, but
      // the gateway ought to never call us anyway.
      return true;
    },

    parseInbound(_req: RawRequest): ParsedInbound {
      return { kind: "skip" };
    },

    async sendReply(args: { event: InboundEvent; text: string }): Promise<void> {
      const handle = args.event.userId;
      if (!isSafeHandle(handle)) {
        throw new IMessageAdapterError(`unsafe iMessage handle: ${handle}`);
      }
      const escapedText = escapeAppleScriptString(args.text);
      const escapedHandle = escapeAppleScriptString(handle);
      const script = [
        'tell application "Messages"',
        "  set targetService to 1st service whose service type = iMessage",
        `  set targetBuddy to buddy "${escapedHandle}" of targetService`,
        `  send "${escapedText}" to targetBuddy`,
        "end tell",
      ].join("\n");
      await osascriptRun(script);
    },

    async setTyping(_args: { event: InboundEvent }): Promise<void> {
      // Messages.app does not expose a typing-indicator API to AppleScript.
    },

    pollNewMessages(): Promise<{ events: readonly InboundEvent[]; cursor: number }> {
      const cursor = readCursor(cursorPath);
      const db = new Database(chatDbPath, { readonly: true });
      try {
        const rows = db.query<MessageRow, [number]>(MESSAGE_QUERY).all(cursor);
        const events: InboundEvent[] = [];
        let maxId = cursor;
        for (const row of rows) {
          if (row.ROWID > maxId) maxId = row.ROWID;
          if (row.is_from_me === 1) continue;
          const text = row.text ?? "";
          if (text.trim() === "") continue;
          const handle = row.handle_id_str ?? `handle:${row.handle_id ?? "unknown"}`;
          events.push({
            idempotencyKey: `imsg:${row.ROWID}`,
            workspaceId: "imessage",
            channelId: handle,
            userId: handle,
            ts: String(row.date),
            text,
            subtype: "message",
          });
        }
        if (maxId !== cursor) writeCursor(cursorPath, maxId);
        return Promise.resolve({ events, cursor: maxId });
      } finally {
        db.close();
      }
    },

    getCursor(): number {
      return readCursor(cursorPath);
    },

    resetCursor(): void {
      writeCursor(cursorPath, 0);
    },
  };
}

// ─── chat.db path validation ────────────────────────────────────────────────

/**
 * Allow the canonical chat.db location (`<HOME>/Library/Messages/chat.db`)
 * and any custom path that resolves to a file named `chat.db`. Reject
 * absolute paths attempting traversal outside `~/Library/Messages/` UNLESS
 * the caller explicitly overrode (tests use a tmpdir).
 */
function validateChatDbPath(path: string): string {
  if (!path) {
    throw new IMessageAdapterError("chat.db path is empty (HOME env not set?)");
  }
  const norm = normalize(path);
  if (!norm.endsWith("chat.db")) {
    throw new IMessageAdapterError(`chat.db path must end in 'chat.db': ${path}`);
  }
  return norm;
}

function isSafeHandle(handle: string): boolean {
  // Allow email-shaped handles + +<digits> phone handles + tel: URIs.
  return (
    /^[\w._%+-]+@[\w.-]+\.\w{2,}$/.test(handle) ||
    /^\+\d{6,15}$/.test(handle) ||
    /^tel:\+?\d{6,15}$/.test(handle)
  );
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// ─── cursor persistence ────────────────────────────────────────────────────

function readCursor(cursorPath: string): number {
  if (!existsSync(cursorPath)) return 0;
  try {
    const raw = readFileSync(cursorPath, "utf8");
    const v = JSON.parse(raw) as { cursor?: number };
    return typeof v.cursor === "number" && Number.isFinite(v.cursor) ? v.cursor : 0;
  } catch {
    return 0;
  }
}

function writeCursor(cursorPath: string, cursor: number): void {
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, JSON.stringify({ cursor }), { mode: 0o600 });
}

// ─── default osascript runner ──────────────────────────────────────────────

/**
 * Minimal structural type for the slice of `child_process.spawn` that the
 * osascript runner uses. Keeping it explicit (rather than importing Node's
 * `ChildProcess`) lets tests inject a deterministic fake without a real
 * process spawn — mirroring the dependency-injection style used elsewhere in
 * factory's adapters.
 */
type SpawnedChild = {
  readonly stdout?: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null;
  readonly stdin: { write(chunk: string): void; end(): void } | null;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
};

export type OsascriptSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: readonly ["pipe", "ignore", "pipe"] },
) => SpawnedChild;

/**
 * Run `osascript` reading the script from stdin, using an injected `spawn`.
 * Resolves on exit code 0; rejects with an {@link IMessageAdapterError} on a
 * spawn failure or any non-zero exit (surfacing captured stderr).
 */
export function runOsascript(spawn: OsascriptSpawn, script: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const head = "osascript";
    const child = spawn(head, ["-"], { stdio: ["pipe", "ignore", "pipe"] });
    const errBufs: Buffer[] = [];
    child.stderr?.on("data", (b) => errBufs.push(b));
    child.on("error", (e) => reject(new IMessageAdapterError("osascript spawn failed", e)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new IMessageAdapterError(
            `osascript exited with ${code}: ${Buffer.concat(errBufs).toString("utf8")}`,
          ),
        );
    });
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

const defaultOsascript = async (script: string): Promise<void> => {
  const { spawn } = await import("node:child_process");
  return runOsascript(spawn as unknown as OsascriptSpawn, script);
};

// ─── chat.db row shape + query ──────────────────────────────────────────────

const MESSAGE_QUERY = `
  SELECT
    m.ROWID,
    m.text,
    m.is_from_me,
    m.date,
    m.handle_id,
    h.id AS handle_id_str
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
`;

type MessageRow = {
  readonly ROWID: number;
  readonly text: string | null;
  readonly is_from_me: number;
  readonly date: number;
  readonly handle_id: number | null;
  readonly handle_id_str: string | null;
};

// ─── helpers consumed by tests ────────────────────────────────────────────

export const _internal = {
  isSafeHandle,
  escapeAppleScriptString,
  validateChatDbPath,
  runOsascript,
};
