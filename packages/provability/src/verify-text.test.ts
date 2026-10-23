/**
 * The text layer's gaps, pinned through the verifier (the review's I1, I2,
 * I3, I14): a claim the extractor read wrong or not at all passed every rung
 * with "no claims to prove", and a figure or a negation the comparison could
 * not read passed as grounded or checked. Each case is the wrong answer the
 * model wrote, and each must fail.
 */
import { describe, expect, test } from "bun:test";
import { config, evidenceOf, fetched, now } from "./test-helpers";
import { verifyDocument } from "./verify";

const at = (...points: number[]): string => String.fromCodePoint(...points);
const POLICY = "https://acme.example/policy";
/** The page the run fetched says 14 days. */
const page = evidenceOf([
  {
    id: "toolu_fetch",
    name: "WebFetch",
    input: { url: POLICY },
    content: fetched(POLICY, "Refunds are accepted within 14 days of purchase for unused items."),
  },
]);
const moneyAdd = (amount: string) =>
  JSON.stringify({ currency: "USD", minorUnits: amount.replace(".", ""), exponent: 2, amount });
/** MoneyAdd computed 1284.50. */
const total = evidenceOf([
  {
    id: "toolu_sum",
    name: "MoneyAdd",
    input: { currency: "USD", amountsMinor: ["100000", "28450"] },
    content: moneyAdd("1284.50"),
  },
]);

const verify = (
  text: string,
  level: "grounded" | "checked",
  evidence = level === "grounded" ? page : total,
) =>
  verifyDocument(text, {
    config: config(level),
    evidence,
    workspaceRoot: process.cwd(),
    now,
    // MoneyAdd is replayed and reproduces its result; nothing else is replayed.
    isPureTool: (name: string) => name === "MoneyAdd",
    replay: async () => ({ content: moneyAdd("1284.50"), isError: false }),
  });

describe("a claim joined to a question is read and fails (the review's I1)", () => {
  const A = "The refund window is 30 days [1]";
  const B = "The invoice total is 1,284.60 [1]";
  const joins = [
    (claim: string) => `${claim}.anything else?`,
    (claim: string) => `${claim}.${at(0xa0)}Anything else?`,
    (claim: string) => `${claim}.<br>Anything else?`,
    (claim: string) => `${claim}${at(0x2028)}Anything else?`,
    (claim: string) => `${claim}${at(0x2026)}Should I email it?`,
    (claim: string) => `${claim} ${at(0x2014)} anything else I can help with?`,
    (claim: string) => `${claim}; want me to send the PDF?`,
    (claim: string) => `${claim}, right?`,
    (claim: string) => `${claim} per acme.example/policy.Anything else?`,
  ];
  for (const join of joins) {
    test(`grounded: ${JSON.stringify(join(A))}`, async () => {
      const bundle = await verify(`${join(A)}\n\n[1]: ${POLICY}`, "grounded");
      expect(bundle.verdict).toBe("fail");
      expect(bundle.claims).toHaveLength(1);
      expect(bundle.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
    });
    test(`checked: ${JSON.stringify(join(B))}`, async () => {
      const bundle = await verify(`${join(B)}\n\n[1]: tool:toolu_sum`, "checked");
      expect(bundle.verdict).toBe("fail");
      expect(bundle.claims).toHaveLength(1);
      expect(bundle.claims[0]?.bindings[0]?.reason).toBe("value_absent");
    });
  }
  test("the honest total joined to a question is checked", async () => {
    const bundle = await verify(
      "The invoice total is 1,284.50 [1]; want me to send the PDF?\n\n[1]: tool:toolu_sum",
      "checked",
    );
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claims).toHaveLength(1);
  });
  test("an honest cited claim naming a domain, then a question, is grounded", async () => {
    const honest = evidenceOf([
      {
        id: "toolu_fetch",
        name: "WebFetch",
        input: { url: POLICY },
        content: fetched(
          POLICY,
          "The refund window is 30 days from purchase. See acme.example/refunds for the form.",
        ),
      },
    ]);
    for (const doc of [
      "The refund window is 30 days per acme.example/refunds [1] — anything else?",
      "The refund window is 30 days [1] per acme.example — anything else?",
    ]) {
      const bundle = await verify(`${doc}\n\n[1]: ${POLICY}`, "grounded", honest);
      expect(`${doc} → ${bundle.verdict} ${bundle.claims.length}`).toBe(`${doc} → pass 1`);
    }
  });
  test("a clarifying question still has nothing to prove", async () => {
    for (const question of [
      "Would you like a refund of $45, or store credit?",
      "Got it \u2014 2 seats, correct?",
      "Just to confirm: 2 adults and 1 child, departing June 3?",
      "Should I set the timeout to 30 seconds in Startup.Configure for production?",
    ]) {
      const bundle = await verify(question, "checked");
      expect(`${question} → ${bundle.verdict} ${bundle.claims.length}`).toBe(
        `${question} → pass 0`,
      );
    }
  });
});

