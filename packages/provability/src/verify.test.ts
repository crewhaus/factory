import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSource } from "@crewhaus/claim-ledger";
import { openEventLog } from "@crewhaus/event-log";
import {
  buildEvidenceIndex,
  evidenceFromMessages,
  evidenceFromSessionLog,
  recordFromCall,
} from "./evidence";
import { renderBundleJson, renderFooter, renderMarkdownSection } from "./render";
import {
  artifact,
  checkedBy,
  config,
  evidenceOf,
  fetched,
  memoryArtifacts,
  now,
  proofCheckCall,
} from "./test-helpers";
import type {
  ProofArtifactStore,
  ProofBundle,
  ProofClaim,
  UnmetReason,
  VerifyOptions,
} from "./types";
import {
  HEAD_CONCURRENCY,
  MAX_HEAD_REQUESTS,
  _setGroundingBudgetForTest,
  bareId,
  bundleHash,
  claimReasons,
  clipAround,
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
      evidence: checkedBy([accepted]),
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
      evidence: checkedBy([rejected]),
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
      evidence: checkedBy([unrelated]),
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
      evidence: checkedBy([overlap]),
    });
    expect(only(inverted).bindings[0]).toMatchObject({ reason: "claim_mismatch", ok: false });
    expect(only(inverted).bindings[0]?.detail).toContain("states the opposite");
    expect(inverted).toMatchObject({ verdict: "fail", achieved: "none" });
    // And the other way round: a proof of "no overlap" does not prove "two overlap".
    const flipped = await verify(
      "Two of the six meetings overlap [1].\n\n[1]: proof:prf_0123456789abcdef",
      {
        config: config("proven"),
        artifacts: memoryArtifacts([accepted]),
        evidence: checkedBy([accepted]),
      },
    );
    expect(only(flipped).bindings[0]?.reason).toBe("claim_mismatch");
    // Polarity is read word by word: the same denial in other words is
    // proven ("do not" and "don't"; "no two" moved within the sentence)…
    const proofOf = (id: string, proved: string) => {
      const proof = artifact({ id, claim: proved });
      return {
        config: config("proven"),
        artifacts: memoryArtifacts([proof]),
        evidence: checkedBy([proof]),
      };
    };
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
    const pair = artifact({
      id: "prf_eeeeeeeeeeeeeeee",
      claim: "Meetings 1 and 2 do not overlap.",
    });
    const narrower = await verify(`${claim}\n\n[1]: proof:prf_eeeeeeeeeeeeeeee`, {
      config: config("proven"),
      artifacts: memoryArtifacts([pair]),
      evidence: checkedBy([pair]),
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
    const opts = {
      config: config("proven"),
      artifacts: memoryArtifacts([total]),
      evidence: checkedBy([total]),
    };
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

  test("a figure's sign, its glued magnitude and a date's order are part of the statement", () => {
    // A proof that says -500 is not the statement of a sentence saying 500.
    expect(
      statementMismatch(
        "The account balance at year end is -500 dollars",
        "The account balance at year end is 500 dollars",
        0.8,
      ),
    ).toContain("the figures differ");
    expect(
      statementMismatch(
        "The account balance at year end is 500 dollars",
        "The account balance at year end is 600 dollars",
        0.8,
      ),
    ).toContain("the figures differ");
    // The same three numbers in another order are another date.
    expect(
      statementMismatch(
        "The contract was signed on 2024-03-05 by both parties",
        "The contract was signed on 2024-05-03 by both parties",
        0.8,
      ),
    ).toContain("the figures differ");
    // A magnitude glued to its numeral is the same figure as the word (the
    // bar is lowered only because "million" is a content token "$5M" lacks).
    expect(
      statementMismatch(
        "The acquisition was priced at $5 million in cash",
        "The acquisition was priced at $5M in cash",
        0.7,
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

  test("a HEAD the egress fabric refused says so: not checked, never 'no answer'", async () => {
    const cfg = config("cited", { sources: { resolve: "head" } });
    const refused = await verify("Alpha is real [1].\n\n[1]: https://collector.example/?k=x", {
      config: cfg,
      resolveHead: async () => ({ refused: "egress" }),
    });
    const binding = only(refused).bindings[0];
    expect(binding).toMatchObject({ ok: false, reason: "unresolved" });
    expect(binding?.detail).toContain("egress fabric refused to send a HEAD");
    expect(binding?.detail).not.toContain("got no answer");
    expect(refused.verdict).toBe("fail");
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
    // At `cited` the one URL cited is the one source (design §5.4).
    expect(renderFooter(capped)).toBe(
      "── provability · cited ✗ · 1/4 claims · unmet: [A1] [A2] [A3] · 1 source · 3 assumptions (3 refused)",
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

describe("grounded: only a page the run read, as the page", () => {
  const CLAIM = "Acme accepts refund requests within 30 days of purchase";
  const answer = `${CLAIM} [1].\n\n[1]: ${POLICY}`;
  const asHits = JSON.stringify([{ url: POLICY, text: `${CLAIM}.` }]);

  test("a sub-agent's or a sibling model's JSON answer grounds nothing (design §8: child returns are inputs)", async () => {
    for (const name of ["Task", "Consult", "Escalate", "Skill"]) {
      const bundle = await verify(answer, {
        config: config("grounded"),
        evidence: evidenceOf([
          { id: "t", name, input: { prompt: "find Acme's refund window" }, content: asHits },
        ]),
      });
      expect([name, only(bundle).bindings[0]?.reason, bundle.verdict]).toEqual([
        name,
        "not_fetched",
        "fail",
      ]);
      expect(renderFooter(bundle)).toContain("grounded ✗");
    }
    // A child that DID fetch the page, which says 14 days, and summarised it
    // as 30: the page decides, not the summary.
    const misreported = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "c1",
          name: "WebFetch",
          input: { url: POLICY },
          content: fetched(POLICY, "Acme accepts refund requests within 14 days of purchase."),
        },
        {
          id: "t",
          name: "Task",
          input: { prompt: "research the refund window" },
          content: JSON.stringify({ findings: [{ url: POLICY, summary: `${CLAIM}.` }] }),
        },
      ]),
    });
    expect(only(misreported).bindings[0]?.reason).toBe("not_found_in_source");
    // An MCP search's hits are evidence, as before.
    const searched = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        { id: "m", name: "mcp__search__query", input: { q: "acme refunds" }, content: asHits },
      ]),
    });
    expect(only(searched).status).toBe("met");
  });

  test("an error page is not the page: a 404 that repeats the slug, a 503 that states the claim", async () => {
    const slug =
      "https://acme.example/help/acme-accepts-refund-requests-within-30-days-of-purchase";
    const slugged = `${CLAIM} [1].\n\n[1]: ${slug}`;
    const apache404 = `URL: ${slug}\nStatus: 404\nContent-Type: text/html\n\nNot Found\n\nThe requested URL /help/acme-accepts-refund-requests-within-30-days-of-purchase was not found on this server.`;
    const notFound = await verify(slugged, {
      config: config("grounded"),
      evidence: evidenceOf([
        { id: "f", name: "WebFetch", input: { url: slug }, content: apache404 },
      ]),
    });
    expect(only(notFound).bindings[0]).toMatchObject({ rung: "cited", reason: "not_fetched" });
    expect(only(notFound).bindings[0]?.detail).toContain("answered 404");
    expect(renderFooter(notFound)).toContain("grounded ✗");
    const unavailable = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "f",
          name: "Fetch",
          input: { url: POLICY },
          content: `HTTP 503 Service Unavailable\ncontent-type: text/plain\n\n${CLAIM}.`,
        },
      ]),
    });
    expect(only(unavailable).bindings[0]?.reason).toBe("not_fetched");
    expect(only(unavailable).bindings[0]?.detail).toContain("answered 503");
    // A later fetch of the same URL that answered 200 is the page.
    const recovered = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "f1",
          name: "Fetch",
          input: { url: POLICY },
          content: "HTTP 503 Service Unavailable\ncontent-type: text/plain\n\ndown",
        },
        {
          id: "f2",
          name: "WebFetch",
          input: { url: POLICY },
          content: fetched(POLICY, `${CLAIM}.`),
        },
      ]),
    });
    expect(only(recovered).status).toBe("met");
  });

  test("a page that holds the claim only where it prints its own address does not ground it; its own text does", async () => {
    const slug =
      "https://acme.example/help/acme-accepts-refund-requests-within-30-days-of-purchase";
    const slugged = `${CLAIM} [1].\n\n[1]: ${slug}`;
    const of = (body: string, input: Record<string, unknown> = { url: slug }) =>
      verify(slugged, {
        config: config("grounded"),
        evidence: evidenceOf([{ id: "f", name: "WebFetch", input, content: fetched(slug, body) }]),
      });
    // A soft 404 — status 200, the requested path printed back.
    const soft = await of(
      "This page has moved. You asked for /help/acme-accepts-refund-requests-within-30-days-of-purchase; try the help centre.",
    );
    expect(only(soft).bindings[0]?.reason).toBe("not_found_in_source");
    expect(only(soft).bindings[0]?.detail).toContain("only where it prints the address");
    // The page's own text states it beside a breadcrumb of its own path.
    const real = await of(
      `Help > /help/acme-accepts-refund-requests-within-30-days-of-purchase\n\n${CLAIM}, for every order.`,
    );
    expect(only(real).status).toBe("met");
    // A slug that spells the claim, never printed, on a page that states it.
    expect(only(await of(`${CLAIM}, for every order.`)).status).toBe("met");
    // WebFetch's prompt naming the claim is not "the input handed back".
    expect(
      only(await of(`${CLAIM}, for every order.`, { url: slug, prompt: `${CLAIM}?` })).status,
    ).toBe("met");
  });

  test("a claim further down a spilled page grounds in the whole output, and fails closed without it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "prov-spill-"));
    try {
      const page = Array.from({ length: 200 }, (_, i) =>
        i === 150
          ? `${CLAIM}.`
          : `Line ${i + 1}: shipping, sizing and gift cards are covered here.`,
      ).join("\n");
      const head = page.split("\n").slice(0, 100).join("\n");
      const content = `${fetched(POLICY, head)}\n[part 1 of 2; Read .crewhaus/tool-results/run_1/toolu_big.part-2.txt for part 2]\n[truncated, full output at .crewhaus/tool-results/run_1/toolu_big.txt]`;
      const evidenceIn = () =>
        buildEvidenceIndex(
          evidenceFromMessages(
            [
              {
                role: "assistant",
                content: [
                  { type: "tool_use", id: "toolu_big", name: "WebFetch", input: { url: POLICY } },
                ],
              },
              {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "toolu_big", content }],
              },
            ],
            { workspaceRoot: ws },
          ),
        );
      // Without the saved output: the preview alone, and the claim is not in it.
      const preview = await verify(answer, { config: config("grounded"), evidence: evidenceIn() });
      expect(only(preview).bindings[0]?.reason).toBe("not_found_in_source");
      mkdirSync(join(ws, ".crewhaus", "tool-results", "run_1"), { recursive: true });
      writeFileSync(
        join(ws, ".crewhaus", "tool-results", "run_1", "toolu_big.txt"),
        fetched(POLICY, page),
      );
      const whole = await verify(answer, { config: config("grounded"), evidence: evidenceIn() });
      expect(only(whole).status).toBe("met");
      expect(only(whole).bindings[0]?.excerpt).toContain("within 30 days of purchase");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("checked: a result that does not say the claim does not check it", () => {
  const draft = "Acme is the leading refund processor in Europe [1].\n\n[1]: tool:toolu_lint";
  const sentence = "Acme is the leading refund processor in Europe.";
  const evidence = evidenceOf([
    {
      id: "toolu_lint",
      name: "CitationLint",
      input: { text: draft },
      content: JSON.stringify({
        from: "inline",
        ok: true,
        markerCount: 1,
        definedCount: 1,
        issues: [],
      }),
    },
    {
      id: "toolu_norm",
      name: "NormalizeText",
      input: { text: sentence, form: "lower" },
      content: sentence.toLowerCase(),
    },
    {
      id: "toolu_fact",
      name: "FactCrossCheck",
      input: { claims: [{ text: sentence, sources: ["https://acme.example/about"] }] },
      // tool-verify's report shape: a URL nobody fetched is not checked.
      content: JSON.stringify({
        from: "claims",
        ok: false,
        checked: 1,
        claims: [
          {
            index: 0,
            claim: sentence,
            mode: "paraphrase",
            cites: ["https://acme.example/about"],
            verdict: "unchecked",
            reason: "the source is a URL, which this tool does not fetch",
            sources: [],
          },
        ],
      }),
    },
    {
      id: "toolu_rank",
      name: "Evaluate",
      input: { expression: "rank(acme, refunds, europe)" },
      content: '{"leader":"Acme is the leading refund processor in Europe by volume"}',
    },
  ]);
  const allow = { allow: ["citationLint", "normalizeText", "factCrossCheck", "evaluate"] };

  test("a lint run over the draft, or a tool that hands the sentence back, checks nothing — at checked or grounded", async () => {
    for (const level of ["checked", "grounded"] as const) {
      for (const [id, words] of [
        ["toolu_lint", "its words are the call's own input"],
        ["toolu_norm", "hands the call's own input back"],
        ["toolu_fact", "reports this claim unchecked, not supported"],
      ] as const) {
        const bundle = await verify(`${sentence.slice(0, -1)} [1].\n\n[1]: tool:${id}`, {
          config: config(level, { execution: allow }),
          evidence,
        });
        expect([level, id, only(bundle).bindings[0]?.reason]).toEqual([level, id, "value_absent"]);
        expect(only(bundle).bindings[0]?.detail).toContain(words);
        expect(bundle.verdict).toBe("fail");
      }
    }
    // Scenario B through the lint: its figure is not in the result either.
    const total = await verify("The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_lint", {
      config: config("checked", { execution: allow }),
      evidence,
    });
    expect(only(total).bindings[0]?.reason).toBe("value_absent");
  });

  test("a result that states the claim in its own words still checks it", async () => {
    const bundle = await verify(`${sentence.slice(0, -1)} [1].\n\n[1]: tool:toolu_rank`, {
      config: config("checked", { execution: allow }),
      evidence,
    });
    expect(only(bundle).status).toBe("met");
  });

  test("the excerpt shows the figure that met the floor, however far down the result", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: item-${i + 1} amount 100.00`);
    const result = `${rows.join("\n")}\ntotal: 1284.50`;
    const bundle = await verify("The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_rows", {
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_rows", name: "Evaluate", input: { expression: "sum(rows)" }, content: result },
      ]),
    });
    const binding = only(bundle).bindings[0];
    expect(binding).toMatchObject({ ok: true, rung: "checked" });
    expect(binding?.excerpt).toContain("1284.50");
    expect((binding?.excerpt ?? "").length).toBeLessThanOrEqual(240);
    // A result that fits is frozen whole, as before.
    const short = await verify("The invoice total is 1,284.50 [1].\n\n[1]: tool:toolu_s", {
      config: config("checked", { execution: { replay: false } }),
      evidence: evidenceOf([
        { id: "toolu_s", name: "Evaluate", input: {}, content: '{"total":"1284.50"}' },
      ]),
    });
    expect(only(short).bindings[0]?.excerpt).toBe('{"total":"1284.50"}');
  });

  test("a duplicated tool_result reads as continuity-store reads it: the last one", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prov-dup-"));
    try {
      const log = await openEventLog("sess_00000000000000d1", { rootDir });
      for (const [id, results] of [
        [
          "toolu_ok_then_error",
          [
            ["1284.50", false],
            ["boom", true],
          ],
        ],
        [
          "toolu_error_then_ok",
          [
            ["boom", true],
            ["1284.50", false],
          ],
        ],
      ] as const) {
        await log.append({
          kind: "tool_use",
          payload: { id, name: "MoneyAdd", input: {} },
        } as never);
        for (const [content, isError] of results) {
          await log.append({
            kind: "tool_result",
            payload: { toolUseId: id, content, isError },
          } as never);
        }
      }
      await log.close();
      const evidence = buildEvidenceIndex(
        await evidenceFromSessionLog({ sessionId: "sess_00000000000000d1", rootDir }),
      );
      const bundle = await verify(
        "The total is 1,284.50 [1]. The total is still 1,284.50 [2].\n\n[1]: tool:toolu_ok_then_error\n[2]: tool:toolu_error_then_ok",
        { config: config("checked", { execution: { replay: false } }), evidence },
      );
      // PlanComplete: error_result for the first, verified for the second.
      expect(bundle.claims.map((c) => c.bindings[0]?.reason ?? "ok")).toEqual([
        "tool_errored",
        "ok",
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("proven: a proof's hypotheses are assumptions, and a checker accepted it in this run", () => {
  const sentence = "Revenue is 9 [1].\n\n[1]: proof:prf_9999999999999999";
  // A builtin certificate `given "revenue = 9 and true"`, `and_elim left`:
  // accepted, and resting on its own conclusion.
  const assumes = artifact({
    id: "prf_9999999999999999",
    claim: "Revenue is 9.",
    statement: "revenue = 9",
    proof: "1. revenue = 9 and true by given\n2. revenue = 9 by and_elim 1",
    assumptions: ["revenue = 9 and true"],
  });
  const opts = (patch: Parameters<typeof config>[1] = {}) => ({
    config: config("proven", patch),
    artifacts: memoryArtifacts([assumes]),
    evidence: checkedBy([assumes]),
  });

  test("allowed: listed beside the statement, counted on every surface", async () => {
    const bundle = await verify(sentence, opts());
    expect(only(bundle).bindings[0]).toMatchObject({
      ok: true,
      rung: "proven",
      assumptions: ["revenue = 9 and true"],
    });
    expect(bundle).toMatchObject({ verdict: "pass", achieved: "proven", hypotheses: 1 });
    expect(bundle.checkers).toEqual([
      { id: "builtin", artifact: assumes.id, axioms: [], assumptions: ["revenue = 9 and true"] },
    ]);
    expect(renderFooter(bundle)).toBe(
      "── provability · proven ✓ · 1/1 claim · 0 sources · 1 assumption",
    );
    const md = renderMarkdownSection(bundle);
    expect(md).toContain(
      `**Assumptions (1):**\n- [1] revenue = 9 and true (a hypothesis of ${assumes.id})`,
    );
    expect(md).toContain("(assuming: revenue = 9 and true; axioms: none)");
    expect(renderBundleJson(bundle)).toContain("revenue = 9 and true");
  });

  test("forbid refuses the proof, and so does a cap it is past", async () => {
    for (const patch of [{ assumptions: "forbid" as const }, { maxAssumptions: 0 }]) {
      const bundle = await verify(sentence, opts(patch));
      expect(only(bundle).bindings[0]).toMatchObject({
        ok: false,
        reason: "assumption_forbidden",
        assumptions: ["revenue = 9 and true"],
      });
      expect(bundle).toMatchObject({
        verdict: "fail",
        achieved: "none",
        assumptionsRefused: 1,
      });
      expect(bundle.checkers).toBeUndefined();
      expect(renderFooter(bundle)).toBe(
        "── provability · proven ✗ · 0/1 claim · unmet: [1] · 0 sources · 1 assumption (1 refused)",
      );
    }
    const forbid = await verify(sentence, opts({ assumptions: "forbid" }));
    expect(only(forbid).bindings[0]?.detail).toContain("rests on 1 hypothesis");
    // The same claim declared outright is refused alike.
    const declared = await verify(
      "Revenue is 9 [A1].\n\n[A1]: assume: revenue = 9",
      opts({ assumptions: "forbid" }),
    );
    expect(declared).toMatchObject({ verdict: "fail", assumptionsRefused: 1 });
  });

  test("the cap counts declared assumptions and hypotheses together, in document order", async () => {
    const text =
      "The fiscal year starts in April [A1]. Revenue is 9 [1]. Revenue is still 9 [1].\n\n[A1]: assume: April\n[1]: proof:prf_9999999999999999";
    const within = await verify(text, opts({ maxAssumptions: 2 }));
    expect(within).toMatchObject({ verdict: "pass", assumptions: 1, hypotheses: 1 });
    expect(renderFooter(within)).toContain("· 2 assumptions");
    const past = await verify(text, opts({ maxAssumptions: 1 }));
    expect(past.claims.map((c) => c.status)).toEqual(["assumption", "unmet", "unmet"]);
    expect(past.claims[1]?.bindings[0]?.detail).toContain("max_assumptions (1)");
    expect(past).toMatchObject({ verdict: "fail", assumptionsRefused: 2 });
  });

  test("an SMT problem's asserts and definitions are its hypotheses", async () => {
    const smt = artifact({
      id: "prf_5555555555555555",
      checker: "smt",
      claim: "Revenue is 9.",
      statement: "(= revenue 9)",
      assumptions: ["(define-fun revenue () Int 9)", "(assert (> revenue 0))"],
    });
    const bundle = await verify("Revenue is 9 [1].\n\n[1]: proof:prf_5555555555555555", {
      config: config("proven"),
      artifacts: memoryArtifacts([smt]),
      evidence: checkedBy([smt]),
    });
    expect(bundle).toMatchObject({ verdict: "pass", hypotheses: 2 });
    expect(renderFooter(bundle)).toContain("· 2 assumptions");
  });

  test("an artifact no ProofCheck in this run wrote, one flipped to ok, or one off the checker list is not proven", async () => {
    const accepted = artifact({ id: "prf_7777777777777777" });
    const text = "No two of the six meetings overlap [1].\n\n[1]: proof:prf_7777777777777777";
    // Hand-written: the file is there, the run never checked it.
    const forged = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
    });
    expect(only(forged).bindings[0]?.reason).toBe("proof_missing");
    expect(only(forged).bindings[0]?.detail).toContain("no ProofCheck call");
    // Flipped: the run's ProofCheck said rejected; the file says ok.
    const flipped = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
      evidence: checkedBy([{ ...accepted, ok: false, reason: "10.5 <= 10 is false" }]),
    });
    expect(only(flipped).bindings[0]?.reason).toBe("proof_rejected");
    expect(only(flipped).bindings[0]?.detail).toContain("reported it rejected");
    // An errored ProofCheck call is not a check.
    const errored = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
      evidence: evidenceOf([{ ...proofCheckCall(accepted), isError: true }]),
    });
    expect(only(errored).bindings[0]?.reason).toBe("proof_missing");
    // Off the list: a lean4 artifact under formal.checkers [builtin, smt].
    const lean = { ...accepted, checker: "lean4" };
    const offList = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([lean]),
      evidence: checkedBy([lean]),
    });
    expect(only(offList).bindings[0]?.reason).toBe("proof_missing");
    expect(only(offList).bindings[0]?.detail).toContain("not on provability.formal.checkers");
    // Hypotheses stripped from the file after the check.
    const stripped = await verify(sentence, {
      config: config("proven"),
      artifacts: memoryArtifacts([{ ...assumes, assumptions: [] }]),
      evidence: checkedBy([assumes]),
    });
    expect(only(stripped).bindings[0]?.reason).toBe("proof_missing");
    expect(only(stripped).bindings[0]?.detail).toContain("not the one ProofCheck reported");
    // Rewritten after the check: the id, the verdict, the checker and the
    // lists all agree with the run's report, but the claim, the statement or
    // the proof is not what that ProofCheck call was given (design §6.4,
    // acceptance C: a rewritten accepted artifact is never served as proven).
    for (const patch of [
      {
        claim: "Two plus two is four.",
        statement: "2 + 2 = 4",
      },
      { statement: "let s = [9, 10, 13], e = [10.5, 12, 14] in forall i, e_i <= s_(i+1)" },
      { proof: "1. given everything" },
    ] as const) {
      const checked = { ...accepted, ...patch };
      const rewritten = await verify(text, {
        config: config("proven"),
        artifacts: memoryArtifacts([accepted]),
        evidence: checkedBy([checked]),
      });
      expect([patch, only(rewritten).status, only(rewritten).bindings[0]?.reason]).toEqual([
        patch,
        "unmet",
        "proof_missing",
      ]);
      expect(only(rewritten).bindings[0]?.detail).toContain("not the one ProofCheck checked");
    }
    // A call whose logged input is gone is no record of what was checked.
    const inputless = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
      evidence: evidenceOf([{ ...proofCheckCall(accepted), input: {} }]),
    });
    expect(only(inputless).bindings[0]?.reason).toBe("proof_missing");
    // Under scope: turn, a check from another turn does not count.
    const earlier = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
      evidence: evidenceOf([{ ...proofCheckCall(accepted), turnNumber: 1 }]),
      turnNumbers: new Set([2]),
    });
    expect(only(earlier).bindings[0]?.detail).toContain("(this turn)");
    // An offline check with no log at hand may trust the store, by asking.
    const trusted = await verify(text, {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
      trustStoredProofs: true,
    });
    expect(only(trusted).status).toBe("met");
  });

  test("a report that clipped its lists still matches the artifact that keeps them whole", async () => {
    const long = Array.from({ length: 3 }, (_, i) => `h${i} ${"x".repeat(400)}`);
    const many = artifact({ id: "prf_6666666666666666", assumptions: long });
    const report = proofCheckCall(many);
    const content = JSON.parse(report.content) as Record<string, unknown>;
    content["assumptions"] = [
      `${(long[0] as string).slice(0, 299)}…`,
      "… and 2 more (the artifact keeps them all)",
    ];
    const bundle = await verify(
      "No two of the six meetings overlap [1].\n\n[1]: proof:prf_6666666666666666",
      {
        config: config("proven"),
        artifacts: memoryArtifacts([many]),
        evidence: evidenceOf([{ ...report, content: JSON.stringify(content) }]),
      },
    );
    expect(only(bundle).status).toBe("met");
  });

  test("a wired re-check decides, once per artifact, and supplies the hypotheses", async () => {
    const accepted = artifact({ id: "prf_8888888888888888" });
    const text =
      "No two of the six meetings overlap [1]. Again, no two of the six meetings overlap [1].\n\n[1]: proof:prf_8888888888888888";
    let calls = 0;
    const base = {
      config: config("proven"),
      artifacts: memoryArtifacts([accepted]),
      evidence: checkedBy([accepted]),
    };
    const rejected = await verify(text, {
      ...base,
      recheckProof: async () => {
        calls += 1;
        return { ok: false };
      },
    });
    expect(calls).toBe(1);
    expect(rejected.claims.map((c) => c.bindings[0]?.reason)).toEqual([
      "proof_rejected",
      "proof_rejected",
    ]);
    const resting = await verify(text, {
      ...base,
      recheckProof: () => ({ ok: true, assumptions: ["meeting 6 is cancelled"], axioms: [] }),
    });
    expect(resting).toMatchObject({ verdict: "pass", hypotheses: 1 });
    // A re-check that cannot run is not a verdict.
    const threw = await verify(text, {
      ...base,
      recheckProof: async () => {
        throw new Error("checker gone");
      },
    });
    expect(threw.verdict).toBe("pass");
  });
});

describe("bounded work on what the model writes", () => {
  const fastest = (run: () => unknown): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      run();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };

  test("a dressed id is trimmed in linear time, whatever the run of punctuation", () => {
    expect(bareId("`toolu_01`.")).toBe("toolu_01");
    expect(bareId("<(prf_0123456789abcdef)>!?")).toBe("prf_0123456789abcdef");
    expect(bareId("(.)")).toBe("");
    // An end-anchored class took 6 s on 80 000 dots that do not end the id.
    const n = 200_000;
    const base = fastest(() => bareId(`toolu_${"a".repeat(n)}x`));
    expect(fastest(() => bareId(`toolu_${".".repeat(n)}x`))).toBeLessThan(base * 20 + 100);
  });

  test("a tool id or a URL with a long internal run is verified in linear time", async () => {
    const n = 200_000;
    const timed = async (text: string): Promise<number> => {
      const t = performance.now();
      await verify(text, { config: config("checked") });
      return performance.now() - t;
    };
    const idBase = await timed(`The total is 4 [1].\n\n[1]: tool:toolu_${"a".repeat(n)}x`);
    expect(await timed(`The total is 4 [1].\n\n[1]: tool:toolu_${".".repeat(n)}x`)).toBeLessThan(
      idBase * 20 + 200,
    );
  }, 20_000);

  test("HEADs go out a few at a time, under one deadline for the whole verification", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://h${i}.example/p`);
    const text = `${urls.map((_, i) => `Claim number ${i} is cited here [${i + 1}].`).join(" ")}\n\n${urls
      .map((u, i) => `[${i + 1}]: ${u}`)
      .join("\n")}`;
    let inFlight = 0;
    let most = 0;
    const t = performance.now();
    const bundle = await verify(text, {
      config: config("cited", { sources: { resolve: "head" } }),
      resolveHead: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
        return 200;
      },
    });
    expect(bundle.met).toBe(12);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(HEAD_CONCURRENCY);
    expect(performance.now() - t).toBeLessThan(12 * 40);
    // Hosts that never answer: unresolved at the deadline, the rest checked.
    const aborted: string[] = [];
    const t2 = performance.now();
    const stalled = await verify(text, {
      config: config("cited", { sources: { resolve: "head" } }),
      headDeadlineMs: 150,
      resolveHead: (url, signal) =>
        url.includes("h3.") || url.includes("h7.")
          ? new Promise((resolve) =>
              signal?.addEventListener("abort", () => {
                aborted.push(url);
                resolve(undefined);
              }),
            )
          : Promise.resolve(200),
    });
    expect(performance.now() - t2).toBeLessThan(2_000);
    expect(stalled.met).toBe(10);
    const late = stalled.claims.filter((c) => c.status === "unmet").map((c) => c.bindings[0]);
    expect(late.map((b) => b?.reason)).toEqual(["unresolved", "unresolved"]);
    expect(late[0]?.detail).toContain("ran past 150 ms");
    expect(aborted.sort()).toEqual(["https://h3.example/p", "https://h7.example/p"]);
  });

  test("grounding reads at most its budget of fetched text, and yields between claims", async () => {
    const body = "The refund window is 30 days for every order placed online. ".repeat(50);
    const evidence = evidenceOf([
      { id: "f", name: "WebFetch", input: { url: POLICY }, content: fetched(POLICY, body) },
    ]);
    const text = `The refund window is 30 days [1]. Every order placed online counts [1]. The window is 30 days [1].\n\n[1]: ${POLICY}`;
    _setGroundingBudgetForTest(1_000);
    try {
      const capped = await verify(text, { config: config("grounded"), evidence });
      expect(capped.claims.map((c) => c.status)).toEqual(["met", "met", "unmet"]);
      expect(capped.claims[2]?.bindings[0]).toMatchObject({ rung: "cited", reason: "below_floor" });
      expect(capped.claims[2]?.bindings[0]?.detail).toContain("not checked");
      // At `cited` the cap costs nothing: no source needs reading there.
      expect((await verify(text, { config: config("cited"), evidence })).verdict).toBe("pass");
    } finally {
      _setGroundingBudgetForTest();
    }
    // A timer due while a long answer is verified runs before it is done.
    const big = evidenceOf([
      {
        id: "g",
        name: "WebFetch",
        input: { url: POLICY },
        content: fetched(
          POLICY,
          "Shipping is free over 50 dollars and takes three days. ".repeat(4_000),
        ),
      },
    ]);
    const many = `${Array.from({ length: 150 }, (_, i) => `Shipping takes ${i + 3} days [1].`).join(" ")}\n\n[1]: ${POLICY}`;
    let done = false;
    let ranDuring = false;
    setTimeout(() => {
      ranDuring = !done;
    }, 1);
    await verify(many, { config: config("grounded"), evidence: big });
    done = true;
    expect(ranDuring).toBe(true);
  }, 20_000);
});

