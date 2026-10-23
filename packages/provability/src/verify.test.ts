import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSource } from "@crewhaus/claim-ledger";
import { buildEvidenceIndex, recordFromCall } from "./evidence";
import { renderFooter } from "./render";
import { artifact, config, evidenceOf, fetched, memoryArtifacts, now } from "./test-helpers";
import type {
  ProofArtifactStore,
  ProofBundle,
  ProofClaim,
  UnmetReason,
  VerifyOptions,
} from "./types";
import {
  MAX_HEAD_REQUESTS,
  bundleHash,
  claimReasons,
  isToolAllowed,
  polarityMeter,
  statementMismatch,
  unverifiedBundle,
  verifyDocument,
} from "./verify";

const ALL_REASONS: ReadonlyArray<UnmetReason> = [
  "no_citation",
  "no_definition",
  "not_locatable",
  "host_denied",
  "private_address",
  "path_outside_workspace",
  "path_missing",
  "unresolved",
  "not_fetched",
  "not_found_in_source",
  "polarity_conflict",
  "not_independent",
  "tool_missing",
  "tool_errored",
  "tool_not_allowed",
  "value_absent",
  "replay_mismatch",
  "proof_missing",
  "proof_rejected",
  "claim_mismatch",
  "assumption_forbidden",
  "below_floor",
];
/** Every reason any test's bundle produced — the last test checks all 22 appeared. */
const produced = new Set<UnmetReason>();

const workspace = mkdtempSync(join(tmpdir(), "prov-verify-"));
const outside = mkdtempSync(join(tmpdir(), "prov-outside-"));
mkdirSync(join(workspace, "docs"), { recursive: true });
writeFileSync(
  join(workspace, "docs", "pricing.md"),
  "# Pricing\n\nThe Pro plan costs 10 dollars per month and includes unlimited seats.\n",
);
writeFileSync(join(outside, "secret.md"), "The secret plan costs 99 dollars.\n");
symlinkSync(join(outside, "secret.md"), join(workspace, "docs", "leak.md"));
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function verify(
  text: string,
  opts: Partial<VerifyOptions> & Pick<VerifyOptions, "config">,
): Promise<ProofBundle> {
  const bundle = await verifyDocument(text, {
    evidence: buildEvidenceIndex([]),
    workspaceRoot: workspace,
    now,
    ...opts,
  });
  for (const claim of bundle.claims) for (const reason of claimReasons(claim)) produced.add(reason);
  return bundle;
}

const only = (bundle: ProofBundle): ProofClaim => {
  expect(bundle.claims).toHaveLength(1);
  return bundle.claims[0] as ProofClaim;
};

const POLICY = "https://acme.example/policy";

describe("acceptance A — the fabricated citation (grounded)", () => {
  const answer = `The refund window is 30 days [1].\n\n[1]: ${POLICY}`;

  test("a URL the run never fetched is not_fetched", async () => {
    const bundle = await verify(answer, { config: config("grounded") });
    const claim = only(bundle);
    expect(claim.status).toBe("unmet");
    expect(claim.best).toBe("cited");
    expect(claim.bindings[0]).toMatchObject({
      ref: "[1]",
      kind: "source",
      rung: "cited",
      ok: false,
      reason: "not_fetched",
      origin: POLICY,
    });
    expect(bundle).toMatchObject({
      verdict: "fail",
      score: 0,
      achieved: "cited",
      met: 0,
      unmet: 1,
    });
  });

  test("fetched, but the page says 14 days: not_found_in_source, and never waivable", async () => {
    let asked = 0;
    const evidence = evidenceOf([
      {
        id: "toolu_fetch",
        name: "WebFetch",
        input: { url: POLICY },
        content: fetched(POLICY, "Our refund window is 14 days from delivery."),
      },
    ]);
    const bundle = await verify(answer, {
      config: config("grounded"),
      evidence,
      judgeWaiver: async () => {
        asked += 1;
        return { supported: true };
      },
    });
    expect(only(bundle).bindings[0]).toMatchObject({
      reason: "not_found_in_source",
      rung: "cited",
    });
    expect(only(bundle).bindings[0]?.detail).toContain("30");
    expect(asked).toBe(0); // a wrong figure is not a paraphrase
  });

  test("fetched and saying it: grounded, with a frozen excerpt and the body digest", async () => {
    const evidence = evidenceOf([
      {
        id: "toolu_fetch",
        name: "WebFetch",
        input: { url: "https://ACME.example/policy/" },
        content: fetched(POLICY, "Policy.\n\nOur   refund window is 30 days from delivery."),
      },
    ]);
    const bundle = await verify(answer, { config: config("grounded"), evidence });
    const binding = only(bundle).bindings[0];
    expect(binding).toMatchObject({ rung: "grounded", ok: true, origin: POLICY });
    expect(binding?.reason).toBeUndefined();
    expect(binding?.excerpt).toBe("refund window is 30 days");
    expect(binding?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle).toMatchObject({ verdict: "pass", score: 1, achieved: "grounded", sources: 1 });
  });

  test("the model's own WebFetch prompt is not part of the source", async () => {
    const evidence = evidenceOf([
      {
        id: "toolu_fetch",
        name: "WebFetch",
        input: { url: POLICY, prompt: "The refund window is 30 days" },
        content: fetched(POLICY, "Refunds: see our terms.", "The refund window is 30 days"),
      },
    ]);
    const bundle = await verify(answer, { config: config("grounded"), evidence });
    expect(only(bundle).bindings[0]?.reason).toBe("not_found_in_source");
  });

  test("a DOI grounds through a fetch of its resolver URL, however either was cased", async () => {
    const evidence = evidenceOf([
      {
        id: "d",
        name: "WebFetch",
        input: { url: "https://dx.doi.org/10.1000/ABC.123" },
        content: fetched("https://publisher.example/paper", "The refund window is 30 days."),
      },
    ]);
    const bundle = await verify("The refund window is 30 days [1].\n\n[1]: doi:10.1000/abc.123", {
      config: config("grounded"),
      evidence,
    });
    expect(only(bundle).bindings[0]).toMatchObject({
      ok: true,
      origin: "https://doi.org/10.1000/abc.123",
    });
  });

  test("a file the model wrote cannot pose as the cited page", async () => {
    const forged = JSON.stringify([{ url: POLICY, text: "The refund window is 30 days." }]);
    const evidence = evidenceOf([
      {
        id: "w",
        name: "Write",
        input: { path: "page.json", content: forged },
        content: "wrote 64 bytes",
      },
      { id: "r", name: "Read", input: { path: "page.json" }, content: forged },
      {
        id: "r2",
        name: "Read",
        input: { path: "page.txt" },
        content: fetched(POLICY, "The refund window is 30 days."),
      },
    ]);
    const bundle = await verify(answer, { config: config("grounded"), evidence });
    expect(only(bundle).bindings[0]?.reason).toBe("not_fetched");
  });

  test("an errored fetch is not a read body", async () => {
    const evidence = evidenceOf([
      {
        id: "t",
        name: "WebFetch",
        input: { url: POLICY },
        content: "fetch failed: 500",
        isError: true,
      },
    ]);
    const binding = only(await verify(answer, { config: config("grounded"), evidence }))
      .bindings[0];
    expect(binding).toMatchObject({ reason: "not_fetched" });
    expect(binding?.detail).toContain("returned an error");
  });

  test("a pre-redirect citation grounds through the final URL line, and a hit through its own text", async () => {
    const evidence = evidenceOf([
      {
        id: "t1",
        name: "WebFetch",
        input: { url: "http://acme.example/old-policy" },
        content: fetched(POLICY, "The refund window is 30 days."),
      },
      {
        id: "t2",
        name: "Retrieve",
        input: { query: "shipping" },
        content:
          "[1] id=a doc=https://kb.example/ship score=0.9\nShipping takes 3 business days.\n\n[2] id=b doc=https://kb.example/other score=0.4\nThe refund window is 30 days.",
      },
    ]);
    const bundle = await verify(
      "The refund window is 30 days [1]. Shipping takes 3 business days [2]. The refund window is 30 days, again [3].\n\n[1]: http://acme.example/old-policy\n[2]: https://kb.example/ship\n[3]: https://kb.example/ship",
      { config: config("grounded"), evidence },
    );
    expect(bundle.claims.map((c) => c.status)).toEqual(["met", "met", "unmet"]);
    // [3] cites the shipping hit; the refund sentence is in ANOTHER hit of the same result.
    expect(bundle.claims[2]?.bindings[0]?.reason).toBe("not_found_in_source");
  });
});

