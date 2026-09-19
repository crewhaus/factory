/**
 * The reference grammar — how a caller NAMES a secret without holding one.
 *
 * A reference is a string like `env:SLACK_TOKEN` or `keychain:acme-api#deploy`.
 * It says where to look, never what is there. Every tool in this package takes
 * references as input and returns facts ABOUT them, which is what makes the
 * whole package safe to put in front of a model: the input is a name, the
 * output is a report, and the value itself never appears in either.
 *
 * ── Argument injection ─────────────────────────────────────────────────────
 *
 * Four of the seven backends run a credential helper, and every component of a
 * reference lands in that helper's argv. Passing an argv ARRAY (never a shell
 * string) stops a caller reaching the shell; it does NOT stop them reaching
 * the helper's own option parser. This repo has already shipped exactly that
 * bug once — `gitBranchCreate({name: "-D"})` ran `git branch -D victim` — so
 * every caller-supplied component that becomes an argv element is refused when
 * it begins with `-`, before any command is built.
 *
 * For `pass`, `secret-tool` and `op` that refusal is load-bearing: the value
 * is a bare positional word and the helper would read `--anything` as an
 * option. For `keychain` it is belt-and-braces — the value is the ARGUMENT of
 * `-s`/`-a`, which getopt(3) consumes unconditionally (verified against the
 * real binary: `security find-generic-password -s -weird-svc -a nobody -w`
 * exits 44 "item could not be found", not an option error). Refusing the shape
 * costs a caller nothing either way: no credential is legitimately named `-f`.
 *
 * No `--` terminator is sent to `pass` or `secret-tool`. `pass` parses with a
 * getopt(1) wrapper and libsecret with GOption, and which of them consumes a
 * bare `--` cannot be verified from here — a terminator the helper does not
 * understand turns every lookup into an error. The refusal above removes the
 * shape that would need one. `op` is a cobra CLI, where `--` is part of the
 * framework, so it gets one.
 */

/** A refusal carrying the sentence to return to the caller. */
export type Refusal = { readonly ok: false; readonly message: string };
export type Resolved<T> = { readonly ok: true; readonly value: T } | Refusal;
export const refuse = (message: string): Refusal => ({ ok: false, message });

/** Every way this package knows to find a secret. */
export type SecretRef =
  /** A bare NAME: the local chain (environment, `.env.local`, `.env`, file). */
  | { readonly kind: "auto"; readonly name: string }
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "envfile"; readonly path: string; readonly key: string }
  | { readonly kind: "keychain"; readonly service: string; readonly account?: string }
  | { readonly kind: "pass"; readonly name: string }
  | { readonly kind: "libsecret"; readonly attribute: string; readonly value: string }
  | { readonly kind: "op"; readonly uri: string };

export type BackendId = SecretRef["kind"];

/** Backends that run a helper binary rather than reading a local file. */
export const COMMAND_BACKENDS: ReadonlySet<BackendId> = new Set<BackendId>([
  "keychain",
  "pass",
  "libsecret",
  "op",
]);

/** A shell-safe environment-variable name, and the shape of a `.env` key. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How much of an offending value a refusal repeats back. */
const ECHO = 60;
const echo = (value: string): string =>
  value.length > ECHO ? `${value.slice(0, ECHO)}…` : value.replace(/[\r\n\0]/g, "?");

/**
 * Refuse a component that a helper's option parser would read as a flag, or
 * that cannot survive being passed as one argument.
 */
function checkComponent(what: string, value: string): Refusal | undefined {
  if (value === "") return refuse(`the ${what} is empty.`);
  if (value.startsWith("-")) {
    return refuse(
      `the ${what} "${echo(value)}" begins with "-", which a credential helper would read as an option rather than as a name. No secret is legitimately named that way; rename it, or reach it through a reference that does not put it on a command line.`,
    );
  }
  if (/[\0\n\r]/.test(value)) {
    return refuse(
      `the ${what} contains a newline or a NUL byte, which cannot be passed as a single argument.`,
    );
  }
  return undefined;
}