describe("the judge, and the excerpt, are spent only where they decide", () => {
  const evidence = evidenceOf([
    {
      id: "f",
      name: "WebFetch",
      input: { url: POLICY },
      content: "Customers may return items within the refund window.",
    },
    {
      id: "g",
      name: "WebFetch",
      input: { url: "https://acme.example/terms" },
      content: "Customers can return goods within the refund window of the store.",
    },
    {
      id: "h",
      name: "WebFetch",
      input: { url: "https://consumer.gov/returns" },
      content: "Customers may return items within the refund window.",
    },
  ]);
  const claimText = "Customers can return goods within the refund window of the store";

  test("not asked about a claim another binding already meets, in either order", async () => {
    for (const refs of ["[1] [2]", "[2] [1]"]) {
      let asked = 0;
      const bundle = await verify(
        `${claimText} ${refs}.\n\n[1]: ${POLICY}\n[2]: https://acme.example/terms`,
        {
          config: config("grounded"),
          evidence,
          judgeWaiver: async () => {
            asked += 1;
            return { supported: true, costUsdMicros: 1500 };
          },
        },
      );
      expect([refs, asked, bundle.judgeWaived, bundle.spentUsdMicros]).toEqual([
        refs,
        0,
        0,
        undefined,
      ]);
      expect(only(bundle).status).toBe("met");
      expect(renderFooter(bundle)).not.toContain("judge-waived");
    }
  });

  test("at independent: 2, asked only for an origin the claim does not already count", async () => {
    const asked: string[] = [];
    const judgeWaiver = async (input: { source: string }) => {
      asked.push(input.source);
      return { supported: true };
    };
    const cfg = config("grounded", { grounded: { independent: 2 } });
    const corroborated = await verify(
      `${claimText} [1] [2].\n\n[1]: https://acme.example/terms\n[2]: https://consumer.gov/returns`,
      { config: cfg, evidence, judgeWaiver },
    );
    expect(asked).toEqual(["https://consumer.gov/returns"]);
    expect(only(corroborated).status).toBe("met");
    // A waiver on the same publisher could not make up the count: not asked.
    asked.length = 0;
    const samePublisher = await verify(
      `${claimText} [1] [2].\n\n[1]: https://acme.example/terms\n[2]: ${POLICY}`,
      { config: cfg, evidence, judgeWaiver },
    );
    expect(asked).toEqual([]);
    expect(only(samePublisher).status).toBe("unmet");
  });

  test("a grounded excerpt shows the claim at its tightest, its figure first", async () => {
    const page =
      "Acme Corporation refund policy. After extensive consultation with our customers, partners, regulators, logistics providers and the wider retail community across many seasons, markets and product categories, the board has decided that refund requests are accepted within 30 days of purchase.";
    const bundle = await verify(
      `Acme refund requests are accepted within 30 days of purchase [1].\n\n[1]: ${POLICY}`,
      {
        config: config("grounded"),
        evidence: evidenceOf([
          { id: "f", name: "WebFetch", input: { url: POLICY }, content: page },
        ]),
      },
    );
    const binding = only(bundle).bindings[0];
    expect(binding?.rung).toBe("grounded");
    expect(binding?.excerpt).toContain("30 days of purchase");
    expect((binding?.excerpt ?? "").length).toBeLessThanOrEqual(240);
  });

  test("clipAround keeps what met the floor, and marks each cut", () => {
    expect(clipAround("short text", 0, 5, 240)).toBe("short text");
    const text = `${"a ".repeat(200)}TARGET${" b".repeat(200)}`;
    const at = text.indexOf("TARGET");
    const out = clipAround(text, at, at + 6, 40);
    expect(out).toContain("TARGET");
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    const long = clipAround(`x ${"y".repeat(500)}`, 2, 502, 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.startsWith("…y")).toBe(true);
  });
});