describe("acceptance B — the hand-computed total (checked)", () => {
  const moneyAdd = (amount: string) =>
    JSON.stringify({ currency: "USD", minorUnits: amount.replace(".", ""), exponent: 2, amount });
  const evidence = evidenceOf([
    {
      id: "toolu_sum",
      name: "MoneyAdd",
      input: { currency: "USD", amountsMinor: ["100000", "28450"] },
      content: moneyAdd("1284.50"),
    },
    {
      id: "toolu_bad",
      name: "MoneyAdd",
      input: { currency: "XXX" },
      content: "unknown currency",
      isError: true,
    },
    { id: "toolu_bash", name: "Bash", input: { command: "echo 1284.5" }, content: "1284.5" },
    { id: "toolu_mcp", name: "mcp__calc__add", input: { a: 1, b: 2 }, content: "3" },
    { id: "toolu_mcp_case", name: "MCP__CALC__ADD", input: { a: 1, b: 2 }, content: "3" },
    { id: "toolu_sum2", name: "Evaluate", input: { expression: "2+2" }, content: '{"value":4}' },
  ]);
  const base = {
    config: config("checked"),
    evidence,
    isPureTool: (name: string) => name !== "Bash",
  };

  test("a total with no citation at all is no_citation", async () => {
    const bundle = await verify("The invoice total is 1,284.50.", base);
    const claim = only(bundle);
    expect(claim.bindings).toEqual([]);
    expect(claimReasons(claim)).toEqual(["no_citation"]);
    expect(bundle.verdict).toBe("fail");
  });

  test("an id wrapped in backticks or followed by a full stop is still the id", async () => {
    const bundle = await verify(
      "The invoice total is 1,284.50 [4]. The total is still 1,284.50 [5].\n\n[4]: tool:`toolu_sum`\n[5]: tool:toolu_sum.",
      base,
    );
    expect(bundle.claims.map((c) => c.bindings[0]?.origin)).toEqual(["toolu_sum", "toolu_sum"]);
    expect(bundle.verdict).toBe("pass");
  });

  test("a tool id the run never made is tool_missing", async () => {
    const bundle = await verify(
      "The invoice total is 1,284.50 [4].\n\n[4]: tool:toolu_made_up",
      base,
    );
    expect(only(bundle).bindings[0]).toMatchObject({
      kind: "execution",
      reason: "tool_missing",
      rung: "none",
    });
  });

  test("a misquoted total is value_absent", async () => {
    const bundle = await verify("The invoice total is 1,294.50 [4].\n\n[4]: tool:toolu_sum", base);
    const binding = only(bundle).bindings[0];
    expect(binding?.reason).toBe("value_absent");
    expect(binding?.detail).toContain("1294.5");
  });

  test("a tampered replay is replay_mismatch", async () => {
    const bundle = await verify("The invoice total is 1,284.50 [4].\n\n[4]: tool:toolu_sum", {
      ...base,
      replay: async () => ({ content: moneyAdd("1284.51"), isError: false }),
    });
    expect(only(bundle).bindings[0]).toMatchObject({
      reason: "replay_mismatch",
      replayed: true,
      ok: false,
    });
  });

  test("a correct MoneyAdd result, replayed, is checked", async () => {
    const calls: string[] = [];
    const bundle = await verify("The invoice total is 1,284.50 [4].\n\n[4]: tool:toolu_sum", {
      ...base,
      replay: async (name, input) => {
        calls.push(name);
        expect(input).toEqual({ currency: "USD", amountsMinor: ["100000", "28450"] });
        return { content: `  ${moneyAdd("1284.50")}\n`, isError: false };
      },
    });
    const binding = only(bundle).bindings[0];
    expect(binding).toMatchObject({
      rung: "checked",
      ok: true,
      replayed: true,
      origin: "toolu_sum",
    });
    expect(binding?.excerpt).toContain("1284.50");
    expect(calls).toEqual(["MoneyAdd"]);
    expect(bundle).toMatchObject({ verdict: "pass", achieved: "checked" });
  });

  test("an errored call, a tool off the allowlist, and exact MCP names", async () => {
    const bundle = await verify(
      [
        "The invoice total is 1,284.50 [1].",
        "The shell agreed that it is 1,284.5 [2].",
        "One plus two is 3 [3].",
        "One plus two is still 3 [4].",
        "",
        "[1]: tool:toolu_bad",
        "[2]: tool:toolu_bash",
        "[3]: tool:toolu_mcp",
        "[4]: tool:toolu_mcp_case",
      ].join("\n"),
      base,
    );
    expect(bundle.claims.map((c) => c.bindings[0]?.reason ?? "ok")).toEqual([
      "tool_errored",
      "tool_not_allowed",
      "ok",
      "tool_not_allowed",
    ]);
  });

  test("a sentence that negates the result's value, or its words, is value_absent", async () => {
    const negatedTotal = await verify(
      "The invoice total is not 1,284.50 [4].\n\n[4]: tool:toolu_sum",
      base,
    );
    expect(only(negatedTotal).bindings[0]).toMatchObject({ reason: "value_absent", ok: false });
    expect(only(negatedTotal).bindings[0]?.detail).toContain("states no negation");
    const evidence2 = evidenceOf([
      {
        id: "toolu_o",
        name: "Evaluate",
        input: { expression: "overlap check" },
        content: '{"result":"The meetings do not overlap"}',
      },
    ]);
    const opposite = await verify("The meetings overlap [1].\n\n[1]: tool:toolu_o", {
      ...base,
      evidence: evidence2,
    });
    expect(only(opposite).bindings[0]).toMatchObject({ reason: "value_absent" });
    expect(only(opposite).bindings[0]?.detail).toContain("says the opposite");
    const same = await verify("The meetings do not overlap [1].\n\n[1]: tool:toolu_o", {
      ...base,
      evidence: evidence2,
    });
    expect(only(same).status).toBe("met");
  });

  test("a negation elsewhere in the sentence does not deny the figure the result states", async () => {
    // Each sentence states the total the result computed; its negation
    // governs a discount, a tax, the lines that did not ship — not the total.
    const evidence2 = evidenceOf([
      {
        id: "toolu_eur",
        name: "MoneyAdd",
        input: { amounts: ["1000.00", "284.50"], currency: "EUR" },
        content: '{"amount":"1284.50","currency":"EUR"}',
      },
    ]);
    const opts = {
      config: config("checked", { execution: { replay: false } }),
      evidence: evidence2,
    };
    for (const sentence of [
      "The invoice total without VAT is 1,284.50 EUR",
      "Not counting tax, the invoice total is 1,284.50 EUR",
      "The total for the lines that did not ship is 1,284.50 EUR",
      "No discount was applied, so the invoice total is 1,284.50 EUR",
      "The invoice total excluding VAT is 1,284.50 EUR",
      "None of the 1,284.50 EUR total is overdue",
    ]) {
      const bundle = await verify(`${sentence} [1].\n\n[1]: tool:toolu_eur`, opts);
      expect([sentence, only(bundle).status, only(bundle).best]).toEqual([
        sentence,
        "met",
        "checked",
      ]);
    }
    // The figure itself denied is the reverse of the result, however the
    // denial is worded.
    for (const sentence of [
      "The invoice total is not 1,284.50 EUR",
      "The invoice total isn't 1,284.50 EUR",
      "The invoice total was never 1,284.50 EUR",
      "The invoice total is not equal to 1,284.50 EUR",
    ]) {
      const bundle = await verify(`${sentence} [1].\n\n[1]: tool:toolu_eur`, opts);
      expect([sentence, only(bundle).bindings[0]?.reason]).toEqual([sentence, "value_absent"]);
      expect(only(bundle).bindings[0]?.detail).toContain("states no negation of 1,284.50");
    }
  });

  test("a result's negation denies the figure only where it governs it", async () => {
    const opts = (content: string) => ({
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_r", name: "Evaluate", input: { expression: "x" }, content },
      ]),
    });
    const claim = (sentence: string) => `${sentence} [1].\n\n[1]: tool:toolu_r`;
    // An unrelated negation in the result answers nothing.
    const unrelated = await verify(
      claim("The invoice total is not 1,284.50"),
      opts('{"amount":"1284.50","note":"no rounding applied"}'),
    );
    expect(only(unrelated).bindings[0]?.reason).toBe("value_absent");
    // A negation in a JSON field of its own is not beside the figure.
    const field = await verify(
      claim("The total is 1,284.50 EUR"),
      opts('{"total":"1284.50","discount":"none","currency":"EUR"}'),
    );
    expect(only(field).status).toBe("met");
    // A conjunction ends the negation's reach: the second figure is stated.
    const but = await verify(
      claim("The invoice total is 1,284.50"),
      opts("The invoice total is not 1284.05 but 1284.50."),
    );
    expect(only(but).status).toBe("met");
    // The result denying the same figure checks a claim denying it.
    const agreed = await verify(
      claim("The invoice total is not 1,284.50"),
      opts("The invoice total is not 1284.50; it is 1284.05."),
    );
    expect(only(agreed).status).toBe("met");
  });

  test("a result that denies what a figured claim states is value_absent, and the reverse", async () => {
    const opts = (content: string) => ({
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_p", name: "Evaluate", input: { expression: "isprime(91)" }, content },
      ]),
    });
    const claim = (sentence: string) => `${sentence} [1].\n\n[1]: tool:toolu_p`;
    const notPrime = "91 is not prime: 91 = 7 * 13";
    const prime = await verify(claim("The number 91 is prime"), opts(notPrime));
    expect(only(prime).bindings[0]).toMatchObject({ reason: "value_absent", ok: false });
    expect(only(prime).bindings[0]?.detail).toContain('denies "prime"');
    // The detail names the claim's word, never the result's text.
    expect(only(prime).bindings[0]?.detail).not.toContain("7 * 13");
    expect(only(await verify(claim("91 is not prime"), opts(notPrime))).status).toBe("met");
    const reverse = await verify(claim("91 is not prime"), opts("91 is prime"));
    expect(only(reverse).bindings[0]?.reason).toBe("value_absent");
    // A figure the result denies in so many words.
    const denied = await verify(
      claim("1 vendor is approved for payment"),
      opts("Not 1 vendor is approved for payment."),
    );
    expect(only(denied).bindings[0]?.reason).toBe("value_absent");
    // A partitive denies the predicate, not the count, on either side.
    const partitive = await verify(
      claim("None of the 3 invoices is overdue"),
      opts('{"overdue":0,"invoices":3}'),
    );
    expect(only(partitive).status).toBe("met");
  });

  test("a negation joined to the figure by a colon, a bracket or a dash is beside it", async () => {
    const opts = (content: string) => ({
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_p", name: "Evaluate", input: { expression: "isprime(91)" }, content },
      ]),
    });
    const claim = (sentence: string) => `${sentence} [1].\n\n[1]: tool:toolu_p`;
    for (const result of [
      "91: not prime (7 * 13)",
      "not prime: 91 = 7 * 13",
      "91 (not prime)",
      "91 - not prime",
      '{"91":"not prime"}',
    ]) {
      const bundle = await verify(claim("91 is prime"), opts(result));
      expect([result, only(bundle).bindings[0]?.reason]).toEqual([result, "value_absent"]);
      expect(only(bundle).bindings[0]?.detail).toContain('denies "prime"');
    }
    // The reverse: the result states, beside the figure, what the claim denies.
    const reverse = await verify(claim("91 is not prime"), opts("91: prime"));
    expect(only(reverse).bindings[0]?.reason).toBe("value_absent");
    // A full stop, a comma, a semicolon or a line break ends the statement:
    // a denial in the next one is about something else.
    for (const result of [
      "91 is odd. Not prime-checked yet",
      "91 is prime, not even",
      "91 is prime; 93 is not prime",
      "91 is prime\nnot prime: 93",
    ]) {
      const bundle = await verify(claim("91 is prime"), opts(result));
      expect([result, only(bundle).status]).toEqual([result, "met"]);
    }
  });

  test("a determiner or preposition negation in the result does not deny the noun after it", async () => {
    const opts = (content: string) => ({
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_e", name: "Evaluate", input: { expression: "x" }, content },
      ]),
    });
    const claim = (sentence: string) => `${sentence} [1].\n\n[1]: tool:toolu_e`;
    for (const [sentence, result] of [
      ["All 120 tests passed", "No tests failed out of 120"],
      ["The subtotal excluding VAT is 1,284.50 EUR", "The subtotal without VAT is 1284.50 EUR"],
      ["The subtotal without VAT is 1,284.50 EUR", "The subtotal excluding VAT is 1284.50 EUR"],
      ["The subtotal without VAT is 1,284.50 EUR", "The subtotal without VAT is 1284.50 EUR"],
      ["14 refunds were paid", "None of the refunds are pending; 14 refunds were paid"],
    ] as const) {
      const bundle = await verify(claim(sentence), opts(result));
      expect([sentence, only(bundle).status, only(bundle).best]).toEqual([
        sentence,
        "met",
        "checked",
      ]);
    }
    // A predicate negation still denies: "91 is not prime" (3h) stays refused…
    const predicate = await verify(claim("The number 91 is prime"), opts("91 is not prime"));
    expect(only(predicate).bindings[0]?.reason).toBe("value_absent");
    // …and a figure keeps every negation: "no 2 meetings overlap" denies 2.
    const figure = await verify(
      claim("2 meetings overlap this week"),
      opts("No 2 meetings overlap this week"),
    );
    expect(only(figure).bindings[0]?.reason).toBe("value_absent");
  });

  test("a figure common to a large result is read once however many claims state it", async () => {
    // Every line of a large result holds the figure 1 (a quantity): reading
    // its statements once per claim made 200 claims cost 200 reads of it.
    const lines = Array.from(
      { length: 6_000 },
      (_, i) => `order ${10_000 + i} shipped 1 unit to the north region`,
    );
    const content = lines.join("\n");
    const opts = {
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_rows", name: "mcp__calc__add", input: { q: "orders" }, content },
      ]),
    };
    const claims = Array.from(
      { length: 200 },
      (_, i) => `Order ${10_000 + i} shipped 1 unit to the north region [1].`,
    ).join(" ");
    const before = polarityMeter.tokens;
    const bundle = await verify(`${claims}\n\n[1]: tool:toolu_rows`, opts);
    expect(bundle.met).toBe(200);
    // Each statement of the result read at most once: never once a claim.
    expect(polarityMeter.tokens - before).toBeLessThanOrEqual(indexSource(content).tokens.length);
  }, 20_000);

  test("a claim with no numeral: a leading negation or a missing number word in the result is value_absent", async () => {
    const opts = (content: string) => ({
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_w", name: "Evaluate", input: { expression: "x" }, content },
      ]),
    });
    const claim = (sentence: string) => `${sentence} [1].\n\n[1]: tool:toolu_w`;
    const leading = await verify(
      claim("One vendor is approved for payment"),
      opts("Not one vendor is approved for payment."),
    );
    expect(only(leading).bindings[0]?.reason).toBe("value_absent");
    expect(only(leading).bindings[0]?.detail).toContain("says the opposite");
    const meetings = await verify(
      claim("Two of the six meetings overlap"),
      opts("No two of the six meetings overlap."),
    );
    expect(only(meetings).bindings[0]?.reason).toBe("value_absent");
    const other = await verify(
      claim("Two vendors are approved for payment this quarter by finance"),
      opts("Three vendors are approved for payment this quarter by finance."),
    );
    expect(only(other).bindings[0]?.reason).toBe("value_absent");
    expect(only(other).bindings[0]?.detail).toContain("does not state two");
    const dropped = await verify(
      claim("The vendor is not approved for payment"),
      opts("The vendor is approved for payment."),
    );
    expect(only(dropped).bindings[0]?.reason).toBe("value_absent");
    expect(
      only(
        await verify(
          claim("One vendor is approved for payment"),
          opts("One vendor is approved for payment."),
        ),
      ).status,
    ).toBe("met");
  });

  test("one large result cited by many claims is read once, not once a claim", async () => {
    const big = JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ amount: `${i}.50` })));
    let reads = 0;
    const record = {
      toolUseId: "toolu_big",
      toolName: "MoneyAdd",
      input: {},
      isError: false,
      origins: [],
      get content(): string {
        reads += 1;
        return big;
      },
    };
    const claims = Array.from({ length: 60 }, (_, i) => `The total is ${i}.50 [1].`).join(" ");
    const bundle = await verify(`${claims}\n\n[1]: tool:toolu_big`, {
      config: config("cited"),
      evidence: buildEvidenceIndex([record]),
    });
    expect(bundle.met).toBe(60);
    // Its digest, its numbers and its excerpt: once each.
    expect(reads).toBeLessThanOrEqual(3);
  });

  test("a claim with no figure must still be about the result (coverage fallback)", async () => {
    const evidence2 = evidenceOf([
      {
        id: "toolu_v",
        name: "Evaluate",
        input: { expression: "currency rounding check" },
        content: '{"status":"rounding exact, no drift"}',
      },
    ]);
    const ok = await verify(
      "The currency rounding check found no drift [1].\n\n[1]: tool:toolu_v",
      {
        ...base,
        evidence: evidence2,
      },
    );
    expect(only(ok).status).toBe("met");
    const unrelated = await verify(
      "The weather in Paris was lovely and warm [1].\n\n[1]: tool:toolu_v",
      {
        ...base,
        evidence: evidence2,
      },
    );
    expect(only(unrelated).bindings[0]?.reason).toBe("value_absent");
  });

  test("replay runs once per call, within max_replays, only at the checked floor, only for pure tools", async () => {
    let calls = 0;
    const replay = async () => {
      calls += 1;
      return { content: moneyAdd("1284.50"), isError: false };
    };
    const text =
      "The invoice total is 1,284.50 [1]. Again, the total is 1,284.50 [1]. And 4 is the check [2].\n\n[1]: tool:toolu_sum\n[2]: tool:toolu_sum2";
    const budgeted = await verify(text, {
      ...base,
      config: config("checked", { execution: { maxReplays: 1 } }),
      replay,
    });
    expect(calls).toBe(1);
    expect(budgeted.claims.map((c) => c.bindings[0]?.replayed)).toEqual([true, true, false]);
    expect(budgeted.verdict).toBe("pass"); // not replayed is still checked

    calls = 0;
    await verify(text, { ...base, config: config("grounded"), replay });
    await verify(text, { ...base, config: config("proven"), replay });
    await verify(text, {
      ...base,
      config: config("checked", { execution: { replay: false } }),
      replay,
    });
    await verify(text, { ...base, replay, isPureTool: () => false });
    await verify(text, {
      ...base,
      replay,
      isPureTool: () => {
        throw new Error("catalog gone");
      },
    });
    expect(calls).toBe(0);
  });

  test("a replay that cannot run or throws leaves the binding checked, not replayed", async () => {
    const throwsSync = (() => {
      throw new Error("sync boom");
    }) as unknown as VerifyOptions["replay"];
    for (const replay of [
      async () => undefined,
      async () => Promise.reject(new Error("boom")),
      async () => ({ content: 42 as never, isError: false }),
      throwsSync,
    ]) {
      const bundle = await verify("The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_sum", {
        ...base,
        replay,
      });
      expect(only(bundle).bindings[0]).toMatchObject({ ok: true, replayed: false });
    }
    const errored = await verify("The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_sum", {
      ...base,
      replay: async () => ({ content: "boom", isError: true }),
    });
    expect(only(errored).bindings[0]?.reason).toBe("replay_mismatch");
  });

  test("execution evidence satisfies a lower floor; a source does not satisfy checked (below_floor)", async () => {
    const lower = await verify("The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_sum", {
      ...base,
      config: config("cited"),
    });
    expect(only(lower)).toMatchObject({ status: "met", best: "checked" });
    const evidence3 = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: POLICY },
        content: "The refund window is 30 days.",
      },
    ]);
    const source = await verify(`The refund window is 30 days [1].\n\n[1]: ${POLICY}`, {
      ...base,
      evidence: evidence3,
    });
    expect(only(source).bindings[0]).toMatchObject({
      rung: "grounded",
      ok: false,
      reason: "below_floor",
    });
    expect(source.achieved).toBe("grounded");
  });

  test("isToolAllowed maps builtin names case-insensitively, other names exactly", () => {
    expect(isToolAllowed("MoneyAdd", ["moneyAdd"])).toBe(true);
    expect(isToolAllowed("moneyadd", ["moneyAdd"])).toBe(true);
    expect(isToolAllowed("Bash", ["moneyAdd"])).toBe(false);
    expect(isToolAllowed("mcp__calc__add", ["mcp__calc__add"])).toBe(true);
    expect(isToolAllowed("mcp__Calc__add", ["mcp__calc__add"])).toBe(false);
  });
});

