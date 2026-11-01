/**
 * The `.env` writer, against the reader that builds every spawn environment.
 *
 * The writer's encoding and `parseEnvText`'s decoding are two halves of one
 * format, so the load-bearing property is the round trip: what goes in comes
 * back byte for byte. Around it: the line edits keep the operator's file as
 * they left it, a refusal names the variable and never the value, and the
 * file ends up 0600 however loose it was.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_ASSIGN_RE,
  ENV_KEY_RE,
  ENV_STUB_RE,
  EnvWriteError,
  unsetEnvVar,
  upsertEnvVar,
} from "./env-writer";
import { parseEnvText } from "./spawn-contracts";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function envPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "env-writer-"));
  scratch.push(dir);
  return join(dir, ".env");
}

const read = (path: string): string => readFileSync(path, "utf8");

describe("upsertEnvVar → parseEnvText round trip", () => {
  const values: ReadonlyArray<readonly [label: string, value: string]> = [
    ["a double quote", 'a"b'],
    ["a backslash", "a\\b"],
    ["a spaced hash", "a b # c"],
    ["the empty string", ""],
    ["unicode", "clé-✓-日本"],
    ["a plain token", "plain-token_1.2"],
  ];
  for (const [label, value] of values) {
    test(`returns the original bytes for ${label}`, () => {
      const path = envPath();
      upsertEnvVar(path, "SECRET", value);
      expect(parseEnvText(read(path))["SECRET"]).toBe(value);
      // Rewriting in place must not compound the escaping.
      upsertEnvVar(path, "SECRET", value);
      expect(parseEnvText(read(path))["SECRET"]).toBe(value);
      expect(
        read(path)
          .split("\n")
          .filter((line) => line !== ""),
      ).toHaveLength(1);
    });
  }
});

describe("line edits", () => {
  test("a new key is appended and reported as such", () => {
    const path = envPath();
    writeFileSync(path, "FIRST=one\n");
    expect(upsertEnvVar(path, "SECOND", "two")).toEqual({
      variable: "SECOND",
      state: "set",
      how: "appended",
      file: ".env",
    });
    expect(read(path)).toBe("FIRST=one\nSECOND=two\n");
  });

  test("replacing an assignment keeps its `export ` prefix and its place", () => {
    const path = envPath();
    writeFileSync(path, "# header\nexport TOKEN=old\nOTHER=x\n");
    expect(upsertEnvVar(path, "TOKEN", "new").how).toBe("replaced");
    expect(read(path)).toBe("# header\nexport TOKEN=new\nOTHER=x\n");
  });

  test("a `# KEY=` stub is promoted in place", () => {
    const path = envPath();
    writeFileSync(path, "A=1\n# TOKEN=\nB=2\n");
    expect(upsertEnvVar(path, "TOKEN", "set-now").how).toBe("uncommented");
    expect(read(path)).toBe("A=1\nTOKEN=set-now\nB=2\n");
  });

  test("unset writes `# KEY=` in place, appends one for an unknown key, and is idempotent", () => {
    const path = envPath();
    writeFileSync(path, "KEEP=yes\nDROP=no\n");
    expect(unsetEnvVar(path, "DROP")).toEqual({
      variable: "DROP",
      state: "commented-stub",
      how: "commented",
      file: ".env",
    });
    expect(read(path)).toBe("KEEP=yes\n# DROP=\n");
    unsetEnvVar(path, "DROP");
    expect(read(path)).toBe("KEEP=yes\n# DROP=\n");
    expect(unsetEnvVar(path, "NEVER_SET").how).toBe("appended");
    expect(read(path)).toBe("KEEP=yes\n# DROP=\n# NEVER_SET=\n");
  });

  test("a missing file is created holding just the one line", () => {
    const path = envPath();
    upsertEnvVar(path, "ONLY", "value");
    expect(read(path)).toBe("ONLY=value\n");
  });
});

describe("refusals", () => {
  const value = ["refused", "value", "0123456789"].join("-");

  test("a newline or a NUL in the value is refused, naming the key and not the value", () => {
    for (const bad of [`${value}\nsecond-line`, `${value}\u0000tail`]) {
      const path = envPath();
      writeFileSync(path, "KEEP=yes\n");
      let caught: unknown;
      try {
        upsertEnvVar(path, "MULTI_KEY", bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EnvWriteError);
      const message = (caught as Error).message;
      expect(message).toBe(
        "the value for MULTI_KEY contains a newline — .env cannot represent that",
      );
      expect(message).not.toContain(value);
      // Refused before anything was written.
      expect(read(path)).toBe("KEEP=yes\n");
    }
  });

  test("a bad name is refused by both writers, and the file is left alone", () => {
    for (const name of ["1ABC", "BAD-NAME", "WITH SPACE", "", "A".repeat(129)]) {
      const path = envPath();
      writeFileSync(path, "KEEP=yes\n");
      expect(() => upsertEnvVar(path, name, value)).toThrow(EnvWriteError);
      expect(() => unsetEnvVar(path, name)).toThrow(EnvWriteError);
      try {
        upsertEnvVar(path, name, value);
      } catch (err) {
        expect((err as Error).message).toBe(`"${name}" is not a valid variable name`);
        expect((err as Error).message).not.toContain(value);
      }
      expect(read(path)).toBe("KEEP=yes\n");
    }
    expect(ENV_KEY_RE.test("A".repeat(128))).toBe(true);
  });

  test("a filesystem failure is NOT a refusal — it is thrown as it came", () => {
    const path = envPath();
    mkdirSync(path); // a directory where the file should be
    let caught: unknown;
    try {
      upsertEnvVar(path, "PLAIN", "value");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(EnvWriteError);
  });
});

describe("the file mode", () => {
  test("is 0600 after a write, even over a 0644 file", () => {
    const path = envPath();
    writeFileSync(path, "LOOSE=yes\n", { mode: 0o644 });
    upsertEnvVar(path, "TIGHT", "now");
    const mode = statSync(path).mode & 0o777;
    // Windows has no POSIX mode bits: `stat` reports 0666 for any writable
    // file, and `chmod` only toggles read-only. The 0600 claim is a POSIX
    // claim; owner read+write is what is assertable there.
    if (process.platform === "win32") expect(mode & 0o600).toBe(0o600);
    else expect(mode).toBe(0o600);
  });
});

describe("the line grammar the readers share", () => {
  test("an assignment and a stub are told apart, with or without `export `", () => {
    expect("export TOKEN=x".match(ENV_ASSIGN_RE)?.[1]).toBe("TOKEN");
    expect("  TOKEN = x".match(ENV_ASSIGN_RE)?.[1]).toBe("TOKEN");
    expect("# TOKEN=".match(ENV_ASSIGN_RE)).toBeNull();
    expect("# TOKEN=".match(ENV_STUB_RE)?.[1]).toBe("TOKEN");
    expect("#TOKEN=".match(ENV_STUB_RE)?.[1]).toBe("TOKEN");
    expect("# a comment about TOKEN".match(ENV_STUB_RE)).toBeNull();
  });
});