describe("grounded: what the run itself wrote is never the source", () => {
  const SAID = "The refund window is 30 days from the date of purchase";
  const answer = `${SAID} [1].\n\n[1]: ${POLICY}`;

  test("a runtime tool given a url it does not take grounds nothing under it (design §8)", async () => {
    // Remember, then Recall with a url the model added: tool-memory's schema
    // strips the key, the log keeps it, and the remembered sentence was
    // served as grounded ✓ under a page nobody fetched.
    for (const [name, input] of [
      ["Recall", { query: "refund window", url: POLICY }],
      ["Task", { description: "policy", prompt: "What does our policy page say?", url: POLICY }],
      ["Consult", { question: "What is the refund window?", href: POLICY }],
      ["Skill", { name: "refunds", uri: POLICY }],
    ] as const) {
      const bundle = await verify(answer, {
        config: config("grounded", { onFail: "halt" }),
        evidence: evidenceOf([
          { id: "m", name: "Remember", input: { text: `${SAID}.` }, content: "remembered" },
          { id: "t", name, input, content: `${SAID}.` },
        ]),
      });
      expect([name, only(bundle).bindings[0]?.reason, bundle.verdict]).toEqual([
        name,
        "not_fetched",
        "fail",
      ]);
    }
    // A path key the same way: a Skill body is not the workspace file.
    const pathed = await verify(
      "The Pro plan costs 99 dollars per month [1].\n\n[1]: ./docs/pricing.md",
      {
        config: config("grounded"),
        evidence: evidenceOf(
          [
            {
              id: "s",
              name: "Skill",
              input: { name: "pricing", path: "docs/pricing.md" },
              content: "The Pro plan costs 99 dollars per month.",
            },
          ],
          workspace,
        ),
      },
    );
    expect(only(pathed).bindings[0]?.reason).toBe("not_fetched");
    // A child's wrong summary with the page's url beside it: the page, which
    // the run did fetch, decides.
    const misreported = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "f",
          name: "WebFetch",
          input: { url: POLICY },
          content: fetched(POLICY, "The refund window is 14 days from the date of purchase."),
        },
        {
          id: "t",
          name: "Task",
          input: { description: "policy", prompt: "Summarise the policy", url: POLICY },
          content: `${SAID}.`,
        },
      ]),
    });
    expect(only(misreported).bindings[0]?.reason).toBe("not_found_in_source");
  });

  test("a session log, a bundle or a link into the state directory is never read as a source", async () => {
    const log = ".crewhaus/sessions/sess_00000000000000aa.jsonl";
    mkdirSync(join(workspace, ".crewhaus", "sessions"), { recursive: true });
    const line = `${JSON.stringify({
      kind: "assistant_message",
      payload: { text: `Noting for the record: ${SAID.toLowerCase()}.` },
    })}\n`;
    writeFileSync(join(workspace, log), line);
    symlinkSync(join(workspace, log), join(workspace, "docs", "notes.jsonl"));
    mkdirSync(join(workspace, "logs"), { recursive: true });
    writeFileSync(join(workspace, "logs", "sess_00000000000000ab.jsonl"), line);
    const read = (path: string) => ({
      id: `r_${path}`,
      name: "Read",
      input: { path },
      content: line,
    });
    const evidence = evidenceOf(
      [read(log), read("docs/notes.jsonl"), read("logs/sess_00000000000000ab.jsonl")],
      workspace,
    );
    for (const cited of [log, "docs/notes.jsonl"]) {
      const bundle = await verify(`${SAID} [1].\n\n[1]: ./${cited}`, {
        config: config("grounded"),
        evidence,
      });
      const binding = only(bundle).bindings[0];
      expect([cited, binding?.reason, binding?.rung]).toEqual([cited, "not_fetched", "cited"]);
      expect(binding?.detail).toContain(".crewhaus/");
      expect(binding?.detail).toContain("the model's own text");
    }
    // Spelled in another case: on a case-insensitive volume (macOS by
    // default) that is the same log, and the on-disk spelling is compared.
    const upper = ".CREWHAUS/sessions/sess_00000000000000aa.jsonl";
    const insensitive = existsSync(join(workspace, upper));
    const shouted = await verify(`${SAID} [1].\n\n[1]: ./${upper}`, {
      config: config("grounded"),
      evidence: evidenceOf([read(upper)], workspace),
    });
    const loud = only(shouted).bindings[0];
    expect(loud?.ok).toBe(false);
    if (insensitive) {
      expect([loud?.reason, loud?.rung]).toEqual(["not_fetched", "cited"]);
      expect(loud?.detail).toContain(".crewhaus/");
    }
    // A relocated session directory is refused once the caller names it.
    const relocated = `${SAID} [1].\n\n[1]: ./logs/sess_00000000000000ab.jsonl`;
    const named = await verify(relocated, {
      config: config("grounded"),
      evidence,
      stateRoots: ["logs"],
    });
    expect(only(named).bindings[0]).toMatchObject({ reason: "not_fetched", rung: "cited" });
    expect(only(named).bindings[0]?.detail).toContain("under logs");
    // A workspace file the run read still grounds.
    const pricing = await verify(
      "The Pro plan costs 10 dollars per month [1].\n\n[1]: ./docs/pricing.md",
      {
        config: config("grounded"),
        evidence: evidenceOf(
          [
            {
              id: "p",
              name: "Read",
              input: { path: "docs/pricing.md" },
              content: "The Pro plan costs 10 dollars per month and includes unlimited seats.",
            },
          ],
          workspace,
        ),
        stateRoots: ["logs"],
      },
    );
    expect(only(pricing).status).toBe("met");
  });

  test("an MCP store hands back text the run wrote to it: that grounds no URL", async () => {
    const row = { url: POLICY, text: `${SAID}.` };
    const stored = await verify(answer, {
      config: config("grounded", { onFail: "halt" }),
      evidence: evidenceOf([
        {
          id: "w",
          name: "mcp__sqlite__write_query",
          input: {
            query: `INSERT INTO notes (url, text) VALUES ('${POLICY}', '${SAID}.')`,
          },
          content: "1 row affected",
        },
        {
          id: "r",
          name: "mcp__sqlite__read_query",
          input: { query: "SELECT url, text FROM notes" },
          content: JSON.stringify([row]),
        },
      ]),
    });
    const binding = only(stored).bindings[0];
    expect(binding?.reason).toBe("not_fetched");
    expect(binding?.detail).toContain("w (mcp__sqlite__write_query) sent earlier");
    expect(stored.verdict).toBe("fail");
    // Written to the server, read back through a stray url on its recall:
    // the same.
    const recalled = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        { id: "m", name: "mcp__memory__store", input: { text: `${SAID}.` }, content: "ok" },
        {
          id: "r",
          name: "mcp__memory__recall",
          input: { query: "refund window", url: POLICY },
          content: `${SAID}.`,
        },
      ]),
    });
    expect(only(recalled).bindings[0]?.reason).toBe("not_fetched");
    // A search hit read BEFORE the run wrote its notes is still the page's.
    const searched = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "s",
          name: "mcp__search__query",
          input: { q: "acme refund policy" },
          content: JSON.stringify([row]),
        },
        { id: "n", name: "Write", input: { path: "notes.md", content: `${SAID}.` }, content: "ok" },
      ]),
    });
    expect(only(searched).status).toBe("met");
    // A row the result carried is whatever the server keeps: a file the run
    // wrote and a filesystem server read back is the model's text.
    const filed = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "w",
          name: "Write",
          input: { path: "notes.json", content: JSON.stringify([row]) },
          content: "ok",
        },
        {
          id: "r",
          name: "mcp__filesystem__read_text_file",
          input: { path: "notes.json" },
          content: JSON.stringify([row]),
        },
      ]),
    });
    expect(only(filed).bindings[0]?.reason).toBe("not_fetched");
  });

  test("a page fetched over MCP grounds whatever the run sent elsewhere before it", async () => {
    // Only the server's own store can hand text back: the preflight's draft,
    // a saved report, a searched phrase and a comment posted to another
    // server never come out of a fetch the input pointed at the page.
    const PAGE = `Returns policy\n\n${SAID}. Items must be unused.`;
    const fetchIt = { id: "f", name: "mcp__fetch__fetch", input: { url: POLICY }, content: PAGE };
    for (const [label, before] of [
      [
        "preflight",
        {
          id: "p",
          name: "ProvabilityPreflight",
          input: { draft: answer },
          content: '{"verdict":"fail","claims":[{"status":"unmet","reason":"not_fetched"}]}',
        },
      ],
      [
        "write",
        { id: "p", name: "Write", input: { path: "report.md", content: answer }, content: "ok" },
      ],
      [
        "search",
        {
          id: "p",
          name: "WebSearch",
          input: { query: `acme "${SAID.toLowerCase()}"` },
          content: `1. Acme returns — ${POLICY}`,
        },
      ],
      [
        "another server",
        {
          id: "p",
          name: "mcp__zendesk__add_comment",
          input: { ticket: 7, body: `Customer says: ${SAID.toLowerCase()}. Checking.` },
          content: "ok",
        },
      ],
    ] as const) {
      const bundle = await verify(answer, {
        config: config("grounded"),
        evidence: evidenceOf([before, fetchIt]),
      });
      expect([label, only(bundle).status]).toEqual([label, "met"]);
    }
    // Sent to the same server first, it is that server's to hand back.
    const same = await verify(answer, {
      config: config("grounded"),
      evidence: evidenceOf([
        {
          id: "p",
          name: "mcp__fetch__post",
          input: { url: "https://x.example", body: `${SAID}.` },
          content: "ok",
        },
        fetchIt,
      ]),
    });
    expect(only(same).bindings[0]?.reason).toBe("not_fetched");
  });
});