describe("acceptance C — the overlap claim (proven)", () => {
  const claim = "No two of the six meetings overlap [1].";
  const accepted = artifact({ id: "prf_0123456789abcdef", axioms: ["propext"] });
  const rejected = artifact({
    id: "prf_aaaaaaaaaaaaaaaa",
    ok: false,
    reason: "the negated goal is satisfiable",
    counterexample: "meetings 2 and 5 overlap at 10:30",
  });
  const unrelated = artifact({
    id: "prf_bbbbbbbbbbbbbbbb",
    claim: "The sum of two even numbers is even.",
  });

  test("an accepted artifact whose claim the sentence states is proven, with its checker listed", async () => {
    const store = memoryArtifacts([accepted]);
    const bundle = await verify(`${claim}\n\n[1]: proof:prf_0123456789abcdef`, {
      config: config("proven"),
      artifacts: store,
    });
    expect(only(bundle).bindings[0]).toMatchObject({
      kind: "formal",
      rung: "proven",
      ok: true,
      checker: "builtin",
      statement: accepted.statement,
      sha256: accepted.outputDigest,
      origin: accepted.id,
    });
    expect(bundle.checkers).toEqual([
      { id: "builtin", artifact: accepted.id, axioms: ["propext"] },
    ]);
    expect(bundle).toMatchObject({ verdict: "pass", achieved: "proven" });
  });

  test("a rejected artifact is proof_rejected, its counterexample in the detail", async () => {
    const bundle = await verify(`${claim}\n\n[1]: proof:prf_aaaaaaaaaaaaaaaa`, {
      config: config("proven"),
      artifacts: memoryArtifacts([rejected]),
    });
    const binding = only(bundle).bindings[0];
    expect(binding?.reason).toBe("proof_rejected");
    expect(binding?.detail).toContain("meetings 2 and 5 overlap at 10:30");
    expect(bundle.checkers).toBeUndefined();
  });

  test("an accepted proof of something else is claim_mismatch", async () => {
    const bundle = await verify(`${claim}\n\n[1]: proof:prf_bbbbbbbbbbbbbbbb`, {
      config: config("proven"),
      artifacts: memoryArtifacts([unrelated]),
    });
    expect(only(bundle).bindings[0]?.reason).toBe("claim_mismatch");
  });

  test("a proof of the opposite, or of other figures, does not prove the sentence", async () => {
    // The meetings DO overlap: an honest proof of that must not serve the
    // false "no two overlap" (acceptance C) — coverage alone drops "no".
    const overlap = artifact({
      id: "prf_cccccccccccccccc",
      claim: "Two of the six meetings overlap.",
    });
    const inverted = await verify(`${claim}\n\n[1]: proof:prf_cccccccccccccccc`, {
      config: config("proven"),
      artifacts: memoryArtifacts([overlap]),
    });
    expect(only(inverted).bindings[0]).toMatchObject({ reason: "claim_mismatch", ok: false });
    expect(only(inverted).bindings[0]?.detail).toContain("states the opposite");
    expect(inverted).toMatchObject({ verdict: "fail", achieved: "none" });
    // And the other way round: a proof of "no overlap" does not prove "two overlap".
    const flipped = await verify(
      "Two of the six meetings overlap [1].\n\n[1]: proof:prf_0123456789abcdef",
      { config: config("proven"), artifacts: memoryArtifacts([accepted]) },
    );
    expect(only(flipped).bindings[0]?.reason).toBe("claim_mismatch");
    // Polarity is read word by word: the same denial in other words is
    // proven ("do not" and "don't"; "no two" moved within the sentence)…
    const proofOf = (id: string, proved: string) => ({
      config: config("proven"),
      artifacts: memoryArtifacts([artifact({ id, claim: proved })]),
    });
    for (const [sentence, proved] of [
      ["Meetings 2 and 5 don't overlap", "Meetings 2 and 5 do not overlap."],
      ["Of the six meetings, no two overlap", "No two of the six meetings overlap."],
    ] as const) {
      const bundle = await verify(
        `${sentence} [1].\n\n[1]: proof:prf_dddddddddddddddd`,
        proofOf("prf_dddddddddddddddd", proved),
      );
      expect([sentence, only(bundle).bindings[0]?.ok]).toEqual([sentence, true]);
    }
    // …but a negation moved to another word is another statement: "no two
    // overlap" is about every pair, "two didn't overlap" about two meetings.
    const moved = await verify(
      "Two of the six meetings didn't overlap at all [1].\n\n[1]: proof:prf_dddddddddddddddd",
      proofOf("prf_dddddddddddddddd", "No two of the six meetings overlap."),
    );
    expect(only(moved).bindings[0]?.reason).toBe("claim_mismatch");
    expect(only(moved).bindings[0]?.detail).toContain(`denies "two"`);
    // A proof about meetings 1 and 2 is not a proof about all six.
    const narrower = await verify(`${claim}\n\n[1]: proof:prf_eeeeeeeeeeeeeeee`, {
      config: config("proven"),
      artifacts: memoryArtifacts([
        artifact({ id: "prf_eeeeeeeeeeeeeeee", claim: "Meetings 1 and 2 do not overlap." }),
      ]),
    });
    expect(only(narrower).bindings[0]).toMatchObject({ reason: "claim_mismatch" });
    expect(only(narrower).bindings[0]?.detail).toContain("figures differ");
  });

  test("a negation the proof's claim does not speak to leaves the proved statement proven", async () => {
    // The sentence may say more than the proof (design §6.4): its "no" and
    // "without" deny a discount and VAT, not the proved total.
    const total = artifact({
      id: "prf_ffffffffffffffff",
      claim: "The invoice total is 1,284.50 EUR.",
    });
    const opts = { config: config("proven"), artifacts: memoryArtifacts([total]) };
    for (const sentence of [
      "No discount was applied, so the invoice total is 1,284.50 EUR",
      "The invoice total without VAT is 1,284.50 EUR",
      "Not counting tax, the invoice total is 1,284.50 EUR",
    ]) {
      const bundle = await verify(`${sentence} [1].\n\n[1]: proof:prf_ffffffffffffffff`, opts);
      expect([sentence, only(bundle).status, only(bundle).best]).toEqual([
        sentence,
        "met",
        "proven",
      ]);
    }
    // The proved word itself denied is still the opposite, however far the
    // denial sits from the rest of the sentence.
    const denied = await verify(
      "No discount was applied, and the invoice total is not 1,284.50 EUR [1].\n\n[1]: proof:prf_ffffffffffffffff",
      opts,
    );
    expect(only(denied).bindings[0]?.reason).toBe("claim_mismatch");
    expect(only(denied).bindings[0]?.detail).toContain("states the opposite");
    // Two figures with their negations swapped: each word compared on its own.
    const swapped = statementMismatch(
      "The total is not 5 and the count is 3.",
      "The total is 5 and the count is not 3",
      0.8,
    );
    expect(swapped).toContain(`the proof's claim denies "5"`);
    // A partitive denies the whole statement though it denies no one word.
    expect(
      statementMismatch("The 3 invoices are overdue.", "None of the 3 invoices is overdue", 0.8),
    ).toContain("this sentence is negated");
    // (At 0.8 this direction already fails on coverage: "none" is a content token.)
    expect(
      statementMismatch("None of the 3 invoices is overdue.", "The 3 invoices are overdue", 0.6),
    ).toContain("the proof's claim is negated");
    // …unless it governs something the proof never mentions.
    expect(
      statementMismatch(
        "The invoice total is 1,284.50 EUR.",
        "None of the discounts applied, so the invoice total is 1,284.50 EUR",
        0.8,
      ),
    ).toBeUndefined();
  });

  test("missing, malformed, unwired, unreadable and mislabelled artifacts are proof_missing", async () => {
    const store = memoryArtifacts([{ ...accepted, id: "prf_cccccccccccccccc" }]);
    const cases = [
      ["prf_dddddddddddddddd", store],
      ["prf_../../etc/passwd", store],
      ["prf_0123456789abcdef", undefined],
      [
        "prf_0123456789abcdef",
        {
          get: async () => Promise.reject(new Error("disk on fire")),
          put: async () => {},
          list: async () => [],
        },
      ],
      [
        "prf_0123456789abcdef",
        {
          get: (() => {
            throw new Error("sync fire");
          }) as unknown as ProofArtifactStore["get"],
          put: async () => {},
          list: async () => [],
        },
      ],
    ] as const;
    const before = store.reads;
    for (const [id, artifacts] of cases) {
      const bundle = await verify(`${claim}\n\n[1]: proof:${id}`, {
        config: config("proven"),
        ...(artifacts !== undefined ? { artifacts } : {}),
      });
      expect(only(bundle).bindings[0]?.reason).toBe("proof_missing");
    }
    // The malformed id never reached the store.
    expect(store.reads - before).toBe(1);
    // An artifact stored under one id that names another is not that proof.
    const mislabelled = memoryArtifacts();
    mislabelled.get = async () => ({ ...accepted, id: "prf_eeeeeeeeeeeeeeee" });
    const bundle = await verify(`${claim}\n\n[1]: proof:prf_0123456789abcdef`, {
      config: config("proven"),
      artifacts: mislabelled,
    });
    expect(only(bundle).bindings[0]?.detail).toContain("names another id");
    // A store that hands back something that is not an artifact is not trusted field by field.
    const junk = memoryArtifacts();
    junk.get = async () => ({ id: "prf_0123456789abcdef", ok: true }) as never;
    const malformed = await verify(`${claim}\n\n[1]: proof:prf_0123456789abcdef`, {
      config: config("proven"),
      artifacts: junk,
    });
    expect(only(malformed).bindings[0]).toMatchObject({ reason: "proof_missing" });
    expect(only(malformed).bindings[0]?.detail).toContain("malformed");
  });
});

