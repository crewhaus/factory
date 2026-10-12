/**
 * spec-lines.ts reads a spec's text without patterns that rescanned a run in
 * it, and runs.ts guards its keyed-line pattern. Each read must answer what
 * its pattern answered, and the spec readers fed a spec a model wrote, with a
 * U+2028 line, a long word and a run of blank lines in it, must neither run
 * those patterns over the run nor read it more than a few times by hand.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySpecPatch } from "@crewhaus/spec-patch";
import { scanWork } from "./__test__/scan-work";
import { scanMcpServers } from "./builders";
import { sessionKeyOf } from "./feedback-ops";
import { declaredBudgetUsd } from "./health";
import { hasLineBreak } from "./linear-mask";
import { specBlock, specScalar } from "./memory-ops";
import { specCredentialValues } from "./runs";
import { declaredExpose } from "./runtime-ops";
import { declaredCadences } from "./schedulers";
import { declaredPaths, provenanceOf } from "./spec-edit";
import {
  hasIndentedKey,
  keyLineParts,
  keyValueParts,
  keyedScalar,
  namedValues,
  withoutTrailingComment,
} from "./spec-lines";
import { capabilityBadges } from "./spec-view";
import { declaresLocalWiki, scanThredzBlock } from "./thredz";

const KEY_LINE = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/;
const KEY_VALUE = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/;
const SPEC_SCALAR_LINE = /^[ \t]*(?:- )?([A-Za-z0-9_.-]+):[ \t]*(.*)$/;
const SESSION_KEY = /^\s*sessionKey\s*:\s*(.+)$/;
const FIELDS = /([A-Za-z][A-Za-z0-9_]*)=("[^"]*"|\S+)/g;
const COMMENT = /#.*$/;
const keyed = (key: string): RegExp => new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
const indentedKey = (key: string): RegExp => new RegExp(`^\\s+${key}\\s*:`, "m");

/** The two readers as they were, each by its pattern. */
const before = {
  sessionKeyOf(specYaml: string): string | null {
    for (const line of specYaml.split("\n")) {
      const m = line.match(SESSION_KEY);
      if (m === null) continue;
      const value = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value !== "" && !value.startsWith("#")) return value;
    }
    return null;
  },
  provenanceOf(yamlText: string): Record<string, unknown> | null {
    const header = /^#\s*crewhaus:optimize\s+(.*)$/m.test(yamlText)
      ? (yamlText.match(/^#\s*crewhaus:optimize\s+(.*)$/m)?.[1] ?? "")
      : null;
    if (header === null) return null;
    const fields: Record<string, unknown> = {};
    for (const m of header.matchAll(FIELDS)) {
      const key = m[1] as string;
      const raw = (m[2] ?? "").replace(/^"|"$/g, "");
      const num = Number(raw);
      fields[key] = raw !== "" && !Number.isNaN(num) ? num : raw;
    }
    return Object.keys(fields).length > 0 ? fields : null;
  },
};

/** Every concatenation of up to `depth` of `pieces`, `visit`ed; returns how many. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): number {
  let count = 0;
  const walk = (text: string, d: number): void => {
    visit(text);
    count++;
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
  return count;
}

/** `n` seeded pseudo-random concatenations of 1 to `maxPieces` of `pieces`. */
function randomTexts(pieces: readonly string[], n: number, maxPieces: number): string[] {
  let seed = 0x3c6ef372;
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    const length = 1 + next(maxPieces);
    for (let k = 0; k < length; k++) text += pieces[next(pieces.length)];
    out.push(text);
  }
  return out;
}

/**
 * The texts where `read` and `want` disagree, over every concatenation of up
 * to `depth` pieces and `random` seeded random ones; and how many of them
 * `want` matched, so a test can tell the alphabet reaches the matching side.
 */
function disagreements(
  pieces: readonly string[],
  depth: number,
  random: number,
  read: (text: string) => unknown,
  want: (text: string) => unknown,
  matched: (answer: unknown, text: string) => boolean,
): { differ: string[]; matches: number } {
  const differ: string[] = [];
  let matches = 0;
  const visit = (t: string): void => {
    const answer = want(t);
    if (matched(answer, t)) matches++;
    if (JSON.stringify(read(t)) !== JSON.stringify(answer)) differ.push(JSON.stringify(t));
  };
  everyText(pieces, depth, visit);
  for (const t of randomTexts(pieces, random, 14)) visit(t);
  return { differ, matches };
}

/** A match's groups from 1 on, undefined ones kept; null for no match. */
const groups = (m: RegExpMatchArray | null): Array<string | undefined> | null =>
  m === null ? null : m.slice(1);

const found = (answer: unknown): boolean => answer !== null && answer !== false;

