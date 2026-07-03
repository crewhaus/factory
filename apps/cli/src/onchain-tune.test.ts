import { describe, expect, test } from "bun:test";
import {
  OnchainTuneError,
  type ReceiptRecord,
  detectAnomalies,
  learnSpendBaseline,
  parseReceiptHistory,
  proposePolicy,
  renderSentinelReport,
  renderTuneReport,
} from "./onchain-tune";

/** Build a receipt-history JSONL from records at runtime (no fixture files). */
function jsonl(
  records: Array<{
    ts?: number;
    contractId: string;
    valueWei: string | number;
    status?: "0x1" | "0x0" | null;
    simulated?: boolean;
  }>,
): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const HISTORY = jsonl([
  { ts: 1, contractId: "usdc", valueWei: "1000", status: "0x1", simulated: true },
  { ts: 2, contractId: "usdc", valueWei: "2000", status: "0x1", simulated: true },
  { ts: 3, contractId: "weth", valueWei: "5000", status: "0x1", simulated: true },
  // a reverted send — excluded from the baseline + allowlist
  { ts: 4, contractId: "scam", valueWei: "999999", status: "0x0", simulated: true },
]);

describe("parseReceiptHistory (#66)", () => {
  test("parses valid records + BigInt wei", () => {
    const recs = parseReceiptHistory(HISTORY);
    expect(recs).toHaveLength(4);
    expect(recs[2]?.contractId).toBe("weth");
    expect(recs[2]?.valueWei).toBe(5000n);
  });

  test("rejects a record with no contractId (raw-address send)", () => {
    expect(() => parseReceiptHistory(`${JSON.stringify({ valueWei: "1" })}\n`)).toThrow(
      /missing contractId/,
    );
  });

  test("rejects a bad valueWei + bad JSON", () => {
    expect(() =>
      parseReceiptHistory(`${JSON.stringify({ contractId: "x", valueWei: "-5" })}\n`),
    ).toThrow(OnchainTuneError);
    expect(() => parseReceiptHistory("{bad\n")).toThrow(/not valid JSON/);
  });
});

describe("proposePolicy (#66)", () => {
  test("derives maxValueWei from the max successful spend + margin, allowlist from used ids", () => {
    const recs = parseReceiptHistory(HISTORY);
    const proposal = proposePolicy(recs, {}, { optimizable: true, target: "onchain" });
    // max successful spend is 5000 (weth); 5000 * 1.25 = 6250
    expect(proposal.proposedMaxValueWei).toBe("6250");
    // allowlist excludes the reverted "scam" contract
    expect(proposal.proposedAllowedContracts).toEqual(["usdc", "weth"]);
    // whitelisted target → a validated transaction_policy block is emitted
    expect(proposal.patch).toBeDefined();
    expect(proposal.patch?.path).toEqual(["transaction_policy"]);
    expect(proposal.patch?.value["maxValueWei"]).toBe("6250");
    expect(proposal.patch?.value["allowedContracts"]).toEqual(["usdc", "weth"]);
    expect(proposal.patch?.value["simulationRequired"]).toBe(true);
  });

  test("advice-only (no patch) for a non-whitelisted target", () => {
    const recs = parseReceiptHistory(HISTORY);
    const proposal = proposePolicy(recs, {}, { optimizable: false, target: "cli" });
    expect(proposal.proposedMaxValueWei).toBe("6250");
    expect(proposal.patch).toBeUndefined();
  });

  test("warns when the current cap denies observed legitimate spend", () => {
    const recs = parseReceiptHistory(HISTORY);
    const proposal = proposePolicy(
      recs,
      { maxValueWei: "3000", allowedContracts: ["usdc", "weth", "unused"] },
      { optimizable: true, target: "onchain" },
    );
    expect(proposal.warnings.join(" ")).toContain("BELOW observed legitimate spend");
    // never-used current allowlist id flagged for least-privilege removal
    expect(proposal.warnings.join(" ")).toContain("unused");
  });

  test("no successful spend → no cap + advice-only patch absent", () => {
    const recs = parseReceiptHistory(jsonl([{ contractId: "x", valueWei: "1", status: "0x0" }]));
    const proposal = proposePolicy(recs, {}, { optimizable: true, target: "onchain" });
    expect(proposal.proposedMaxValueWei).toBeUndefined();
    expect(proposal.patch).toBeUndefined();
    expect(renderTuneReport(proposal)).toContain("no successful spend");
  });

  test("honors a custom cap margin", () => {
    const recs = parseReceiptHistory(HISTORY);
    const proposal = proposePolicy(
      recs,
      {},
      { optimizable: true, target: "onchain", capMarginPct: 2 },
    );
    expect(proposal.proposedMaxValueWei).toBe("10000"); // 5000 * 2
  });

  test("rejects a margin <= 1", () => {
    const recs = parseReceiptHistory(HISTORY);
    expect(() =>
      proposePolicy(recs, {}, { optimizable: true, target: "onchain", capMarginPct: 1 }),
    ).toThrow(/capMarginPct must be > 1/);
  });
});

describe("learnSpendBaseline + detectAnomalies (#66)", () => {
  test("learns per-contract max/mean from successful sends only", () => {
    const recs = parseReceiptHistory(HISTORY);
    const baseline = learnSpendBaseline(recs);
    expect(baseline.perContract["usdc"]?.maxWei).toBe(2000n);
    expect(baseline.perContract["usdc"]?.meanWei).toBe(1500n); // (1000+2000)/2
    expect(baseline.globalMaxWei).toBe(5000n);
    // the reverted scam contract never enters the baseline
    expect(baseline.perContract["scam"]).toBeUndefined();
  });

  test("flags a spend > N× the per-contract max", () => {
    const baseline = learnSpendBaseline(parseReceiptHistory(HISTORY));
    const candidate: ReceiptRecord[] = parseReceiptHistory(
      jsonl([
        { ts: 10, contractId: "usdc", valueWei: "10000", status: "0x1" }, // 5× > 2× max 2000
        { ts: 11, contractId: "usdc", valueWei: "1500", status: "0x1" }, // within 2×
      ]),
    );
    const anomalies = detectAnomalies(candidate, baseline, { maxMultiple: 2 });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.contractId).toBe("usdc");
    expect(anomalies[0]?.reason).toContain("exceeds 2×");
  });

  test("flags a send to a contract id never in the baseline", () => {
    const baseline = learnSpendBaseline(parseReceiptHistory(HISTORY));
    const candidate = parseReceiptHistory(
      jsonl([{ ts: 20, contractId: "rugpull", valueWei: "1", status: "0x1" }]),
    );
    const anomalies = detectAnomalies(candidate, baseline);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.reason).toContain("never seen in the learned baseline");
    expect(renderSentinelReport(anomalies)).toContain("ANOMALY rugpull");
  });

  test("no anomalies → clean report", () => {
    const baseline = learnSpendBaseline(parseReceiptHistory(HISTORY));
    const candidate = parseReceiptHistory(
      jsonl([{ ts: 30, contractId: "usdc", valueWei: "1500", status: "0x1" }]),
    );
    expect(detectAnomalies(candidate, baseline)).toHaveLength(0);
    expect(renderSentinelReport([])).toContain("no anomalies");
  });
});