describe("cited", () => {
  test("a marker with no definition is no_definition; a footnote keeps its caret", async () => {
    const bundle = await verify("Revenue rose 12% [1]. Costs fell 3% [^a].", {
      config: config("cited"),
    });
    expect(bundle.claims.map((c) => c.bindings[0]?.ref)).toEqual(["[1]", "[^a]"]);
    expect(bundle.claims.map((c) => c.bindings[0]?.reason)).toEqual([
      "no_definition",
      "no_definition",
    ]);
  });

  test("a dangling marker unmeets a claim another binding meets (every marker must be defined)", async () => {
    const bundle = await verify(
      "The refund window is 14 days [1] [2].\n\n[1]: https://acme.example/policy",
      { config: config("cited") },
    );
    expect(only(bundle)).toMatchObject({ status: "unmet", best: "cited" });
    expect(only(bundle).bindings.map((b) => [b.ref, b.ok, b.reason ?? null])).toEqual([
      ["[1]", true, null],
      ["[2]", false, "no_definition"],
    ]);
    expect(bundle).toMatchObject({ verdict: "fail", achieved: "none" });
    expect(renderFooter(bundle)).toContain("unmet: [2]");
  });

  test("free text is not_locatable unless bibliographic, and even then cannot be grounded", async () => {
    const text =
      "Revenue rose 12% in 2024 [1].\n\n[1]: Smith, J. (2024). Annual report. Acme Press.";
    const plain = await verify(text, { config: config("cited") });
    expect(plain.claims[0]?.bindings[0]).toMatchObject({ rung: "none", reason: "not_locatable" });
    // Not accepted as a reference, the free text is prose the reader sees: it
    // is read as a claim citing its own (unlocatable) definition.
    expect(plain.claims.slice(1).map((c) => [c.text, c.definition, c.status])).toEqual([
      ["Smith, J. (2024).", "[1]", "unmet"],
    ]);
    const bib = await verify(text, {
      config: config("cited", { sources: { bibliographic: true } }),
    });
    expect(only(bib)).toMatchObject({ status: "met", best: "cited" });
    const groundedBib = await verify(text, {
      config: config("grounded", { sources: { bibliographic: true } }),
    });
    expect(only(groundedBib).bindings[0]).toMatchObject({ rung: "cited", reason: "not_locatable" });
  });

  test("allow and deny host globs (deny wins), and private addresses even when allowed", async () => {
    const text = (url: string) => `Revenue rose 12% [1].\n\n[1]: ${url}`;
    const cfg = config("cited", {
      sources: { allow: ["*.gov", "169.254.169.254"], deny: ["bad.gov"] },
    });
    const reason = async (url: string) =>
      only(await verify(text(url), { config: cfg })).bindings[0]?.reason ?? "ok";
    expect(await reason("https://data.census.gov/x")).toBe("ok");
    expect(await reason("https://bad.gov/x")).toBe("host_denied");
    expect(await reason("https://acme.example/x")).toBe("host_denied");
    expect(await reason("http://169.254.169.254/latest/meta-data")).toBe("private_address");
    const open = config("cited");
    for (const url of [
      "http://localhost:8080/x",
      "http://[::ffff:a9fe:a9fe]/",
      "http://10.0.0.7/",
    ]) {
      expect(only(await verify(text(url), { config: open })).bindings[0]?.reason).toBe(
        "private_address",
      );
    }
    // A DOI is cited through doi.org, so an allowlist must name it.
    expect(await reason("doi:10.1000/xyz123")).toBe("host_denied");
  });

  test("workspace paths: inside and present, outside, a link leading out, missing", async () => {
    const reason = async (p: string, level: "cited" | "grounded" = "cited") =>
      only(
        await verify(`The Pro plan costs 10 dollars [1].\n\n[1]: ${p}`, { config: config(level) }),
      ).bindings[0];
    expect((await reason("./docs/pricing.md#plans"))?.ok).toBe(true);
    expect(await reason("../../etc/passwd")).toMatchObject({ reason: "path_outside_workspace" });
    expect(await reason("docs/leak.md")).toMatchObject({
      reason: "path_outside_workspace",
      origin: "docs/leak.md",
    });
    expect(await reason("docs/nope.md")).toMatchObject({ reason: "path_missing" });
    // Present but never read in this run: not grounded.
    expect(await reason("docs/pricing.md", "grounded")).toMatchObject({ reason: "not_fetched" });
  });

  test("a path source grounds through a Read of the same file, however it was spelled", async () => {
    const evidence = evidenceOf(
      [
        {
          id: "r",
          name: "Read",
          input: { path: join(workspace, "docs", "pricing.md") },
          content:
            "# Pricing\n\nThe Pro plan costs 10 dollars per month and includes unlimited seats.\n",
        },
      ],
      workspace,
    );
    const bundle = await verify(
      "The Pro plan costs 10 dollars per month [1].\n\n[1]: ./docs/../docs/pricing.md",
      {
        config: config("grounded"),
        evidence,
      },
    );
    expect(only(bundle).bindings[0]).toMatchObject({
      ok: true,
      rung: "grounded",
      origin: "docs/pricing.md",
    });
  });

  test("resolve: head — one HEAD per URL, 2xx/3xx only, fail-closed when unwired, skipped above grounded", async () => {
    const heads: string[] = [];
    const statuses: Record<string, number | undefined> = {
      "https://ok.example/": 200,
      "https://moved.example/": 301,
      "https://gone.example/": 404,
      "https://silent.example/": undefined,
    };
    const resolveHead = async (url: string) => {
      heads.push(url);
      if (url === "https://throws.example/") throw new Error("network down");
      return statuses[url];
    };
    const text = [
      "Alpha is real [1]. Beta is real [2]. Gamma is real [3]. Delta is real [4]. Epsilon is real [5]. Alpha again [1].",
      "",
      "[1]: https://ok.example",
      "[2]: https://moved.example",
      "[3]: https://gone.example",
      "[4]: https://silent.example",
      "[5]: https://throws.example",
    ].join("\n");
    const cfg = config("cited", { sources: { resolve: "head" } });
    const bundle = await verify(text, { config: cfg, resolveHead });
    expect(bundle.claims.map((c) => c.bindings[0]?.reason ?? "ok")).toEqual([
      "ok",
      "ok",
      "unresolved",
      "unresolved",
      "unresolved",
      "ok",
    ]);
    expect(heads).toHaveLength(5);
    const odd = await verify("Alpha is real [1].\n\n[1]: https://ok.example", {
      config: cfg,
      resolveHead: async () => "200" as never,
    });
    expect(only(odd).bindings[0]?.reason).toBe("unresolved");
    const syncThrow = await verify("Alpha is real [1].\n\n[1]: https://ok.example", {
      config: cfg,
      resolveHead: (() => {
        throw new Error("sync");
      }) as unknown as VerifyOptions["resolveHead"],
    });
    expect(only(syncThrow).bindings[0]?.reason).toBe("unresolved");
    const unwired = await verify(text, { config: cfg });
    expect(unwired.claims[0]?.bindings[0]?.detail).toContain("no reachability check is wired");
    heads.length = 0;
    await verify(text, {
      config: config("checked", { sources: { resolve: "head" } }),
      resolveHead,
    });
    expect(heads).toEqual([]);
    // A denied host is never requested.
    await verify(text, {
      config: config("cited", { sources: { resolve: "head", deny: ["*.example"] } }),
      resolveHead,
    });
    expect(heads).toEqual([]);
  });

  test("resolve: head sends at most MAX_HEAD_REQUESTS per verification; past it, unresolved", async () => {
    let requests = 0;
    const n = MAX_HEAD_REQUESTS + 10;
    const text = [
      Array.from({ length: n }, (_, i) => `Fact number ${i} is documented here [${i + 1}].`).join(
        " ",
      ),
      "",
      ...Array.from({ length: n }, (_, i) => `[${i + 1}]: https://site${i}.example/t`),
    ].join("\n");
    const bundle = await verify(text, {
      config: config("cited", { sources: { resolve: "head" } }),
      resolveHead: async () => {
        requests += 1;
        return 200;
      },
    });
    expect(requests).toBe(MAX_HEAD_REQUESTS);
    expect(bundle.met).toBe(MAX_HEAD_REQUESTS);
    const past = bundle.claims[MAX_HEAD_REQUESTS]?.bindings[0];
    expect(past).toMatchObject({ reason: "unresolved" });
    expect(past?.detail).toContain(`more than ${MAX_HEAD_REQUESTS} distinct URLs`);
  });
});

