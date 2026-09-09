/**
 * `.env` write-back coverage — the credential path.
 *
 * Every test works inside its own `mkdtempSync` directory, so nothing here
 * can touch a real harness's `.env`, and no value written is a real secret.
 * The assertions are deliberately byte-level: this module's whole contract is
 * that it edits a file the Hangar console also edits, so "preserved ordering"
 * and "0600" have to be checked as bytes and as a mode, not as a shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_KEY_RE, readEnvFile, upsertEnvVar } from "./env-file";
import { ServiceSetupError } from "./types";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewhaus-env-file-"));
  envPath = join(dir, ".env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seed the fixture `.env` with exact bytes. */
function seed(text: string): void {
  writeFileSync(envPath, text, "utf8");
}

/** The fixture's exact bytes back. */
function bytes(path: string = envPath): string {
  return readFileSync(path, "utf8");
}

/** Permission bits only, the way the 0600 contract is stated. */
function permissions(path: string = envPath): number {
  return statSync(path).mode & 0o777;
}

describe("readEnvFile", () => {
  test("a missing file is empty and reports exists: false", () => {
    const view = readEnvFile(join(dir, "nope.env"));
    expect(view.exists).toBe(false);
    expect(view.values).toEqual({});
    expect(view.stubs).toEqual([]);
  });

  test("an existing but empty file exists with no values", () => {
    seed("");
    const view = readEnvFile(envPath);
    expect(view.exists).toBe(true);
    expect(view.values).toEqual({});
    expect(view.stubs).toEqual([]);
  });

  test("reads assignments with and without an `export ` prefix", () => {
    seed("PLAIN=one\nexport EXPORTED=two\n");
    const view = readEnvFile(envPath);
    expect(view.values["PLAIN"]).toBe("one");
    expect(view.values["EXPORTED"]).toBe("two");
  });

  test("strips matched double and single quotes", () => {
    seed(`DOUBLE="d value"\nSINGLE='s value'\n`);
    const view = readEnvFile(envPath);
    expect(view.values["DOUBLE"]).toBe("d value");
    expect(view.values["SINGLE"]).toBe("s value");
  });

  test("strips a trailing ` # comment` from an unquoted value", () => {
    seed("TOKEN=abc123 # minted 2026-01-01\n");
    expect(readEnvFile(envPath).values["TOKEN"]).toBe("abc123");
  });

  test("a `#` inside a quoted value survives", () => {
    seed(`HASHY="keep # this"\n`);
    expect(readEnvFile(envPath).values["HASHY"]).toBe("keep # this");
  });

  test("collects `# KEY=` stubs, sorted, and keeps them out of values", () => {
    seed("# BETA=\n#ALPHA=\nLIVE=1\n");
    const view = readEnvFile(envPath);
    expect(view.stubs).toEqual(["ALPHA", "BETA"]);
    expect(view.values).toEqual({ LIVE: "1" });
  });

  test("a stub that is LATER assigned does not remain in stubs", () => {
    seed("# TOKEN=\nTOKEN=live\n");
    const view = readEnvFile(envPath);
    expect(view.stubs).toEqual([]);
    expect(view.values["TOKEN"]).toBe("live");
  });

  test("blank lines and prose comments are ignored", () => {
    seed("\n# just a note about the file\n\nA=1\n");
    const view = readEnvFile(envPath);
    expect(view.values).toEqual({ A: "1" });
    expect(view.stubs).toEqual([]);
  });
});