describe("grounded: one sub-agent's call is never graded under another's URL", () => {
  // An OpenAI-compatible server numbers ids per conversation: the parent's
  // first fetch and its child's share `functions.WebFetch:0`.
  const ID = "functions.WebFetch:0";
  const BLOG = "https://blog.example/acme-refunds";
  const call = (sessionId: string, url: string, said: string) =>
    recordFromCall({
      toolUseId: ID,
      toolName: "WebFetch",
      input: { url },
      content: fetched(url, said),
      isError: false,
      sessionId,
    });

  test("the body under the cited URL is the call that fetched it", async () => {
    const evidence = buildEvidenceIndex([
      call(
        "sess_00000000000000a1",
        BLOG,
        "The refund window is 30 days from the date of purchase.",
      ),
      call(
        "sess_00000000000000b2",
        POLICY,
        "The refund window is 14 days from the date of purchase.",
      ),
    ]);
    const cite = (days: number) =>
      verify(`The refund window is ${days} days from the date of purchase [1].\n\n[1]: ${POLICY}`, {
        config: config("grounded"),
        evidence,
      });
    expect(only(await cite(30)).bindings[0]?.reason).toBe("not_found_in_source");
    const honest = only(await cite(14)).bindings[0];
    expect(honest).toMatchObject({ ok: true, rung: "grounded" });
    expect(honest?.excerpt).toContain("14 days");
  });

  test("a tool: id only several sub-agents share is ambiguous, not a guess", async () => {
    const evidence = buildEvidenceIndex(
      [
        call("sess_00000000000000b2", POLICY, "x"),
        call("sess_00000000000000c3", BLOG, "y"),
        recordFromCall({
          toolUseId: "toolu_own",
          toolName: "MoneyAdd",
          input: {},
          content: "4",
          isError: false,
          sessionId: "sess_00000000000000a1",
        }),
      ],
      { sessionId: "sess_00000000000000a1" },
    );
    const bundle = await verify(`The total is 4 [1].\n\n[1]: tool:${ID}`, {
      config: config("checked", { execution: { allow: ["webFetch"] } }),
      evidence,
    });
    expect(only(bundle).bindings[0]?.reason).toBe("tool_missing");
    expect(only(bundle).bindings[0]?.detail).toContain("names 2 calls");
  });
});