describe("grounded", () => {
  test("the words with a negation the claim lacks are polarity_conflict", async () => {
    const evidence = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: POLICY },
        content: "Refunds are not accepted after 30 days.",
      },
    ]);
    const bundle = await verify(`Refunds are accepted after 30 days [1].\n\n[1]: ${POLICY}`, {
      config: config("grounded"),
      evidence,
    });
    expect(only(bundle).bindings[0]?.reason).toBe("polarity_conflict");
  });

  test("a negation that opens the source's statement is polarity_conflict; one in another clause is not", async () => {
    const at = async (body: string, sentence: string) => {
      const evidence = evidenceOf([
        { id: "f", name: "WebFetch", input: { url: POLICY }, content: fetched(POLICY, body) },
      ]);
      const bundle = await verify(`${sentence} [1].\n\n[1]: ${POLICY}`, {
        config: config("grounded"),
        evidence,
      });
      return only(bundle).bindings[0]?.reason ?? "ok";
    };
    expect(await at("No two of the six meetings overlap.", "Two of the six meetings overlap")).toBe(
      "polarity_conflict",
    );
    expect(
      await at(
        "Not a single vendor is approved for payment.",
        "A single vendor is approved for payment",
      ),
    ).toBe("polarity_conflict");
    // The statement's own negation, the claim's too, agrees.
    expect(
      await at("No two of the six meetings overlap.", "No two of the six meetings overlap"),
    ).toBe("ok");
    // A negation in another clause, three words off, or in a compound is not the statement's.
    expect(
      await at("With no exceptions, the refund window is 14 days.", "The refund window is 14 days"),
    ).toBe("ok");
    expect(
      await at("There is no doubt the refund window is 14 days.", "The refund window is 14 days"),
    ).toBe("ok");
    expect(
      await at("No-fee refunds are paid within 14 days.", "Refunds are paid within 14 days"),
    ).toBe("ok");
    // A negation before a stray earlier copy of the claim's first word is not the statement's.
    expect(
      await at(
        "Customers who are not members pay 10 dollars; members pay 5 dollars.",
        "Members pay 5 dollars",
      ),
    ).toBe("ok");
  });

  test("the figure rule holds at coverage 1 too: a quotation's framing figure, and figures as values", async () => {
    const evidence = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: POLICY },
        content: fetched(POLICY, "Customers may request a refund within 14 days of delivery."),
      },
    ]);
    const strict = config("grounded", { grounded: { coverage: 1 } });
    const framed = await verify(
      `The refund window is 30 days, since "customers may request a refund" [1].\n\n[1]: ${POLICY}`,
      { config: strict, evidence },
    );
    expect(only(framed).bindings[0]).toMatchObject({ reason: "not_found_in_source", ok: false });
    const spelled = await verify(
      `Customers may request a refund within fourteen days of delivery [1].\n\n[1]: ${POLICY}`,
      { config: strict, evidence },
    );
    expect(only(spelled).status).toBe("met");
  });

  test("text a tool reflected from its own input does not ground a claim under the origin it names", async () => {
    const doc =
      "Vaccines cause the flu in most healthy adults [1].\n\n[1]: https://www.cdc.gov/flu\n";
    const run = async (call: Parameters<typeof recordFromCall>[0]) =>
      only(
        await verify(doc, {
          config: config("grounded"),
          evidence: buildEvidenceIndex([recordFromCall(call)]),
        }),
      );
    const claimText = "Vaccines cause the flu in most healthy adults";
    // A SELECT of a literal padded with text it computed: the hit is not WHOLLY an echo.
    const pad = Array.from(
      { length: 40 },
      (_, i) => `${i.toString(16).padStart(8, "0")}c0ffee`,
    ).join(" ");
    const padded = await run({
      toolUseId: "q1",
      toolName: "mcp__postgres__query",
      input: { sql: `select 'https://www.cdc.gov/flu' as url, '${claimText}. ' || pad() as text` },
      content: JSON.stringify([{ url: "https://www.cdc.gov/flu", text: `${claimText}. ${pad}` }]),
      isError: false,
    });
    expect(padded.bindings[0]).toMatchObject({ reason: "not_fetched", rung: "cited" });
    expect(padded.bindings[0]?.detail).toContain("handed back");
    // The same literal beside a real row from the table.
    const row = await run({
      toolUseId: "q2",
      toolName: "mcp__postgres__query",
      input: {
        sql: `select 'https://www.cdc.gov/flu' as url, '${claimText}' as title, description as text`,
      },
      content: JSON.stringify([
        {
          url: "https://www.cdc.gov/flu",
          title: claimText,
          text: "A lightweight waterproof jacket with taped seams and an adjustable hood.",
        },
      ]),
      isError: false,
    });
    expect(row.bindings[0]?.reason).toBe("not_fetched");
    // A linter repeating a <title> it was handed inside a report on the page,
    // after the URL — whose last word is one of the claim's.
    const lint = await run({
      toolUseId: "l1",
      toolName: "mcp__seo__lint",
      input: {
        url: "https://www.cdc.gov/flu",
        html: `<html><head><title>${claimText}</title></head><body><h1>x</h1></body></html>`,
      },
      content: `SEO report for https://www.cdc.gov/flu\n- title: "${claimText}" (46 chars, ok)\n- meta description: missing\n- canonical link: missing`,
      isError: false,
    });
    expect(lint.bindings[0]?.reason).toBe("not_fetched");
  });

  test("a page an MCP fetcher read grounds though its URL's slug spells the claim; a printed address does not", async () => {
    const url = "https://blog.example.com/2024/05/rust-is-faster-than-go";
    const page =
      "Benchmarks 2024\n\nOur measurements show Rust is faster than Go on every workload.";
    let asked = 0;
    const run = async (toolName: string, input: Record<string, unknown>, content: string) =>
      only(
        await verify(`Rust is faster than Go [1].\n\n[1]: ${url}`, {
          config: config("grounded"),
          evidence: buildEvidenceIndex([
            recordFromCall({ toolUseId: "m1", toolName, input, content, isError: false }),
          ]),
          judgeWaiver: async () => {
            asked += 1;
            return { supported: true, costUsdMicros: 1 };
          },
        }),
      );
    // A reader returns the page, not its address: the slug is not a reflection.
    for (const [toolName, input] of [
      ["mcp__fetch__fetch", { url, max_length: 5000 }],
      ["mcp__firecrawl__scrape", { url, formats: ["markdown"] }],
    ] as const) {
      const claim = await run(toolName, input, page);
      expect([toolName, claim.status, claim.best]).toEqual([toolName, "met", "grounded"]);
    }
    // A page headed with its address still grounds in its own text, and the
    // excerpt is the page's, not the address.
    const headed = await run("mcp__fetch__fetch", { url }, `Source: ${url}\n\n${page}`);
    expect(headed.status).toBe("met");
    expect(headed.bindings[0]?.excerpt).toBe("Rust is faster than Go");
    // A result whose only copy of the claim is the address it prints — a 404
    // page repeating the path, a log line — read nothing, and nothing of it
    // reaches the judge.
    for (const content of [
      "<h1>404 Not Found</h1><p>The requested URL /2024/05/rust-is-faster-than-go was not found on this server.</p>",
      "GET /2024/05/rust-is-faster-than-go -> 404 Not Found",
      `Fetched ${url.replace("blog.example.com", "BLOG.EXAMPLE.COM")} (binary content omitted)`,
    ]) {
      const claim = await run("mcp__fetch__fetch", { url }, content);
      expect([content, claim.bindings[0]?.reason]).toEqual([content, "not_fetched"]);
      expect(claim.bindings[0]?.detail).toContain("handed back");
    }
    const paraphrase = await run(
      "mcp__fetch__fetch",
      { url: "https://blog.example.com/2024/05/rust-beats-go" },
      "GET /2024/05/rust-beats-go -> 404 Not Found",
    );
    expect(paraphrase.status).toBe("unmet");
    expect(asked).toBe(0);
    // The printed slug next to a title the call was handed: blanking the
    // address out leaves the reflected title, which is the input's.
    const lint = await run(
      "mcp__seo__lint",
      { url, html: "<title>Rust is faster than Go</title>" },
      `SEO report for ${url}\n- title: "Rust is faster than Go" (22 chars, ok)`,
    );
    expect(lint.bindings[0]?.reason).toBe("not_fetched");
  });

  test("a search hit whose query only shares words with it still grounds; so does a Retrieve hit", async () => {
    const searched = await verify(
      "A flu vaccine cannot cause flu illness [1].\n\n[1]: https://www.cdc.gov/flu/prevent/misconceptions.htm",
      {
        config: config("grounded"),
        evidence: buildEvidenceIndex([
          recordFromCall({
            toolUseId: "s1",
            toolName: "mcp__search__web",
            input: { query: "cdc flu vaccine cannot cause flu" },
            content: JSON.stringify({
              results: [
                {
                  url: "https://www.cdc.gov/flu/prevent/misconceptions.htm",
                  title: "Misconceptions about Seasonal Flu",
                  snippet: "A flu vaccine cannot cause flu illness.",
                },
              ],
            }),
            isError: false,
          }),
        ]),
      },
    );
    expect(only(searched).status).toBe("met");
    // Retrieve returns corpus text, never its query: a hit that repeats the
    // query word for word is still the corpus's.
    const retrieved = await verify(
      "Shipping takes 3 business days [1].\n\n[1]: https://kb.example/ship",
      {
        config: config("grounded"),
        evidence: evidenceOf([
          {
            id: "r1",
            name: "Retrieve",
            input: { query: "shipping takes 3 business days" },
            content:
              "[1] id=a doc=https://kb.example/ship score=0.9\nShipping takes 3 business days.",
          },
        ]),
      },
    );
    expect(only(retrieved).status).toBe("met");
  });

  test("a reflected paraphrase is never sent to the waiver judge", async () => {
    let asked = 0;
    const bundle = await verify(
      "Vaccines usually cause the flu in most healthy adults [1].\n\n[1]: https://www.cdc.gov/flu",
      {
        config: config("grounded"),
        evidence: buildEvidenceIndex([
          recordFromCall({
            toolUseId: "l2",
            toolName: "mcp__seo__lint",
            input: {
              url: "https://www.cdc.gov/flu",
              html: "<title>Vaccines cause the flu in adults</title>",
            },
            content:
              'SEO report\n- title: "Vaccines cause the flu in adults" (32 chars, ok)\n- h1 count: 1',
            isError: false,
          }),
        ]),
        judgeWaiver: async () => {
          asked += 1;
          return { supported: true, costUsdMicros: 1 };
        },
      },
    );
    expect(asked).toBe(0);
    expect(only(bundle).status).toBe("unmet");
  });

  test("independent: 2 needs two registrable domains; one publisher twice is not_independent", async () => {
    const evidence = evidenceOf([
      {
        id: "a",
        name: "WebFetch",
        input: { url: "https://docs.acme.example/a" },
        content: "The refund window is 30 days.",
      },
      {
        id: "b",
        name: "WebFetch",
        input: { url: "https://www.acme.example/b" },
        content: "The refund window is 30 days.",
      },
      {
        id: "c",
        name: "WebFetch",
        input: { url: "https://consumer.gov/c" },
        content: "The refund window is 30 days.",
      },
    ]);
    const cfg = config("grounded", { grounded: { independent: 2 } });
    const sameSite = await verify(
      "The refund window is 30 days [1] [2].\n\n[1]: https://docs.acme.example/a\n[2]: https://www.acme.example/b",
      { config: cfg, evidence },
    );
    const claim = only(sameSite);
    expect(claim.status).toBe("unmet");
    expect(claim.bindings.map((b) => [b.rung, b.ok, b.reason])).toEqual([
      ["grounded", false, "not_independent"],
      ["grounded", false, "not_independent"],
    ]);
    expect(claim.bindings[0]?.detail).toContain("acme.example");
    expect(sameSite.achieved).toBe("cited");

    const corroborated = await verify(
      "The refund window is 30 days [1] [2].\n\n[1]: https://docs.acme.example/a\n[2]: https://consumer.gov/c",
      { config: cfg, evidence },
    );
    expect(only(corroborated).status).toBe("met");
    expect(corroborated.achieved).toBe("grounded");
    expect(corroborated.sources).toBe(2);
    // At the cited floor independence does not apply.
    const cited = await verify(
      "The refund window is 30 days [1].\n\n[1]: https://docs.acme.example/a",
      {
        config: config("cited", { grounded: { independent: 2 } }),
        evidence,
      },
    );
    expect(only(cited).status).toBe("met");
  });

  test("an execution binding meets a grounded floor regardless of independence", async () => {
    const evidence = evidenceOf([
      { id: "sum", name: "MoneyAdd", input: {}, content: '{"amount":"1284.50"}' },
    ]);
    const bundle = await verify("The total is 1,284.50 [1].\n\n[1]: tool:sum", {
      config: config("grounded", { grounded: { independent: 3 } }),
      evidence,
    });
    expect(only(bundle).status).toBe("met");
  });

  describe("the paraphrase-waiver judge", () => {
    const evidence = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: POLICY },
        content: "Customers may return items within the refund window.",
      },
    ]);
    const text = `Customers can return goods within the refund window of the store [1].\n\n[1]: ${POLICY}`;

    test("asked only for a partial-coverage miss at the grounded floor; a yes marks the binding", async () => {
      const asked: Array<{ claim: string; excerpt: string; source: string }> = [];
      const bundle = await verify(text, {
        config: config("grounded"),
        evidence,
        judgeWaiver: async (input) => {
          asked.push(input);
          return { supported: true, model: "judge-model", costUsdMicros: 120 };
        },
      });
      expect(asked).toEqual([
        {
          claim: "Customers can return goods within the refund window of the store.",
          excerpt: "Customers may return items within the refund window",
          source: POLICY,
        },
      ]);
      expect(only(bundle).bindings[0]).toMatchObject({
        ok: true,
        rung: "grounded",
        judgeWaived: true,
      });
      expect(bundle).toMatchObject({
        judgeWaived: 1,
        judgeModel: "judge-model",
        spentUsdMicros: 120,
      });
      expect(renderFooter(bundle)).toContain("1/1 claim (1 judge-waived)");
    });

    test("a judge's spend counts only when it is a real, non-negative number", async () => {
      for (const costUsdMicros of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
        const bundle = await verify(text, {
          config: config("grounded"),
          evidence,
          judgeWaiver: async () => ({ supported: true, model: "judge-x", costUsdMicros }),
        });
        expect(bundle.judgeWaived).toBe(1);
        expect(bundle.spentUsdMicros).toBe(0);
      }
    });

    test("a no, a throw, and other floors leave the miss standing", async () => {
      let asked = 0;
      const no = await verify(text, {
        config: config("grounded"),
        evidence,
        judgeWaiver: async () => {
          asked += 1;
          return { supported: false, costUsdMicros: 50 };
        },
      });
      expect(only(no).bindings[0]?.reason).toBe("not_found_in_source");
      expect(no.spentUsdMicros).toBe(50);
      const threw = await verify(text, {
        config: config("grounded"),
        evidence,
        judgeWaiver: async () => {
          asked += 1;
          throw new Error("judge down");
        },
      });
      expect(only(threw).bindings[0]?.reason).toBe("not_found_in_source");
      expect(asked).toBe(2);
      for (const level of ["cited", "checked"] as const) {
        await verify(text, {
          config: config(level),
          evidence,
          judgeWaiver: async () => {
            asked += 1;
            return { supported: true };
          },
        });
      }
      expect(asked).toBe(2);
    });
  });
});

