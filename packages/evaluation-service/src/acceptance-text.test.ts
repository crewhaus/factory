/**
 * Acceptance A, B and C with the claim hidden from a reader that was too
 * literal (the review's I1 and I2), through the live loop: a cited figure
 * joined to a follow-up question, or written as a heading, was served at
 * every rung with "0/0 claims (no claims to prove)". Under `halt` each must
 * stop the run (design §0: un-servable even when the model misbehaves).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RunFailedError } from "@crewhaus/errors";
import { moneyAdd } from "@crewhaus/tool-math";
import { defaultProvabilityConfig } from "@crewhaus/tool-proof";
import { config, tempDirs } from "./__fixtures__/helpers";
import { URL_A, runTurn, scriptedModel, webFetch } from "./__fixtures__/loop";
import { wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** One answer, under `halt` at `level`: the run's result, or what stopped it. */
async function answer(
  level: "cited" | "grounded" | "checked" | "proven",
  text: string,
): Promise<{ readonly result?: string; readonly caught?: unknown; readonly calls: number }> {
  const cwd = dirs.make();
  const sessionRootDir = join(cwd, ".crewhaus", "sessions");
  const allow = defaultProvabilityConfig().execution.allow;
  const gates = await wireEvaluation(
    {
      specName: "support-bot",
      primaryModel: "test-model",
      provability: config(level, { onFail: "halt", execution: { allow } }),
    },
    { cwd, sessionRootDir, footerTarget: "reply", catalog: [webFetch, moneyAdd] },
  );
  const model = scriptedModel([[{ type: "text", text }]]);
  try {
    const run = await runTurn({ model, tools: [webFetch, moneyAdd], gates, sessionRootDir });
    return { result: run.result, calls: model.calls() };
  } catch (caught) {
    return { caught, calls: model.calls() };
  }
}

const halted = (run: { readonly result?: string; readonly caught?: unknown }): void => {
  expect(run.result).toBeUndefined();
  expect(run.caught).toBeInstanceOf(RunFailedError);
  expect((run.caught as RunFailedError).report.class).toBe("provability");
};

describe("A and B joined to a follow-up question are not served (the review's I1)", () => {
  const nbsp = String.fromCharCode(0xa0);
  for (const level of ["cited", "grounded", "checked", "proven"] as const) {
    test(`a dash tag question at ${level}`, async () => {
      // Uncited, so it fails every rung once it is read at all.
      halted(await answer(level, "The refund window is 30 days — anything else I can help with?"));
    });
  }
  test("a comma tag question at grounded", async () => {
    halted(await answer("grounded", `The refund window is 30 days [1], right?\n\n[1]: ${URL_A}`));
  });
  test("a no-break space before the question at grounded", async () => {
    halted(
      await answer(
        "grounded",
        `The refund window is 30 days [1].${nbsp}Anything else?\n\n[1]: ${URL_A}`,
      ),
    );
  });
  test("a semicolon before the question at checked", async () => {
    halted(await answer("checked", "The invoice total is 1,284.60; want me to send the PDF?"));
  });
});

describe("A, B and C written as a heading are not served (the review's I2)", () => {
  test("A: an ATX heading citing the page, and a setext one", async () => {
    halted(await answer("grounded", `## The refund window is 30 days [1]\n\n[1]: ${URL_A}`));
    halted(await answer("grounded", "The refund window is 30 days\n---"));
  });
  test("B: the total as a labelled heading", async () => {
    halted(await answer("checked", "## Invoice total: 1,284.50"));
  });
  test("C: the overlap claim as a heading", async () => {
    halted(await answer("proven", "### No two of the six meetings overlap"));
  });
});

describe("A, B and C as a heading with a follow-up question are not served (I2)", () => {
  // The question after the heading hid it from the rule for an answer of
  // nothing but headings: each was served "✓ · 0/0 claims".
  test("C: the overlap heading, then an offer", async () => {
    halted(
      await answer(
        "proven",
        "### No two of the six meetings overlap\n\nWant me to send the invites?",
      ),
    );
  });
  test("B: the total heading, then a question", async () => {
    halted(await answer("checked", "## The invoice total is 1,284.60\n\nShould I email it?"));
    halted(await answer("checked", "## Invoice total: 1,284.60\n\nWant me to send the PDF?"));
  });
  test("A: an ATX and a setext heading, then a question", async () => {
    halted(await answer("grounded", "## The refund window is 30 days\n\nAnything else?"));
    halted(
      await answer("grounded", "The refund window is 30 days\n---\n\nWant me to send the link?"),
    );
    halted(
      await answer(
        "grounded",
        `## The refund window is 30 days [1]\n\nWant me to send the link?\n\n[1]: ${URL_A}`,
      ),
    );
  });
  test("a clarifying question after a title still has nothing to prove", async () => {
    const run = await answer("grounded", "## Refund options for 2024\n\nWhich option do you want?");
    expect(run.caught).toBeUndefined();
    expect(run.result).toContain("0/0");
  });
});
