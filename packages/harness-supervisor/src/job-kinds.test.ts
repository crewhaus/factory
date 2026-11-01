/**
 * The job vocabulary — the boundary where a request turns into a command
 * line, and so the one place a mistake becomes an injection.
 */
import { describe, expect, test } from "bun:test";
import { JOB_KINDS, JobArgumentError, isJobKind, jobArgv } from "./job-kinds";

describe("job kinds", () => {
  test("the four kinds, and nothing else, are jobs", () => {
    expect([...JOB_KINDS]).toEqual(["doctor", "compile", "eval", "dream-run"]);
    for (const kind of JOB_KINDS) expect(isJobKind(kind)).toBe(true);
    for (const other of ["run", "optimize", "Doctor", "", "eval "]) {
      expect(`${other}:${isJobKind(other)}`).toBe(`${other}:false`);
    }
  });
});

describe("jobArgv", () => {
  test("each kind maps to a fixed command line", () => {
    expect(jobArgv("doctor")).toEqual(["doctor"]);
    expect(jobArgv("compile")).toEqual(["compile", "crewhaus.yaml", "-o", "dist"]);
    expect(jobArgv("dream-run")).toEqual(["dream", "run", "crewhaus.yaml"]);
    expect(jobArgv("eval")).toEqual(["eval", "crewhaus.yaml"]);
  });

  test("eval carries a dataset and a graders file, shape-checked, in that order", () => {
    expect(jobArgv("eval", { dataset: "smoke", graders: "graders.yaml" })).toEqual([
      "eval",
      "crewhaus.yaml",
      "--dataset",
      "smoke",
      "--graders",
      "graders.yaml",
    ]);
    // A harness-relative path of plain segments is fine.
    expect(jobArgv("eval", { dataset: "datasets/smoke@2.jsonl" })).toEqual([
      "eval",
      "crewhaus.yaml",
      "--dataset",
      "datasets/smoke@2.jsonl",
    ]);
  });

  test("options mean nothing to the kinds that take none", () => {
    expect(jobArgv("doctor", { dataset: "../x", graders: "-x" })).toEqual(["doctor"]);
  });

  test("an argument can never become a parent path, a flag or an absolute path", () => {
    for (const bad of [
      "../x",
      "a/../../x",
      "-x",
      "--write-back",
      "/etc/passwd",
      "a b",
      "a;b",
      "",
    ]) {
      for (const field of ["dataset", "graders"] as const) {
        let caught: unknown;
        try {
          jobArgv("eval", { [field]: bad });
        } catch (err) {
          caught = err;
        }
        expect(`${field}=${bad}:${caught instanceof JobArgumentError}`).toBe(
          `${field}=${bad}:true`,
        );
        // The refusal says which field, and quotes what it refused.
        expect((caught as Error).message).toContain(`job eval: "${field}"`);
        expect((caught as Error).message).toContain(JSON.stringify(bad));
      }
    }
  });
});