describe("upsertEnvVar — placement", () => {
  test("replaces an existing assignment IN PLACE, keeping neighbours", () => {
    seed("# top comment\nFIRST=1\n\nTOKEN=old\n\n# tail comment\nLAST=9\n");
    const result = upsertEnvVar(envPath, "TOKEN", "new");
    expect(result).toEqual({ variable: "TOKEN", how: "replaced", file: ".env" });
    expect(bytes()).toBe("# top comment\nFIRST=1\n\nTOKEN=new\n\n# tail comment\nLAST=9\n");
  });

  test("preserves an `export ` prefix on replace", () => {
    seed("export TOKEN=old\nOTHER=2\n");
    expect(upsertEnvVar(envPath, "TOKEN", "new").how).toBe("replaced");
    expect(bytes()).toBe("export TOKEN=new\nOTHER=2\n");
  });

  test("promotes a `# KEY=` stub at its original line index", () => {
    seed("ALPHA=1\n# BETA=\nGAMMA=3\n");
    const result = upsertEnvVar(envPath, "BETA", "2");
    expect(result.how).toBe("uncommented");
    expect(bytes()).toBe("ALPHA=1\nBETA=2\nGAMMA=3\n");
    expect(bytes().split("\n").indexOf("BETA=2")).toBe(1);
  });

  test("a promoted stub is no longer a stub when read back", () => {
    seed("# BETA=\n");
    upsertEnvVar(envPath, "BETA", "2");
    const view = readEnvFile(envPath);
    expect(view.stubs).toEqual([]);
    expect(view.values["BETA"]).toBe("2");
  });

  test("appends a genuinely new key", () => {
    seed("ALPHA=1\n");
    const result = upsertEnvVar(envPath, "DELTA", "4");
    expect(result.how).toBe("appended");
    expect(bytes()).toBe("ALPHA=1\nDELTA=4\n");
  });

  test("appending does not grow a blank line on each write", () => {
    seed("ALPHA=1\n");
    upsertEnvVar(envPath, "B", "2");
    upsertEnvVar(envPath, "C", "3");
    upsertEnvVar(envPath, "D", "4");
    expect(bytes()).toBe("ALPHA=1\nB=2\nC=3\nD=4\n");
  });

  test("repairs a file that lacks a trailing newline before appending", () => {
    seed("ALPHA=1");
    upsertEnvVar(envPath, "DELTA", "4");
    expect(bytes()).toBe("ALPHA=1\nDELTA=4\n");
  });

  test("creates the file, and its directory, when absent", () => {
    const nested = join(dir, "harness", "crew", ".env");
    const result = upsertEnvVar(nested, "TOKEN", "v1");
    expect(result.how).toBe("appended");
    expect(bytes(nested)).toBe("TOKEN=v1\n");
    expect(readEnvFile(nested).values["TOKEN"]).toBe("v1");
  });

  test("writing into an existing-but-empty file leaves one assignment", () => {
    seed("");
    upsertEnvVar(envPath, "TOKEN", "v1");
    expect(bytes()).toBe("TOKEN=v1\n");
  });

  test("reports the file's basename, not its path", () => {
    const nested = join(dir, "harness", ".env.local");
    expect(upsertEnvVar(nested, "TOKEN", "v1").file).toBe(".env.local");
  });
});

describe("upsertEnvVar — skipIfUnchanged", () => {
  test("an identical value reports unchanged and does not rewrite the file", () => {
    upsertEnvVar(envPath, "TOKEN", "same");
    const before = bytes();
    const mtimeBefore = statSync(envPath).mtimeMs;

    const result = upsertEnvVar(envPath, "TOKEN", "same");
    expect(result.how).toBe("unchanged");
    expect(bytes()).toBe(before);
    expect(statSync(envPath).mtimeMs).toBe(mtimeBefore);
  });

  test("skipIfUnchanged: false rewrites the line anyway", () => {
    seed("export TOKEN=same\n");
    const result = upsertEnvVar(envPath, "TOKEN", "same", { skipIfUnchanged: false });
    expect(result.how).toBe("replaced");
    expect(bytes()).toBe("export TOKEN=same\n");
  });

  test("a changed value is written even with the default skip", () => {
    seed("TOKEN=old\n");
    expect(upsertEnvVar(envPath, "TOKEN", "new").how).toBe("replaced");
    expect(readEnvFile(envPath).values["TOKEN"]).toBe("new");
  });

  test("a missing file is never unchanged", () => {
    expect(upsertEnvVar(envPath, "TOKEN", "v1").how).toBe("appended");
  });
});

