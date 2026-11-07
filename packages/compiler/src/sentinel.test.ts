/**
 * The compile-side leak scanner (#514). The planted `intent` must reach no exit,
 * and the controls prove the scan is not blind: a marker somewhere that does
 * reach an exit is found there.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LOOP_PROJECTION_SPECS } from "./__fixtures__/loop-projection-specs";
import { compile } from "./index";
import {
  ABSENT_CORPUS,
  CONTROL_PLANE_ID_RE,
  compiledExits,
  exitHits,
  expectNoMarker,
} from "./sentinel";

const MARKER = "ZZINTENTMARKERZZ";

/** A marker in all four `intent` fields, the shape the owner can write. */
const INTENT = `intent:
  purpose: purpose ${MARKER}
  serves: [serves ${MARKER}]
  outcomes: [outcome ${MARKER}]
  excludes: [exclude ${MARKER}]
`;

describe("intent reaches no exit", () => {
  for (const [target, yaml] of Object.entries(ABSENT_CORPUS)) {
    test(`${target}: files, eval entry, IR, loop and README all lack the marker`, () => {
      expect(() => expectNoMarker({ [target]: `${yaml}${INTENT}` }, MARKER)).not.toThrow();
    });
  }
});

describe("the scanner is not blind", () => {
  const named = ABSENT_CORPUS.cli.replace("name: support-cli", `name: ${MARKER}`);

  test("the exits are the ones it promises, one per emitted file", () => {
    const exits = compiledExits(ABSENT_CORPUS.cli).map((e) => e.exit);
    const files = compile(ABSENT_CORPUS.cli).files.map((f) => `files:${f.path}`);
    const evalFiles = compile(ABSENT_CORPUS.cli, { evalEntry: true }).files.map(
      (f) => `eval:${f.path}`,
    );
    expect(files.length).toBeGreaterThan(0);
    expect(evalFiles.length).toBeGreaterThan(0);
    expect(exits).toEqual([...files, ...evalFiles, "emit-ir", "loop", "readme"]);
    expect(exits.length).toBe(files.length + evalFiles.length + 3);
    expect(new Set(exits).size).toBe(exits.length);
  });

  test("a marker in name: is found in the files, the IR and the README", () => {
    const hits = exitHits(named, MARKER).map((e) => e.exit);
    expect(hits.some((exit) => exit.startsWith("files:"))).toBe(true);
    expect(hits.some((exit) => exit.startsWith("eval:"))).toBe(true);
    expect(hits).toContain("emit-ir");
    expect(hits).toContain("readme");
  });

  test("a model name is found in the loop projection", () => {
    const hits = exitHits(LOOP_PROJECTION_SPECS["cli"] as string, "claude-opus-4-7");
    expect(hits.map((e) => e.exit)).toContain("loop");
  });

  test("a RegExp needle finds what a string needle finds, and a g flag holds no state", () => {
    const asString = exitHits(named, MARKER).map((e) => e.exit);
    expect(exitHits(named, new RegExp(MARKER)).map((e) => e.exit)).toEqual(asString);
    expect(exitHits(named, new RegExp(MARKER, "g")).map((e) => e.exit)).toEqual(asString);
  });

  test("expectNoMarker throws, naming each spec and exit", () => {
    let message = "";
    try {
      expectNoMarker({ clean: ABSENT_CORPUS.cli, leaky: named }, MARKER);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("leaky → emit-ir");
    expect(message).toContain("leaky → readme");
    expect(message).not.toContain("clean →");
  });
});

describe("the control-plane id scan", () => {
  const PREFIXES = [
    "hrn",
    "dep",
    "run",
    "sess",
    "appr",
    "dec",
    "rule",
    "cmd",
    "prn",
    "grt",
    "inv",
    "crd",
    "lnk",
    "dev",
    "wi",
    "att",
    "con",
    "crs",
    "chg",
    "psn",
    "pcl",
    "pgr",
    "ppj",
    "pso",
    "piv",
    "pex",
    "per",
    "spc",
  ];

  test("it holds no state", () => {
    expect(CONTROL_PLANE_ID_RE.flags).toBe("");
  });

  for (const [target, yaml] of Object.entries(ABSENT_CORPUS)) {
    test(`${target}: no exit holds an id`, () => {
      expect(exitHits(yaml, CONTROL_PLANE_ID_RE).map((e) => e.exit)).toEqual([]);
    });
  }

  test("an id planted in the instructions is found", () => {
    const id = ["con", "0123456789abcdef"].join("_");
    const planted = ABSENT_CORPUS.cli.replace("Help users.", `Help users. ${id}`);
    expect(exitHits(planted, CONTROL_PLANE_ID_RE).length).toBeGreaterThan(0);
  });

  test("every prefix matches a 16-character body, and a shorter body does not", () => {
    for (const prefix of PREFIXES) {
      expect(CONTROL_PLANE_ID_RE.test(`${prefix}_${"0".repeat(16)}`), prefix).toBe(true);
      expect(CONTROL_PLANE_ID_RE.test(`${prefix}_${"0".repeat(15)}`), prefix).toBe(false);
    }
  });

  test("a 26-character ULID body matches, and an emitted word does not", () => {
    expect(CONTROL_PLANE_ID_RE.test("run_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    for (const word of ["run_failed", "run_done", "dev_mode", "per_tenant"]) {
      expect(CONTROL_PLANE_ID_RE.test(word), word).toBe(false);
    }
  });
});

describe("the entry point", () => {
  test("the compiler's own entry does not load the sentinel, so a bundle never does", () => {
    const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(entry).not.toContain("./sentinel");
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };
    expect(manifest.exports["./sentinel"]).toBe("./src/sentinel.ts");
  });
});
