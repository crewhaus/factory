/**
 * Turning a credential helper's exit code and complaint into an answer.
 *
 * "It did not resolve" is three completely different situations, and telling
 * them apart is most of what this package is for:
 *
 *   - **absent** — the helper works and there is no such secret. Fix the name.
 *   - **unavailable** — the helper is not installed here. Fix the machine, or
 *     use another backend.
 *   - **error** — the helper is installed and refused: a locked keychain, no
 *     D-Bus session, a gpg key that cannot decrypt, an expired `op` session.
 *     Nothing about the secret's existence is known, and reporting "absent"
 *     here is the lie that sends an operator to rename a secret that was
 *     there all along.
 *
 * Every string matched below is RECORDED output (see `../fixtures.ts`), and
 * the child's `LC_ALL=C` in `./run` is what keeps these bytes the same on a
 * machine whose operator does not work in English.
 *
 * A timeout and a truncated read are errors with their own reasons, never
 * "absent": a helper killed on the deadline said nothing at all, and a value
 * cut off at the cap would fingerprint to a confident wrong answer.
 */
import { firstLine, stripValues } from "./fingerprint";
import type { SecretRef } from "./refs";
import type { CommandRun } from "./run";

export type BackendOutcome =
  | { readonly status: "resolved"; readonly value: string }
  | { readonly status: "absent"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

/** The program each backend needs, for the "not installed" message. */
export function helperName(kind: SecretRef["kind"]): string {
  switch (kind) {
    case "keychain":
      return "security";
    case "pass":
      return "pass";
    case "libsecret":
      return "secret-tool";
    case "op":
      return "op";
    default:
      return "";
  }
}

/**
 * Does this helper append a newline of its own to the value it prints?
 *
 * Getting this wrong is not cosmetic. An extra `\n` changes the fingerprint,
 * so the same secret read through two backends would be reported as two
 * different secrets, and a rotation would be reported as having taken when it
 * had not.
 *
 *   - `security -w` prints the password and a newline.
 *   - `pass show` cats the entry, which ends with a newline.
 *   - `secret-tool lookup` writes the secret bytes and nothing else — this is
 *     the documented nuisance where a shell prompt runs into the output.
 *   - `op read --no-newline` suppresses the one it would otherwise add.
 */
export function stripsTrailingNewline(kind: SecretRef["kind"]): boolean {
  return kind === "keychain" || kind === "pass";
}

/** Remove exactly ONE trailing newline, never a run of them. */
function unterminate(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * The shared pre-classification: the cases where the outcome is decided
 * without looking at a single backend-specific byte.
 */
function commonFailure(kind: SecretRef["kind"], run: CommandRun): BackendOutcome | undefined {
  if (run.spawnError !== undefined) {
    return {
      status: "unavailable",
      reason: `\`${helperName(kind)}\` is not installed on this machine (${firstLine(run.spawnError)}).`,
    };
  }
  if (run.timedOut) {
    return {
      status: "error",
      reason: `\`${helperName(kind)}\` did not answer before the deadline and was killed — it may be waiting for a passphrase or an unlock prompt that no one can see. Nothing is known about whether the secret exists.`,
    };
  }
  if (run.truncated) {
    return {
      status: "error",
      reason: `\`${helperName(kind)}\` returned more output than this tool will hold, so the value is incomplete. A fingerprint over a cut value would be a confident wrong answer, so none was taken.`,
    };
  }
  return undefined;
}

/**
 * Classify one helper run.
 *
 * `run.stdout` may BE the secret, so every reason built here is passed through
 * `stripValues` with it: a helper that echoes the value into its own
 * diagnostics (they do) must not get it into a tool result by that route.
 */
export function classify(ref: SecretRef, run: CommandRun): BackendOutcome {
  const early = commonFailure(ref.kind, run);
  if (early !== undefined) return early;

  const stderr = stripValues(run.stderr, [run.stdout.trim()]);
  const detail = firstLine(stderr);
  const said = detail === "" ? "no message" : detail;

  if (run.exitCode === 0) {
    const value = stripsTrailingNewline(ref.kind) ? unterminate(run.stdout) : run.stdout;
    // An exit of 0 with nothing on stdout is not a secret. `secret-tool`
    // answers that way for an attribute set that matches nothing on some
    // versions, and treating "" as a resolved value would have the caller
    // configure a service with an empty credential.
    if (value === "") {
      return {
        status: "absent",
        reason: `\`${helperName(ref.kind)}\` succeeded but printed nothing, which means no item matched.`,
      };
    }
    return { status: "resolved", value };
  }

  switch (ref.kind) {
    case "keychain": {
      if (/could not be found in the keychain/i.test(stderr)) {
        return {
          status: "absent",
          reason: `no generic-password item in the keychain matches service "${ref.service}"${ref.account !== undefined ? ` and account "${ref.account}"` : ""}.`,
        };
      }
      if (/User interaction is not allowed|interaction.*not allowed/i.test(stderr)) {
        return {
          status: "error",
          reason:
            "the keychain refused without a prompt (User interaction is not allowed) — it is locked, or this process is not allowed to read that item. Unlock the login keychain, or grant access once in Keychain Access.",
        };
      }
      return { status: "error", reason: `security exited ${run.exitCode}: ${said}` };
    }
    case "pass": {
      if (/is not in the password store/i.test(stderr)) {
        return { status: "absent", reason: `pass has no entry named "${ref.name}".` };
      }
      if (/decryption failed|No secret key|gpg: /i.test(stderr)) {
        return {
          status: "error",
          reason: `gpg could not decrypt the entry: ${said}. The entry exists; the key to read it is missing or locked.`,
        };
      }
      return { status: "error", reason: `pass exited ${run.exitCode}: ${said}` };
    }
    case "libsecret": {
      if (
        /Cannot autolaunch D-Bus|Failed to connect to the session bus|DBUS_SESSION_BUS_ADDRESS/i.test(
          stderr,
        )
      ) {
        return {
          status: "error",
          reason:
            "there is no D-Bus session bus to talk to, so the keyring could not be reached at all (this is the usual shape on a headless box or in CI). Nothing is known about whether the secret exists.",
        };
      }
      // Exit 1 and not a word about it is `secret-tool`'s documented "nothing
      // matched" — and it is the ONLY silent answer that means that. A helper
      // killed by a signal (the OOM killer, a supervisor shutting the harness
      // down) also exits non-zero with an empty stderr, and reading THAT as
      // "no keyring item has service=acme" is a definite answer invented from
      // a probe that never ran. The exit code is the only thing that
      // distinguishes them, so it is checked rather than assumed.
      if (
        /no such secret|not found/i.test(stderr) ||
        (run.exitCode === 1 && stderr.trim() === "")
      ) {
        return {
          status: "absent",
          reason: `no keyring item has ${ref.attribute}=${ref.value}.`,
        };
      }
      if (stderr.trim() === "") {
        return {
          status: "error",
          reason: `secret-tool exited ${run.exitCode} without a message, which is not its "nothing matched" answer (that is exit 1) — it was most likely killed. Nothing is known about whether the secret exists.`,
        };
      }
      return { status: "error", reason: `secret-tool exited ${run.exitCode}: ${said}` };
    }
    case "op": {
      if (/not currently signed in|session expired|no account found/i.test(stderr)) {
        return {
          status: "error",
          reason: `the 1Password CLI is not signed in: ${said}. Sign in, or set OP_SERVICE_ACCOUNT_TOKEN, and try again.`,
        };
      }
      if (
        /isn't an item|isn't a field|could not read secret|no item matches|doesn't exist/i.test(
          stderr,
        )
      ) {
        return { status: "absent", reason: `1Password has nothing at ${ref.uri}: ${said}` };
      }
      return { status: "error", reason: `op exited ${run.exitCode}: ${said}` };
    }
    default:
      return { status: "error", reason: `exited ${run.exitCode}: ${said}` };
  }
}

/**
 * Classify a WRITE. Success is an exit of 0 and nothing more; the value is
 * never echoed back, and the verify step — not this function — is what decides
 * whether the rotation actually took.
 */
export function classifyWrite(ref: SecretRef, run: CommandRun, newValue: string): BackendOutcome {
  const early = commonFailure(ref.kind, run);
  if (early !== undefined) return early;
  if (run.exitCode === 0) return { status: "resolved", value: "" };
  // The new value was on this command's stdin, and a helper that fails can
  // quote its input back. Strip it before the message goes anywhere.
  const stderr = stripValues(run.stderr, [newValue, newValue.trim()]);
  return {
    status: "error",
    reason: `\`${helperName(ref.kind)}\` exited ${run.exitCode}: ${firstLine(stderr) || "no message"}`,
  };
}
