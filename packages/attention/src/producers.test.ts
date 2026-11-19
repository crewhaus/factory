/** Producers: a kind outside the vocabulary and a second registration are refused; a
 *  registered producer's item is listed with the others. */
import { afterEach, describe, expect, test } from "bun:test";
import { attentionRef } from "@crewhaus/control-contract";
import { NOW, harnessDir, iso, tempRoot, testFacts } from "./__test__/fleet";
import { assembleInbox, foldHarness } from "./fold";
import { attIdOf } from "./ids";
import { _resetProducersForTest, producers, registerProducer } from "./producers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  _resetProducersForTest();
  for (const c of cleanups.splice(0)) c();
});

describe("registerProducer", () => {
  test("refuses a kind outside the vocabulary", () => {
    expect(() => registerProducer("source-conflict-x", { templates: [], fold: () => [] })).toThrow(
      "is not an attention kind",
    );
    expect(producers()).toEqual([]);
  });

  test("a registered producer's item appears, and a second registration is refused", () => {
    const planted = "setup";
    {
      const t = tempRoot();
      cleanups.push(t.cleanup);
      const dir = harnessDir(t.root, "produced");
      const ref = attentionRef(attIdOf("hrn_0123456789abcdef", planted, "producer:one"));
      registerProducer(planted, {
        templates: ["advisor.other"],
        fold: (_dir, _facts, ctx) => [
          {
            ref,
            kind: planted as never,
            band: "consider",
            harness: ctx.harness,
            source: { kind: "producer", id: "one" },
            title: { template: "advisor.other", params: { screen: "overview" } },
            whyNow: { template: "why.advisor-suggestion", params: {} },
            affected: { runs: [], count: 0 },
            evidence: [],
            choices: [],
            requiredClass: "operator",
            state: "open",
            evidenceRev: "0000000000000000",
            since: iso(NOW),
            freshness: ctx.freshness,
          },
        ],
      });
      expect(() => registerProducer(planted, { templates: [], fold: () => [] })).toThrow(
        "already registered",
      );
      const inbox = assembleInbox(
        [foldHarness(dir, testFacts(), NOW, { harness: "hrn_0123456789abcdef" })],
        NOW,
      );
      expect(inbox.items.map((i) => i.ref)).toEqual([ref]);
    }
  });
});