describe("assumptions", () => {
  const text =
    "Revenue rose 12% [1]. The fiscal year starts in April [A1]. Costs are stable this year [A2].\n\n[1]: https://acme.example/r\n[A1]: assume: the fiscal year starts in April\n[A2]: assume: costs are stable";

  test("allowed: counted, excluded from the score, never ok", async () => {
    const bundle = await verify(text, { config: config("cited") });
    expect(bundle.claims.map((c) => c.status)).toEqual(["met", "assumption", "assumption"]);
    expect(bundle.claims[1]?.bindings[0]).toEqual({
      ref: "[A1]",
      kind: "assumption",
      rung: "none",
      ok: false,
      origin: "the fiscal year starts in April",
    });
    expect(bundle).toMatchObject({ assumptions: 2, met: 1, unmet: 0, score: 1, verdict: "pass" });
  });

  test("forbid: every assumption is assumption_forbidden, refused and counted", async () => {
    const bundle = await verify(text, { config: config("cited", { assumptions: "forbid" }) });
    expect(bundle.claims.map((c) => c.status)).toEqual(["met", "unmet", "unmet"]);
    expect(bundle.claims[1]?.bindings[0]?.reason).toBe("assumption_forbidden");
    expect(bundle).toMatchObject({ assumptions: 0, assumptionsRefused: 2, verdict: "fail" });
  });

  test("max_assumptions: the ones past the cap, in document order, are unmet", async () => {
    const bundle = await verify(text, { config: config("cited", { maxAssumptions: 1 }) });
    expect(bundle.claims.map((c) => c.status)).toEqual(["met", "assumption", "unmet"]);
    expect(bundle.claims[2]?.bindings[0]).toMatchObject({ reason: "assumption_forbidden" });
    expect(bundle.claims[2]?.bindings[0]?.detail).toContain("max_assumptions (1)");
    expect(bundle).toMatchObject({
      assumptions: 1,
      assumptionsRefused: 1,
      score: 0.5,
      verdict: "fail",
    });
  });

  test("a refused assumption fails the verdict whatever the threshold, and is still counted", async () => {
    const four =
      "Revenue rose 12% [1]. The fiscal year starts in April [A1]. Costs are stable this year [A2]. Margins are steady this quarter [A3].\n\n[1]: https://acme.example/r\n[A1]: assume: April\n[A2]: assume: stable\n[A3]: assume: steady";
    // 1 of 4 met clears a 0.25 threshold — but three assumptions against a
    // cap of 0 is the dodge the cap exists to close (design §2).
    const capped = await verify(four, {
      config: config("cited", { maxAssumptions: 0, threshold: 0.25 }),
    });
    expect(capped).toMatchObject({
      verdict: "fail",
      score: 0.25,
      assumptions: 0,
      assumptionsRefused: 3,
      achieved: "none",
    });
    expect(renderFooter(capped)).toBe(
      "── provability · cited ✗ · 1/4 claims · unmet: [A1] [A2] [A3] · 0 sources · 3 assumptions (3 refused)",
    );
    const forbidden = await verify(four, {
      config: config("cited", { assumptions: "forbid", threshold: 0.25 }),
    });
    expect(forbidden).toMatchObject({ verdict: "fail", assumptionsRefused: 3, achieved: "none" });
    // Within the cap the same threshold passes, with nothing refused.
    const within = await verify(four, {
      config: config("cited", { maxAssumptions: 3, threshold: 0.25 }),
    });
    expect(within).toMatchObject({ verdict: "pass", assumptions: 3, score: 1 });
    expect(within.assumptionsRefused).toBeUndefined();
    expect(renderFooter(within)).toContain("· 3 assumptions");
  });

  test("a claim with an assumption and failing evidence is unmet, not an assumption", async () => {
    const bundle = await verify(
      "Revenue rose 12% [1] [A1].\n\n[1]: https://acme.example/r\n[A1]: assume: revenue is reported net",
      { config: config("grounded") },
    );
    expect(only(bundle).status).toBe("unmet");
    expect(claimReasons(only(bundle))).toEqual(["not_fetched"]);
  });
});

