/**
 * The model walk lists the justification judge's model when the spec names
 * none: the consumer's default. `@crewhaus/ir` cannot import the judge
 * package, so it keeps a copy, and this pins the two together.
 */
import { expect, test } from "bun:test";
import { JUSTIFICATION_JUDGE_DEFAULT_MODEL } from "@crewhaus/ir/slots";
import { DEFAULT_JUSTIFICATION_JUDGE_MODEL } from "@crewhaus/justification-judge-claude";

test("the walk's justification judge default is the judge package's", () => {
  expect(JUSTIFICATION_JUDGE_DEFAULT_MODEL).toBe(DEFAULT_JUSTIFICATION_JUDGE_MODEL);
});
