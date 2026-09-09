/**
 * Comment-preserving spec-edit tests.
 *
 * The reason this module exists rather than a `parse` → mutate → `stringify`
 * round-trip is that a harness's `crewhaus.yaml` is a hand-authored file: the
 * comments explaining why a model was pinned, the blank lines separating
 * sections, and the author's key order all have to survive setup writing one
 * slug into it. So the central assertion here is a LINE-BY-LINE comparison of
 * before and after, not a re-parse — a re-parse would happily pass on a file
 * that lost every comment.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewThredzSpace, setThredzSpace } from "./spec-edit";
import { ServiceSetupError } from "./types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write `yaml` as a harness spec and return its absolute path. */
function writeSpec(yaml: string, file = "crewhaus.yaml"): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-spec-edit-"));
  dirs.push(dir);
  const specPath = join(dir, file);
  writeFileSync(specPath, yaml, "utf8");
  return specPath;
}

/** Capture a thrown `ServiceSetupError`, asserting that one was thrown. */
function caught(fn: () => unknown): ServiceSetupError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceSetupError);
    return err as ServiceSetupError;
  }
  throw new Error("expected a ServiceSetupError, but nothing was thrown");
}

/** The 1-based indices of lines that differ between two documents. */
function changedLines(before: string, after: string): readonly number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const changed: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) changed.push(i + 1);
  }
  return changed;
}

/** A spec with comments, blank lines, and a deliberate key order. */
const COMMENTED_SPEC = `# Crew secretary — the on-call note-taker.
# Keep this file in sync with ops/README.md.
name: secretary
target: channel # the shape, not the channel

model: claude-opus-4 # pinned: 4.5 regressed on our tone eval

channels:
  slack:
    # Both refs are read by the daemon, never by setup.
    botToken: $SECRETARY_SLACK_BOT_TOKEN
    signingSecret: $SECRETARY_SLACK_SIGNING_SECRET

thredz:
  api_key: $SECRETARY_THREDZ_KEY # minted per-agent
  space: old-space # the wiki space setup provisions
  visibility: shared

# Trailing note: the gateway port is NOT the events port.
gateway:
  port: 4601
`;

describe("setThredzSpace", () => {
  test("changes only the thredz.space line, leaving comments and order intact", () => {
    const specPath = writeSpec(COMMENTED_SPEC);
    const result = setThredzSpace(specPath, "crew-secretary");

    expect(result).toEqual({
      file: "crewhaus.yaml",
      path: "thredz.space",
      outcome: "set",
      value: "crew-secretary",
    });

    const after = readFileSync(specPath, "utf8");
    const changed = changedLines(COMMENTED_SPEC, after);
    expect(changed).toHaveLength(1);

    const lineNo = changed[0] ?? 0;
    const before = COMMENTED_SPEC.split("\n")[lineNo - 1];
    const now = after.split("\n")[lineNo - 1];
    expect(before).toBe("  space: old-space # the wiki space setup provisions");
    expect(now).toBe("  space: crew-secretary # the wiki space setup provisions");

    // Every comment, blank line and sibling key survives verbatim.
    expect(after).toContain("# Crew secretary — the on-call note-taker.");
    expect(after).toContain("model: claude-opus-4 # pinned: 4.5 regressed on our tone eval");
    expect(after).toContain("    # Both refs are read by the daemon, never by setup.");
    expect(after).toContain("# Trailing note: the gateway port is NOT the events port.");
    expect(after).toContain("  api_key: $SECRETARY_THREDZ_KEY # minted per-agent");
    expect(after).toContain("  visibility: shared");
    expect(after.split("\n").length).toBe(COMMENTED_SPEC.split("\n").length);
  });

  test("adds space inside the thredz map when the key is absent", () => {
    const source = `name: secretary

thredz:
  # the key lives in .env
  api_key: $SECRETARY_THREDZ_KEY
  visibility: private

gateway:
  port: 4601
`;
    const specPath = writeSpec(source);
    expect(setThredzSpace(specPath, "crew-secretary").outcome).toBe("set");

    const after = readFileSync(specPath, "utf8");
    const lines = after.split("\n");
    const added = lines.findIndex((l) => l.trim().startsWith("space:"));
    expect(added).toBeGreaterThan(-1);
    expect(lines[added]).toBe("  space: crew-secretary");

    // It landed inside the thredz map, after its siblings and before the
    // next top-level key.
    const thredzAt = lines.indexOf("thredz:");
    const gatewayAt = lines.indexOf("gateway:");
    expect(added).toBeGreaterThan(thredzAt);
    expect(added).toBeLessThan(gatewayAt);

    // The siblings and their comment are untouched.
    expect(after).toContain("  # the key lives in .env");
    expect(after).toContain("  api_key: $SECRETARY_THREDZ_KEY");
    expect(after).toContain("  visibility: private");
    expect(after).toContain("gateway:\n  port: 4601");

    // Nothing else moved: the file is the source with one line inserted.
    expect(after).toBe(
      source.replace("  visibility: private\n", "  visibility: private\n  space: crew-secretary\n"),
    );
  });

  test("is unchanged, and leaves the bytes alone, when the value already matches", () => {
    const specPath = writeSpec(COMMENTED_SPEC);
    const before = readFileSync(specPath);
    const mtimeBefore = statSync(specPath).mtimeMs;

    const result = setThredzSpace(specPath, "old-space");
    expect(result).toEqual({
      file: "crewhaus.yaml",
      path: "thredz.space",
      outcome: "unchanged",
      value: "old-space",
    });

    expect(readFileSync(specPath).equals(before)).toBe(true);
    expect(statSync(specPath).mtimeMs).toBe(mtimeBefore);
  });

  test("re-running after a set is a no-op", () => {
    const specPath = writeSpec(COMMENTED_SPEC);
    expect(setThredzSpace(specPath, "crew-secretary").outcome).toBe("set");
    const afterFirst = readFileSync(specPath);
    expect(setThredzSpace(specPath, "crew-secretary").outcome).toBe("unchanged");
    expect(readFileSync(specPath).equals(afterFirst)).toBe(true);
  });

  test("reports the spec's own basename, not the full path", () => {
    const specPath = writeSpec(COMMENTED_SPEC, "secretary.crewhaus.yaml");
    expect(setThredzSpace(specPath, "x").file).toBe("secretary.crewhaus.yaml");
  });
});

