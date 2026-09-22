/**
 * Recorded credential-helper output, and a runner that replays it.
 *
 * These tools read a real machine, and a machine is the worst possible test
 * fixture: CI is Linux and has no keychain, the author's laptop is macOS and
 * has no `secret-tool`, and a test that asks the host a question passes on one
 * and reports something different on the other. So every parser in this
 * package takes its input through `_setRunner`, and every test drives it from
 * the strings below.
 *
 * ── Provenance, per fixture ────────────────────────────────────────────────
 *
 * Marked **captured**: run on this machine and pasted verbatim, byte for byte.
 * Marked **transcribed**: the helper's documented/known output for a state
 * that cannot be produced safely or at all here (a locked keychain cannot be
 * locked from a test; `pass`, `secret-tool` and `op` are not installed on the
 * machine this was written on). A transcribed fixture proves the classifier
 * handles the shape it claims to handle; it does not prove the helper emits
 * exactly those bytes. Where the difference matters the classifier matches a
 * distinctive PHRASE rather than a whole line, and the fallback for an
 * unrecognised message is `error` — never `absent` — so a fixture that has
 * drifted degrades into "the helper said something we do not understand"
 * rather than into "your secret does not exist".
 */
import type { CommandRun } from "./lib/run";

/** The secret every "it resolved" fixture carries. Nothing may echo it. */
export const SECRET = "sk-live-9f3c1ad2b47e5c8091d6a4f7e2b0c3d5";
/** A second one, for "are these two the same secret?" tests. */
export const OTHER_SECRET = "sk-live-0000111122223333444455556666777";

type Partialish = Partial<CommandRun> & { readonly argv?: readonly string[] };

const run = (over: Partialish): CommandRun => ({
  argv: over.argv ?? [],
  exitCode: over.exitCode ?? 0,
  stdout: over.stdout ?? "",
  stderr: over.stderr ?? "",
  truncated: over.truncated ?? false,
  timedOut: over.timedOut ?? false,
  ...(over.spawnError !== undefined ? { spawnError: over.spawnError } : {}),
});

// ─── macOS: security(1) ─────────────────────────────────────────────────────

/**
 * **captured** — macOS 26.6.2 (build 25G83), 2026-09-18:
 *   $ security find-generic-password -s crewhaus-tool-secrets-absent-xyz -a nobody -w
 * Exit 44, and this exact line on stderr.
 */
export const SECURITY_NOT_FOUND = run({
  exitCode: 44,
  stderr:
    "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
});

/**
 * **captured** — same machine, same day. The point of this one is that a
 * service name beginning with `-` is consumed as the ARGUMENT of `-s` by
 * getopt(3) rather than read as an option: the command reports "not found",
 * not "illegal option".
 *   $ security find-generic-password -s -weird-svc -a nobody -w
 */
export const SECURITY_DASH_SERVICE_NOT_FOUND = SECURITY_NOT_FOUND;

/**
 * **captured** — the shape of `security`'s own option error, for contrast:
 *   $ security find-generic-password -s x -a y -w --bogus
 */
export const SECURITY_ILLEGAL_OPTION = run({
  exitCode: 1,
  stderr:
    "find-generic-password: illegal option -- -\nUsage: find-generic-password [-h] [-a account] [-s service] [options...] [-g] [keychain...]\n",
});

/** **transcribed** — a found item: `-w` prints the password and a newline. */
export const SECURITY_FOUND = run({ exitCode: 0, stdout: `${SECRET}\n` });

/**
 * **transcribed** — errSecInteractionNotAllowed. This is what a locked login
 * keychain (or an item this binary has no ACL entry for) answers with, and it
 * must never be classified as "absent": the item is there.
 *
 * The exit code below is a placeholder non-zero, not a recorded number — a
 * locked keychain cannot be produced from a test, and nothing in the package
 * keys on the number. The classifier matches the PHRASE, which is the part
 * that is documented.
 */
export const SECURITY_LOCKED = run({
  exitCode: 1,
  stderr: "security: SecKeychainItemCopyContent (<NULL>): User interaction is not allowed.\n",
});

// ─── Linux/macOS: pass(1) ───────────────────────────────────────────────────

/** **transcribed** — `pass show` cats the entry, which ends with a newline. */
export const PASS_FOUND = run({ exitCode: 0, stdout: `${SECRET}\n` });

/** **transcribed** — password-store's own not-found message. */
export const PASS_NOT_FOUND = run({
  exitCode: 1,
  stderr: "Error: acme/deploy is not in the password store.\n",
});

/** **transcribed** — the entry exists; the key to decrypt it does not. */
export const PASS_GPG_LOCKED = run({
  exitCode: 2,
  stderr: "gpg: decryption failed: No secret key\n",
});

// ─── Linux: secret-tool(1), libsecret ───────────────────────────────────────

/**
 * **transcribed** — `secret-tool lookup` writes the secret bytes and nothing
 * else. The missing trailing newline is the documented nuisance where a shell
 * prompt runs into the output, and it is why this backend's value is NOT
 * un-terminated by the classifier.
 */
export const SECRET_TOOL_FOUND = run({ exitCode: 0, stdout: SECRET });

/** **transcribed** — nothing matched: exit 1, and not a word about it. */
export const SECRET_TOOL_ABSENT = run({ exitCode: 1 });

