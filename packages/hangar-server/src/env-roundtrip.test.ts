/**
 * The pin on `.env` write→read fidelity.
 *
 * `upsertEnvVar` is the only writer of credential values in the console, and
 * `encodeEnvValue` escapes `\` and `"` whenever it has to quote a value. For
 * a long time nothing reversed that: both readers — `readEnvFileFacts` here
 * and `parseEnvText`, which builds the environment the spawned daemon
 * actually receives — stripped the surrounding quotes and stopped. So
 * `upsertEnvVar(path, "K", 'a"b')` wrote `K="a\"b"` and read back `a\"b`.
 *
 * Nothing in the current credential set reaches the quoting path (provider
 * tokens are all `[A-Za-z0-9_.-]`), so no live secret was ever corrupted.
 * That is precisely why it needs a test rather than a comment: the failure is
 * invisible until the day a provider issues a token with a punctuation
 * character in it, and by then the symptom is an auth error nobody traces
 * back to the env file.
 *
 * Both readers are asserted, because a value that survives the console's
 * presence check but not the spawn would be worse than one that fails both.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvText } from "@crewhaus/harness-supervisor";
import { readEnvFileFacts, upsertEnvVar } from "./creds-ops";

/** A containment helper that simply joins — the tests own the directory. */
function containIn(dir: string): (segments: readonly string[]) => string | undefined {
  return (segments) => join(dir, ...segments);
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hangar-envroundtrip-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Values chosen for the ways a `.env` line can be misread: whitespace that a
 * trim would eat, a `#` that an unquoted comment-strip would truncate at, the
 * two characters the writer escapes, an `=` that a naive split would break on,
 * a `$` that an interpolating reader would expand, and the empty string.
 */
const AWKWARD: ReadonlyArray<readonly [label: string, value: string]> = [
  ["a plain token", "xoxb-1234567890-abcdefg"],
  ["a space", "two words"],
  ["leading and trailing spaces", "  padded  "],
  ["a hash", "value#tag"],
  ["a spaced hash — the comment-strip case", "value # not-a-comment"],
  ["a double quote", 'say "hi"'],
  ["a backslash", "a\\b"],
  ["a backslash before a quote", 'a\\"b'],
  ["a trailing backslash", "ends-with\\"],
  ["doubled backslashes", "a\\\\b"],
  ["an equals sign", "k=v"],
  ["a dollar sign", "$NOT_A_REF"],
  ["a braced dollar ref", "${ALSO_NOT_A_REF}"],
  ["a single quote", "it's"],
  ["wrapped in single quotes", "'quoted'"],
  ["the empty string", ""],
  ["a JSON blob", '{"a":1,"b":"x y"}'],
];

describe("upsertEnvVar → readEnvFileFacts round trip", () => {
  for (const [label, value] of AWKWARD) {
    test(`returns the original bytes for ${label}`, () => {
      withDir((dir) => {
        upsertEnvVar(join(dir, ".env"), "SECRET", value);
        const facts = readEnvFileFacts(dir, containIn(dir));
        expect(facts.values["SECRET"]).toBe(value);
      });
    });
  }

  test("the spawn-side reader agrees with the console-side reader, value for value", () => {
    withDir((dir) => {
      const path = join(dir, ".env");
      for (const [, value] of AWKWARD) {
        upsertEnvVar(path, "SECRET", value);
        const viaFacts = readEnvFileFacts(dir, containIn(dir)).values["SECRET"];
        const viaSpawn = parseEnvText(readFileSync(path, "utf8"))["SECRET"];
        expect(viaSpawn).toBe(value);
        expect(viaSpawn).toBe(viaFacts);
      }
    });
  });

  test("survives being rewritten in place, repeatedly", () => {
    // Re-encoding an already-encoded value is where an asymmetric pair
    // compounds: each pass would add another layer of backslashes.
    withDir((dir) => {
      const path = join(dir, ".env");
      const value = 'a\\"b';
      for (let i = 0; i < 5; i += 1) upsertEnvVar(path, "SECRET", value);
      expect(readEnvFileFacts(dir, containIn(dir)).values["SECRET"]).toBe(value);
      expect(
        readFileSync(path, "utf8")
          .split("\n")
          .filter((l) => l !== ""),
      ).toHaveLength(1);
    });
  });

  test("a quoted value keeps its surrounding whitespace and its hash", () => {
    withDir((dir) => {
      const path = join(dir, ".env");
      upsertEnvVar(path, "SECRET", "  x # y  ");
      // The written line must be quoted, or the reader would trim and truncate.
      expect(readFileSync(path, "utf8")).toContain('SECRET="  x # y  "');
      expect(readEnvFileFacts(dir, containIn(dir)).values["SECRET"]).toBe("  x # y  ");
    });
  });
});

describe("parseEnvText quoting rules", () => {
  test("unescapes inside double quotes only", () => {
    // The writer emits escapes only inside double quotes, so only double
    // quotes reverse them. Single quotes are hand-written and literal —
    // treating `\"` as an escape there would corrupt a value nobody escaped.
    expect(parseEnvText('K="a\\"b"')["K"]).toBe('a"b');
    expect(parseEnvText("K='a\\\"b'")["K"]).toBe('a\\"b');
    expect(parseEnvText('K="a\\\\b"')["K"]).toBe("a\\b");
    expect(parseEnvText("K='a\\\\b'")["K"]).toBe("a\\\\b");
  });

  test("leaves a lone backslash that escapes nothing alone", () => {
    // `\n` is not an escape this format defines; only `\\` and `\"` are.
    expect(parseEnvText('K="a\\nb"')["K"]).toBe("a\\nb");
  });

  test("strips a trailing comment only when the value is unquoted", () => {
    expect(parseEnvText("K=bare # comment")["K"]).toBe("bare");
    expect(parseEnvText('K="kept # inside"')["K"]).toBe("kept # inside");
  });

  test("an unterminated quote is taken literally rather than swallowed", () => {
    expect(parseEnvText('K="unterminated')["K"]).toBe('"unterminated');
  });
});