describe("setThredzSpace refusals", () => {
  test("no thredz: block at all", () => {
    const specPath = writeSpec("name: n\ntarget: channel\n");
    const err = caught(() => setThredzSpace(specPath, "s"));
    expect(err.service).toBe("harness");
    expect(err.message).toBe("crewhaus.yaml has no thredz: block to scope");
    expect(err.options.fix).toContain("add a thredz: block");
    expect(err.failureClass).toBe("config");
  });

  test("an empty `thredz:` key is treated as no block", () => {
    const err = caught(() => setThredzSpace(writeSpec("name: n\nthredz:\n"), "s"));
    expect(err.message).toContain("has no thredz: block");
  });

  test("`thredz: false` is no block either", () => {
    const err = caught(() => setThredzSpace(writeSpec("name: n\nthredz: false\n"), "s"));
    expect(err.message).toContain("has no thredz: block");
  });

  test("the boolean shorthand says so and shows the expansion", () => {
    const err = caught(() => setThredzSpace(writeSpec("name: n\nthredz: true\n"), "s"));
    expect(err.service).toBe("harness");
    expect(err.message).toBe(
      "crewhaus.yaml uses the thredz shorthand (`thredz: true`), which has nowhere to put a space",
    );
    expect(err.options.fix).toContain("api_key: $YOUR_KEY_VAR");
  });

  test("the string shorthand names the form but NEVER the value", () => {
    // In the string shorthand the scalar IS the Thredz api_key, and the spec
    // schema accepts a literal there — so echoing it would print a live
    // credential to stdout. Name the form instead.
    const err = caught(() => setThredzSpace(writeSpec("name: n\nthredz: $MY_KEY\n"), "s"));
    expect(err.message).toBe(
      "crewhaus.yaml uses the thredz shorthand (`thredz: <value>`), which has nowhere to put a space",
    );
    expect(err.message).not.toContain("MY_KEY");
    const literal = caught(() =>
      setThredzSpace(writeSpec("name: n\nthredz: thredz_liveSECRET0123\n"), "s"),
    );
    expect(literal.message).not.toContain("thredz_liveSECRET0123");
    expect(err.options.fix).toContain("expand it to the object form");
  });

  test("a non-mapping thredz block is its own distinct message", () => {
    for (const yaml of ["thredz:\n  - api_key: $K\n", "thredz: [1, 2]\n", "thredz: 42\n"]) {
      const err = caught(() => setThredzSpace(writeSpec(yaml), "s"));
      expect(err.service).toBe("harness");
      expect(err.message).toBe("crewhaus.yaml's thredz: block is not a mapping");
      expect(err.options.fix).toContain("mapping with an api_key key");
    }
  });

  test("a literal api_key refuses — setup will not sit beside a plaintext credential", () => {
    const source = "name: n\nthredz:\n  api_key: thr_live_abc123\n";
    const specPath = writeSpec(source);
    const err = caught(() => setThredzSpace(specPath, "crew"));
    expect(err.service).toBe("harness");
    expect(err.message).toBe(
      "crewhaus.yaml inlines a literal thredz.api_key — setup will not add configuration beside a plaintext credential",
    );
    expect(err.options.fix).toContain("$UPPER_SNAKE env ref");
    // And the refusal is total: the file is not touched.
    expect(readFileSync(specPath, "utf8")).toBe(source);
    // The message never echoes the credential value.
    expect(err.message).not.toContain("thr_live_abc123");
  });

  test("every refusal leaves the file byte-identical", () => {
    for (const yaml of [
      "name: n\n",
      "name: n\nthredz: true\n",
      "name: n\nthredz: $K\n",
      "thredz: [1]\n",
      "thredz:\n  api_key: plaintext\n",
    ]) {
      const specPath = writeSpec(yaml);
      caught(() => setThredzSpace(specPath, "s"));
      expect(readFileSync(specPath, "utf8")).toBe(yaml);
    }
  });
});

