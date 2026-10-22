import { describe, expect, test } from "bun:test";
import { buildEvidenceIndex } from "./evidence";
import { renderBundleJson, renderFooter, renderMarkdownSection, renderNudge } from "./render";
import { summarizeBundle } from "./summary";
import { artifact, config, evidenceOf, fetched, memoryArtifacts, now } from "./test-helpers";
import type { ProofBundle } from "./types";
import { unverifiedBundle, verifyDocument } from "./verify";

const POLICY = "https://acme.example/policy";
/** Page text that must never reach the model through the nudge. */
const PAGE = "Refunds are accepted within 14 days of delivery for every order placed online.";

const evidence = evidenceOf([
  { id: "f1", name: "WebFetch", input: { url: POLICY }, content: fetched(POLICY, PAGE) },
  {
    id: "f2",
    name: "WebFetch",
    input: { url: "https://acme.example/ship" },
    content: "Shipping is free over 50 dollars.",
  },
  {
    id: "f3",
    name: "WebFetch",
    input: { url: "https://acme.example/hours" },
    content: "Support answers within one hour.",
  },
  { id: "sum", name: "MoneyAdd", input: {}, content: '{"amount":"1284.50"}' },
]);

async function bundleFor(text: string, level = config("grounded")): Promise<ProofBundle> {
  return verifyDocument(text, {
    config: level,
    evidence,
    now,
    artifacts: memoryArtifacts([
      artifact({ id: "prf_0123456789abcdef", statement: "∀ i≠j. disjoint(m_i, m_j)" }),
    ]),
  });
}

const passing = [
  "Refunds are accepted within 14 days of delivery [1].",
  "Shipping is free over 50 dollars [2].",
  "Support answers within one hour [3].",
  "",
  `[1]: ${POLICY}`,
  "[2]: https://acme.example/ship",
  "[3]: https://acme.example/hours",
].join("\n");

const failing = [
  "The refund window is 30 days [1].",
  "Shipping is free over 50 dollars [2].",
  "Support answers within one hour [3].",
  "Returns are accepted at every store in the country.",
  "The fiscal year starts in April [A1].",
  "",
  `[1]: ${POLICY}`,
  "[2]: https://acme.example/ship",
  "[3]: https://acme.example/never-read",
  "[A1]: assume: the fiscal year starts in April",
].join("\n");

describe("renderFooter — design §5.4's exact shapes", () => {
  test("pass", async () => {
    const bundle = await bundleFor(passing);
    expect(
      renderFooter(bundle, {
        path: ".crewhaus/proofs/support-bot/sess_0000000000000001/turn-7.json",
      }),
    ).toBe(
      "── provability · grounded ✓ · 3/3 claims · 3 sources · 0 assumptions · .crewhaus/proofs/support-bot/sess_0000000000000001/turn-7.json",
    );
    expect(renderFooter(bundle)).toBe(
      "── provability · grounded ✓ · 3/3 claims · 3 sources · 0 assumptions",
    );
  });

  test("fail: the unmet claims' markers, then the uncited count", async () => {
    const bundle = await bundleFor(failing);
    expect(renderFooter(bundle)).toBe(
      "── provability · grounded ✗ · 1/4 claims · unmet: [1] [3] +1 uncited · 1 source · 1 assumption",
    );
  });

  test("an allowed assumption beside failing evidence is not listed as unmet", async () => {
    const bundle = await bundleFor(
      `The refund window is 30 days [1] [A1].\n\n[1]: ${POLICY}\n[A1]: assume: refunds are counted in days`,
    );
    expect(renderFooter(bundle)).toBe(
      "── provability · grounded ✗ · 0/1 claim · unmet: [1] · 0 sources · 0 assumptions",
    );
  });

  test("refused assumptions are counted beside the accepted ones", async () => {
    const bundle = await bundleFor(
      "Shipping is free over 50 dollars [2]. The fiscal year starts in April [A1]. Costs are stable this year [A2].\n\n[2]: https://acme.example/ship\n[A1]: assume: April\n[A2]: assume: stable",
      config("grounded", { maxAssumptions: 1, threshold: 0.5 }),
    );
    expect(renderFooter(bundle)).toBe(
      "── provability · grounded ✗ · 1/2 claims · unmet: [A2] · 1 source · 2 assumptions (1 refused)",
    );
    expect(renderMarkdownSection(bundle)).toContain(
      "**Assumptions (2, 1 refused):**\n- [A1] April\n- [A2] stable (assumption forbidden)",
    );
    const nudge = renderNudge(bundle);
    expect(nudge).toContain("1 declared assumption was refused");
    expect(nudge).toContain('"Costs are stable this year."');
    expect(summarizeBundle(bundle)).toMatchObject({ assumptions: 1, assumptionsRefused: 1 });
  });

  test("unverified", () => {
    expect(
      renderFooter(unverifiedBundle(config("grounded"), new Error("sandbox\nunreachable"), 0, now)),
    ).toBe("── provability · grounded ? unverified — sandbox unreachable");
  });

  test("vacuous and only-uncited", async () => {
    expect(renderFooter(await bundleFor("Which order do you mean?"))).toBe(
      "── provability · grounded ✓ · 0/0 claims (no claims to prove) · 0 sources · 0 assumptions",
    );
    expect(
      renderFooter(await bundleFor("Returns are accepted at every store in the country.")),
    ).toBe(
      "── provability · grounded ✗ · 0/1 claim · unmet: 1 uncited · 0 sources · 0 assumptions",
    );
  });
});

