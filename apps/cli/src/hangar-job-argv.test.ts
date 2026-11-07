/**
 * What the console queues has to survive the CLI that will run it. The argv
 * builders are checked against the real flag schemas, so a flag the console
 * spells wrong, or a value it leaves off, fails here rather than in a job.
 */
import { describe, expect, test } from "bun:test";
import {
  EVAL_JOB_ARGV,
  type LaunchOffers,
  OPTIMIZE_JOB_ARGV,
  evalArgv,
  flywheelArgv,
  optimizeArgv,
  sentinelArgv,
} from "@crewhaus/hangar-server/eval-inputs";
import { parseArgs } from "@crewhaus/infra-utils";
import { assertFromAdviceFlagsCompatible } from "./advice-apply";
import { EVAL_SCHEMA, FLYWHEEL_SCHEMA, OPTIMIZE_SCHEMA } from "./arg-schemas";

const ready = { offered: true, shapeOk: true, note: null, verb: "crewhaus x" };
const OFFERS: LaunchOffers = {
  eval: ready,
  optimize: ready,
  flywheel: ready,
  conventional: { dataset: true, graders: true },
};

const hasInputs = (flags: Record<string, unknown>): void => {
  expect(typeof flags["dataset"]).toBe("string");
  expect(typeof flags["graders"]).toBe("string");
};

/** The verb is the first argv element; `parseArgs` reads what follows it. */
const parse = (schema: typeof EVAL_SCHEMA, argv: readonly string[]) =>
  parseArgs(argv.slice(1), schema);

describe("the argv the console queues parses under the real schemas", () => {
  test("the closed vocabulary", () => {
    hasInputs(parse(EVAL_SCHEMA, EVAL_JOB_ARGV).flags);
    hasInputs(parse(OPTIMIZE_SCHEMA, OPTIMIZE_JOB_ARGV).flags);
  });

  test("an eval, with every flag the launcher can send", () => {
    const { argv } = evalArgv(
      {
        slice: "easy",
        repeats: 2,
        seed: 7,
        budgetUsd: 1.5,
        maxCostUsd: 2,
        gate: true,
        allowTestSplit: true,
        releaseConfirm: true,
      },
      OFFERS,
    );
    const { flags, positional } = parse(EVAL_SCHEMA, argv);
    hasInputs(flags);
    expect(positional).toEqual(["crewhaus.yaml"]);
    expect(flags["gate"]).toBe(true);
    expect(flags["allow-test-split"]).toBe(true);
  });

  test("a resume, which takes a path", () => {
    const { argv } = evalArgv({ resume: "run_00000000000000aa" }, OFFERS);
    const { flags } = parse(EVAL_SCHEMA, argv);
    hasInputs(flags);
    expect(flags["resume"]).toBe(".crewhaus/evals/run_00000000000000aa");
  });

  test("an optimize", () => {
    const { argv } = optimizeArgv({ mutator: "rule-based", budgetUsd: 1, concurrency: 2 }, OFFERS);
    const { flags } = parse(OPTIMIZE_SCHEMA, argv);
    hasInputs(flags);
    expect(flags["mutator"]).toBe("rule-based");
  });

  test("applying saved suggestions, which the CLI will not take with a mutator", () => {
    const { argv } = optimizeArgv({ fromAdvice: true }, OFFERS);
    const { flags } = parse(OPTIMIZE_SCHEMA, argv);
    hasInputs(flags);
    expect(flags["from-advice"]).toBe("suggestions.json");
    expect(() =>
      assertFromAdviceFlagsCompatible({
        mutator: typeof flags["mutator"] === "string",
        iterations: typeof flags["iterations"] === "string",
        stage: typeof flags["stage"] === "string",
      }),
    ).not.toThrow();
  });

  test("the sentinel, whose inputs eval asks for first", () => {
    const { argv } = sentinelArgv({}, OFFERS);
    const { flags } = parse(EVAL_SCHEMA, argv);
    hasInputs(flags);
    expect(flags["sentinel"]).toBe(true);
    expect(flags["baseline"]).toBe("eval/sentinel-baseline");
  });

  test("the flywheel, which resolves its own inputs and is given none", () => {
    const { argv } = flywheelArgv({ budgetUsd: 1, iterations: 2 }, OFFERS);
    expect(argv.slice(0, 2)).toEqual(["flywheel", "run"]);
    const { flags } = parseArgs(argv.slice(2), FLYWHEEL_SCHEMA);
    expect(flags["dataset"]).toBeUndefined();
    expect(flags["graders"]).toBeUndefined();
    expect(flags["iterations"]).toBe("2");
  });
});
