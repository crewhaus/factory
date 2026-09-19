/**
 * The parts, tested without a host.
 *
 * Nothing in this file spawns a process, reads a keychain or asks the machine
 * a question: every classifier is driven from `./fixtures`, and the two things
 * that genuinely need a filesystem (the atomic write and the rotation lock)
 * work inside a temp directory made per test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvText } from "@crewhaus/harness-supervisor";
import {
  ENV_CRLF,
  ENV_DUPLICATE,
  ENV_HANDWRITTEN,
  ENV_NO_TRAILING_NEWLINE,
  ENV_QUOTED,
  NOT_INSTALLED,
  OP_ABSENT,
  OP_FOUND,
  OP_SIGNED_OUT,
  OTHER_SECRET,
  PASS_FOUND,
  PASS_GPG_LOCKED,
  PASS_NOT_FOUND,
  SECRET,
  SECRET_TOOL_ABSENT,
  SECRET_TOOL_FOUND,
  SECRET_TOOL_NO_DBUS,
  SECURITY_DASH_SERVICE_NOT_FOUND,
  SECURITY_FOUND,
  SECURITY_ILLEGAL_OPTION,
  SECURITY_LOCKED,
  SECURITY_NOT_FOUND,
  TIMED_OUT,
  TRUNCATED,
} from "./fixtures";
import { classify, classifyWrite, stripsTrailingNewline } from "./lib/backends";
import {
  assignedKeys,
  decodeAssignment,
  encodeBare,
  liveAssignments,
  parseEnvDoc,
  planUnset,
  planUpsert,
  renderEnvDoc,
  stubIndex,
} from "./lib/envfile";
import { describeValue, fingerprint, firstLine, stripValues } from "./lib/fingerprint";
import {
  LOCK_STALE_MS,
  _setClock,
  acquireLock,
  appendJournal,
  lastRotation,
  readJournal,
} from "./lib/journal";
import {
  type SecretRef,
  formatRef,
  parseRef,
  readArgv,
  whyNotRotatable,
  writeArgv,
} from "./lib/refs";
import { buildChildEnv } from "./lib/run";
import { writeFileAtomic } from "./lib/write";

const originalCwd = process.cwd();
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-secrets-lib-"));
  process.chdir(workspace);
  _setClock(() => Date.parse("2026-09-18T12:00:00Z"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setClock(undefined);
});

/** Parse or explode — most tests are about what happens AFTER a valid ref. */
function ref(raw: string): SecretRef {
  const parsed = parseRef(raw);
  if (!parsed.ok) throw new Error(`expected "${raw}" to parse: ${parsed.message}`);
  return parsed.value;
}

// ---------------------------------------------------------------------------