describe("grounded: a redirect is read where it landed", () => {
  const SHORT = "https://bit.ly/3xYzAbc";
  const BAD = "https://bad.example/refunds";
  const SAID = "The refund window is 30 days from the date of purchase";
  const landed = (from: string, to: string, body: string): string =>
    `URL: ${to}\nRequested: ${from}\nStatus: 200\nContent-Type: text/html\n\n${body}`;
  const via = (from: string, to: string) =>
    evidenceOf([
      { id: "f", name: "WebFetch", input: { url: from }, content: landed(from, to, `${SAID}.`) },
    ]);

  test("a body a denied or private host served does not ground the URL that redirected to it", async () => {
    const deny = config("grounded", { sources: { deny: ["bad.example"] } });
    const direct = await verify(`${SAID} [1].\n\n[1]: ${BAD}`, {
      config: deny,
      evidence: via(SHORT, BAD),
    });
    expect(only(direct).bindings[0]?.reason).toBe("host_denied");
    const shortened = await verify(`${SAID} [1].\n\n[1]: ${SHORT}`, {
      config: deny,
      evidence: via(SHORT, BAD),
    });
    expect(only(shortened).bindings[0]).toMatchObject({ reason: "host_denied", rung: "none" });
    expect(only(shortened).bindings[0]?.detail).toContain("redirected to bad.example");
    const looped = await verify(`${SAID} [1].\n\n[1]: ${SHORT}`, {
      config: config("grounded"),
      evidence: via(SHORT, "http://127.0.0.1/refunds"),
    });
    expect(only(looped).bindings[0]?.reason).toBe("private_address");
    // Nothing refused: the shortener grounds in the page it led to.
    const allowed = await verify(`${SAID} [1].\n\n[1]: ${SHORT}`, {
      config: config("grounded"),
      evidence: via(SHORT, BAD),
    });
    expect(only(allowed).status).toBe("met");
    // `allow` names what may be CITED: a DOI's publisher need not be on it.
    const doi = await verify(`${SAID} [1].\n\n[1]: doi:10.1234/abc`, {
      config: config("grounded", { sources: { allow: ["doi.org"] } }),
      evidence: via("https://doi.org/10.1234/abc", "https://publisher.example/article/abc"),
    });
    expect(only(doi).status).toBe("met");
  });

  test("independent: 2 counts the host that served the body, not the URL cited", async () => {
    const cfg = config("grounded", { grounded: { independent: 2 } });
    const twice = await verify(`${SAID} [1] [2].\n\n[1]: ${POLICY}\n[2]: ${SHORT}`, {
      config: cfg,
      evidence: evidenceOf([
        { id: "a", name: "WebFetch", input: { url: POLICY }, content: fetched(POLICY, `${SAID}.`) },
        {
          id: "b",
          name: "WebFetch",
          input: { url: SHORT },
          content: landed(SHORT, POLICY, `${SAID}.`),
        },
      ]),
    });
    expect(only(twice).bindings.map((b) => [b.rung, b.reason])).toEqual([
      ["grounded", "not_independent"],
      ["grounded", "not_independent"],
    ]);
    // One fetch of a DOI, cited as the DOI and as the page it resolved to.
    const PAGE = "https://publisher.example/article/abc";
    const doi = await verify(`${SAID} [1] [2].\n\n[1]: doi:10.1234/abc\n[2]: ${PAGE}`, {
      config: cfg,
      evidence: via("https://doi.org/10.1234/abc", PAGE),
    });
    expect(only(doi).status).toBe("unmet");
    expect(only(doi).bindings[0]?.reason).toBe("not_independent");
  });
});

