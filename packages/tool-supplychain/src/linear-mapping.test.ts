/**
 * A mapping finds a repeated key by a map, not by searching its entries.
 *
 * `parseYamlSubset` keeps a mapping's last value for a repeated key in the
 * key's first slot, as a loader does. It found that slot by searching every
 * entry so far for each key: quadratic in the keys of one mapping, and a
 * workflow file may hold 50,000 lines. A map from key to slot now answers,
 * for a block mapping and for one that opens a sequence item (`- a: 1`).
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges
 * `findIndex` for each entry it visits, never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { type YamlMap, type YamlNode, parseYamlSubset } from "./lib/yaml";

/** Characters copied, searched or read, and elements visited, per character; under 3 here. */
const WORK_PER_CHARACTER = 6;

const range = (k: number) => Array.from({ length: k }, (_, i) => i);

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = [key: string, line: number, value: string];

/** `[key, line, value]` per entry, for a map of scalars. */
function rows(node: YamlNode | undefined): Row[] {
  if (node?.kind !== "map") return [];
  return (node as YamlMap).entries.map((e) => [
    e.key,
    e.line,
    e.value.kind === "scalar" ? e.value.value : e.value.kind,
  ]);
}

/** Last value wins, in the key's first slot: what a loader keeps. */
function lastWins(pairs: ReadonlyArray<Row>): Row[] {
  const out: Row[] = [];
  for (const pair of pairs) {
    const at = out.findIndex((r) => r[0] === pair[0]);
    if (at === -1) out.push(pair);
    else out[at] = pair;
  }
  return out;
}

describe("a mapping's repeated keys are found by a map", () => {
  test("a block mapping of thousands of keys, every fourth one repeated", () => {
    const measured = [4_000, 8_000].map((k) => {
      const lines = range(k).map((i) => `k${i}: v${i}`);
      for (const i of range(k / 4)) lines.push(`k${4 * i}: w${i}`);
      const text = lines.join("\n");
      const run = jsWork(WORK_PER_CHARACTER * text.length, () => parseYamlSubset(text));
      return { k, text, run };
    });
    for (const { k, text, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length);
      const got = rows(run.value?.doc);
      expect(got).toHaveLength(k);
      expect(got[0]).toEqual(["k0", k + 1, "w0"]);
      expect(got[1]).toEqual(["k1", 2, "v1"]);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("a sequence item's mapping of thousands of keys", () => {
    const measured = [4_000, 8_000].map((k) => {
      const text = `- ${range(k)
        .map((i) => `k${i}: v${i}`)
        .join("\n  ")}\n  k0: again`;
      const run = jsWork(WORK_PER_CHARACTER * text.length, () => parseYamlSubset(text));
      return { k, text, run };
    });
    for (const { k, text, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length);
      const doc = run.value?.doc;
      const item = doc?.kind === "seq" ? doc.items[0] : undefined;
      const got = rows(item);
      expect(got).toHaveLength(k);
      expect(got[0]).toEqual(["k0", k + 1, "again"]);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("last value wins in the first slot, on generated mappings", () => {
    const next = rng(0x5eed0201);
    const keys = ["a", "b", "c", "on", "jobs", "run", "a-b", "x.y"];
    const differ: string[] = [];
    let repeats = 0;
    for (let n = 0; n < 4_000; n++) {
      const pairs: Row[] = [];
      for (let i = 0, count = 1 + Math.floor(next() * 12); i < count; i++) {
        pairs.push([
          keys[Math.floor(next() * keys.length)] as string,
          i + 1,
          `v${Math.floor(next() * 5)}`,
        ]);
      }
      const block = pairs.map(([key, , value]) => `${key}: ${value}`).join("\n");
      const item = `- ${pairs.map(([key, , value]) => `${key}: ${value}`).join("\n  ")}`;
      const expected = lastWins(pairs);
      repeats += pairs.length - expected.length;
      const fromBlock = rows(parseYamlSubset(block).doc);
      const seq = parseYamlSubset(item).doc;
      const fromItem = rows(seq?.kind === "seq" ? seq.items[0] : undefined);
      if (JSON.stringify(fromBlock) !== JSON.stringify(expected)) differ.push(block);
      if (JSON.stringify(fromItem) !== JSON.stringify(expected)) differ.push(item);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(repeats).toBeGreaterThan(5_000);
  }, 20_000);
});