describe("the reference grammar", () => {
  test("every backend has a spelling, and it round-trips", () => {
    const spellings = [
      "SLACK_TOKEN",
      "env:SLACK_TOKEN",
      "file:.crewhaus/secrets/token",
      "envfile:.env#SLACK_TOKEN",
      "keychain:acme-api",
      "keychain:acme-api#deploy",
      "pass:acme/deploy",
      "libsecret:service=acme-api",
      "op://Private/Acme/credential",
    ];
    for (const spelling of spellings) expect(formatRef(ref(spelling))).toBe(spelling);
    // Every spelling reached a DIFFERENT backend or a different target: this
    // asserts the list above actually exercised the whole switch.
    expect(new Set(spellings.map((s) => ref(s).kind)).size).toBe(8);
  });

  test("a bare name means the local chain, not a guess at a backend", () => {
    expect(ref("SLACK_TOKEN")).toEqual({ kind: "auto", name: "SLACK_TOKEN" });
  });

  test("a bare name that is not a variable name is refused rather than guessed", () => {
    const parsed = parseRef("acme/deploy");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("not a reference");
  });

  test("an unknown scheme names the ones that exist", () => {
    const parsed = parseRef("vault:secret/data/acme");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('"vault:" is not a known backend');
      expect(parsed.message).toContain("op://vault/item/field");
    }
  });

  test("envfile: splits on the LAST hash, so a path containing one still works", () => {
    expect(ref("envfile:dir#1/.env#KEY")).toEqual({
      kind: "envfile",
      path: "dir#1/.env",
      key: "KEY",
    });
  });

  test("an incomplete 1Password reference is refused with the shape it needs", () => {
    const parsed = parseRef("op://Private/Acme");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("op://vault/item/field");
  });

  describe("argument injection (CWE-88)", () => {
    // The repo has shipped this exact bug before: gitBranchCreate({name:"-D"})
    // ran `git branch -D victim`. A component that begins with "-" is refused
    // before any argv is built.
    const optionLike = [
      "pass:--version",
      "libsecret:--attr=x",
      "libsecret:attr=-x",
      "keychain:-w",
      "keychain:svc#-a",
    ];
    for (const raw of optionLike) {
      test(`refuses ${raw}`, () => {
        const parsed = parseRef(raw);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.message).toContain('begins with "-"');
      });
    }

    test("a newline in a component is refused — it cannot be one argument", () => {
      const parsed = parseRef("pass:acme\ndeploy");
      expect(parsed.ok).toBe(false);
    });

    test("a NUL is refused", () => {
      expect(parseRef("pass:acme\0deploy").ok).toBe(false);
    });

    test("the refusal message never repeats an unbounded amount of the input", () => {
      const parsed = parseRef(`pass:-${"x".repeat(5_000)}`);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message.length).toBeLessThan(500);
    });
  });

  describe("the argv each backend gets", () => {
    test("keychain passes the service as the ARGUMENT of -s, never as a word", () => {
      expect(readArgv(ref("keychain:acme-api#deploy"))).toEqual([
        "security",
        "find-generic-password",
        "-s",
        "acme-api",
        "-a",
        "deploy",
        "-w",
      ]);
    });

    test("an account is omitted rather than passed empty", () => {
      expect(readArgv(ref("keychain:acme-api"))).toEqual([
        "security",
        "find-generic-password",
        "-s",
        "acme-api",
        "-w",
      ]);
    });

    test("pass and secret-tool get bare argv arrays, never a shell string", () => {
      expect(readArgv(ref("pass:acme/deploy"))).toEqual(["pass", "show", "acme/deploy"]);
      expect(readArgv(ref("libsecret:service=acme-api"))).toEqual([
        "secret-tool",
        "lookup",
        "service",
        "acme-api",
      ]);
    });

    test("op gets a -- terminator, because cobra honours one", () => {
      expect(readArgv(ref("op://Private/Acme/credential"))).toEqual([
        "op",
        "read",
        "--no-newline",
        "--",
        "op://Private/Acme/credential",
      ]);
    });

    test("no argv anywhere is a single string containing a space-separated command", () => {
      const every = ["keychain:a#b", "pass:a/b", "libsecret:s=v", "op://v/i/f"].flatMap((raw) => [
        readArgv(ref(raw)) ?? [],
        writeArgv(ref(raw)) ?? [],
      ]);
      let checked = 0;
      for (const argv of every) {
        for (const element of argv) {
          checked += 1;
          // A shell string would be the only way a space-joined command line
          // could appear; an argv element may contain a space, but no element
          // may BE the program plus its arguments.
          expect(element.startsWith("sh -c")).toBe(false);
        }
      }
      // A scan that matched nothing is a green test proving nothing.
      expect(checked).toBeGreaterThan(10);
    });

    test("a write puts nothing on the command line but the entry's name", () => {
      const argv = writeArgv(ref("pass:acme/deploy")) ?? [];
      expect(argv).toEqual(["pass", "insert", "--multiline", "--force", "acme/deploy"]);
      expect(argv.join(" ")).not.toContain(SECRET);
    });
  });

  describe("what cannot be rotated, and why", () => {
    test("a keychain item is refused because the password would land in argv", () => {
      const why = whyNotRotatable(ref("keychain:acme"));
      expect(why).toContain("ps");
      expect(writeArgv(ref("keychain:acme"))).toBeUndefined();
    });

    test("an environment variable is refused because nothing written changes it", () => {
      expect(whyNotRotatable(ref("env:X"))).toContain("already running");
    });

    test("1Password is refused because the field schema would be a guess", () => {
      expect(whyNotRotatable(ref("op://v/i/f"))).toContain("op item edit");
    });

    test("the local and stdin-accepting backends are rotatable", () => {
      for (const raw of ["file:x", "envfile:.env#K", "pass:a/b", "libsecret:s=v"]) {
        expect(whyNotRotatable(ref(raw))).toBeUndefined();
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe("fingerprints", () => {
  test("the same value fingerprints the same way, twice", () => {
    expect(fingerprint(SECRET)).toBe(fingerprint(SECRET));
  });

  test("two values do not", () => {
    expect(fingerprint(SECRET)).not.toBe(fingerprint(OTHER_SECRET));
  });

  test("one byte of difference is visible", () => {
    expect(fingerprint(SECRET)).not.toBe(fingerprint(`${SECRET}\n`));
  });

  test("it is 12 hex characters, and nothing else", () => {
    expect(fingerprint(SECRET)).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  test("it is NOT the plain sha256 of the value, so a leaked one is not lookup-able", () => {
    const plain = createHash("sha256").update(SECRET, "utf8").digest("hex");
    expect(fingerprint(SECRET)).not.toBe(`sha256:${plain.slice(0, 12)}`);
  });

  test("the domain separator is unambiguous: concatenation cannot collide", () => {
    // Without the NUL, fingerprint("a"+"b") and a prefix ending in "a" would
    // be computable from each other.
    expect(fingerprint("ab")).not.toBe(fingerprint("a\0b"));
  });

  test("a value never appears inside its own fingerprint", () => {
    expect(fingerprint("hunter2")).not.toContain("hunter2");
  });

  describe("describeValue", () => {
    test("reports a trailing newline, the one-byte bug nobody can see", () => {
      const shape = describeValue(`${SECRET}\n`);
      expect(shape.trailingNewline).toBe(true);
      expect(shape.leadingOrTrailingSpace).toBe(false);
    });

    test("reports surrounding whitespace separately from a newline", () => {
      expect(describeValue(` ${SECRET} `).leadingOrTrailingSpace).toBe(true);
    });

    test("reports emptiness, which is not the same as absence", () => {
      expect(describeValue("").empty).toBe(true);
      expect(describeValue("x").empty).toBe(false);
    });
  });

  describe("stripValues", () => {
    test("removes a secret a helper echoed into its own message", () => {
      expect(stripValues(`could not write "${SECRET}"`, [SECRET])).toBe(
        'could not write "<redacted>"',
      );
    });

    test("leaves a very short value alone rather than blacking out the message", () => {
      expect(stripValues("no such item: ab", ["ab"])).toBe("no such item: ab");
    });

    test("removes every occurrence, not just the first", () => {
      const text = stripValues(`${SECRET} and ${SECRET}`, [SECRET]);
      expect(text).not.toContain(SECRET);
    });
  });

  test("firstLine caps a helper's manual to its first complaint", () => {
    expect(firstLine("bad thing\nUsage: ...\n  -a  ...")).toBe("bad thing");
    expect(firstLine("x".repeat(500)).length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------

describe("classifying a credential helper's answer", () => {
  test("macOS: not found is ABSENT, and names what was searched", () => {
    const outcome = classify(ref("keychain:acme-api#deploy"), SECURITY_NOT_FOUND);
    expect(outcome.status).toBe("absent");
    if (outcome.status === "absent") {
      expect(outcome.reason).toContain("acme-api");
      expect(outcome.reason).toContain("deploy");
    }
  });

  test("macOS: a dash-named service still reaches the helper as a name", () => {
    // Belt-and-braces: the grammar refuses this shape, and getopt(3) would
    // have consumed it as the argument of -s anyway (captured fixture).
    const outcome = classify(
      { kind: "keychain", service: "-weird-svc" },
      SECURITY_DASH_SERVICE_NOT_FOUND,
    );
    expect(outcome.status).toBe("absent");
  });

  test("macOS: a locked keychain is an ERROR, never absent", () => {
    const outcome = classify(ref("keychain:acme"), SECURITY_LOCKED);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.reason).toContain("locked");
  });

  test("macOS: an unrecognised complaint degrades to error, not to absent", () => {
    const outcome = classify(ref("keychain:acme"), SECURITY_ILLEGAL_OPTION);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.reason).toContain("illegal option");
  });

  test("macOS: a found item comes back with the newline `security` adds removed", () => {
    const outcome = classify(ref("keychain:acme"), SECURITY_FOUND);
    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") expect(outcome.value).toBe(SECRET);
  });

  test("Linux: pass says which entry is missing", () => {
    const outcome = classify(ref("pass:acme/deploy"), PASS_NOT_FOUND);
    expect(outcome.status).toBe("absent");
    if (outcome.status === "absent") expect(outcome.reason).toContain("acme/deploy");
  });

  test("Linux: a gpg key that cannot decrypt is an error about the KEY", () => {
    const outcome = classify(ref("pass:acme/deploy"), PASS_GPG_LOCKED);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.reason).toContain("gpg");
      expect(outcome.reason).toContain("The entry exists");
    }
  });

  test("Linux: secret-tool's silent exit 1 is absent", () => {
    const outcome = classify(ref("libsecret:service=acme"), SECRET_TOOL_ABSENT);
    expect(outcome.status).toBe("absent");
  });

  test("Linux: a helper that died with no message is an error, not absent", () => {
    // `secret-tool`'s documented "nothing matched" is exit 1 and silence. A
    // helper killed by a signal (the OOM killer, a shutting-down supervisor)
    // is also silent and also non-zero — and answering "no keyring item has
    // service=acme" for a probe that never ran is a definite answer invented
    // from an unknown.
    const outcome = classify(
      { kind: "libsecret", attribute: "service", value: "acme" },
      { ...SECRET_TOOL_ABSENT, exitCode: 143 },
    );
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.reason).toContain("most likely killed");
      expect(outcome.reason).toContain("Nothing is known");
    }
  });

  test("Linux/CI: no D-Bus session is an error, because nothing was asked", () => {
    const outcome = classify(ref("libsecret:service=acme"), SECRET_TOOL_NO_DBUS);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.reason).toContain("D-Bus");
  });

  test("Linux: secret-tool's value is NOT un-terminated — it adds no newline", () => {
    expect(stripsTrailingNewline("libsecret")).toBe(false);
    const outcome = classify(ref("libsecret:service=acme"), SECRET_TOOL_FOUND);
    if (outcome.status === "resolved") expect(outcome.value).toBe(SECRET);
  });

  test("op: a missing item is absent", () => {
    const outcome = classify(ref("op://Private/Acme/credential"), OP_ABSENT);
    expect(outcome.status).toBe("absent");
  });

  test("op: being signed out is an error, and says how to fix it", () => {
    const outcome = classify(ref("op://Private/Acme/credential"), OP_SIGNED_OUT);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.reason).toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  test("op: --no-newline means the value is taken exactly as printed", () => {
    const outcome = classify(ref("op://Private/Acme/credential"), OP_FOUND);
    if (outcome.status === "resolved") expect(outcome.value).toBe(SECRET);
  });

  test("a missing binary is UNAVAILABLE and names the program", () => {
    const outcome = classify(ref("libsecret:service=acme"), NOT_INSTALLED("secret-tool"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.reason).toContain("secret-tool");
  });

  test("a timeout is an error whose REASON is the deadline, not a bare failure", () => {
    const outcome = classify(ref("pass:a/b"), TIMED_OUT);
    expect(outcome.status).toBe("error");
    // Rule: a failure a timeout could also satisfy must assert the reason.
    if (outcome.status === "error") {
      expect(outcome.reason).toContain("deadline");
      expect(outcome.reason).toContain("Nothing is known");
    }
  });

  test("a truncated read refuses to pretend it has the value", () => {
    const outcome = classify(ref("pass:a/b"), TRUNCATED);
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.reason).toContain("incomplete");
  });

  test("exit 0 with no output is absent, not an empty credential", () => {
    const outcome = classify(ref("libsecret:service=acme"), {
      argv: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    expect(outcome.status).toBe("absent");
  });

  test("a helper that echoes the value does not get it into the reason", () => {
    const outcome = classifyWrite(
      ref("pass:a/b"),
      {
        argv: [],
        exitCode: 1,
        stdout: "",
        stderr: `pass: could not write "${SECRET}"`,
        truncated: false,
        timedOut: false,
      },
      SECRET,
    );
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.reason).not.toContain(SECRET);
      expect(outcome.reason).toContain("<redacted>");
    }
  });
});

// ---------------------------------------------------------------------------

describe("the .env line model", () => {
  const files = {
    handwritten: ENV_HANDWRITTEN,
    crlf: ENV_CRLF,
    quoted: ENV_QUOTED,
    duplicate: ENV_DUPLICATE,
    unterminated: ENV_NO_TRAILING_NEWLINE,
    empty: "",
  };

  for (const [name, text] of Object.entries(files)) {
    test(`${name}: parse then render is byte-identical`, () => {
      expect(renderEnvDoc(parseEnvDoc(text))).toBe(text);
    });
  }

  test("a CRLF file stays CRLF when a line changes", () => {
    const planned = planUpsert(parseEnvDoc(ENV_CRLF), "SLACK_BOT_TOKEN", "xoxb-new");
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const out = renderEnvDoc(planned.value.doc);
    expect(out).toContain("SLACK_BOT_TOKEN=xoxb-new\r\n");
    expect(out.includes("\n\n")).toBe(false); // no bare LF crept in
    expect(out.split("\r\n").length).toBe(ENV_CRLF.split("\r\n").length);
  });

  test("comments, blank lines and key order survive an edit", () => {
    const before = parseEnvDoc(ENV_HANDWRITTEN);
    const planned = planUpsert(before, "SLACK_BOT_TOKEN", "xoxb-new");
    if (!planned.ok) throw new Error(planned.message);
    const after = planned.value.doc;
    expect(assignedKeys(after)).toEqual(assignedKeys(before));
    expect(renderEnvDoc(after)).toContain("# Acme harness credentials");
    expect(renderEnvDoc(after)).toContain("# Optional — set to enable the nightly job");
    expect(renderEnvDoc(after).split("\n").length).toBe(ENV_HANDWRITTEN.split("\n").length);
  });

  test("an `export ` prefix is kept", () => {
    const planned = planUpsert(parseEnvDoc(ENV_HANDWRITTEN), "ANTHROPIC_API_KEY", "sk-ant-bbbb");
    if (!planned.ok) throw new Error(planned.message);
    expect(renderEnvDoc(planned.value.doc)).toContain("export ANTHROPIC_API_KEY=sk-ant-bbbb");
  });

  test("a commented stub is promoted IN PLACE, not appended below", () => {
    const planned = planUpsert(
      parseEnvDoc(ENV_HANDWRITTEN),
      "NIGHTLY_WEBHOOK",
      "https://x.example",
    );
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.value.how).toBe("uncommented");
    const lines = renderEnvDoc(planned.value.doc).split("\n");
    expect(lines[7]).toBe("NIGHTLY_WEBHOOK=https://x.example");
    // Exactly one line mentions the key: an appended second assignment would
    // shadow this one depending on which the reader wins with.
    expect(lines.filter((line) => line.includes("NIGHTLY_WEBHOOK")).length).toBe(1);
  });

  test("a new key is appended, and an unterminated file gets its newline first", () => {
    const planned = planUpsert(parseEnvDoc(ENV_NO_TRAILING_NEWLINE), "C", "3");
    if (!planned.ok) throw new Error(planned.message);
    expect(renderEnvDoc(planned.value.doc)).toBe("A=1\nB=2\nC=3\n");
  });

  test("setting the value it already has is `unchanged`, and rewrites nothing", () => {
    const doc = parseEnvDoc(ENV_HANDWRITTEN);
    const planned = planUpsert(doc, "SLACK_BOT_TOKEN", "xoxb-000000-111111");
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.value.how).toBe("unchanged");
    expect(renderEnvDoc(planned.value.doc)).toBe(ENV_HANDWRITTEN);
  });

  test("`unchanged` is decided on the DECODED value, not on the raw line", () => {
    // The trap from the survey: comparing raw text would rewrite a quoted
    // value on every call and report "replaced" forever.
    const doc = parseEnvDoc(ENV_QUOTED);
    const planned = planUpsert(doc, "QUOTED_QUOTE", 'a"b');
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.value.how).toBe("unchanged");
  });

  test("the decoded value is what the canonical reader says it is", () => {
    const doc = parseEnvDoc(ENV_QUOTED);
    const canonical = parseEnvText(ENV_QUOTED);
    for (const key of assignedKeys(doc)) {
      const index = liveAssignments(doc, key)[0] as number;
      expect(decodeAssignment(doc.lines[index]?.raw ?? "")).toBe(canonical[key] as string);
    }
    // Including the two shapes factory#452 was about.
    expect(canonical["QUOTED_QUOTE"]).toBe('a"b');
    expect(canonical["QUOTED_BACKSLASH"]).toBe("c\\d");
  });

  test("a duplicate key is refused, with both line numbers", () => {
    const planned = planUpsert(parseEnvDoc(ENV_DUPLICATE), "API_KEY", "third");
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.message).toContain("lines 1 and 3");
      expect(planned.message).toContain("last one wins");
    }
  });

  test("unset comments the line out and keeps the name", () => {
    const planned = planUnset(parseEnvDoc(ENV_HANDWRITTEN), "SLACK_BOT_TOKEN");
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.value.how).toBe("commented");
    const out = renderEnvDoc(planned.value.doc);
    expect(out).toContain("# SLACK_BOT_TOKEN=");
    expect(out).not.toContain("xoxb-000000-111111");
    expect(stubIndex(parseEnvDoc(out), "SLACK_BOT_TOKEN")).toBe(3);
  });

  test("unsetting something absent changes nothing and says so", () => {
    const planned = planUnset(parseEnvDoc(ENV_HANDWRITTEN), "NOT_THERE");
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.value.how).toBe("absent");
    expect(renderEnvDoc(planned.value.doc)).toBe(ENV_HANDWRITTEN);
  });

  test("a trailing-comment value decodes the way the reader reads it", () => {
    expect(decodeAssignment("LOG_LEVEL=debug # how chatty the daemon is")).toBe("debug");
  });
});