/**
 * **transcribed** — the headless/CI shape. There is no session bus, so the
 * keyring was never reached and NOTHING is known about the secret.
 */
export const SECRET_TOOL_NO_DBUS = run({
  exitCode: 1,
  stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n",
});

// ─── 1Password CLI: op(1) ───────────────────────────────────────────────────

/** **transcribed** — `--no-newline` means exactly the value, no terminator. */
export const OP_FOUND = run({ exitCode: 0, stdout: SECRET });

/** **transcribed** — a reference that names nothing. */
export const OP_ABSENT = run({
  exitCode: 1,
  stderr:
    '[ERROR] 2026/09/18 12:00:00 "op://Private/Acme/credential" isn\'t an item. Specify the item with its UUID, name, or domain.\n',
});

/** **transcribed** — signed out. The item may well exist; we cannot tell. */
export const OP_SIGNED_OUT = run({
  exitCode: 1,
  stderr:
    "[ERROR] 2026/09/18 12:00:01 You are not currently signed in. Please run `op signin --help` for instructions\n",
});

// ─── not installed, and other failures ──────────────────────────────────────

/**
 * **captured** — Bun 1.3.14 on macOS, 2026-09-18: `Bun.spawn` THROWS
 * synchronously when the program is not on PATH, and `spawnRunner` turns that
 * into this. It is how "the backend is not installed here" is detected,
 * instead of probing PATH and racing the answer.
 */
export const NOT_INSTALLED = (program: string): CommandRun =>
  run({ spawnError: `Executable not found in $PATH: "${program}"` });

/** A helper killed on the deadline: it said nothing, so nothing is known. */
export const TIMED_OUT = run({ exitCode: -1, timedOut: true });

/** A value longer than the cap: what came back is not the whole secret. */
export const TRUNCATED = run({ exitCode: 0, stdout: `${SECRET}...`, truncated: true });

/** A helper that echoes the secret into its own diagnostics. They do. */
export const ECHOES_THE_VALUE = run({
  exitCode: 1,
  stdout: SECRET,
  stderr: `pass: could not write "${SECRET}" to the store\n`,
});

// ─── .env files, as humans and other tools leave them ───────────────────────

/** A hand-maintained file: comments, sections, blanks, an `export`, a stub. */
export const ENV_HANDWRITTEN = [
  "# Acme harness credentials",
  "# (regenerate with `crewhaus services setup`)",
  "",
  "SLACK_BOT_TOKEN=xoxb-000000-111111",
  "export ANTHROPIC_API_KEY=sk-ant-aaaa",
  "",
  "# Optional — set to enable the nightly job",
  "# NIGHTLY_WEBHOOK=",
  "LOG_LEVEL=debug # how chatty the daemon is",
  "",
].join("\n");

/**
 * The same file as a Windows editor leaves it. Rewriting this with LF endings
 * would be a whole-file diff produced by a tool asked to change one line.
 */
export const ENV_CRLF = ENV_HANDWRITTEN.split("\n").join("\r\n");

/** A file that disagrees with itself: the LAST assignment is what is read. */
export const ENV_DUPLICATE = ["API_KEY=first", "OTHER=x", "API_KEY=second", ""].join("\n");

/**
 * Values that only survive a round trip if the reader and the writer agree.
 * `QUOTED_BACKSLASH` and `QUOTED_QUOTE` are the exact shapes factory#452 was
 * about: a writer escaped them, the readers did not unescape, and the value
 * came back altered.
 */
export const ENV_QUOTED = [
  "PLAIN=hello",
  'QUOTED_SPACE="two words"',
  'QUOTED_QUOTE="a\\"b"',
  'QUOTED_BACKSLASH="c\\\\d"',
  "SINGLE='literal \\n stays'",
  "TRAILING_COMMENT=value # not part of it",
  "",
].join("\n");

/** No trailing newline: appending must not graft onto the last line. */
export const ENV_NO_TRAILING_NEWLINE = "A=1\nB=2";

// ─── the runner ─────────────────────────────────────────────────────────────

export type RunnerTable = Record<string, CommandRun>;

export type RecordedRunner = {
  /** Every argv this runner was asked to run, joined with spaces. */
  readonly calls: string[][];
  /** Every stdin it was handed, index-aligned with `calls`. */
  readonly stdins: (string | undefined)[];
  run: (argv: readonly string[], options: { stdin?: string }) => Promise<CommandRun>;
};

/**
 * A runner that replays a table keyed by the exact argv.
 *
 * Keying on the WHOLE argv is the point: a test that asserts the classifier's
 * answer also asserts, implicitly, that the tool built the argv it was
 * supposed to. An unexpected command is a loud failure rather than a silent
 * default, because "the tool ran something else" is exactly the bug class this
 * package is guarding against.
 */
export function recordedRunner(table: RunnerTable): RecordedRunner {
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  return {
    calls,
    stdins,
    run: async (argv, options) => {
      calls.push([...argv]);
      stdins.push(options.stdin);
      const key = argv.join(" ");
      const found = table[key];
      if (found === undefined) {
        throw new Error(
          `the tool ran a command no fixture covers: ${key}\nknown: ${Object.keys(table).join(" | ")}`,
        );
      }
      return { ...found, argv: [...argv] };
    },
  };
}
