/**
 * Tests for the pricing audit.
 *
 * Every case pins its own `now`, following `feed.test.ts`'s deliberate
 * fixed-clock convention: the suite must never go red because wall-clock time
 * passed. The wall clock is read only by the CLI entrypoint, which only the
 * scheduled workflow runs.
 *
 * The point of these tests is NOT that the audit passes today — a check that
 * has never been observed failing is not known to work. Each case mutates a
 * copy of the table and asserts the specific finding comes back.
 */
import { expect, test } from "bun:test";
import type { PricingTable } from "../packages/cost-tracker/src/index";
import { DEFAULT_PRICING } from "../packages/cost-tracker/src/index";
import {
  GOLDEN_PRICES,
  auditPricing,
  checkCoherence,
  checkFallbacks,
  checkFreshness,
  checkGolden,
  checkSunsets,
} from "./pricing-audit";

const PINNED = new Date("2026-07-31T00:00:00Z");

/** Deep-ish clone so a mutation cannot leak into the frozen default. */
function clone(t: PricingTable): PricingTable {
  return JSON.parse(JSON.stringify(t)) as PricingTable;
}

test("the committed tables pass every hermetic check", () => {
  const findings = auditPricing(PINNED, { includeFreshness: false });
  const errors = findings.filter((f) => f.severity === "error");
  expect(errors).toEqual([]);
});

test("golden catches a drifted price (the gemini-2.5-pro class of bug)", () => {
  const t = clone(DEFAULT_PRICING);
  // Exactly the real regression: output halved, input untouched, no miss.
  (t.providers.gemini as Record<string, { outputPer1M: number }>)["gemini-2.5-pro"].outputPer1M =
    5.0;
  const findings = checkGolden(t);
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0]?.severity).toBe("error");
  expect(findings[0]?.message).toContain("gemini-2.5-pro");
});

test("golden catches a model that resolves to no row at all (bills $0)", () => {
  const t = clone(DEFAULT_PRICING);
  const openai = t.providers.openai as Record<string, unknown>;
  for (const k of Object.keys(openai)) if (k.startsWith("o3")) delete openai[k];
  const findings = checkGolden(t);
  expect(findings.some((f) => f.message.includes("o3") && f.message.includes("$0"))).toBe(true);
});

test("fallback catches a removed bare-family row and the $0 next-major it causes", () => {
  const t = clone(DEFAULT_PRICING);
  const bedrock = t.providers.bedrock as Record<string, unknown>;
  // Removing every anthropic.claude-* key except the explicit ones reproduces
  // the pre-fix bedrock table, where a next-major id matched nothing.
  bedrock["anthropic.claude-opus"] = undefined;
  bedrock["anthropic.claude-haiku"] = undefined;
  const findings = checkFallbacks(t);
  expect(findings.some((f) => f.message.includes("anthropic.claude-opus"))).toBe(true);
  expect(findings.every((f) => f.severity === "error")).toBe(true);
});

test("coherence catches a capabilities key with no resolvable price", () => {
  const t = clone(DEFAULT_PRICING);
  const bedrock = t.providers.bedrock as Record<string, unknown>;
  bedrock["meta.llama3-1-70b"] = undefined;
  bedrock["meta.llama3-1-8b"] = undefined;
  const findings = checkCoherence(t);
  expect(findings.some((f) => f.message.includes("meta.llama3-1"))).toBe(true);
});

test("sunset errors when a migration target itself has no price", () => {
  const t = clone(DEFAULT_PRICING);
  const anthropic = t.providers.anthropic as Record<string, unknown>;
  for (const k of Object.keys(anthropic)) if (k.startsWith("claude-haiku")) delete anthropic[k];
  const findings = checkSunsets(PINNED, t);
  expect(
    findings.some((f) => f.severity === "error" && f.message.includes("claude-haiku-4-5")),
  ).toBe(true);
});

test("sunset only WARNS on a retired model that keeps its row", () => {
  // Retired-but-priced is intended: historical audit-log re-aggregation must
  // still resolve. It must never fail the build.
  const findings = checkSunsets(PINNED).filter((f) => f.message.includes("retired"));
  expect(findings.length).toBeGreaterThan(0);
  expect(findings.every((f) => f.severity === "warn")).toBe(true);
});

test("freshness is clean at the stamp date and errors once past the threshold", () => {
  const stamped = new Date(`${DEFAULT_PRICING.version}T00:00:00Z`);
  expect(checkFreshness(stamped, 120)).toEqual([]);

  const wayLater = new Date(stamped.getTime() + 200 * 86_400_000);
  const stale = checkFreshness(wayLater, 120);
  expect(stale.length).toBe(1);
  expect(stale[0]?.severity).toBe("error");
});

test("freshness warns in the band between half-life and the threshold", () => {
  const stamped = new Date(`${DEFAULT_PRICING.version}T00:00:00Z`);
  const midlife = new Date(stamped.getTime() + 80 * 86_400_000);
  const findings = checkFreshness(midlife, 120);
  expect(findings.length).toBe(1);
  expect(findings[0]?.severity).toBe("warn");
});

test("every golden id resolves in the committed table", () => {
  // Guards the goldens themselves against referencing a model the table never
  // had — a typo here would make the check silently vacuous.
  for (const g of GOLDEN_PRICES) {
    const findings = checkGolden(DEFAULT_PRICING).filter((f) => f.message.includes(g.modelId));
    expect(findings).toEqual([]);
  }
});