// Every space, tab and line break the patterns tell apart, NEL as a control
// that is neither whitespace nor a line terminator to them, and the
// characters of their keys.
const SPACES = [" ", "\t", "\r", "\n", "\u2028", "\u2029", "\u00a0", "\u0085"];

describe("each read answers what its pattern answered", () => {
  test("keyedScalar", () => {
    const pieces = [...SPACES, "every", "ever", ":", "x", "#"];
    for (const key of ["every", "k"]) {
      const re = keyed(key);
      const { differ, matches } = disagreements(
        [...pieces, key],
        4,
        20_000,
        (t) => keyedScalar(t, key) ?? null,
        (t) => t.match(re)?.[1] ?? null,
        found,
      );
      expect(differ).toEqual([]);
      expect(matches).toBeGreaterThan(300);
    }
  }, 30_000);

  test("keyLineParts", () => {
    const pieces = [...SPACES, "k", "_", "-", ".", ":", "x", "a b"];
    const { differ, matches } = disagreements(
      pieces,
      4,
      30_000,
      (t) => keyLineParts(t),
      (t) => groups(t.match(KEY_LINE)),
      found,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
  }, 30_000);

  test("keyValueParts", () => {
    const pieces = [...SPACES, "k", "_", "-", ".", ":", "x", "a b"];
    const { differ, matches } = disagreements(
      pieces,
      4,
      30_000,
      (t) => keyValueParts(t),
      (t) => groups(t.match(KEY_VALUE)),
      found,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
  }, 30_000);

  test("withoutTrailingComment", () => {
    const pieces = [...SPACES, "#", "x"];
    const { differ, matches } = disagreements(
      pieces,
      5,
      20_000,
      (t) => withoutTrailingComment(t),
      (t) => t.replace(COMMENT, ""),
      (answer, t) => answer !== t,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
  }, 30_000);

  test("hasIndentedKey", () => {
    const pieces = [...SPACES, "wiki", "wik", ":", "x"];
    const re = indentedKey("wiki");
    const { differ, matches } = disagreements(
      pieces,
      4,
      40_000,
      (t) => hasIndentedKey(t, "wiki"),
      (t) => re.test(t),
      found,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
  }, 30_000);

  test("namedValues", () => {
    const pieces = ["a", "1", "_", "=", '"', " ", "\n", "\u2028", "ab", "x=1", '="', "\t"];
    const { differ, matches } = disagreements(
      pieces,
      4,
      40_000,
      (t) => namedValues(t),
      (t) => [...t.matchAll(FIELDS)].map((m) => [m[1], m[2]]),
      (answer) => (answer as unknown[]).length > 0,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
  }, 30_000);

  test("the keyed-line guard in specCredentialValues changes no answer", () => {
    const pieces = ["k", ":", " ", "\t", "- ", "'", "\r", "\u2028", "\u2029", "x"];
    const { differ, matches } = disagreements(
      pieces,
      5,
      20_000,
      (t) => (hasLineBreak(t) ? null : groups(t.match(SPEC_SCALAR_LINE))),
      (t) => groups(t.match(SPEC_SCALAR_LINE)),
      found,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
  }, 30_000);

  test("sessionKeyOf", () => {
    const pieces = ["sessionKey", ":", " ", "\t", "\u2028", "\r", "\n", "x", '"', "'", "#"];
    const { differ, matches } = disagreements(
      pieces,
      4,
      30_000,
      (t) => sessionKeyOf(t),
      (t) => before.sessionKeyOf(t),
      found,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(100);
    expect(sessionKeyOf("channels:\n  slack:\n    sessionKey: channel\n")).toBe("channel");
  }, 30_000);

  test("provenanceOf", () => {
    const pieces = [
      "# crewhaus:optimize ",
      "#",
      " ",
      "\n",
      "\u2028",
      "runId=",
      "a",
      "1",
      '"',
      "score=0.5",
    ];
    const { differ, matches } = disagreements(
      pieces,
      4,
      30_000,
      (t) => provenanceOf(t),
      (t) => before.provenanceOf(t),
      found,
    );
    expect(differ).toEqual([]);
    expect(matches).toBeGreaterThan(1_000);
    const stamped = '# crewhaus:optimize runId=r-1 mutator="claude x" score=0.82\ntarget: cli\n';
    expect(provenanceOf(stamped)).toEqual({ runId: "r-1", mutator: "claude x", score: 0.82 });
  }, 30_000);
});

const N = 20_000;
const SPACE_RUN = " ".repeat(N);
const WORD_RUN = "a".repeat(N);
const HASH_RUN = "#".repeat(N);
const BLANK_RUN = "\n".repeat(N);

/**
 * A spec whose `agent.instructions` a model rewrote, written by
 * `applySpecPatch` as the optimizer write-back writes it. The YAML writer
 * puts the text in a block scalar, keeping each line whole, each U+2028 raw
 * and each blank line, so lines of model text reach every reader that reads
 * the spec line by line. (Text holding a CR is written double-quoted and
 * folded at 80 columns instead, which cuts a long run into short lines.)
 */
const PATCHED = applySpecPatch(
  [
    "target: cli",
    "name: hello-cli",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: You are a helpful assistant.",
    "tools:",
    "  - Read",
    "memory:",
    "  enabled: true",
    "",
  ].join("\n"),
  {
    target: "cli",
    path: ["agent", "instructions"],
    op: "replace",
    value: [
      "Follow these rules.",
      `sessionKey:${SPACE_RUN}x\u2028y`,
      `token:${SPACE_RUN}x\u2028y`,
      `see\u2028# crewhaus:optimize ${WORD_RUN}\u2028end`,
      `${HASH_RUN}\u2028x`,
      BLANK_RUN,
      "Thanks.",
    ].join("\n"),
  },
).yaml;

/**
 * A spec as a model can write it whole (`crewhaus init` writes the model's
 * spec as it came): a long run of spaces before a U+2028 under each key a
 * block reader looks for.
 */
const hostile = (key: string): string => `${key}:${SPACE_RUN}x\u2028y`;
const WRITTEN = [
  "target: cli",
  "name: hello-cli",
  hostile("notes"),
  "heartbeat:",
  `  ${hostile("every")}`,
  "schedule:",
  `  ${hostile("cron")}`,
  "memory:",
  `  ${HASH_RUN}\u2028x`,
  "  dream:",
  `    ${hostile("every")}`,
  "  wiki:",
  `    ${hostile("requireSources")}`,
  "learning:",
  `  ${hostile("enabled")}`,
  "thredz:",
  `  ${hostile("api_key")}`,
  "expose:",
  "  mcp:",
  `    ${hostile("transport")}`,
  "budget:",
  `  usd: 5 ${HASH_RUN}\u2028x`,
  "mcp_servers:",
  `  ${hostile("fs")}`,
  "",
].join("\n");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A harness directory holding `yaml` as its crewhaus.yaml. */
function harnessWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-lines-"));
  dirs.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), yaml);
  return dir;
}

/** Every spec reader this manager runs on a spec's text, on `yaml`. */
function readers(yaml: string): ReadonlyArray<readonly [string, () => unknown]> {
  const dir = harnessWith(yaml);
  return [
    ["specCredentialValues", () => specCredentialValues(dir)],
    ["sessionKeyOf", () => sessionKeyOf(yaml)],
    ["declaredPaths", () => declaredPaths(yaml)],
    ["provenanceOf", () => provenanceOf(yaml)],
    ["declaresLocalWiki", () => declaresLocalWiki(yaml)],
    ["scanThredzBlock", () => scanThredzBlock(yaml)],
    ["declaredCadences", () => declaredCadences(yaml)],
    ["declaredExpose", () => declaredExpose(yaml)],
    [
      "specScalar",
      () => [
        specScalar(specBlock(yaml, ["learning"]) ?? [], "enabled"),
        specScalar(specBlock(yaml, ["memory", "wiki"]) ?? [], "requireSources"),
        specScalar(specBlock(yaml, ["memory", "dream"]) ?? [], "every"),
      ],
    ],
    ["capabilityBadges", () => capabilityBadges(yaml)],
    ["declaredBudgetUsd", () => declaredBudgetUsd(yaml)],
    ["scanMcpServers", () => scanMcpServers(yaml)],
  ];
}

/** The patterns these readers ran before, by source. */
const OLD_SOURCES = new Set(
  [KEY_LINE, KEY_VALUE, SESSION_KEY, FIELDS, COMMENT, indentedKey("wiki")].map((re) => re.source),
);
const isOldKeyedSource = (source: string): boolean =>
  source.startsWith("^\\s*") && source.endsWith("\\s*:\\s*(.*)$");
const RUNS = [SPACE_RUN, WORD_RUN, HASH_RUN, BLANK_RUN].map((run) => run.slice(0, 10_000));

/**
 * Runs `body` with the old patterns refused on the spot, and recorded, when
 * they run over a text holding one of the runs; every other pattern runs.
 * The keyed-line pattern runs.ts still uses is refused too: its guard must
 * keep it off every line holding a run before a line break. Replacing
 * `RegExp.prototype.exec` routes every String and RegExp method that runs a
 * pattern through it (the control below checks that); restored after.
 */
function oldPatternsOver<T>(body: () => T): { ran: string[]; outcome: T | Error } {
  const ran: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    const old =
      OLD_SOURCES.has(this.source) ||
      isOldKeyedSource(this.source) ||
      this.source === SPEC_SCALAR_LINE.source;
    if (old && typeof input === "string" && RUNS.some((run) => input.includes(run))) {
      ran.push(`/${this.source}/`);
      throw new Error(`/${this.source}/ ran over a run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { ran, outcome: body() };
  } catch (err) {
    return { ran, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

// Counted, not timed: each reader is fed both specs with the old patterns
// refused if they run over a run.
describe("a spec a model wrote, with long runs in it", () => {
  test("the patches keep what the readers rescanned", () => {
    expect(PATCHED).toContain(`sessionKey:${SPACE_RUN}x\u2028y`);
    expect(PATCHED).toContain(`\u2028# crewhaus:optimize ${WORD_RUN}\u2028`);
    expect(PATCHED).toContain(BLANK_RUN.slice(0, 1_000));
    // Control: the hook sees the old patterns when they run.
    expect(oldPatternsOver(() => `k:${SPACE_RUN}x\u2028y`.match(keyed("k"))).ran).toEqual([
      `/${keyed("k").source}/`,
    ]);
    expect(oldPatternsOver(() => indentedKey("wiki").test(BLANK_RUN)).ran).toEqual([
      `/${indentedKey("wiki").source}/`,
    ]);
  });

  for (const [name, spec] of [
    ["patched", PATCHED],
    ["written", WRITTEN],
  ] as const) {
    test(`the ${name} spec is read without the old patterns over its runs`, () => {
      for (const [reader, read] of readers(spec)) {
        const { ran, outcome } = oldPatternsOver(read);
        expect({ reader, ran }).toEqual({ reader, ran: [] });
        expect(outcome).not.toBeInstanceOf(Error);
      }
    }, 20_000);
  }

  test("the readers still read what the spec declares around the runs", () => {
    expect(sessionKeyOf(PATCHED)).toBeNull();
    // The header after the U+2028 is a word with no `=`: no fields.
    expect(provenanceOf(PATCHED)).toBeNull();
    expect(declaredPaths(PATCHED)).toContainEqual(["memory", "enabled"]);
    expect(declaresLocalWiki(PATCHED)).toBe(false);
    // Each block is there; the line under it that holds a U+2028 is no
    // scalar, as it was not for the patterns.
    expect(declaredCadences(WRITTEN)).toEqual({
      heartbeat: "declared (no interval read)",
      schedule: "declared (no trigger read)",
      dream: "declared (no interval read)",
    });
    expect(declaredBudgetUsd(WRITTEN)).toBe(5);
    expect(capabilityBadges(WRITTEN).wiki).toBe(true);
  });
});

// Counted, not timed: a scan can rescan a run with no pattern at all (a
// search that resumes one character on instead of after what it read), so
// each reader's own reads are counted (__test__/scan-work.ts) over both specs,
// and each scan's over a line shaped to make it rescan, and held to a few per
// character. A rescan reads the rest of a run from every place in it and
// stops at the bound at once.
describe("the spec readers read a long run a bounded number of times", () => {
  const PER_CHARACTER = 32;
  for (const [name, spec] of [
    ["patched", PATCHED],
    ["written", WRITTEN],
  ] as const) {
    test(`every reader on the ${name} spec`, () => {
      for (const [reader, read] of readers(spec)) {
        const most = PER_CHARACTER * spec.length;
        const { work } = scanWork(most, read);
        expect({ reader, under: work <= most }).toEqual({ reader, under: true });
      }
    }, 20_000);
  }

  const line = `k:${SPACE_RUN}x\u2028y`;
  const cases: ReadonlyArray<readonly [string, (text: string) => unknown, string]> = [
    ["keyedScalar", (t) => keyedScalar(t, "k"), line],
    ["keyLineParts", keyLineParts, line],
    ["keyValueParts", keyValueParts, line],
    ["withoutTrailingComment", withoutTrailingComment, `${HASH_RUN}\u2028x`],
    ["hasIndentedKey over blank lines", (t) => hasIndentedKey(t, "wiki"), BLANK_RUN],
    ["hasIndentedKey over spaced lines", (t) => hasIndentedKey(t, "wiki"), " \n".repeat(N / 2)],
    ["namedValues over a word with no =", namedValues, WORD_RUN],
    ["namedValues over unclosed quotes", namedValues, 'a="'.repeat(N / 3)],
    ["namedValues over names with no value", namedValues, "a= ".repeat(N / 3)],
  ];
  for (const [label, scan, text] of cases) {
    test(label, () => {
      const most = 8 * text.length;
      const { work } = scanWork(most, () => scan(text));
      expect(work).toBeLessThanOrEqual(most);
      // The count sees the run being read; a scan that read it some other
      // way would read as no work here.
      expect(work).toBeGreaterThanOrEqual(text.length);
    });
  }
});