describe("what may be written into a .env, and what is refused", () => {
  test("an ordinary token is written bare", () => {
    const encoded = encodeBare("K", "sk-live-abc_123.def/ghi+jkl=");
    expect(encoded.ok).toBe(true);
  });

  test("base64 padding survives — `=` needs no quoting", () => {
    const value = Buffer.from(SECRET).toString("base64");
    expect(value.endsWith("=")).toBe(true);
    const encoded = encodeBare("K", value);
    expect(encoded.ok).toBe(true);
    expect(parseEnvText(`K=${value}`)["K"]).toBe(value);
  });

  const refused: [string, string, string][] = [
    // A space is refused even though the CANONICAL reader keeps it: these
    // files are also sourced by shells, and a shell splits on it.
    ["an internal space", "two words", "whitespace"],
    ["a tab", "two\twords", "whitespace"],
    ["a leading quote", '"quoted"', "starts with a quote"],
    ["a hash", "value#nope", "comment"],
    ["surrounding whitespace", " padded ", "whitespace"],
    ["a newline", "line1\nline2", "newline"],
    ["a NUL", "a\0b", "NUL"],
  ];
  for (const [what, value, expected] of refused) {
    test(`refuses ${what} rather than inventing a second escaper`, () => {
      const encoded = encodeBare("K", value);
      expect(encoded.ok).toBe(false);
      if (!encoded.ok) {
        expect(encoded.message).toContain(expected);
        // The refusal names the export that would remove it — the point is
        // that a second quoter is the bug, not that the value is unwritable.
        expect(encoded.message).toContain("encodeEnvValue");
      }
    });
  }

  test("everything this package writes round-trips through the CANONICAL reader", () => {
    const values = [
      SECRET,
      "hex0123456789abcdef",
      "a-b_c.d:e@f/g+h=",
      Buffer.from(SECRET).toString("base64url"),
      "100",
      "x".repeat(2_000),
    ];
    let proven = 0;
    for (const value of values) {
      const encoded = encodeBare("K", value);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      expect(parseEnvText(`K=${encoded.value}`)["K"]).toBe(value);
      proven += 1;
    }
    // A property test that quietly proved nothing is worse than no test.
    expect(proven).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------

describe("the child environment a helper gets", () => {
  test("only named variables are forwarded", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/a",
      ANTHROPIC_API_KEY: "sk-ant-should-not-travel",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/a");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  test("LC_ALL is pinned, so a helper's message is the one the classifier knows", () => {
    expect(buildChildEnv({ LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" })["LC_ALL"]).toBe("C");
  });

  test("the keyring and store locations a helper genuinely needs do travel", () => {
    const env = buildChildEnv({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
      PASSWORD_STORE_DIR: "/home/a/.password-store",
      OP_SERVICE_ACCOUNT_TOKEN: "ops_token",
    });
    expect(Object.keys(env).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS",
      "LC_ALL",
      "OP_SERVICE_ACCOUNT_TOKEN",
      "PASSWORD_STORE_DIR",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("writing a file that holds a secret", () => {
  test("a new file is created 0600 and nothing else is left behind", () => {
    const target = join(workspace, "sub", "secret.txt");
    const report = writeFileAtomic(target, SECRET);
    expect(report.created).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe(SECRET);
    expect(readdirSync(join(workspace, "sub")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("an existing world-readable file comes back tightened, and says so", () => {
    const target = join(workspace, ".env");
    writeFileSync(target, "A=1\n");
    chmodSync(target, 0o644);
    const report = writeFileAtomic(target, "A=2\n");
    expect(report.created).toBe(false);
    expect(report.modeTightened).toBe("0644 -> 0600");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("an already-strict file is not reported as changed", () => {
    const target = join(workspace, ".env");
    writeFileSync(target, "A=1\n", { mode: 0o600 });
    expect(writeFileAtomic(target, "A=2\n").modeTightened).toBeUndefined();
  });

  test("a stricter mode than 0600 is preserved, not loosened", () => {
    const target = join(workspace, ".env");
    writeFileSync(target, "A=1\n");
    chmodSync(target, 0o400);
    const report = writeFileAtomic(target, "A=2\n");
    expect(statSync(target).mode & 0o777).toBe(0o400);
    expect(report.modeTightened).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("the rotation journal and its lock", () => {
  test("an entry records fingerprints and no values", () => {
    appendJournal("T", {
      ref: "envfile:.env#K",
      backend: "envfile",
      rotatedAt: "2026-09-18T12:00:00.000Z",
      fingerprint: fingerprint(SECRET),
      previousFingerprint: fingerprint(OTHER_SECRET),
    });
    const raw = readFileSync(join(workspace, ".crewhaus/secrets/rotations.json"), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(OTHER_SECRET);
    const { journal } = readJournal("T");
    expect(lastRotation(journal.entries, "envfile:.env#K")?.fingerprint).toBe(fingerprint(SECRET));
  });

  test("the journal file is not world-readable", () => {
    appendJournal("T", {
      ref: "a",
      backend: "file",
      rotatedAt: "2026-09-18T12:00:00.000Z",
      fingerprint: "sha256:aaaaaaaaaaaa",
    });
    const mode = statSync(join(workspace, ".crewhaus/secrets/rotations.json")).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  test("a corrupt journal is reported and treated as empty, not thrown", () => {
    mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
    writeFileSync(join(workspace, ".crewhaus/secrets/rotations.json"), "{not json");
    const { journal, unreadable } = readJournal("T");
    expect(journal.entries).toEqual([]);
    expect(unreadable).toContain("rotation journal");
  });

  test("the most recent entry for a reference wins", () => {
    for (const day of ["01", "02", "03"]) {
      appendJournal("T", {
        ref: "a",
        backend: "file",
        rotatedAt: `2026-09-${day}T00:00:00.000Z`,
        fingerprint: `sha256:${day.repeat(6)}`,
      });
    }
    const { journal } = readJournal("T");
    expect(lastRotation(journal.entries, "a")?.rotatedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(lastRotation(journal.entries, "b")).toBeUndefined();
  });

  test("a second caller is refused while the first holds the lock", () => {
    const first = acquireLock("T", "envfile:.env#K");
    expect(first.ok).toBe(true);
    const second = acquireLock("T", "envfile:.env#K");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toContain("another rotation is in progress");
      expect(second.message).toContain("invalidates");
    }
    if (first.ok) first.value.release();
    const third = acquireLock("T", "envfile:.env#K");
    expect(third.ok).toBe(true);
  });

  test("a stale lock is taken over, and the takeover is reported", () => {
    const first = acquireLock("T", "envfile:.env#K");
    expect(first.ok).toBe(true);
    // The clock is injected, so this asserts an age, never a wall clock.
    _setClock(() => Date.parse("2026-09-18T12:00:00Z") + LOCK_STALE_MS + 1_000);
    const second = acquireLock("T", "envfile:.env#K");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.brokeStale).toContain("assumed dead");
  });

  test("a lock whose age cannot be read is NOT treated as stale", () => {
    // The create is `open(wx)` followed by a separate `write`, so a concurrent
    // caller can catch the lock in its ZERO-BYTE moment. Reading a missing
    // timestamp as 0 made that empty file look ancient — the second caller
    // broke a lock the first one was still taking, and both rotations ran,
    // which is the one outcome this lock exists to prevent.
    mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
    writeFileSync(join(workspace, ".crewhaus/secrets/rotation.lock"), "");
    const lock = acquireLock("T", "envfile:.env#K");
    expect(lock.ok).toBe(false);
    if (!lock.ok) {
      // The REASON, not just the refusal: "could not be read" is the fact
      // that distinguishes this from an ordinary in-progress rotation.
      expect(lock.message).toContain("could not be read");
      expect(lock.message).toContain("whether a rotation is running");
    }
  });

  test("a lock that records no start time is refused rather than broken", () => {
    mkdirSync(join(workspace, ".crewhaus/secrets"), { recursive: true });
    writeFileSync(
      join(workspace, ".crewhaus/secrets/rotation.lock"),
      JSON.stringify({ ref: "envfile:.env#K", pid: 1 }),
    );
    const lock = acquireLock("T", "envfile:.env#K");
    expect(lock.ok).toBe(false);
    if (!lock.ok) expect(lock.message).toContain("records no start time");
  });

  test("a journal that cannot be READ is reported, not returned as an empty history", () => {
    // EISDIR, not ENOENT. Only ENOENT means "nothing rotated yet"; every
    // other errno used to come back as an empty journal, which switches
    // SecretRotate's interval guard off without saying so.
    mkdirSync(join(workspace, ".crewhaus/secrets/rotations.json"), { recursive: true });
    const { journal, unreadable } = readJournal("T");
    expect(journal.entries).toEqual([]);
    expect(unreadable).toContain("could not be read");
    expect(unreadable).toContain("EISDIR");
  });

  test("a journal that is simply not there yet is NOT reported as unreadable", () => {
    const { journal, unreadable } = readJournal("T");
    expect(journal.entries).toEqual([]);
    expect(unreadable).toBeUndefined();
  });

  test("releasing a lock somebody else already broke does not throw", () => {
    const first = acquireLock("T", "a");
    if (!first.ok) throw new Error(first.message);
    rmSync(join(workspace, ".crewhaus/secrets/rotation.lock"));
    expect(() => first.value.release()).not.toThrow();
  });

  test("the lock file itself exists while held, and is gone after", () => {
    const lock = join(workspace, ".crewhaus/secrets/rotation.lock");
    const held = acquireLock("T", "a");
    if (!held.ok) throw new Error(held.message);
    expect(existsSync(lock)).toBe(true);
    held.value.release();
    expect(existsSync(lock)).toBe(false);
  });
});