describe("cited: a user name before the host is refused", () => {
  test("the reader would see one site and the gate ground another; no HEAD is sent", async () => {
    const EVIL = "https://evil.example/policy";
    const SAID = "The refund window is 30 days from the date of purchase";
    const evidence = evidenceOf([
      { id: "f", name: "WebFetch", input: { url: EVIL }, content: fetched(EVIL, `${SAID}.`) },
    ]);
    const heads: string[] = [];
    for (const written of [
      "https://acme.example@evil.example/policy",
      "https://reader:s3cret@evil.example/policy",
    ]) {
      const bundle = await verify(`${SAID} [1].\n\n[1]: ${written}`, {
        config: config("grounded", { sources: { resolve: "head" } }),
        evidence,
        resolveHead: async (url) => {
          heads.push(url);
          return 200;
        },
      });
      const binding = only(bundle).bindings[0];
      expect(binding).toMatchObject({ reason: "host_denied", rung: "none", origin: EVIL });
      expect(binding?.detail).toContain("the page is on evil.example");
      expect(binding?.detail).not.toContain("s3cret");
      expect(binding?.detail).not.toContain("acme.example@");
    }
    expect(heads).toEqual([]);
    const plain = await verify(`${SAID} [1].\n\n[1]: ${EVIL}`, {
      config: config("grounded"),
      evidence,
    });
    expect(only(plain).status).toBe("met");
  });
});