describe("score, verdict, achieved", () => {
  test("zero claims is a vacuous pass at the floor", async () => {
    for (const text of ["", "Sure.", "Which plan do you mean?", "```\nrevenue = 12\n```"]) {
      const bundle = await verify(text, { config: config("grounded") });
      expect(bundle).toMatchObject({
        verdict: "pass",
        score: 1,
        achieved: "grounded",
        claimCount: 0,
        vacuous: "no claims to prove",
      });
    }
  });

  test("every claim an assumption is vacuous too, and says so", async () => {
    const bundle = await verify("The fiscal year starts in April [A1].\n\n[A1]: assume: April", {
      config: config("proven"),
    });
    expect(bundle).toMatchObject({
      verdict: "pass",
      vacuous: "every claim is an assumption",
      achieved: "proven",
    });
  });

  test("threshold below 1 passes a partial answer; achieved is the highest floor it would pass", async () => {
    const evidence = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: POLICY },
        content: "The refund window is 30 days. Shipping is free over 50 dollars.",
      },
      { id: "sum", name: "MoneyAdd", input: {}, content: '{"amount":"1284.50"}' },
    ]);
    const text = [
      "The refund window is 30 days [1].",
      "Shipping is free over 50 dollars [1].",
      "The invoice total is 1,284.50 [2].",
      "Our support team answers within an hour.",
      "",
      `[1]: ${POLICY}`,
      "[2]: tool:sum",
    ].join("\n");
    const strict = await verify(text, { config: config("grounded"), evidence });
    expect(strict).toMatchObject({
      verdict: "fail",
      met: 3,
      unmet: 1,
      score: 0.75,
      achieved: "none",
    });
    const lenient = await verify(text, {
      config: config("grounded", { threshold: 0.75 }),
      evidence,
    });
    expect(lenient).toMatchObject({ verdict: "pass", achieved: "grounded" });
    const half = await verify(text, { config: config("grounded", { threshold: 0.25 }), evidence });
    expect(half.achieved).toBe("checked");
    // 0.7 × 10 is 7.000000000000001 in floating point: 7 of 10 must pass 0.7.
    const ten = Array.from({ length: 10 }, (_, i) =>
      i < 7 ? `Claim number ${i} holds [${i + 1}].` : `Claim number ${i} holds.`,
    ).join(" ");
    const defs = Array.from({ length: 7 }, (_, i) => `[${i + 1}]: https://e${i}.example/`).join(
      "\n",
    );
    const seventy = await verify(`${ten}\n\n${defs}`, {
      config: config("cited", { threshold: 0.7 }),
    });
    expect(seventy).toMatchObject({ met: 7, verdict: "pass" });
  });

  test("scope: turn uses only that turn's evidence", async () => {
    const evidence = evidenceOf([
      {
        id: "old",
        name: "WebFetch",
        input: { url: POLICY },
        content: "The refund window is 30 days.",
        turnNumber: 1,
      },
    ]);
    const text = `The refund window is 30 days [1].\n\n[1]: ${POLICY}`;
    expect((await verify(text, { config: config("grounded"), evidence })).verdict).toBe("pass");
    const turn2 = await verify(text, {
      config: config("grounded"),
      evidence,
      turnNumbers: new Set([2]),
    });
    expect(only(turn2).bindings[0]?.reason).toBe("not_fetched");
    const turn1 = await verify(text, {
      config: config("grounded"),
      evidence,
      turnNumbers: new Set([1]),
    });
    expect(turn1.verdict).toBe("pass");
  });

  test("the text a definition line shows beyond what it names is read as claims citing it", async () => {
    const bundle = await verify(
      [
        "Revenue rose 12% [1].",
        "",
        "[1]: https://acme.example/r",
        "[2]: https://acme.example/pay Payments are processed within 5 days.",
        '[3]: https://acme.example/t "Terms of service"',
        "[4]: https://acme.example/u — Terms",
        "[5]: Payments are always instant for every customer.",
        "[6]: https://acme.example/report Annual employment report 2024",
        "[7]: see the FAQ page for every customer",
        "[^8]: <docs/my report.md> (Quarterly report)",
        "[9]: tool:toolu_1 The moon is made of green cheese entirely.",
        "[10]: proof:prf_0123456789abcdef — every meeting room is booked",
        "[A1]: assume: costs are stable for the whole year",
      ].join("\n"),
      { config: config("cited") },
    );
    expect(
      bundle.claims.map((c) => [c.text, c.bindings.map((b) => b.ref), c.status, c.definition]),
    ).toEqual([
      ["Revenue rose 12%.", ["[1]"], "met", undefined],
      ["Payments are processed within 5 days.", ["[2]"], "met", "[2]"],
      ["Payments are always instant for every customer.", ["[5]"], "unmet", "[5]"],
      ["Annual employment report 2024", ["[6]"], "met", "[6]"],
      ["see the FAQ page for every customer", ["[7]"], "unmet", "[7]"],
      ["The moon is made of green cheese entirely.", ["[9]"], "unmet", "[9]"],
      ["every meeting room is booked", ["[10]"], "unmet", "[10]"],
    ]);
    expect(bundle.claims[1]?.line).toBeUndefined();
    expect(bundle.claims[2]?.bindings[0]?.reason).toBe("not_locatable");
    expect(bundle.claims[5]?.bindings[0]?.reason).toBe("tool_missing");
    expect(bundle.claims[6]?.bindings[0]?.reason).toBe("proof_missing");
  });

  test("a CITED definition's trailing sentence is checked like an uncited one's, punctuated or not", async () => {
    const evidence = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: POLICY },
        content: fetched(POLICY, "The refund window is 14 days for every order."),
      },
    ]);
    // A cited definition carrying an assertion the source does not make.
    const hidden = await verify(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY} Refunds are always paid in cash within two days.`,
      { config: config("grounded"), evidence },
    );
    expect(hidden.verdict).toBe("fail");
    expect(hidden.claims.map((c) => [c.status, c.definition ?? null])).toEqual([
      ["met", null],
      ["unmet", "[1]"],
    ]);
    expect(hidden.claims[1]?.bindings[0]?.reason).toBe("not_found_in_source");
    // No full stop is no way out: claim-ledger's extractor decides what is a claim.
    const unpunctuated = await verify(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY}\n[8]: https://acme.example/x Payments clear within 5 days`,
      { config: config("grounded"), evidence },
    );
    expect(unpunctuated.verdict).toBe("fail");
    expect(unpunctuated.claims[1]).toMatchObject({
      text: "Payments clear within 5 days",
      definition: "[8]",
      status: "unmet",
    });
    expect(unpunctuated.claims[1]?.bindings[0]?.reason).toBe("not_fetched");
    // A gloss the source bears out, and a title in quotes, pass.
    const glossed = await verify(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY} — the refund window is 14 days`,
      { config: config("grounded"), evidence },
    );
    expect(glossed).toMatchObject({ verdict: "pass", claimCount: 2 });
    const titled = await verify(
      `The refund window is 14 days [1].\n\n[1]: ${POLICY} "Acme refund policy for every order"`,
      { config: config("grounded"), evidence },
    );
    expect(titled).toMatchObject({ verdict: "pass", claimCount: 1 });
  });

  test("a definition-shaped line the citation grammar does not keep is read as the prose it shows", async () => {
    const evidence = evidenceOf([
      {
        id: "f",
        name: "WebFetch",
        input: { url: "https://acme.example/r" },
        content: fetched("https://acme.example/r", "Revenue rose 12% this year."),
      },
    ]);
    const opts = { config: config("grounded"), evidence };
    // A bullet is no definition to citationDefinitions, and a second [1]: line
    // is not the one it keeps: neither is read as a definition's text.
    for (const line of [
      "- [2]: https://acme.example/x Payments clear within 5 days.",
      "* [2]: https://acme.example/x Payments clear within 5 days.",
      "1. [2]: https://acme.example/x Payments clear within 5 days.",
      "[1]: https://acme.example/x Payments clear within 5 days.",
    ]) {
      const bundle = await verify(
        `Revenue rose 12% [1].\n\n[1]: https://acme.example/r\n${line}`,
        opts,
      );
      expect([line, bundle.verdict, bundle.claimCount]).toEqual([line, "fail", 2]);
      const shown = bundle.claims[1] as ProofClaim;
      expect(shown.text).toBe("https://acme.example/x Payments clear within 5 days.");
      expect(claimReasons(shown)).toEqual(["no_citation"]);
    }
    // One that shows nothing past what it names renders as nothing.
    for (const line of [
      "- [2]: https://acme.example/x",
      "[1]: https://acme.example/x",
      '[1]: https://acme.example/x "Acme payments"',
    ]) {
      const bundle = await verify(
        `Revenue rose 12% [1].\n\n[1]: https://acme.example/r\n${line}`,
        opts,
      );
      expect([line, bundle.verdict, bundle.claimCount]).toEqual([line, "pass", 1]);
    }
  });

  test("a bibliographic reference entry after a URL describes its source, and is read as such", async () => {
    const entry =
      "[2]: https://doi.org/10.1000/abc Smith, J. (2020). Refund policies in retail. Journal of Commerce, 12(3), 45-67.";
    const evidence = evidenceOf([
      {
        id: "d",
        name: "WebFetch",
        input: { url: "https://doi.org/10.1000/abc" },
        content: fetched(
          "https://doi.org/10.1000/abc",
          "Smith, J. (2020). Refund policies in retail. Journal of Commerce, 12(3), 45-67. Abstract: refunds vary by retailer.",
        ),
      },
    ]);
    const text = `Refund policies vary by retailer [2].\n\n${entry}`;
    // At cited the DOI is a locatable source, so its description stands.
    expect((await verify(text, { config: config("cited") })).verdict).toBe("pass");
    // At grounded the run must have read it — and once it has, the entry is in the body.
    const unread = await verify(text, { config: config("grounded") });
    expect(unread.verdict).toBe("fail");
    expect(unread.claims.filter((c) => c.definition === "[2]").length).toBeGreaterThan(0);
    const read = await verify(text, { config: config("grounded"), evidence });
    expect(read.verdict).toBe("pass");
    // sources.bibliographic spares a free-text source itself, never a URL's gloss.
    const bib = await verify(
      "Revenue rose 12% in 2024 [1].\n\n[1]: Smith, J. (2024). Annual report. Acme Press.",
      { config: config("cited", { sources: { bibliographic: true } }) },
    );
    expect(bib.claimCount).toBe(1);
  });
});