const HELP = [
  "env:NAME",
  "file:relative/path",
  "envfile:.env#KEY",
  "keychain:service[#account]",
  "pass:path/to/entry",
  "libsecret:attribute=value",
  "op://vault/item/field",
  "or a bare NAME for the local chain",
].join(", ");

/**
 * Parse one reference. Pure: nothing here touches the filesystem or spawns
 * anything, so the grammar can be tested exhaustively without a host.
 *
 * Paths are NOT resolved here. Containment is the caller's step, through
 * `../paths`, at the moment of use — resolving early and using later is how a
 * check-to-use window opens.
 */
export function parseRef(raw: string): Resolved<SecretRef> {
  const input = raw.trim();
  if (input === "") return refuse(`empty reference. Use one of: ${HELP}.`);
  if (/[\0\n\r]/.test(input)) {
    return refuse("a reference may not contain a newline or a NUL byte.");
  }

  // `op://…` is 1Password's own URI, kept in its native spelling so an
  // operator can paste what the 1Password UI shows them.
  if (input.startsWith("op://")) {
    const body = input.slice("op://".length);
    const segments = body.split("/");
    if (segments.length < 3 || segments.some((s) => s === "")) {
      return refuse(
        `"${echo(input)}" is not a complete 1Password reference. It needs a vault, an item and a field: op://vault/item/field.`,
      );
    }
    const bad = checkComponent("1Password reference", input);
    if (bad !== undefined) return bad;
    return { ok: true, value: { kind: "op", uri: input } };
  }

  const colon = input.indexOf(":");
  if (colon === -1) {
    // A bare name is the local chain. It must look like an environment
    // variable, because that is what every step of that chain is keyed by;
    // anything else would be a guess about which backend was meant.
    if (!ENV_NAME_RE.test(input)) {
      return refuse(
        `"${echo(input)}" is not a reference and not a variable name. Use one of: ${HELP}.`,
      );
    }
    return { ok: true, value: { kind: "auto", name: input } };
  }

  const scheme = input.slice(0, colon);
  const rest = input.slice(colon + 1);

  switch (scheme) {
    case "env": {
      if (!ENV_NAME_RE.test(rest)) {
        return refuse(
          `"${echo(rest)}" is not an environment-variable name (letters, digits and underscore, not starting with a digit).`,
        );
      }
      return { ok: true, value: { kind: "env", name: rest } };
    }
    case "file": {
      if (rest === "") return refuse("file: needs a path, e.g. file:.crewhaus/secrets/token.");
      return { ok: true, value: { kind: "file", path: rest } };
    }
    case "envfile": {
      // The LAST `#` splits, so a path containing one is still addressable.
      const hash = rest.lastIndexOf("#");
      if (hash === -1) {
        return refuse(
          `"${echo(input)}" needs a key: envfile:<path>#KEY, e.g. envfile:.env#SLACK_TOKEN.`,
        );
      }
      const path = rest.slice(0, hash);
      const key = rest.slice(hash + 1);
      if (path === "") return refuse("envfile: needs a path before the #.");
      if (!ENV_NAME_RE.test(key)) {
        return refuse(`"${echo(key)}" is not a .env key (letters, digits and underscore).`);
      }
      return { ok: true, value: { kind: "envfile", path, key } };
    }
    case "keychain": {
      const hash = rest.indexOf("#");
      const service = hash === -1 ? rest : rest.slice(0, hash);
      const account = hash === -1 ? undefined : rest.slice(hash + 1);
      const badService = checkComponent("keychain service", service);
      if (badService !== undefined) return badService;
      if (account !== undefined) {
        const badAccount = checkComponent("keychain account", account);
        if (badAccount !== undefined) return badAccount;
      }
      return {
        ok: true,
        value: { kind: "keychain", service, ...(account !== undefined ? { account } : {}) },
      };
    }
    case "pass": {
      const bad = checkComponent("pass entry", rest);
      if (bad !== undefined) return bad;
      return { ok: true, value: { kind: "pass", name: rest } };
    }
    case "libsecret": {
      const eq = rest.indexOf("=");
      if (eq === -1) {
        return refuse(
          `"${echo(input)}" needs an attribute and a value: libsecret:attribute=value, e.g. libsecret:service=acme-api.`,
        );
      }
      const attribute = rest.slice(0, eq);
      const value = rest.slice(eq + 1);
      const badAttr = checkComponent("libsecret attribute", attribute);
      if (badAttr !== undefined) return badAttr;
      const badValue = checkComponent("libsecret value", value);
      if (badValue !== undefined) return badValue;
      return { ok: true, value: { kind: "libsecret", attribute, value } };
    }
    default:
      return refuse(`"${echo(scheme)}:" is not a known backend. Use one of: ${HELP}.`);
  }
}

