/**
 * `compaction:` takes effect on the shapes whose bundles render it: cli,
 * channel and managed, through runtime-core's codegen twin. Compiled from the
 * absent corpus plus one block, so each assertion reads a real bundle.
 */
import { describe, expect, test } from "bun:test";
import type { Spec } from "@crewhaus/spec";
import { CORPUS_TODAY } from "./__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "./absent-corpus";
import { compile } from "./index";

const withBlock = (target: Spec["target"], block: string): string =>
  `${ABSENT_CORPUS[target]}compaction:\n${block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n`;

/** The emitted file that calls the loop, by what only that file holds. */
function loopFile(target: Spec["target"], block: string, marker: string): string {
  const files = compile(withBlock(target, block), { readme: false, today: CORPUS_TODAY }).files;
  const file = files.find((f) => f.content.includes(marker));
  if (file === undefined) throw new Error(`no ${target} file holds ${marker}`);
  return file.content;
}

/** Managed's `runChatLoop({ … })` call inside `runOneTurn`, up to the caller's overrides. */
function runOneTurnCall(content: string): string {
  const start = content.indexOf("export async function runOneTurn");
  expect(start).toBeGreaterThan(-1);
  const call = content.indexOf("runChatLoop({", start);
  const end = content.indexOf("...(args.extraOptions ?? {}),", call);
  expect(call).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(call);
  return content.slice(call, end);
}

const SHAPES: ReadonlyArray<readonly [Spec["target"], string]> = [
  ["cli", "await runChatLoop({"],
  ["channel", 'sessionTarget: "channel"'],
  ["managed", "export async function runOneTurn"],
];

describe("compaction.curate reaches the loop", () => {
  for (const [target, marker] of SHAPES) {
    test(`${target}: curate: true renders an empty curate option`, () => {
      expect(loopFile(target, "curate: true", marker)).toContain("curate: {},");
    });

    test(`${target}: a declared dial rides inside curate`, () => {
      expect(loopFile(target, "curate: true\ndedupeThreshold: 0.8", marker)).toContain(
        'curate: {"dedupeThreshold":0.8},',
      );
    });

    test(`${target}: curate: false renders nothing`, () => {
      expect(loopFile(target, "curate: false\nrelevanceTopK: 3", marker)).not.toContain("curate:");
    });
  }
});

describe("managed applies its compaction settings", () => {
  const MARKER = "export async function runOneTurn";

  test("threshold and the snip window land inside runOneTurn", () => {
    const content = loopFile(
      "managed",
      "threshold: 0.7\nsnip_keep_head: 2\nsnip_keep_tail: 9",
      MARKER,
    );
    const call = runOneTurnCall(content);
    expect(call).toContain("compactionThreshold: 0.7,");
    expect(call).toContain("snipKeepHead: 2,");
    expect(call).toContain("snipKeepTail: 9,");
  });

  test("model lands as compactionModel", () => {
    const call = runOneTurnCall(loopFile("managed", "model: claude-haiku-4-5", MARKER));
    expect(call).toContain('compactionModel: "claude-haiku-4-5",');
  });

  test("without the block, runOneTurn carries no compaction option", () => {
    const files = compile(ABSENT_CORPUS.managed, { readme: false, today: CORPUS_TODAY }).files;
    const text = files.map((f) => f.content).join("\n");
    expect(text).toContain(MARKER);
    for (const option of ["compactionModel", "compactionThreshold", "snipKeep", "curate:"]) {
      expect(text).not.toContain(option);
    }
  });
});

describe("the curation notes", () => {
  const codes = (target: Spec["target"], extra: string): ReadonlyArray<readonly [string, string]> =>
    compile(`${ABSENT_CORPUS[target]}${extra}`, { readme: false, today: CORPUS_TODAY })
      .warnings.filter((w) => w.code.startsWith("compaction-curate"))
      .map((w) => [w.code, w.path] as const);

  for (const [target] of SHAPES) {
    test(`${target}: curate with memory.embedder says the pass is lexical`, () => {
      expect(
        codes(target, "compaction: {curate: true}\nmemory: {embedder: builtin:hash}\n"),
      ).toEqual([["compaction-curate-lexical", "compaction.curate"]]);
    });

    test(`${target}: curate with memory.wiki.embedder says so too`, () => {
      expect(
        codes(target, "compaction: {curate: true}\nmemory:\n  wiki:\n    embedder: builtin:hash\n"),
      ).toEqual([["compaction-curate-lexical", "compaction.curate"]]);
    });

    test(`${target}: no embedder, no note`, () => {
      expect(codes(target, "compaction: {curate: true}\n")).toEqual([]);
    });

    test(`${target}: a dial without curate says it does nothing`, () => {
      expect(codes(target, "compaction: {dedupeThreshold: 0.8}\n")).toEqual([
        ["compaction-curate-knobs-unused", "compaction.dedupeThreshold"],
      ]);
      expect(codes(target, "compaction: {curate: false, relevanceTopK: 3}\n")).toEqual([
        ["compaction-curate-knobs-unused", "compaction.relevanceTopK"],
      ]);
      expect(codes(target, "compaction: {curate: true, relevanceTopK: 3}\n")).toEqual([]);
    });
  }

  test("a shape that does not read the block gets its unused rows, not the notes", () => {
    expect(codes("workflow", "compaction: {dedupeThreshold: 0.8}\n")).toEqual([]);
    expect(
      codes("research", "compaction: {curate: true}\nmemory: {embedder: builtin:hash}\n"),
    ).toEqual([]);
  });
});