describe("previewThredzSpace", () => {
  test("renders (unset) → slug when there is no space key", () => {
    const specPath = writeSpec("thredz:\n  api_key: $K\n");
    expect(previewThredzSpace(specPath, "crew-secretary")).toBe(
      'thredz.space: (unset) → "crew-secretary"',
    );
  });

  test("renders old → new when the space changes", () => {
    const specPath = writeSpec(COMMENTED_SPEC);
    expect(previewThredzSpace(specPath, "crew-secretary")).toBe(
      'thredz.space: old-space → "crew-secretary"',
    );
  });

  test("says so when the file already reads the slug", () => {
    const specPath = writeSpec(COMMENTED_SPEC);
    expect(previewThredzSpace(specPath, "old-space")).toBe(
      'thredz.space already reads "old-space"',
    );
  });

  test("reports the refusals the apply would raise, instead of implying success", () => {
    // A dry run is read specifically to decide whether to proceed, so it must
    // not render `(unset) → "s"` for a spec setThredzSpace will throw on.
    // Both paths share one verdict, so they cannot drift.
    expect(previewThredzSpace(writeSpec("name: n\n"), "s")).toContain("cannot set thredz.space — ");
    expect(previewThredzSpace(writeSpec("name: n\n"), "s")).toContain("no thredz: block");
    expect(previewThredzSpace(writeSpec("thredz: true\n"), "s")).toContain("thredz shorthand");
    expect(previewThredzSpace(writeSpec("thredz: $K\n"), "s")).toContain("thredz shorthand");
    expect(previewThredzSpace(writeSpec("thredz:\n  api_key: sk-literal\n"), "s")).toContain(
      "plaintext credential",
    );
  });

  test("every preview refusal corresponds to a real setThredzSpace throw", () => {
    for (const body of [
      "name: n\n",
      "thredz: true\n",
      "thredz: $K\n",
      "thredz:\n  api_key: lit\n",
    ]) {
      const specPath = writeSpec(body);
      expect(previewThredzSpace(specPath, "s")).toContain("cannot set thredz.space");
      expect(() => setThredzSpace(specPath, "s")).toThrow();
    }
  });

  test("never writes the file", () => {
    const specPath = writeSpec(COMMENTED_SPEC);
    const before = readFileSync(specPath);
    const mtimeBefore = statSync(specPath).mtimeMs;
    previewThredzSpace(specPath, "crew-secretary");
    previewThredzSpace(specPath, "old-space");
    expect(readFileSync(specPath).equals(before)).toBe(true);
    expect(statSync(specPath).mtimeMs).toBe(mtimeBefore);
  });
});