describe("upsertEnvVar — value encoding", () => {
  test("a plain token stays unquoted", () => {
    upsertEnvVar(envPath, "TOKEN", "sk-test_1.2/3:4@5+6");
    expect(bytes()).toBe("TOKEN=sk-test_1.2/3:4@5+6\n");
  });

  test("a value with a space is double-quoted", () => {
    upsertEnvVar(envPath, "TITLE", "hello world");
    expect(bytes()).toBe(`TITLE="hello world"\n`);
  });

  test("a value with a `#` is double-quoted", () => {
    upsertEnvVar(envPath, "TAG", "one#two");
    expect(bytes()).toBe(`TAG="one#two"\n`);
  });

  test("a value with a quote is double-quoted with the quote escaped", () => {
    upsertEnvVar(envPath, "SAYS", `say "hi"`);
    expect(bytes()).toBe(`SAYS="say \\"hi\\""\n`);
  });

  test("a backslash is escaped", () => {
    upsertEnvVar(envPath, "WINPATH", "a\\b");
    expect(bytes()).toBe(`WINPATH="a\\\\b"\n`);
  });

  test("an empty value is written as a bare `KEY=`", () => {
    upsertEnvVar(envPath, "EMPTY", "");
    expect(bytes()).toBe("EMPTY=\n");
  });

  const roundTrip: readonly (readonly [label: string, value: string])[] = [
    ["a plain token", "abc123"],
    ["spaces", "two words here"],
    ["a hash", "one#two"],
    ["a spaced hash", "one # two"],
    ["a double quote", `say "hi"`],
    ["a backslash", "a\\b"],
    ["an equals sign", "a=b=c"],
    ["an empty string", ""],
    ["a $-prefixed value", "$NOT_A_REF"],
    ["a single quote", "it's fine"],
  ];

  for (const [label, value] of roundTrip) {
    test(`round-trips ${label}`, () => {
      upsertEnvVar(envPath, "ROUND", value);
      expect(readEnvFile(envPath).values["ROUND"]).toBe(value);
    });
  }
});

describe("upsertEnvVar — refusals", () => {
  test("refuses a value containing a newline", () => {
    let caught: unknown;
    try {
      upsertEnvVar(envPath, "TOKEN", "line one\nline two");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceSetupError);
    expect((caught as ServiceSetupError).service).toBe("harness");
    expect((caught as ServiceSetupError).message).toContain("newline");
    expect(readEnvFile(envPath).exists).toBe(false);
  });

  test("refuses a value containing a NUL", () => {
    let caught: unknown;
    try {
      upsertEnvVar(envPath, "TOKEN", "bad\0value");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceSetupError);
    expect((caught as ServiceSetupError).service).toBe("harness");
    expect(readEnvFile(envPath).exists).toBe(false);
  });

  test("refuses an invalid variable name", () => {
    let caught: unknown;
    try {
      upsertEnvVar(envPath, "9LIVES", "v1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceSetupError);
    expect((caught as ServiceSetupError).service).toBe("harness");
    expect((caught as ServiceSetupError).message).toContain("not a valid variable name");
    expect((caught as ServiceSetupError).options.fix).toBeDefined();
    expect(readEnvFile(envPath).exists).toBe(false);
  });

  test("a refusal never leaks the value into the message", () => {
    try {
      upsertEnvVar(envPath, "TOKEN", "top\nsecret");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
    }
  });

  test("ENV_KEY_RE accepts a leading underscore and rejects a leading digit", () => {
    expect(ENV_KEY_RE.test("_OK")).toBe(true);
    expect(ENV_KEY_RE.test("OK_1")).toBe(true);
    expect(ENV_KEY_RE.test("9NO")).toBe(false);
    expect(ENV_KEY_RE.test("NO-DASH")).toBe(false);
    expect(ENV_KEY_RE.test("")).toBe(false);
  });
});

describe("upsertEnvVar — file mode", () => {
  test("a newly created file is 0600", () => {
    upsertEnvVar(envPath, "TOKEN", "v1");
    expect(permissions()).toBe(0o600);
  });

  test("an ALREADY-LOOSE file is tightened to 0600", () => {
    seed("TOKEN=old\n");
    chmodSync(envPath, 0o644);
    expect(permissions()).toBe(0o644);

    upsertEnvVar(envPath, "TOKEN", "new");
    expect(permissions()).toBe(0o600);
  });

  test("an append into a loose file also tightens it", () => {
    seed("ALPHA=1\n");
    chmodSync(envPath, 0o666);
    upsertEnvVar(envPath, "BETA", "2");
    expect(permissions()).toBe(0o600);
  });

  test("an unchanged write does not need to touch the mode it already has", () => {
    upsertEnvVar(envPath, "TOKEN", "v1");
    expect(upsertEnvVar(envPath, "TOKEN", "v1").how).toBe("unchanged");
    expect(permissions()).toBe(0o600);
  });
});
