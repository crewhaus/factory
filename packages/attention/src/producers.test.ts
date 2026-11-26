/**
 * Producers: a kind outside the vocabulary and a second registration are refused; a
 * registered producer's item is listed with the others, and carries only its own kind,
 * the harness that was read, a ref derived from its key, content for a content reader
 * only, and commands built from closed templates.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AttentionItem } from "@crewhaus/control-contract";
import { NOW, harnessDir, iso, tempRoot, testFacts } from "./__test__/fleet";
import { assembleInbox, foldHarness } from "./fold";
import { attRefOf } from "./ids";
import {
  type ProducedItem,
  _resetProducersForTest,
  producers,
  registerProducer,
} from "./producers";

const HRN = "hrn_0123456789abcdef";
const OTHER = "hrn_fedcba9876543210";

const cleanups: Array<() => void> = [];
afterEach(() => {
  _resetProducersForTest();
  for (const c of cleanups.splice(0)) c();
});

/** A well-formed item of the `security` producer the tests register. */
function produced(over: Partial<ProducedItem["item"]> = {}, key = "producer:one"): ProducedItem {
  return {
    key,
    item: {
      kind: "security",
      harness: HRN,
      source: { kind: "producer", id: "one" },
      title: { template: "advisor.other", params: { screen: "overview" } },
      whyNow: { template: "why.advisor-suggestion", params: {} },
      affected: { runs: [], count: 0 },
      evidence: [],
      choices: [],
      requiredClass: "operator",
      state: "open",
      evidenceRev: "0123456789abcdef",
      since: iso(NOW),
      freshness: { asOf: iso(NOW), mode: "direct-fold" },
      ...over,
    },
  };
}

/** What the inbox lists when one `security` producer answers these. */
function listed(items: readonly ProducedItem[], content = false): readonly AttentionItem[] {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  const dir = harnessDir(t.root, "produced");
  registerProducer("security", { templates: ["advisor.other"], fold: () => items });
  const harness = foldHarness(dir, testFacts(), NOW, { harness: HRN, content });
  return assembleInbox([harness], NOW).items;
}

describe("registerProducer", () => {
  test("refuses a kind outside the vocabulary", () => {
    expect(() => registerProducer("source-conflict-x", { templates: [], fold: () => [] })).toThrow(
      "is not an attention kind",
    );
    expect(producers()).toEqual([]);
  });

  test("a registered producer's item appears, and a second registration is refused", () => {
    const items = listed([produced()]);
    expect(() => registerProducer("security", { templates: [], fold: () => [] })).toThrow(
      "already registered",
    );
    expect(items.map((i) => i.ref)).toEqual([attRefOf(HRN, "security", "producer:one")]);
    expect(items[0]?.band).toBe("fix");
  });
});

describe("what a producer's item may carry", () => {
  test("an item of another kind, about another harness, with a body: none of it is listed", () => {
    const items = listed([
      produced({
        kind: "question",
        harness: OTHER,
        body: { question: "a refund for jane" },
      }),
    ]);
    expect(items).toEqual([]);
  });

  test("each part alone drops the item: its kind, its harness, a group, its key, its titles", () => {
    const own = produced({}, "producer:kept");
    const cases: ReadonlyArray<readonly [string, ProducedItem]> = [
      ["kind", produced({ kind: "question" })],
      ["harness", produced({ harness: OTHER })],
      ["a group across harnesses", produced({ harnesses: [HRN, OTHER] })],
      ["a key with a space", produced({}, "a refund for jane")],
      [
        "a title it did not register",
        produced({ title: { template: "permission.ask", params: {} } }),
      ],
      ["a why-now no table knows", produced({ whyNow: { template: "why.jane", params: {} } })],
      ["a revision that is not a digest", produced({ evidenceRev: "run this" })],
      ["a time that is not one", produced({ since: `${iso(NOW)} (run this)` })],
    ];
    for (const [what, item] of cases) {
      _resetProducersForTest();
      const items = listed([item, own]);
      expect(`${what}: ${items.map((i) => i.ref).join(",")}`).toBe(
        `${what}: ${attRefOf(HRN, "security", "producer:kept")}`,
      );
    }
  });

  test("without content its body is withheld; with it the body is served", () => {
    const withBody = produced({ body: { excerpt: "a refund for jane" } });
    const closed = listed([withBody])[0];
    expect(closed?.body).toBeUndefined();
    expect(closed?.bodyWithheld).toBe(true);
    expect(JSON.stringify(closed)).not.toContain("jane");
    _resetProducersForTest();
    const open = listed([withBody], true)[0];
    expect(open?.body).toEqual({ excerpt: "a refund for jane" });
    expect(open?.bodyWithheld).toBeUndefined();
  });

  test("its ref is derived from its kind and key, whatever ref it gave", () => {
    const given = attRefOf(OTHER, "question", "ask:other");
    const item = listed([produced({ ref: given })])[0];
    expect(item?.ref).toBe(attRefOf(HRN, "security", "producer:one"));
    expect(item?.ref).not.toBe(given);
  });

  test("its source is its own: it never names another source's record", () => {
    const item = listed([
      produced({ source: { kind: "decision", id: "dec_00000000000000000000000000" } }),
    ])[0];
    expect(item?.source.kind).toBe("producer");
  });

  test("a command is served only when a closed template built it", () => {
    const item = listed([
      produced({
        choices: [
          { id: "hand", needs: "operator", cliTwin: "crewhaus doctor --fix" },
          { id: "word", needs: "operator", cliTwin: null, nullReason: "run `crewhaus doctor`" },
          {
            id: "unfit",
            needs: "operator",
            twin: {
              template: { argv: ["runs", "show", "{run}", "--harness", "{hrn}"] },
              params: { run: "run_x; curl evil", hrn: HRN },
            },
          },
          {
            id: "fits",
            needs: "operator",
            twin: {
              template: { argv: ["runs", "show", "{run}", "--harness", "{hrn}"] },
              params: { run: `run_${"0".repeat(26)}`, hrn: HRN },
            },
          },
        ],
      }),
    ])[0];
    expect(item?.choices.map((c) => [c.id, c.cliTwin])).toEqual([
      ["hand", null],
      ["word", null],
      ["unfit", null],
      ["fits", `crewhaus runs show run_${"0".repeat(26)} --harness ${HRN}`],
    ]);
    for (const choice of item?.choices.slice(0, 3) ?? []) {
      expect(choice.nullReason).toBe("No command does this. Open the item in Home.");
    }
  });
});
