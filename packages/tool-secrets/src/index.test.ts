/**
 * The three tools, through their own schemas and their own `execute`.
 *
 * Two claims run through the whole file and are ASSERTED rather than trusted:
 *
 *   1. No result ever contains a secret value. The last describe block scans
 *      every string these tests collected, and asserts its own hit count —
 *      a scan that quietly matched nothing is a green test proving nothing.
 *   2. No test asks the host a question. The environment, the clock, the
 *      randomness and every command come from seams; the only filesystem is a
 *      temp directory made per test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  ENV_DUPLICATE,
  ENV_HANDWRITTEN,
  NOT_INSTALLED,
  OTHER_SECRET,
  PASS_FOUND,
  PASS_NOT_FOUND,
  SECRET,
  SECURITY_FOUND,
  SECURITY_LOCKED,
  SECURITY_NOT_FOUND,
  recordedRunner,
} from "./fixtures";
import {
  SECRETS_TOOLS,
  _setClock,
  _setEnv,
  _setRandomBytes,
  _setRunner,
  envFileUpsert,
  fingerprint,
  secretLookup,
  secretRotate,
} from "./index";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const originalCwd = process.cwd();
let workspace: string;

/** Everything every tool returned in this file, for the leak scan at the end. */
const everythingReturned: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this, and no tool here reads more than `signal`.
const ctx = {} as any;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-secrets-"));
  process.chdir(workspace);
  _setClock(() => NOW);
  _setEnv({});
  _setRunner(async (argv) => {
    throw new Error(`no fixture runner installed, but the tool ran: ${argv.join(" ")}`);
  });
  _setRandomBytes((size) => new Uint8Array(size).fill(7));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setClock(undefined);
  _setEnv(undefined);
  _setRunner(undefined);
  _setRandomBytes(undefined);
});

async function raw(tool: RegisteredTool, input: unknown, withCtx = ctx): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  const result = (await tool.execute(parsed.data, withCtx)) as string;
  everythingReturned.push(result);
  return result;
}

/** A tool result is arbitrary JSON; asserting on its fields is the point. */
// biome-ignore lint/suspicious/noExplicitAny: the shape under test is JSON the tool chose.
type Json = Record<string, any>;

async function call<T = Json>(tool: RegisteredTool, input: unknown, withCtx = ctx): Promise<T> {
  const text = await raw(tool, input, withCtx);
  if (!text.startsWith("{")) throw new Error(`expected JSON, got a refusal: ${text}`);
  return JSON.parse(text) as T;
}

/** A refusal is a plain sentence, not JSON. */
async function refusal(tool: RegisteredTool, input: unknown): Promise<string> {
  const text = await raw(tool, input);
  if (text.startsWith("{")) throw new Error(`expected a refusal, got a result: ${text}`);
  return text;
}

const envFile = (name = ".env"): string => join(workspace, name);
const readEnv = (name = ".env"): string => readFileSync(envFile(name), "utf8");

// ---------------------------------------------------------------------------
// SecretLookup
// ---------------------------------------------------------------------------