describe("the bundle", () => {
  const text = `The refund window is 30 days [1].\n\n[1]: ${POLICY}`;

  test("bundleHash is stable for the same input and moves with any field", async () => {
    const a = await verify(text, { config: config("grounded") });
    const b = await verify(text, { config: config("grounded") });
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(a.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundleHash(a)).toBe(a.bundleHash);
    const retried = await verify(text, { config: config("grounded"), retryIndex: 1 });
    expect(retried.bundleHash).not.toBe(a.bundleHash);
    expect(bundleHash({ ...a, score: 0.5 })).not.toBe(a.bundleHash);
    // Key order does not matter; values do.
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as ProofBundle;
    expect(bundleHash(reordered)).toBe(a.bundleHash);
  });

  test("claims are clipped to 400 characters and carry their line", async () => {
    const long = `${"The quarterly revenue figures ".repeat(30)}rose 12% [1].\n\n[1]: ${POLICY}`;
    const claim = only(await verify(long, { config: config("cited") }));
    expect(claim.text.length).toBe(400);
    expect(claim.line).toBe(1);
  });

  test("unverifiedBundle records the failure for the fail-open path", () => {
    const bundle = unverifiedBundle(config("checked"), new Error("sandbox gone"), 2, now);
    expect(bundle).toMatchObject({
      verdict: "unverified",
      level: "checked",
      retryIndex: 2,
      error: "sandbox gone",
      claims: [],
      achieved: "none",
      createdAt: "2026-10-22T12:00:00.000Z",
    });
    expect(bundleHash(bundle)).toBe(bundle.bundleHash);
    expect(unverifiedBundle(config("cited"), "x", 0, new Date(0)).createdAt).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  test("a malformed config is the one thing that throws", async () => {
    await expect(
      verifyDocument("x", {
        config: { ...config("cited"), level: "off" as never },
        evidence: buildEvidenceIndex([]),
      }),
    ).rejects.toThrow(/config.level/);
  });
});

test("every UnmetReason is produced by some realistic input above", () => {
  expect(ALL_REASONS.filter((reason) => !produced.has(reason))).toEqual([]);
});