describe("renderNudge", () => {
  test("lists the model's own unmet sentences, what each cited and why — and nothing fetched", async () => {
    const bundle = await bundleFor(failing);
    const nudge = renderNudge(bundle);
    expect(nudge).toContain(
      "The provability gate did not accept your last answer. Floor: grounded.",
    );
    expect(nudge).toContain('"The refund window is 30 days."');
    expect(nudge).toContain(
      `[1] ${POLICY}: the source was read, but the claim's words are not in it together`,
    );
    expect(nudge).toContain("(missing: window, 30)");
    expect(nudge).toContain(
      "[3] https://acme.example/never-read: this run never fetched or read it",
    );
    expect(nudge).toContain('"Returns are accepted at every store in the country."');
    expect(nudge).toContain("no citation");
    expect(nudge).toContain("run ProvabilityPreflight");
    // No fetched content: not the page, not the excerpt of it, not a single distinctive word of it.
    expect(nudge).not.toContain("14 days");
    expect(nudge).not.toContain("delivery");
    expect(nudge).not.toContain("online");
    // Met claims and allowed assumptions are not nagged about.
    expect(nudge).not.toContain("Shipping");
    expect(nudge).not.toContain("fiscal");
    // ASCII except the claim text the model wrote.
    expect(nudge.replace(/"[^"\n]*"/g, "")).toMatch(/^[\x20-\x7e\n]*$/);
  });

  test("a rejected proof's counterexample is the nudge", async () => {
    const bundle = await verifyDocument(
      "No two of the six meetings overlap [1].\n\n[1]: proof:prf_aaaaaaaaaaaaaaaa",
      {
        config: config("proven"),
        evidence: buildEvidenceIndex([]),
        artifacts: memoryArtifacts([
          artifact({
            id: "prf_aaaaaaaaaaaaaaaa",
            ok: false,
            counterexample: "meetings 2 and 5 overlap at 10:30",
          }),
        ]),
      },
    );
    expect(renderNudge(bundle)).toContain("counterexample: meetings 2 and 5 overlap at 10:30");
  });

  test("is ASCII apart from the model's own words, however long the claim or the source", async () => {
    const long = `${"The quarterly revenue figures for the region ".repeat(10)}rose 12% [1].`;
    const bundle = await bundleFor(
      `${long}\n\n[1]: https://acme.example/${"x".repeat(300)}\n[2]: https://acme.example/pay — “Payments” clear within 5 days`,
    );
    const nudge = renderNudge(bundle);
    expect([...nudge].filter((ch) => ch.charCodeAt(0) > 0x7e)).toEqual([]);
    expect(nudge).toContain("...");
  });

  test("says where a claim read from a definition line sits, and how to keep a title out", async () => {
    const bundle = await bundleFor(
      `Refunds are accepted within 14 days of delivery [1].\n\n[1]: ${POLICY} Refunds are always paid in cash within two days.`,
    );
    const nudge = renderNudge(bundle);
    expect(nudge).toContain(
      '"Refunds are always paid in cash within two days." (the text after the source on your definition line [1])',
    );
    expect(nudge).toContain('put a page title in quotes ([1]: https://... "Title")');
    expect(renderMarkdownSection(bundle)).toContain("(text of definition [1])");
    // Not said when no claim came from a definition line.
    expect(renderNudge(await bundleFor(failing))).not.toContain("page title in quotes");
  });

  test("a passing and an unverified bundle say so", async () => {
    expect(renderNudge(await bundleFor(passing))).toContain("accepted your last answer");
    expect(renderNudge(unverifiedBundle(config("cited"), "x"))).toContain("could not verify");
  });
});

describe("renderMarkdownSection", () => {
  test("floor, verdict, score, a row per claim, assumptions, checkers beside their statement", async () => {
    const bundle = await bundleFor(
      `${failing}\nNo two of the six meetings overlap [P].\n\n[P]: proof:prf_0123456789abcdef`,
      config("cited"),
    );
    const md = renderMarkdownSection(bundle);
    expect(
      md.startsWith("## Provability\n\n**Floor:** `cited` · **Verdict:** fail ✗ · **Score:** "),
    ).toBe(true);
    expect(md).toContain("| # | Claim | Status | Best | Evidence |");
    expect(md).toContain("| 1 | The refund window is 30 days. | met | cited | [1] ✓ cited |");
    expect(md).toContain(
      "| 4 | Returns are accepted at every store in the country. | unmet | none | ✗ no citation |",
    );
    expect(md).toContain(
      "| 5 | The fiscal year starts in April. | assumption | none | [A1] assumption |",
    );
    expect(md).toContain("**Assumptions (1):**\n- [A1] the fiscal year starts in April");
    expect(md).toContain(
      "- `builtin` — prf_0123456789abcdef: `∀ i≠j. disjoint(m_i, m_j)` (axioms: none)",
    );
    expect(md.endsWith("\n")).toBe(true);
  });

  test("table cells escape pipes; vacuous, waived and unverified are explained", async () => {
    const piped = await bundleFor(
      "Revenue is net of refunds [A1].\n\n[A1]: assume: revenue | refunds are netted",
      config("cited"),
    );
    expect(renderMarkdownSection(piped)).toContain("- [A1] revenue \\| refunds are netted");
    expect(renderMarkdownSection(await bundleFor("Hello?"))).toContain(
      "Vacuous pass: no claims to prove.",
    );
    expect(renderMarkdownSection(unverifiedBundle(config("grounded"), "boom"))).toContain(
      "**Verdict:** unverified — boom",
    );
  });
});

test("renderBundleJson round-trips", async () => {
  const bundle = await bundleFor(passing);
  expect(JSON.parse(renderBundleJson(bundle))).toEqual(JSON.parse(JSON.stringify(bundle)));
});

test("summarizeBundle carries the trace line's fields", async () => {
  const bundle = await bundleFor(failing);
  expect(summarizeBundle(bundle)).toEqual({
    level: "grounded",
    verdict: "fail",
    score: 0.25,
    threshold: 1,
    achieved: "none",
    claims: 5,
    met: 1,
    unmet: 3,
    assumptions: 1,
    retryIndex: 0,
    bundleHash: bundle.bundleHash,
  });
  expect(summarizeBundle({ ...bundle, judgeModel: "m", spentUsdMicros: 7 })).toMatchObject({
    judgeModel: "m",
    judgeCostUsdMicros: 7,
  });
});