describe("a claim written as a heading is read (the review's I2)", () => {
  test("grounded: an ATX or setext heading citing the wrong figure fails", async () => {
    for (const doc of [
      "## The refund window is 30 days [1]",
      "The refund window is 30 days [1]\n---",
    ]) {
      const bundle = await verify(`${doc}\n\n[1]: ${POLICY}`, "grounded");
      expect(bundle.verdict).toBe("fail");
      expect(bundle.claims).toHaveLength(1);
    }
  });
  test("grounded and checked: a heading with a follow-up question is still read", async () => {
    const grounded = await verify(
      `## The refund window is 30 days [1]\n\nAnything else?\n\n[1]: ${POLICY}`,
      "grounded",
    );
    expect(grounded.verdict).toBe("fail");
    expect(grounded.claims).toHaveLength(1);
    const checked = await verify(
      "## The invoice total is 1,284.60\n\nShould I email it?",
      "checked",
    );
    expect(checked.verdict).toBe("fail");
    expect(checked.claims).toHaveLength(1);
  });
  test("checked: a heading total beside a checked subtotal is read, uncited", async () => {
    const bundle = await verify(
      "## Total with tax: 1,386.26\n\nThe subtotal is 1,284.50 [1].\n\n[1]: tool:toolu_sum",
      "checked",
    );
    expect(bundle.verdict).toBe("fail");
    expect(bundle.claims.map((c) => c.status)).toEqual(["unmet", "met"]);
  });
});

describe("a figure or a negation the reader cannot tell apart is read (the review's I3)", () => {
  test("grounded: 30 in any script is not the page's 14", async () => {
    const window = evidenceOf([
      {
        id: "toolu_fetch",
        name: "WebFetch",
        input: { url: POLICY },
        content: fetched(POLICY, "The refund window is 14 days from the date of purchase."),
      },
    ]);
    for (const thirty of [at(0xff13, 0xff10), at(0x0663, 0x0660), at(0x1d7d1, 0x1d7ce)]) {
      const bundle = await verify(
        `The refund window is ${thirty} days from the date of purchase [1].\n\n[1]: ${POLICY}`,
        "grounded",
        window,
      );
      expect(bundle.claims[0]?.bindings[0]?.reason).toBe("not_found_in_source");
    }
  });
  test("checked: a misquoted total in fullwidth digits is value_absent", async () => {
    const bundle = await verify(
      `The amount is ${at(0xff11)},${at(0xff12, 0xff18, 0xff14)}.${at(0xff16, 0xff10)} USD [1].\n\n[1]: tool:toolu_sum`,
      "checked",
    );
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("value_absent");
  });
  test("grounded: a negation with a zero-width space in it is a polarity conflict", async () => {
    const bundle = await verify(
      `Refunds are n${at(0x200b)}ot accepted within 14 days of purchase for unused items [1].\n\n[1]: ${POLICY}`,
      "grounded",
    );
    expect(bundle.claims[0]?.bindings[0]?.reason).toBe("polarity_conflict");
  });
});

describe("a range's second end is stated (the review's I14)", () => {
  const meetings = evidenceOf([
    {
      id: "toolu_fetch",
      name: "WebFetch",
      input: { url: POLICY },
      content: fetched(
        POLICY,
        "Meeting 2: 10:00-11:30, room B. The store is open on weekdays 9:00-17:00.",
      ),
    },
    {
      id: "toolu_eval",
      name: "Evaluate",
      input: { expression: "slot" },
      content: "Meeting 2: 10:00-11:30",
    },
  ]);
  test("grounded and checked: the end of a range is found", async () => {
    for (const doc of [
      `Meeting 2 ends at 11:30 [1].\n\n[1]: ${POLICY}`,
      `The store closes at 17:00 on weekdays [1].\n\n[1]: ${POLICY}`,
    ]) {
      expect((await verify(doc, "grounded", meetings)).verdict).toBe("pass");
    }
    const checked = await verify(
      "Meeting 2 ends at 11:30 [1].\n\n[1]: tool:toolu_eval",
      "checked",
      meetings,
    );
    expect(checked.verdict).toBe("pass");
  });
});