describe("checked: a check that repeats a claim is read by what it found", () => {
  // tool-verify's FactCrossCheck reports, verbatim, against docs/policy.md
  // saying "The refund window is 14 days from the date of purchase."
  const NOTE =
    "supported means the cited source contains the claim's words — or, for a claim in quotation marks, only the quoted span — never that the claim is true; notFound means they could not be located, never that the source disagrees";
  const report = (entry: Record<string, unknown>, verdict: string): string =>
    JSON.stringify({
      from: "claims",
      ok: verdict === "supported",
      checked: 1,
      claimsFound: 1,
      truncated: false,
      notSupported: verdict === "supported" ? 0 : 1,
      undetermined: 0,
      claims: [{ index: 0, mode: "paraphrase", cites: ["docs/policy.md"], verdict, ...entry }],
      note: NOTE,
    });
  const thirty = report(
    {
      claim: "The refund window is 30 days.",
      reason:
        '3 of 4 of the claim\'s words are in "docs/policy.md", never together; that is not a finding that it says otherwise',
      sources: [
        {
          source: "docs/policy.md",
          status: "notFound",
          coverage: 0.75,
          missing: ["30"],
          line: 1,
          excerpt: "Refunds The refund window is 14 days",
        },
      ],
    },
    "notFound",
  );
  const fourteen = report(
    {
      claim: "The refund window is 14 days.",
      reason: 'every word of the claim is in one span of "docs/policy.md"',
      foundIn: {
        source: "docs/policy.md",
        line: 1,
        excerpt: "Refunds The refund window is 14 days",
      },
      sources: [
        {
          source: "docs/policy.md",
          status: "supported",
          coverage: 1,
          line: 1,
          excerpt: "Refunds The refund window is 14 days",
        },
      ],
    },
    "supported",
  );
  const europe = report(
    {
      claim: "Refunds are processed by Acme in Europe.",
      reason: '1 of 4 of the claim\'s words are in "docs/policy.md", never together',
      sources: [
        {
          source: "docs/policy.md",
          status: "notFound",
          coverage: 0.25,
          missing: ["processed", "acme", "europe"],
          line: 1,
          excerpt: "Refunds The refund",
        },
      ],
    },
    "notFound",
  );
  const asked = (text: string) => ({ claims: [{ text, sources: ["docs/policy.md"] }] });
  const evidence = evidenceOf([
    {
      id: "toolu_30",
      name: "FactCrossCheck",
      input: asked("The refund window is 30 days."),
      content: thirty,
    },
    {
      id: "toolu_14",
      name: "FactCrossCheck",
      input: asked("The refund window is 14 days."),
      content: fourteen,
    },
    {
      id: "toolu_eu",
      name: "FactCrossCheck",
      input: asked("Refunds are processed by Acme in Europe."),
      content: europe,
    },
    {
      id: "toolu_conflict",
      name: "FactCrossCheck",
      input: asked("The refund window is 14 days."),
      content: fourteen.replaceAll('"supported"', '"polarityConflict"'),
    },
    {
      id: "toolu_norm",
      name: "NormalizeText",
      input: { text: "The refund window is 30 days.", form: "lower" },
      content: "the refund window is 30 days.",
    },
  ]);
  const allow = { execution: { allow: ["factCrossCheck", "normalizeText"], replay: false } };
  const cite = (sentence: string, id: string, level: "checked" | "grounded" = "checked") =>
    verify(`${sentence} [1].\n\n[1]: tool:${id}`, { config: config(level, allow), evidence });

  test("a FactCrossCheck that did not find the claim supported does not check it — figure or not, at checked or grounded", async () => {
    for (const level of ["checked", "grounded"] as const) {
      for (const [sentence, id, verdict] of [
        ["The refund window is 30 days", "toolu_30", "notFound"],
        ["Refunds are processed by Acme in Europe", "toolu_eu", "notFound"],
        ["The refund window is 14 days", "toolu_conflict", "polarityConflict"],
      ] as const) {
        const binding = only(await cite(sentence, id, level)).bindings[0];
        expect([level, id, binding?.reason]).toEqual([level, id, "value_absent"]);
        expect(binding?.detail).toContain(`reports this claim ${verdict}, not supported`);
      }
    }
  });

  test("a FactCrossCheck that found it supported checks it, by the source text it found", async () => {
    const binding = only(await cite("The refund window is 14 days", "toolu_14")).bindings[0];
    expect(binding).toMatchObject({ ok: true, rung: "checked" });
    expect(binding?.excerpt).toContain("refund window is 14 days");
    // Not a claim it checked.
    const other = only(
      await cite("The refund window is 14 days for gift cards bought in stores", "toolu_14"),
    ).bindings[0];
    expect(other?.reason).toBe("value_absent");
    expect(other?.detail).toContain("reports no check of this claim");
  });

  test("a FactCrossCheck that found the claim only in the run's own state checks nothing", async () => {
    // FactCrossCheck reads any workspace path: over the session log it finds
    // the model's own earlier sentence, verbatim, and reports it supported.
    const log = ".crewhaus/sessions/sess_00000000000000fc.jsonl";
    mkdirSync(join(workspace, ".crewhaus", "sessions"), { recursive: true });
    const said = "the refund window is 30 days from the date of purchase";
    writeFileSync(
      join(workspace, log),
      `${JSON.stringify({ kind: "assistant_message", payload: { text: `Noting: ${said}.` } })}\n`,
    );
    const found = { source: log, line: 1, excerpt: said };
    const fromLog = report(
      {
        claim: "The refund window is 30 days from the date of purchase.",
        reason: `every word of the claim is in one span of "${log}"`,
        foundIn: found,
        sources: [{ ...found, status: "supported", coverage: 1 }],
      },
      "supported",
    );
    for (const source of [log, ".crewhaus/sessions/sess_00000000000000ff.jsonl"]) {
      const evidence = evidenceOf(
        [
          {
            id: "toolu_fcc",
            name: "FactCrossCheck",
            input: asked("The refund window is 30 days from the date of purchase."),
            content: fromLog.replaceAll(log, source),
          },
        ],
        workspace,
      );
      for (const level of ["checked", "grounded"] as const) {
        const bundle = await verify(
          "The refund window is 30 days from the date of purchase [1].\n\n[1]: tool:toolu_fcc",
          { config: config(level, allow), evidence },
        );
        const binding = only(bundle).bindings[0];
        expect([source, level, binding?.ok, binding?.reason]).toEqual([
          source,
          level,
          false,
          "value_absent",
        ]);
        expect(binding?.detail).toContain("the harness's own state");
      }
    }
  });

  test("a FactCrossCheck whose excerpt was clipped is checked against the span in its source", async () => {
    // The excerpt stops at 240 characters, short of the figure; the claim is
    // located again in the file the tool read.
    const policy =
      "Returns.\n\nThe refund window, which applies to every purchase made in our online store, in any of our retail locations across the country, and through the authorised resellers listed on our partners page, provided that the item is unused and still in its original packaging with all of its tags attached, is 30 days.\n";
    writeFileSync(join(workspace, "docs", "long-policy.md"), policy);
    const clipped =
      "refund window, which applies to every purchase made in our online store, in any of our retail locations across the country, and through the authorised resellers listed on our partners page, provided that the item is unused and still in its\u2026";
    const found = { source: "docs/long-policy.md", line: 3, excerpt: clipped };
    const content = report(
      {
        claim: "The refund window is 30 days.",
        reason: 'every word of the claim is in one span of "docs/long-policy.md"',
        foundIn: found,
        sources: [{ ...found, status: "supported", coverage: 1 }],
      },
      "supported",
    );
    const evidence = evidenceOf(
      [
        {
          id: "toolu_long",
          name: "FactCrossCheck",
          input: asked("The refund window is 30 days."),
          content,
        },
      ],
      workspace,
    );
    const met = await verify("The refund window is 30 days [1].\n\n[1]: tool:toolu_long", {
      config: config("checked", allow),
      evidence,
    });
    expect(only(met).status).toBe("met");
    // A wrong figure is still absent from the span.
    const wrong = await verify("The refund window is 90 days [1].\n\n[1]: tool:toolu_long", {
      config: config("checked", allow),
      evidence,
    });
    expect(only(wrong).status).toBe("unmet");
  });

  test("a tool that hands a figure claim back checks nothing", async () => {
    const binding = only(await cite("The refund window is 30 days", "toolu_norm")).bindings[0];
    expect(binding?.reason).toBe("value_absent");
    expect(binding?.detail).toContain("hands the call's own input back");
  });

  test("a value selected from a document the call was handed still checks a claim about it", async () => {
    // JsonQuery and RegexExtract on the default all-compute allowlist,
    // their real outputs: a bare value is the tool's answer, and the
    // document it came from is not the claim handed over.
    const selected = evidenceOf([
      {
        id: "toolu_jq",
        name: "JsonQuery",
        input: {
          json: '{"account":{"id":7,"status":"suspended"}}',
          path: "$.account.status",
          valuesOnly: true,
        },
        content: '{"count":1,"truncated":false,"values":["suspended"]}',
      },
      {
        id: "toolu_rx",
        name: "RegexExtract",
        input: {
          text: "2024-05-01 deploy service=billing status=failed reason=timeout",
          pattern: "reason=(\\w+)",
          valuesOnly: true,
        },
        content: '{"count":1,"truncated":false,"values":["reason=timeout"]}',
      },
      {
        id: "toolu_rm",
        name: "RegexExtract",
        input: { text: "Account 7 status: suspended. Owner: Max.", pattern: "status: (\\w+)" },
        content:
          '{"count":1,"truncated":false,"matches":[{"match":"status: suspended","index":10,"line":1,"column":11,"groups":{},"captures":["suspended"]}]}',
      },
    ]);
    const extract = { execution: { allow: ["jsonQuery", "regexExtract"], replay: false } };
    for (const [sentence, id] of [
      ["The account is suspended", "toolu_jq"],
      ["The billing deploy failed with reason timeout", "toolu_rx"],
      ["The account is suspended", "toolu_rm"],
    ] as const) {
      const bundle = await verify(`${sentence} [1].\n\n[1]: tool:${id}`, {
        config: config("checked", extract),
        evidence: selected,
      });
      expect([id, only(bundle).status, only(bundle).bindings[0]?.detail]).toEqual([
        id,
        "met",
        undefined,
      ]);
    }
  });
});

