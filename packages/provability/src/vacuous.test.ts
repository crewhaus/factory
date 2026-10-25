/**
 * The vacuous-pass backstop (design §2, §0 A and B): an answer the
 * extractor finds no claim in passes vacuously only when nothing a reader
 * sees of it cites something or states a figure outside a question. Every
 * round-1 and round-2 bypass transcript — a claim merged into a question,
 * a heading, a table row — fails at grounded and at checked; an honest
 * clarifying question, a greeting and an answer of code alone stay vacuous.
 */
import { describe, expect, test } from "bun:test";
import { citationDefinitions } from "@crewhaus/claim-ledger";
import { config, evidenceOf, fetched, now } from "./test-helpers";
import type { ProofBundle, ProvabilityLevel } from "./types";
import { backstopClaims } from "./vacuous";
import { verifyDocument } from "./verify";

const URL_A = "https://acme.example/policy";
const D = `\n\n[1]: ${URL_A}`;
/** The page says 14 days; the answers say 30. */
const evidence = evidenceOf([
  {
    id: "toolu_f",
    name: "WebFetch",
    input: { url: URL_A },
    content: fetched(URL_A, "Refunds\nThe refund window is 14 days from the date of purchase."),
  },
]);

async function verify(text: string, level: ProvabilityLevel): Promise<ProofBundle> {
  return verifyDocument(text, { config: config(level), evidence, now });
}

/** Rounds 1 and 2 (review-result.json I1, review2-result.json I1/I2), and the shapes the extractor still missed. */
const BYPASSES = [
  `The refund window is 30 days [1]\nAnything else I can help with?${D}`,
  "The invoice total is 1,284.50\nShall I email it to the customer?",
  "The refund window is 30 days.Anything else?",
  `The refund window is 30 days [1].anything else?${D}`,
  `The refund window is 30 days [1]. Anything else?${D}`,
  `The refund window is 30 days [1]<br>Anything else?${D}`,
  `The refund window is 30 days [1] Anything else?${D}`,
  "The refund window is 30 days Anything else?",
  "The refund window is 30 days\u0085Anything else?",
  "The invoice total is 1,284.50.want me to email it?",
  `The invoice total is 1,284.50 [1]…Should I email it?${D}`,
  "The refund window is 30 days — anything else I can help with?",
  "The refund window is 30 days – anything else?",
  "The invoice total is 1,284.60; want me to send the PDF?",
  "| Refund window | 30 days | Any questions? |",
  `Acme accepts refund requests within 30 days of purchase [1], see the policy.md.Anything else?${D}`,
  `The refund window is 30 days [1] per acme.example/policy.Anything else?${D}`,
  `## The refund window is 30 days [1]${D}`,
  "The refund window is 30 days\n---",
  "## Invoice total: 1,284.50",
  // The extractor found no claim in these three when the backstop landed.
  "1,284.60; want the PDF?",
  "Refunds: 30 days\fAnything else?",
  `The refund window is 30 days [1]　Anything else?${D}`,
];

const HONEST = [
  "Do you want 2 or 3 copies?",
  "Which of the 4 plans do you mean?",
  "Should I book it for 10:30?",
  "Which of the 4 plans do you mean — Basic or Pro?",
  "Should I send 2 copies — or 3 — to Bob?",
  "Should I bump the 2 services to Node.js 20?",
  "Do you mean the 3.x branch?",
  "Want me to check https://acme.example/v2/1.html for the 3 links?",
  "Hello! How can I help you today?",
  "## Refund options for 2024\n\nWhich option do you want?",
  "Sure — what's the order number?",
  "```ts\nconst refundWindowDays = 30;\n```",
  // A list item's number is the item's, not a figure the answer states.
  "To reset your password:\n\n1. Open Settings\n2. Tap Security\n3. Choose Reset",
  "Try these:\n\n1. Restart the router\n2. Reconnect",
  "Here's how to do it:\n\n1. Click **Export**.\n2. Pick CSV.",
  "  1. Log in.",
  "Could you try:\n1. Clearing the cache\n2. Logging in again?",
  "Which do you mean?\n\n1. Basic\n2. Pro",
  "Steps:\n\n1) Open Settings\n2) Tap Security",
];

describe("the vacuous-pass backstop (design §2)", () => {
  test("every bypass transcript fails at grounded and at checked: its claim is read and checked", async () => {
    for (const text of BYPASSES) {
      for (const level of ["grounded", "checked"] as const) {
        const bundle = await verify(text, level);
        expect([text, level, bundle.verdict, bundle.vacuous]).toEqual([
          text,
          level,
          "fail",
          undefined,
        ]);
        expect(bundle.claimCount).toBeGreaterThan(0);
      }
    }
  });

  test("the backstop reads the shapes the extractor missed on its own, markers bound", () => {
    for (const [text, claim, markers] of [
      ["1,284.60; want the PDF?", "1,284.60", []],
      ["Refunds: 30 days\fAnything else?", "Refunds: 30 days", []],
      [`The refund window is 30 days [1]　Anything else?${D}`, undefined, ["1"]],
    ] as const) {
      const read = backstopClaims(text, citationDefinitions(text), [], 0);
      expect(read).toHaveLength(1);
      if (claim !== undefined) expect(read[0]?.text).toBe(claim);
      expect(read[0]?.markers).toEqual([...markers]);
    }
  });

  test("a clarifying question, a greeting and an answer of code alone stay vacuous", async () => {
    for (const text of HONEST) {
      expect([text, backstopClaims(text, citationDefinitions(text), [], 0)]).toEqual([text, []]);
      for (const level of ["grounded", "checked"] as const) {
        const bundle = await verify(text, level);
        expect([text, level, bundle.verdict, bundle.vacuous]).toEqual([
          text,
          level,
          "pass",
          "no claims to prove",
        ]);
      }
    }
    // The backstop reads no figure in a bold item number or a quoted list's
    // either (what the extractor makes of those is its own: claim-ledger).
    for (const text of [
      "**1.** Open Settings\n**2.** Tap Security",
      "> 1. Open Settings\n> 2. Tap Security",
    ]) {
      expect([text, backstopClaims(text, citationDefinitions(text), [], 0)]).toEqual([text, []]);
    }
    // A list item's own figure is still read: only its number is blanked.
    const item = "Here you go:\n\n1. 1,284.60; want the PDF?";
    expect(backstopClaims(item, citationDefinitions(item), [], 0)).toMatchObject([
      { text: "1,284.60" },
    ]);
    // A heading is a title, but for what it states after a label.
    const labelled = "## Invoice total: 1,284.50\n\nWant the PDF?";
    expect(backstopClaims(labelled, citationDefinitions(labelled), [], 0)).toMatchObject([
      { text: "Invoice total: 1,284.50" },
    ]);
    // A question wrapped over two lines is one question to the backstop.
    const wrapped = "Which of these 3 plans\ndo you mean?";
    expect(backstopClaims(wrapped, citationDefinitions(wrapped), [], 0)).toEqual([]);
  });

  test("an answer whose every claim is a declared assumption is not read twice", async () => {
    const text = "Assume the refund window is 30 days [A1].\n\n[A1]: assume: the window is 30 days";
    const bundle = await verify(text, "grounded");
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claimCount).toBe(1);
    expect(bundle.vacuous).toBe("every claim is an assumption");
  });

  test("an answer with claims is read as the extractor reads it, and no more", async () => {
    const text = `The refund window is 14 days from the date of purchase [1].${D}`;
    const bundle = await verify(text, "grounded");
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claimCount).toBe(1);
  });
});