describe("SecretLookup", () => {
  test("a set environment variable resolves, with a fingerprint and no value", async () => {
    _setEnv({ SLACK_TOKEN: SECRET });
    const result = await call(secretLookup, { refs: ["env:SLACK_TOKEN"] });
    const [first] = result.results;
    expect(first.resolved).toBe(true);
    expect(first.backend).toBe("env");
    expect(first.fingerprint).toBe(fingerprint(SECRET));
    expect(first.length).toBe(SECRET.length);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.allResolved).toBe(true);
  });

  test("there is no option anywhere that would return the value", () => {
    const shape = JSON.stringify(secretLookup.inputSchema);
    for (const forbidden of ["reveal", "plaintext", "showValue", "unsafe"]) {
      expect(shape.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(secretLookup.readOnly).toBe(true);
  });

  test("an unset variable is absent, and says so in those words", async () => {
    const result = await call(secretLookup, { refs: ["env:NOPE"] });
    expect(result.results[0].status).toBe("absent");
    expect(result.results[0].reason).toContain("not set");
    expect(result.allResolved).toBe(false);
  });

  test("a trailing newline — the invisible one-byte bug — is reported", async () => {
    writeFileSync(envFile("token.txt"), `${SECRET}\n`);
    const result = await call(secretLookup, { refs: ["file:token.txt"] });
    expect(result.results[0].trailingNewline).toBe(true);
    expect(result.results[0].fingerprint).toBe(fingerprint(`${SECRET}\n`));
  });

  test("two references to the same secret carry the same fingerprint", async () => {
    _setEnv({ A: SECRET, B: SECRET, C: OTHER_SECRET });
    const result = await call(secretLookup, { refs: ["env:A", "env:B", "env:C"] });
    const [a, b, c] = result.results;
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  test("an invalid reference is reported per-reference, not as a whole-call failure", async () => {
    _setEnv({ GOOD: SECRET });
    const result = await call(secretLookup, { refs: ["env:GOOD", "vault:nope"] });
    expect(result.results[0].resolved).toBe(true);
    expect(result.results[1].status).toBe("invalid");
    expect(result.checked).toBe(2);
  });

  test("a cancelled scan does not claim that every reference resolved", async () => {
    _setEnv({ A: SECRET });
    const controller = new AbortController();
    controller.abort();
    const result = await call(
      secretLookup,
      { refs: ["env:A", "env:B", "env:C"] },
      { signal: controller.signal },
    );
    // One reference was checked and it resolved. Saying "allResolved" about
    // three references when two were never looked at is a preflight that
    // green-lights credentials nobody checked.
    expect(result.checked).toBe(1);
    expect(result.requested).toBe(3);
    expect(result.allResolved).toBe(false);
    expect(result.incomplete).toContain("never checked");
  });

  test('a path that cannot be EXAMINED is an error, not "does not exist"', async () => {
    // A regular file standing where a directory should be: stat fails with
    // ENOTDIR. Only ENOENT means the secret is absent; every other errno
    // (ENOTDIR, EACCES, ELOOP) means the question was never answered, and
    // reporting those as absent sends an operator to re-create a credential
    // that may be sitting right there.
    writeFileSync(join(workspace, "blocker"), "x");
    const result = await call(secretLookup, { refs: ["file:blocker/secret"] });
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].reason).toContain("not a directory");
    expect(result.results[0].reason).toContain("Nothing is known");
  });

  test("a path that escapes the workspace is refused, not read", async () => {
    const result = await call(secretLookup, { refs: ["file:../../../etc/passwd"] });
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].reason).toContain("outside the workspace root");
  });

  describe("command backends", () => {
    test("macOS keychain: resolves through the exact argv, value never returned", async () => {
      const runner = recordedRunner({
        "security find-generic-password -s acme-api -a deploy -w": SECURITY_FOUND,
      });
      _setRunner(runner.run);
      const result = await call(secretLookup, { refs: ["keychain:acme-api#deploy"] });
      expect(result.results[0].resolved).toBe(true);
      expect(result.results[0].fingerprint).toBe(fingerprint(SECRET));
      expect(runner.calls[0]).toEqual([
        "security",
        "find-generic-password",
        "-s",
        "acme-api",
        "-a",
        "deploy",
        "-w",
      ]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    test("not found is absent", async () => {
      _setRunner(
        recordedRunner({ "security find-generic-password -s acme-api -w": SECURITY_NOT_FOUND }).run,
      );
      const result = await call(secretLookup, { refs: ["keychain:acme-api"] });
      expect(result.results[0].status).toBe("absent");
    });

    test("a locked keychain is an error — the operator is not sent to rename a secret", async () => {
      _setRunner(
        recordedRunner({ "security find-generic-password -s acme-api -w": SECURITY_LOCKED }).run,
      );
      const result = await call(secretLookup, { refs: ["keychain:acme-api"] });
      expect(result.results[0].status).toBe("error");
      expect(result.results[0].reason).toContain("locked");
    });

    test("a helper that is not installed (CI's shape) is unavailable, not absent", async () => {
      _setRunner(
        recordedRunner({ "secret-tool lookup service acme": NOT_INSTALLED("secret-tool") }).run,
      );
      const result = await call(secretLookup, { refs: ["libsecret:service=acme"] });
      expect(result.results[0].status).toBe("unavailable");
      expect(result.results[0].reason).toContain("not installed");
    });
  });

  describe("a bare name: the whole local chain", () => {
    test("the environment wins, and the .env that disagrees is reported", async () => {
      _setEnv({ SLACK_TOKEN: SECRET });
      writeFileSync(envFile(), `SLACK_TOKEN=${OTHER_SECRET}\n`);
      const result = await call(secretLookup, { refs: ["SLACK_TOKEN"] });
      const [first] = result.results;
      expect(first.resolved).toBe(true);
      expect(first.wonBy).toBe("env:SLACK_TOKEN");
      expect(first.fingerprint).toBe(fingerprint(SECRET));
      expect(first.alsoDefinedIn[0].sameValue).toBe(false);
      expect(first.warning).toContain("2 places with different values");
      expect(JSON.stringify(result)).not.toContain(OTHER_SECRET);
    });

    test("the same value in two places is not a warning", async () => {
      _setEnv({ SLACK_TOKEN: SECRET });
      writeFileSync(envFile(), `SLACK_TOKEN=${SECRET}\n`);
      const result = await call(secretLookup, { refs: ["SLACK_TOKEN"] });
      expect(result.results[0].alsoDefinedIn[0].sameValue).toBe(true);
      expect(result.results[0].warning).toBeUndefined();
    });

    test(".env.local beats .env, matching the harness's own precedence", async () => {
      writeFileSync(envFile(".env"), `TOKEN=${OTHER_SECRET}\n`);
      writeFileSync(envFile(".env.local"), `TOKEN=${SECRET}\n`);
      const result = await call(secretLookup, { refs: ["TOKEN"] });
      expect(result.results[0].wonBy).toBe("envfile:.env.local#TOKEN");
      expect(result.results[0].fingerprint).toBe(fingerprint(SECRET));
    });

    test("a place that outranks the winner and could not be checked is reported", async () => {
      // `.env.local` outranks `.env`. Here it cannot be read at all, so the
      // value found in `.env` is only the winner IF `.env.local` holds
      // nothing — which is exactly what is not known. Dropping the unreadable
      // step because something lower down answered turns an unknown into a
      // confident report about the place that lost.
      mkdirSync(join(workspace, ".env.local"), { recursive: true });
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      const result = await call(secretLookup, { refs: ["TOKEN"] });
      const [first] = result.results;
      expect(first.resolved).toBe(true);
      expect(first.wonBy).toBe("envfile:.env#TOKEN");
      expect(first.couldNotCheck[0].ref).toBe("envfile:.env.local#TOKEN");
      expect(first.couldNotCheck[0].status).toBe("error");
      expect(first.warning).toContain("outranks");
    });

    test("the secrets directory is the last resort", async () => {
      mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
      writeFileSync(join(workspace, ".crewhaus/secrets/TOKEN"), SECRET);
      const result = await call(secretLookup, { refs: ["TOKEN"] });
      expect(result.results[0].wonBy).toBe("file:.crewhaus/secrets/TOKEN");
    });

    test("nothing anywhere lists everywhere it looked", async () => {
      const result = await call(secretLookup, { refs: ["TOKEN"] });
      expect(result.results[0].resolved).toBe(false);
      expect(result.results[0].searched).toEqual([
        "env:TOKEN",
        "envfile:.env.local#TOKEN",
        "envfile:.env#TOKEN",
        "file:.crewhaus/secrets/TOKEN",
      ]);
    });
  });

  test("a recorded rotation is reported as lastRotatedAt", async () => {
    _setEnv({ TOKEN: SECRET });
    mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
    writeFileSync(
      join(workspace, ".crewhaus/secrets/rotations.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ref: "env:TOKEN",
            backend: "env",
            rotatedAt: "2026-09-01T00:00:00.000Z",
            fingerprint: "sha256:aaaaaaaaaaaa",
          },
        ],
      }),
    );
    const result = await call(secretLookup, { refs: ["env:TOKEN"] });
    expect(result.results[0].lastRotatedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// EnvFileUpsert
// ---------------------------------------------------------------------------

describe("EnvFileUpsert", () => {
  test("it creates a .env that is not world-readable", async () => {
    const result = await call(envFileUpsert, {
      entries: [{ key: "LOG_LEVEL", value: "debug" }],
    });
    expect(result.applied).toBe(true);
    expect(result.created).toBe(true);
    expect(readEnv()).toBe("LOG_LEVEL=debug\n");
    expect(statSync(envFile()).mode & 0o077).toBe(0);
  });

  test("a value taken from a reference never appears in the result", async () => {
    _setEnv({ SOURCE: SECRET });
    const result = await call(envFileUpsert, {
      entries: [{ key: "SLACK_TOKEN", valueFrom: "env:SOURCE" }],
    });
    expect(result.entries[0].how).toBe("appended");
    expect(result.entries[0].fingerprint).toBe(fingerprint(SECRET));
    expect(result.entries[0].source).toBe("env:SOURCE");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // …but it did reach the file, which is the point.
    expect(readEnv()).toContain(SECRET);
  });

  test("a bare name in valueFrom means the same chain SecretLookup searches", async () => {
    // Not "the environment only". A bare name that meant one thing in a
    // lookup and another in a write would resolve to two different secrets
    // depending on which tool the caller reached for.
    writeFileSync(envFile(".env.local"), `SOURCE_TOKEN=${SECRET}\n`);
    const result = await call(envFileUpsert, {
      path: ".env",
      entries: [{ key: "SLACK_TOKEN", valueFrom: "SOURCE_TOKEN" }],
    });
    expect(result.entries[0].fingerprint).toBe(fingerprint(SECRET));
    expect(result.entries[0].source).toContain(".env.local");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("a bare name whose chain disagrees says which place won", async () => {
    _setEnv({ SOURCE_TOKEN: SECRET });
    writeFileSync(envFile(".env.local"), `SOURCE_TOKEN=${OTHER_SECRET}\n`);
    const result = await call(envFileUpsert, {
      path: ".env",
      entries: [{ key: "SLACK_TOKEN", valueFrom: "SOURCE_TOKEN" }],
    });
    expect(result.entries[0].fingerprint).toBe(fingerprint(SECRET));
    expect(result.warnings[0]).toContain("also defined, with a different value");
    expect(result.warnings[0]).toContain(".env.local");
    expect(JSON.stringify(result)).not.toContain(OTHER_SECRET);
  });

  test("a literal value on a credential-shaped key is written with a warning", async () => {
    const result = await call(envFileUpsert, {
      entries: [{ key: "STRIPE_SECRET", value: "sk-test-123" }],
    });
    expect(result.applied).toBe(true);
    expect(result.warnings[0]).toContain("already in this conversation's transcript");
  });

  test("an ordinary key gets no warning", async () => {
    const result = await call(envFileUpsert, { entries: [{ key: "LOG_LEVEL", value: "debug" }] });
    expect(result.warnings).toBeUndefined();
  });

  test("an existing file keeps its comments, blanks and key order", async () => {
    writeFileSync(envFile(), ENV_HANDWRITTEN);
    await call(envFileUpsert, { entries: [{ key: "SLACK_BOT_TOKEN", value: "xoxb-new" }] });
    const after = readEnv();
    expect(after).toContain("# Acme harness credentials");
    expect(after).toContain("# NIGHTLY_WEBHOOK=");
    expect(after).toContain("export ANTHROPIC_API_KEY=sk-ant-aaaa");
    expect(after.split("\n").length).toBe(ENV_HANDWRITTEN.split("\n").length);
    expect(after).toContain("SLACK_BOT_TOKEN=xoxb-new");
  });

  test("a stub is promoted in place rather than shadowed by an appended line", async () => {
    writeFileSync(envFile(), ENV_HANDWRITTEN);
    const result = await call(envFileUpsert, {
      entries: [{ key: "NIGHTLY_WEBHOOK", value: "https://hooks.example/x" }],
    });
    expect(result.entries[0].how).toBe("uncommented");
    expect(
      readEnv()
        .split("\n")
        .filter((l) => l.includes("NIGHTLY_WEBHOOK")).length,
    ).toBe(1);
  });

  test("setting a value that is already there writes nothing at all", async () => {
    writeFileSync(envFile(), ENV_HANDWRITTEN);
    const before = readEnv();
    const result = await call(envFileUpsert, {
      entries: [{ key: "SLACK_BOT_TOKEN", value: "xoxb-000000-111111" }],
    });
    expect(result.entries[0].how).toBe("unchanged");
    expect(result.applied).toBe(false);
    expect(readEnv()).toBe(before);
  });

  test("unset comments the assignment out and keeps the key's name", async () => {
    writeFileSync(envFile(), ENV_HANDWRITTEN);
    const result = await call(envFileUpsert, {
      entries: [{ key: "SLACK_BOT_TOKEN", action: "unset" }],
    });
    expect(result.entries[0].how).toBe("commented");
    expect(readEnv()).toContain("# SLACK_BOT_TOKEN=");
    expect(readEnv()).not.toContain("xoxb-000000-111111");
  });

  test("the previous value is reported as a fingerprint, never as itself", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    _setEnv({ SOURCE: SECRET });
    const result = await call(envFileUpsert, {
      entries: [{ key: "TOKEN", valueFrom: "env:SOURCE" }],
    });
    expect(result.entries[0].previousFingerprint).toBe(fingerprint(OTHER_SECRET));
    expect(JSON.stringify(result)).not.toContain(OTHER_SECRET);
  });

  test("a world-readable .env is tightened, and the change is reported", async () => {
    writeFileSync(envFile(), "A=1\n", { mode: 0o644 });
    const result = await call(envFileUpsert, { entries: [{ key: "A", value: "2" }] });
    expect(result.modeTightened).toBe("0644 -> 0600");
  });

  describe("dryRun", () => {
    test("reports the same plan the real write would make, and writes nothing", async () => {
      writeFileSync(envFile(), ENV_HANDWRITTEN);
      const before = readEnv();
      const dry = await call(envFileUpsert, {
        entries: [
          { key: "SLACK_BOT_TOKEN", value: "xoxb-new" },
          { key: "NEW_KEY", value: "1" },
        ],
        dryRun: true,
      });
      expect(dry.applied).toBe(false);
      expect(readEnv()).toBe(before);

      const wet = await call(envFileUpsert, {
        entries: [
          { key: "SLACK_BOT_TOKEN", value: "xoxb-new" },
          { key: "NEW_KEY", value: "1" },
        ],
      });
      expect(wet.applied).toBe(true);
      // The same plan, produced by the same code path: only `applied` differs.
      expect(dry.entries).toEqual(wet.entries);
      expect(dry.changed).toBe(wet.changed);
    });

    test("says when it would create the file", async () => {
      const dry = await call(envFileUpsert, {
        entries: [{ key: "A", value: "1" }],
        dryRun: true,
      });
      expect(dry.wouldCreateFile).toBe(true);
      expect(existsSync(envFile())).toBe(false);
    });
  });

  describe("refusals — and nothing written after any of them", () => {
    test("a key the file assigns twice", async () => {
      writeFileSync(envFile(), ENV_DUPLICATE);
      const message = await refusal(envFileUpsert, {
        entries: [{ key: "API_KEY", value: "third" }],
      });
      expect(message).toContain("lines 1 and 3");
      expect(message).toContain("Nothing was written");
      expect(readEnv()).toBe(ENV_DUPLICATE);
    });

    test("both value and valueFrom", async () => {
      const message = await refusal(envFileUpsert, {
        entries: [{ key: "A", value: "1", valueFrom: "env:B" }],
      });
      expect(message).toContain("exactly one of value or valueFrom");
    });

    test("neither value nor valueFrom", async () => {
      const message = await refusal(envFileUpsert, { entries: [{ key: "A" }] });
      expect(message).toContain("neither was given");
    });

    test("the same key twice in one call", async () => {
      const message = await refusal(envFileUpsert, {
        entries: [
          { key: "A", value: "1" },
          { key: "A", value: "2" },
        ],
      });
      expect(message).toContain("appears twice");
    });

    test("a reference that does not resolve — before anything is written", async () => {
      writeFileSync(envFile(), "A=1\n");
      const message = await refusal(envFileUpsert, {
        entries: [{ key: "TOKEN", valueFrom: "env:MISSING" }],
      });
      expect(message).toContain("did not resolve");
      expect(message).toContain("Nothing was written");
      expect(readEnv()).toBe("A=1\n");
    });

    test("a value needing quotes, naming the export that would allow it", async () => {
      const message = await refusal(envFileUpsert, {
        entries: [{ key: "A", value: "two words" }],
      });
      expect(message).toContain("encodeEnvValue");
      expect(existsSync(envFile())).toBe(false);
    });

    test("one bad entry means NONE of the entries land", async () => {
      writeFileSync(envFile(), "A=1\n");
      const message = await refusal(envFileUpsert, {
        entries: [
          { key: "GOOD", value: "fine" },
          { key: "BAD", value: 'has "quotes" and spaces' },
        ],
      });
      expect(message).toContain("BAD");
      expect(readEnv()).toBe("A=1\n");
    });

    test("a .env outside the workspace", async () => {
      const message = await refusal(envFileUpsert, {
        path: "../escape.env",
        entries: [{ key: "A", value: "1" }],
      });
      expect(message).toContain("outside the workspace root");
    });

    test("unset with a value", async () => {
      const message = await refusal(envFileUpsert, {
        entries: [{ key: "A", action: "unset", value: "1" }],
      });
      expect(message).toContain("takes no value");
    });
  });
});

// ---------------------------------------------------------------------------
// SecretRotate
// ---------------------------------------------------------------------------

/** The value `_setRandomBytes` above produces, for 32 bytes as base64url. */
const GENERATED = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

const stepNames = (result: { steps: { step: string }[] }): string[] =>
  result.steps.map((step) => step.step);

describe("SecretRotate", () => {
  test("the happy path: write, verify, then keep the old one aside", async () => {
    writeFileSync(envFile(), `# creds\nTOKEN=${OTHER_SECRET}\n`);
    const result = await call(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "base64url" },
    });
    expect(result.ok).toBe(true);
    // The order is the safety property: nothing is retired before the new
    // value has been read back.
    expect(stepNames(result)).toEqual([
      "lock",
      "read-current",
      "interval-guard",
      "new-value",
      "keep-previous",
      "write-new",
      "verify",
      "record",
      "retire-previous",
    ]);
    expect(result.fingerprint.before).toBe(fingerprint(OTHER_SECRET));
    expect(result.fingerprint.after).toBe(fingerprint(GENERATED));
    expect(result.previousKeptAs).toBe("envfile:.env#TOKEN_PREVIOUS");
    const after = readEnv();
    expect(after).toContain(`TOKEN=${GENERATED}`);
    expect(after).toContain(`TOKEN_PREVIOUS=${OTHER_SECRET}`);
    expect(after).toContain("# creds");
    expect(JSON.stringify(result)).not.toContain(GENERATED);
    expect(JSON.stringify(result)).not.toContain(OTHER_SECRET);
  });

  test("it says that the provider has not been told anything", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    const result = await call(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "base64url" },
    });
    expect(result.note).toContain("stays valid at that provider until you revoke it");
  });

  test("the rotation is recorded, with fingerprints and no values", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    await call(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "hex" },
    });
    const journal = readFileSync(join(workspace, ".crewhaus/secrets/rotations.json"), "utf8");
    expect(journal).toContain("envfile:.env#TOKEN");
    expect(journal).toContain("2026-09-18T12:00:00.000Z");
    expect(journal).not.toContain(OTHER_SECRET);
    expect(journal).not.toContain(Buffer.from(new Uint8Array(32).fill(7)).toString("hex"));
  });

  test("the lock is released, even though the rotation succeeded", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    await call(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "base64url" },
    });
    expect(existsSync(join(workspace, ".crewhaus/secrets/rotation.lock"))).toBe(false);
  });

  test("retirePrevious comments the kept copy out — after the verify, not before", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    const result = await call(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "base64url" },
      retirePrevious: true,
    });
    expect(result.ok).toBe(true);
    const retire = result.steps.find((step: { step: string }) => step.step === "retire-previous");
    expect(retire.ok).toBe(true);
    expect(readEnv()).toContain("# TOKEN_PREVIOUS=");
    expect(readEnv()).not.toContain(OTHER_SECRET);
  });

  test("keepPrevious:false leaves no copy of the old value behind", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    const result = await call(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "base64url" },
      keepPrevious: false,
    });
    expect(result.ok).toBe(true);
    expect(readEnv()).not.toContain(OTHER_SECRET);
    expect(result.previousKeptAs).toBeUndefined();
  });

  describe("dryRun", () => {
    test("walks every step and changes nothing on disk", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      const before = readEnv();
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      expect(result.applied).toBe(false);
      expect(stepNames(result)).toEqual([
        "lock",
        "read-current",
        "interval-guard",
        "new-value",
        "keep-previous",
        "write-new",
        "verify",
        "retire-previous",
      ]);
      expect(readEnv()).toBe(before);
      expect(existsSync(join(workspace, ".crewhaus/secrets/rotations.json"))).toBe(false);
      expect(existsSync(join(workspace, ".crewhaus/secrets/rotation.lock"))).toBe(false);
    });

    test("each step it did not take says it would have, and what the outcome would be", async () => {
      writeFileSync(envFile(), "# creds\n# TOKEN=\n");
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        createIfAbsent: true,
        dryRun: true,
      });
      const write = result.steps.find((step: { step: string }) => step.step === "write-new");
      expect(write.wouldRun).toBe(true);
      // The outcome comes from the real plan: the stub would be PROMOTED, not
      // appended, and a dry run that guessed would say the wrong thing here.
      expect(write.detail).toBe("would set TOKEN in .env (uncommented)");
    });
  });

  describe("refusals", () => {
    test("a backend whose rotation would put the value on a command line", async () => {
      const message = await refusal(secretRotate, {
        ref: "keychain:acme",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(message).toContain("ps");
      expect(message).toContain("cannot be rotated");
    });

    test("an environment variable, which nothing written can change", async () => {
      const message = await refusal(secretRotate, {
        ref: "env:TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(message).toContain("already running");
    });

    test("neither generate nor newValueFrom", async () => {
      const message = await refusal(secretRotate, { ref: "envfile:.env#TOKEN" });
      expect(message).toContain("neither was given");
    });

    test("both of them", async () => {
      const message = await refusal(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        newValueFrom: "env:NEW",
      });
      expect(message).toContain("both were given");
    });

    test("a secret that does not exist yet, unless you say so", async () => {
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("read-current");
      expect(result.reason).toContain("createIfAbsent");
      expect(existsSync(envFile())).toBe(false);
    });

    test("…and creates it when you do", async () => {
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        createIfAbsent: true,
      });
      expect(result.ok).toBe(true);
      expect(result.fingerprint.before).toBeUndefined();
      expect(readEnv()).toContain(`TOKEN=${GENERATED}`);
    });

    test("a new value identical to the current one", async () => {
      writeFileSync(envFile(), `TOKEN=${GENERATED}\n`);
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("new-value");
      expect(result.reason).toContain("identical");
    });

    test("a source for the new value that does not resolve", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        newValueFrom: "env:MISSING",
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("new-value");
      expect(result.oldValueStillInPlace).toBe(true);
      expect(readEnv()).toContain(OTHER_SECRET);
    });
  });

  describe("the interval guard", () => {
    const seedJournal = (rotatedAt: string): void => {
      mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
      writeFileSync(
        join(workspace, ".crewhaus/secrets/rotations.json"),
        JSON.stringify({
          version: 1,
          entries: [
            {
              ref: "envfile:.env#TOKEN",
              backend: "envfile",
              rotatedAt,
              fingerprint: "sha256:aaaaaaaaaaaa",
            },
          ],
        }),
      );
    };

    test("refuses a rotation that is too soon, and writes nothing", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      seedJournal("2026-09-18T10:00:00.000Z"); // two hours before the fixed clock
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        minIntervalHours: 24,
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("interval-guard");
      expect(result.reason).toContain("2.0h ago");
      expect(readEnv()).toContain(OTHER_SECRET);
    });

    test("allows one that is old enough", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      seedJournal("2026-08-01T00:00:00.000Z");
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        minIntervalHours: 24,
      });
      expect(result.ok).toBe(true);
    });

    test("an unreadable rotation TIME is reported, not passed over in silence", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      seedJournal("last Tuesday");
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(result.ok).toBe(true);
      const guard = result.steps.find((step: { step: string }) => step.step === "interval-guard");
      expect(guard.detail).toContain("not a date this can read");
    });

    // The two below are the same situation with and without a policy attached,
    // and they are the point of this block: an interval that cannot be
    // MEASURED has not been met, so asking for one and getting a rotation
    // anyway is a guard that silently stopped applying.
    test("an interval that cannot be measured is refused, not waved through", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      seedJournal("last Tuesday");
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        minIntervalHours: 24,
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("interval-guard");
      // The REASON, not just the failure: a stop for any other cause would
      // satisfy `ok: false` just as well.
      expect(result.reason).toContain("not a date this can read");
      expect(result.reason).toContain("cannot be established");
      expect(readEnv()).toContain(OTHER_SECRET);
    });

    test("a corrupt journal fails open with no interval asked for, and closed with one", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
      writeFileSync(join(workspace, ".crewhaus/secrets/rotations.json"), "{broken");

      // No policy asked for: the history is a convenience, the credential is
      // not, so the rotation still happens — and says the record was gone.
      const open = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(open.ok).toBe(true);
      const guard = open.steps.find((step: { step: string }) => step.step === "interval-guard");
      expect(guard.detail).toContain("treated as never rotated");

      // A policy asked for, on a history that cannot answer: refused.
      writeFileSync(join(workspace, ".crewhaus/secrets/rotations.json"), "{broken");
      const closed = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        minIntervalHours: 24,
      });
      expect(closed.failedAt).toBe("interval-guard");
      expect(closed.reason).toContain("a guard that cannot be checked is not a guard");
    });

    test("a journal that cannot be READ is not an empty history", async () => {
      writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
      // A directory where the journal should be: readFileSync fails with
      // EISDIR, which is not "nothing has been rotated yet". Every errno but
      // ENOENT used to come back as an empty journal, which turned
      // minIntervalHours off without saying so.
      mkdirSync(join(workspace, ".crewhaus/secrets/rotations.json"), { recursive: true });
      const result = await call(secretRotate, {
        ref: "envfile:.env#TOKEN",
        generate: { bytes: 32, encoding: "base64url" },
        minIntervalHours: 24,
      });
      expect(result.failedAt).toBe("interval-guard");
      expect(result.reason).toContain("could not be read");
      expect(result.reason).toContain("cannot be established");
      expect(readEnv()).toContain(OTHER_SECRET);
    });
  });

  test("a concurrent rotation is refused rather than allowed to race", async () => {
    writeFileSync(envFile(), `TOKEN=${OTHER_SECRET}\n`);
    mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
    writeFileSync(
      join(workspace, ".crewhaus/secrets/rotation.lock"),
      JSON.stringify({ ref: "envfile:.env#TOKEN", pid: 1, startedAt: NOW - 1_000 }),
    );
    const message = await refusal(secretRotate, {
      ref: "envfile:.env#TOKEN",
      generate: { bytes: 32, encoding: "base64url" },
    });
    expect(message).toContain("another rotation is in progress");
    expect(readEnv()).toContain(OTHER_SECRET);
  });

  describe("a command backend", () => {
    test("the new value goes on STDIN, and never onto the command line", async () => {
      const runner = recordedRunner({
        "pass show acme/deploy": PASS_FOUND,
        "pass insert --multiline --force acme/deploy": { ...PASS_FOUND, stdout: "" },
      });
      _setRunner(runner.run);
      // The read-back returns the OLD value, so this also proves verify runs.
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
      });
      const insertIndex = runner.calls.findIndex((argv) => argv[1] === "insert");
      expect(runner.calls[insertIndex].join(" ")).not.toContain(GENERATED);
      expect(runner.stdins[insertIndex]).toBe(GENERATED);
      expect(result.ok).toBe(false); // see below — verify caught it
    });

    test("a value that does not read back is rolled back, and says which step failed", async () => {
      const runner = recordedRunner({
        "pass show acme/deploy": PASS_FOUND, // always the OLD value
        "pass insert --multiline --force acme/deploy": { ...PASS_FOUND, stdout: "" },
      });
      _setRunner(runner.run);
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("verify");
      expect(result.rolledBack).toBe(true);
      expect(result.oldValueStillInPlace).toBe(true);
      expect(result.reason).toContain("read back as a different value");
      // The rollback wrote the OLD value back through the same path.
      const inserts = runner.calls.filter((argv) => argv[1] === "insert");
      expect(inserts.length).toBe(2);
      expect(runner.stdins[runner.stdins.length - 1]).toBe(SECRET);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    test("a write that fails leaves the old value untouched and names the step", async () => {
      const runner = recordedRunner({
        "pass show acme/deploy": PASS_FOUND,
        "pass insert --multiline --force acme/deploy": PASS_NOT_FOUND,
      });
      _setRunner(runner.run);
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("write-new");
      expect(result.oldValueStillInPlace).toBe(true);
      // The claim is VERIFIED, not assumed: the last thing the tool did was
      // read the secret back. A failed write does not prove nothing was
      // stored, so "the old value is still in place" has to be checked.
      expect(result.reason).toContain("read-back confirms the previous value is still in place");
      expect(runner.calls[runner.calls.length - 1]).toEqual(["pass", "show", "acme/deploy"]);
    });

    test("a write that failed but stored the value ANYWAY is reported, not called safe", async () => {
      // `pass insert` writes the entry and then git-commits it. A failed
      // commit exits non-zero with the new secret already in the store, and
      // "the old value is still in place" would send the operator away from
      // a service that is already locked out.
      let stored = SECRET;
      _setRunner(async (argv, options) => {
        const base = { argv, stderr: "", truncated: false, timedOut: false };
        if (argv[1] === "insert") {
          stored = options.stdin as string;
          return {
            ...base,
            exitCode: 1,
            stdout: "",
            stderr: "fatal: could not commit: index.lock exists\n",
          };
        }
        return { ...base, exitCode: 0, stdout: `${stored}\n` };
      });
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
        keepPrevious: false,
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("write-new");
      expect(result.oldValueStillInPlace).toBe(false);
      expect(result.storedValueIsTheNewOne).toBe(true);
      expect(result.recovery).toContain("IS holding the new value");
      expect(JSON.stringify(result)).not.toContain(stored);
    });

    test("a write that wiped the old value without storing the new one shouts about it", async () => {
      // The worst outcome this tool can produce: the old value gone, the new
      // one not stored. "unknown" would bury the one fact the operator has to
      // act on, and the kept copy is the way back.
      let stored: string | undefined = SECRET;
      _setRunner(async (argv) => {
        const base = { argv, stderr: "", truncated: false, timedOut: false };
        if (argv[1] === "insert") {
          stored = undefined;
          return { ...base, exitCode: 1, stderr: "gpg: signing failed\n", stdout: "" };
        }
        return stored === undefined
          ? {
              ...base,
              exitCode: 1,
              stdout: "",
              stderr: "Error: acme/deploy is not in the password store.\n",
            }
          : { ...base, exitCode: 0, stdout: `${stored}\n` };
      });
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
        keepPrevious: false,
      });
      expect(result.failedAt).toBe("write-new");
      expect(result.secretIsNowAbsent).toBe(true);
      expect(result.oldValueStillInPlace).toBe(false);
      expect(result.recovery).toContain("no value at all");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    test("a write failure whose state cannot be read back says so, rather than picking one", async () => {
      let runCount = 0;
      _setRunner(async (argv) => {
        const base = { argv, stdout: "", stderr: "", truncated: false, timedOut: false };
        if (argv[1] === "insert") {
          return { ...base, exitCode: 1, stderr: "gpg: signing failed\n" };
        }
        if (runCount++ === 0) return { ...base, exitCode: 0, stdout: `${SECRET}\n` };
        // The read-back itself fails: nothing is known about what is stored.
        return { ...base, exitCode: 2, stderr: "gpg: decryption failed: No secret key\n" };
      });
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
        keepPrevious: false,
      });
      expect(result.failedAt).toBe("write-new");
      expect(result.oldValueStillInPlace).toBe("unknown");
      expect(result.recovery).toContain("did not settle what is stored now");
    });

    test("a backend with nowhere to keep the old value says so instead of inventing one", async () => {
      const runner = recordedRunner({
        "pass show acme/deploy": PASS_FOUND,
        "pass insert --multiline --force acme/deploy": { ...PASS_FOUND, stdout: "" },
      });
      _setRunner(runner.run);
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
      });
      const keep = result.steps.find((step: { step: string }) => step.step === "keep-previous");
      expect(keep.detail).toContain("no place to keep");
    });

    test("an unexpected failure still releases the lock, and says to check first", async () => {
      // The seam throws rather than answering — the shape of a bug, not of a
      // failed command. The lock must not survive it: a leaked lock wedges
      // every later rotation of this secret until the stale timeout.
      _setRunner(async () => {
        throw new Error("the runner exploded");
      });
      const message = await refusal(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(message).toContain("unexpected failure after the lock was taken");
      expect(message).toContain("SecretLookup");
      expect(existsSync(join(workspace, ".crewhaus/secrets/rotation.lock"))).toBe(false);
    });

    test("a helper that is not installed fails at read-current, before any write", async () => {
      _setRunner(recordedRunner({ "pass show acme/deploy": NOT_INSTALLED("pass") }).run);
      const result = await call(secretRotate, {
        ref: "pass:acme/deploy",
        generate: { bytes: 32, encoding: "base64url" },
      });
      expect(result.ok).toBe(false);
      expect(result.failedAt).toBe("read-current");
      expect(result.reason).toContain("not installed");
    });
  });

  test("rotating a file backend keeps the old bytes beside it", async () => {
    mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
    writeFileSync(join(workspace, ".crewhaus/secrets/TOKEN"), OTHER_SECRET);
    const result = await call(secretRotate, {
      ref: "file:.crewhaus/secrets/TOKEN",
      generate: { bytes: 32, encoding: "hex" },
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, ".crewhaus/secrets/TOKEN.previous"), "utf8")).toBe(
      OTHER_SECRET,
    );
    expect(statSync(join(workspace, ".crewhaus/secrets/TOKEN")).mode & 0o077).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("the promise, asserted", () => {
  test("no result any test in this file collected contains a secret", () => {
    const values = [SECRET, OTHER_SECRET, GENERATED];
    let scanned = 0;
    for (const result of everythingReturned) {
      scanned += 1;
      for (const value of values) expect(result).not.toContain(value);
    }
    // A scan that ran over nothing is a green test that proves nothing — this
    // package's own lesson, and the reason for this assertion.
    expect(scanned).toBeGreaterThan(40);
  });

  test("every tool declares what it is", () => {
    expect(SECRETS_TOOLS.length).toBe(3);
    for (const tool of SECRETS_TOOLS) {
      // Each one can spawn a credential helper, so each declares the boundary.
      expect(tool.ioCapability).toBe("process");
      expect(tool.scope).toBe("external");
    }
    expect(secretLookup.readOnly).toBe(true);
    expect(envFileUpsert.destructive).toBe(true);
    expect(secretRotate.destructive).toBe(true);
    expect(secretRotate.requireJustification).toBe(true);
  });
});