describe("proven: a frame that negates the proved statement", () => {
  test("'it is not true that …' states the opposite of what was proved", async () => {
    const proved = "No two of the three meetings overlap.";
    for (const sentence of [
      "It is not true that no two of the three meetings overlap",
      "It is not the case that no two of the three meetings overlap",
      "It's not true that no two of the three meetings overlap",
      "It isn't the case that no two of the three meetings overlap",
      "It is false that no two of the three meetings overlap",
      // Other words for false, and the frame put after its clause.
      "It is incorrect that no two of the three meetings overlap",
      "It is wrong that no two of the three meetings overlap",
      "It is not correct that no two of the three meetings overlap",
      "That no two of the three meetings overlap is false",
      "That no two of the three meetings overlap is not true",
      "That no two of the three meetings overlap is not the case",
      "Not true: no two of the three meetings overlap",
    ]) {
      expect([sentence, statementMismatch(proved, sentence, 0.8)]).toEqual([
        sentence,
        "this sentence is negated and the proof's claim is not — it states the opposite",
      ]);
    }
    expect(
      statementMismatch(
        "The invoice total is 1,284.50 EUR.",
        "It is not true that the invoice total is 1,284.50 EUR",
        0.8,
      ),
    ).toContain("states the opposite");
    // Two frames cancel; "it is true that" is none.
    for (const sentence of [
      "It is not true that it is not true that no two of the three meetings overlap",
      "It is true that no two of the three meetings overlap",
      "No two of the three meetings overlap",
    ]) {
      expect([sentence, statementMismatch(proved, sentence, 0.8)]).toEqual([sentence, undefined]);
    }
    // Through the gate, at the proven floor.
    const accepted = artifact({ id: "prf_00000000000000f1", claim: proved });
    const bundle = await verify(
      "It is not true that no two of the three meetings overlap [1].\n\n[1]: proof:prf_00000000000000f1",
      {
        config: config("proven"),
        evidence: checkedBy([accepted]),
        artifacts: memoryArtifacts([accepted]),
      },
    );
    expect(only(bundle).bindings[0]?.reason).toBe("claim_mismatch");
  });
});

describe("bounded work: the HEADs an answer asks for", () => {
  test("are collected in time linear in the URLs it cites", async () => {
    const timed = async (n: number): Promise<number> => {
      const text = [
        Array.from({ length: n }, (_, i) => `Fact ${i} is here [${i + 1}].`).join(" "),
        "",
        ...Array.from({ length: n }, (_, i) => `[${i + 1}]: https://s${i}.example/t`),
      ].join("\n");
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 2; i++) {
        let sent = 0;
        const t = performance.now();
        const bundle = await verify(text, {
          config: config("cited", { sources: { resolve: "head" } }),
          resolveHead: async () => {
            sent += 1;
            return 200;
          },
        });
        best = Math.min(best, performance.now() - t);
        expect([sent, bundle.met]).toEqual([MAX_HEAD_REQUESTS, MAX_HEAD_REQUESTS]);
      }
      return best;
    };
    const small = await timed(2_000);
    // Sixteen times the URLs: a list searched once per URL took some seventy
    // times as long (47 ms to 3.2 s); linear, about fifteen.
    expect(await timed(32_000)).toBeLessThan(small * 30 + 100);
  }, 30_000);
});

test("every UnmetReason is produced by some realistic input above", () => {
  expect(ALL_REASONS.filter((reason) => !produced.has(reason))).toEqual([]);
});