/** The reference, spelled back the way it was parsed. Never a value. */
export function formatRef(ref: SecretRef): string {
  switch (ref.kind) {
    case "auto":
      return ref.name;
    case "env":
      return `env:${ref.name}`;
    case "file":
      return `file:${ref.path}`;
    case "envfile":
      return `envfile:${ref.path}#${ref.key}`;
    case "keychain":
      return `keychain:${ref.service}${ref.account !== undefined ? `#${ref.account}` : ""}`;
    case "pass":
      return `pass:${ref.name}`;
    case "libsecret":
      return `libsecret:${ref.attribute}=${ref.value}`;
    case "op":
      return ref.uri;
  }
}

/**
 * The argv that READS a secret, as an array, for each command backend.
 *
 * `security -w` prints the password and nothing else. `op read --no-newline`
 * suppresses the newline the CLI otherwise appends — without it every
 * 1Password value would be reported as `trailingNewline: true` and its
 * fingerprint would differ from the same secret read anywhere else.
 */
export function readArgv(ref: SecretRef): readonly string[] | undefined {
  switch (ref.kind) {
    case "keychain":
      return [
        "security",
        "find-generic-password",
        "-s",
        ref.service,
        ...(ref.account !== undefined ? ["-a", ref.account] : []),
        "-w",
      ];
    case "pass":
      return ["pass", "show", ref.name];
    case "libsecret":
      return ["secret-tool", "lookup", ref.attribute, ref.value];
    case "op":
      return ["op", "read", "--no-newline", "--", ref.uri];
    default:
      return undefined;
  }
}

/**
 * The argv that WRITES a secret, for the backends where writing is honest.
 *
 * The new value goes on STDIN, never in argv: `ps` shows every process's
 * command line to every user on the box, so a rotation that passed the value
 * as an argument would publish it at the moment it was created.
 *
 * `keychain` is deliberately absent. `security add-generic-password` takes the
 * password as `-w <value>` and has no stdin form, so this package refuses to
 * rotate a keychain item rather than leak one. `op` is absent for a different
 * reason: writing through `op item edit` requires knowing the item's field
 * schema, and guessing it edits the wrong field.
 */
export function writeArgv(ref: SecretRef): readonly string[] | undefined {
  switch (ref.kind) {
    case "pass":
      // --multiline reads the value from stdin; --force skips the "overwrite?"
      // prompt, which would otherwise block until the deadline.
      return ["pass", "insert", "--multiline", "--force", ref.name];
    case "libsecret":
      // `secret-tool store` reads the secret from stdin by design.
      return [
        "secret-tool",
        "store",
        "--label",
        `crewhaus ${ref.attribute}=${ref.value}`,
        ref.attribute,
        ref.value,
      ];
    default:
      return undefined;
  }
}

/** Why a backend cannot be rotated, in words a caller can act on. */
export function whyNotRotatable(ref: SecretRef): string | undefined {
  switch (ref.kind) {
    case "env":
    case "auto":
      return "an environment variable belongs to a process that is already running; nothing this tool writes could change it. Rotate the file or store the value comes FROM, then restart what reads it.";
    case "keychain":
      return "`security add-generic-password` takes the new password as a command-line argument, and a command line is readable by every process on the machine through `ps`. Rotating a keychain item would publish the value it is meant to protect, so this package does not do it. Use Keychain Access, or `security add-generic-password -U` yourself.";
    case "op":
      return "writing a 1Password field needs the item's field schema (`op item edit`), and guessing it edits the wrong field. Rotate in 1Password, then verify here with SecretLookup.";
    default:
      return undefined;
  }
}
