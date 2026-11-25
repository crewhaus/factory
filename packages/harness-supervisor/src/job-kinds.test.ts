/**
 * The job vocabulary — the boundary where a request turns into a command
 * line, and so the one place a mistake becomes an injection.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_JOB_KIND,
  JOB_KINDS,
  JobArgumentError,
  RUNS_RESUME_JOB_KIND,
  exportHarnessArgv,
  isJobKind,
  jobArgv,
  runsResumeArgv,
} from "./job-kinds";

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

describe("the harness export job", () => {
  test("runs `state backup --out` for an absolute path, and is not a kind the job route takes", () => {
    const out = join(tmpdir(), "exports", "hrn_0123456789abcdef", "01J.tar.gz");
    expect(exportHarnessArgv(out)).toEqual(["state", "backup", "--out", out]);
    expect(isJobKind(EXPORT_JOB_KIND)).toBe(false);
    expect((JOB_KINDS as readonly string[]).includes(EXPORT_JOB_KIND)).toBe(false);
  });

  test("refuses a relative path, an empty one, and one with a control character", () => {
    for (const bad of ["", "exports/x.tar.gz", "--out", `${join(tmpdir(), "x")}\n--force`]) {
      expect(() => exportHarnessArgv(bad)).toThrow(JobArgumentError);
    }
    expect(() => exportHarnessArgv(`${join(tmpdir(), "x")}\u001b[201~`)).toThrow("control");
  });
});

describe("the job that settles a graph run's pause", () => {
  const GRUN = "grun_0123456789abcdef";

  test("runs `runs resume` with a graph run id and one of two words, and is not a kind the job route takes", () => {
    expect(runsResumeArgv(GRUN, "approve")).toEqual([
      "runs",
      "resume",
      GRUN,
      "--decision",
      "approve",
    ]);
    expect(runsResumeArgv(GRUN, "reject").at(-1)).toBe("reject");
    expect(isJobKind(RUNS_RESUME_JOB_KIND)).toBe(false);
    expect((JOB_KINDS as readonly string[]).includes(RUNS_RESUME_JOB_KIND)).toBe(false);
    expect([...JOB_KINDS]).toEqual(["doctor", "compile", "eval", "dream-run"]);
  });

  test("refuses any other decision and any other run id", () => {
    for (const decision of ["", "Approve", "approve ", "ship it", "--force", "approve\n"]) {
      expect(() => runsResumeArgv(GRUN, decision)).toThrow(JobArgumentError);
      expect(() => runsResumeArgv(GRUN, decision)).toThrow("approve or reject");
    }
    for (const grun of ["", "grun_x", "run_0123456789abcdef", `${GRUN};id`, "--decision"]) {
      expect(() => runsResumeArgv(grun, "approve")).toThrow(JobArgumentError);
      expect(() => runsResumeArgv(grun, "approve")).toThrow("graph run id");
    }
  });
});
