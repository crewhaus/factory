import { describe, expect, test } from "bun:test";
import {
  type CompactionSettings,
  compactionRunOptions,
  renderCompactionFields,
} from "./compaction-codegen";

/** One value per field, so a combination is a choice of which ones are present. */
const VALUES: Required<CompactionSettings> = {
  model: 'claude-haiku-4-5"\\',
  params: { maxTokens: 512, thinking: { effort: "low" }, temperature: 0.2 },
  threshold: 0.7,
  snipKeepHead: 2,
  snipKeepTail: 9,
  curate: true,
  dedupeThreshold: 0.8,
  relevanceTopK: 5,
};
const FIELDS = Object.keys(VALUES) as (keyof CompactionSettings)[];

/** Every present/absent combination of the eight fields. */
function combinations(): CompactionSettings[] {
  const out: CompactionSettings[] = [];
  for (let mask = 0; mask < 1 << FIELDS.length; mask += 1) {
    const c: Record<string, unknown> = {};
    FIELDS.forEach((field, bit) => {
      if ((mask & (1 << bit)) !== 0) c[field] = VALUES[field];
    });
    out.push(c as CompactionSettings);
  }
  return out;
}

/** Evaluate rendered fields the way a bundle does: inside an object literal. */
const evaluate = (fields: string): unknown => new Function(`return ({${fields}\n})`)();

describe("compactionRunOptions", () => {
  test("an empty block sets nothing and renders nothing", () => {
    expect(compactionRunOptions({})).toEqual({});
    expect(renderCompactionFields({}, "  ")).toBe("");
  });

  test("each field alone lands on its loop option", () => {
    expect(compactionRunOptions({ model: "m" })).toEqual({ compactionModel: "m" });
    expect(compactionRunOptions({ params: { maxTokens: 9 } })).toEqual({
      compactionParams: { maxTokens: 9 },
    });
    expect(compactionRunOptions({ threshold: 0.6 })).toEqual({ compactionThreshold: 0.6 });
    expect(compactionRunOptions({ snipKeepHead: 3 })).toEqual({ snipKeepHead: 3 });
    expect(compactionRunOptions({ snipKeepTail: 4 })).toEqual({ snipKeepTail: 4 });
    expect(compactionRunOptions({ curate: true })).toEqual({ curate: {} });
  });

  test("curate off or absent sets nothing, and its dials alone set nothing", () => {
    expect(compactionRunOptions({ curate: false })).toEqual({});
    expect(compactionRunOptions({ curate: false, dedupeThreshold: 0.8 })).toEqual({});
    expect(compactionRunOptions({ dedupeThreshold: 0.8, relevanceTopK: 3 })).toEqual({});
    expect(renderCompactionFields({ curate: false, relevanceTopK: 3 }, "")).toBe("");
  });

  test("the dials appear only inside curate", () => {
    expect(compactionRunOptions({ curate: true, dedupeThreshold: 0.8 })).toEqual({
      curate: { dedupeThreshold: 0.8 },
    });
    expect(compactionRunOptions({ curate: true, relevanceTopK: 3 })).toEqual({
      curate: { relevanceTopK: 3 },
    });
  });
});

describe("renderCompactionFields", () => {
  test("one line per option, in the loop's order, at the given indent", () => {
    expect(renderCompactionFields(VALUES, "    ")).toBe(
      [
        "",
        `    compactionModel: ${JSON.stringify(VALUES.model)},`,
        '    compactionParams: {"maxTokens":512,"thinking":{"effort":"low"},"temperature":0.2},',
        "    compactionThreshold: 0.7,",
        "    snipKeepHead: 2,",
        "    snipKeepTail: 9,",
        '    curate: {"dedupeThreshold":0.8,"relevanceTopK":5},',
      ].join("\n"),
    );
  });

  test("curate with no dials renders an empty object", () => {
    expect(renderCompactionFields({ curate: true }, "  ")).toBe("\n  curate: {},");
  });

  test("every combination of the eight fields evaluates to the options object", () => {
    const all = combinations();
    expect(all.length).toBe(256);
    for (const c of all) {
      expect(evaluate(renderCompactionFields(c, "  "))).toEqual(compactionRunOptions(c));
    }
  });
});
