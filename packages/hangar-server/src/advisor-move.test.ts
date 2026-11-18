/**
 * The Advisor's pure half lives in `@crewhaus/harness-advice/advisor`; this server keeps
 * gathering, the ledger file and the job vocabulary. The two id grammars are one, and the
 * server's own types still fit the moved structural ones.
 */
import { expect, test } from "bun:test";
import {
  SAFE_SEGMENT_RE as ADVICE_SAFE_SEGMENT_RE,
  type AdvisorEvalHealthState,
  type AdvisorLaunchOffer,
  type AdvisorPreflightItem,
} from "@crewhaus/harness-advice/advisor";
import { ADVISOR_CLI_TWINS, ADVISOR_JOB_ARGV } from "./advisor";
import { SAFE_SEGMENT_RE } from "./constants";
import type { LaunchOffer } from "./eval-inputs";
import type { EvalHealthState } from "./evals";
import type { HealthPreflightItem } from "./health";

/** Compile-time: each server type is assignable to the structural type the ranking reads. */
type Assignable<A, B> = A extends B ? true : false;
const TYPE_CHECKS: [
  Assignable<HealthPreflightItem, AdvisorPreflightItem>,
  Assignable<EvalHealthState, AdvisorEvalHealthState>,
  Assignable<AdvisorEvalHealthState, EvalHealthState>,
  Assignable<LaunchOffer, AdvisorLaunchOffer>,
] = [true, true, true, true];

test("the server's types fit the moved structural types", () => {
  expect(TYPE_CHECKS).toEqual([true, true, true, true]);
});

test("the item-id grammar is the server's own", () => {
  expect(ADVICE_SAFE_SEGMENT_RE.source).toBe(SAFE_SEGMENT_RE.source);
  expect(ADVICE_SAFE_SEGMENT_RE.flags).toBe(SAFE_SEGMENT_RE.flags);
});

test("every job kind has its command, and the vocabulary stays here", () => {
  expect(Object.keys(ADVISOR_CLI_TWINS).sort()).toEqual(Object.keys(ADVISOR_JOB_ARGV).sort());
});
