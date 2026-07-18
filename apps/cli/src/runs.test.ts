import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { RunsError, isRunsSessionId, resolveRunsResumeSpecPath } from "./runs";

describe("isRunsSessionId", () => {
  test("accepts sess_<16 hex>, rejects everything else", () => {
    expect(isRunsSessionId("sess_0123456789abcdef")).toBe(true);
    expect(isRunsSessionId("sess_0123456789ABCDEF")).toBe(false); // uppercase hex not allowed
    expect(isRunsSessionId("sess_012")).toBe(false);
    expect(isRunsSessionId("0123456789abcdef")).toBe(false);
    expect(isRunsSessionId("")).toBe(false);
  });
});

describe("resolveRunsResumeSpecPath", () => {
  const cwd = "/harness";

  test("returns the absolute --spec when it exists", () => {
    const exists = (p: string) => p === "/harness/agent.yaml";
    expect(resolveRunsResumeSpecPath("agent.yaml", cwd, exists)).toBe("/harness/agent.yaml");
    expect(isAbsolute(resolveRunsResumeSpecPath("agent.yaml", cwd, exists))).toBe(true);
  });

  test("keeps an absolute --spec as-is", () => {
    const exists = (p: string) => p === "/other/spec.yaml";
    expect(resolveRunsResumeSpecPath("/other/spec.yaml", cwd, exists)).toBe("/other/spec.yaml");
  });

  test("throws RunsError naming the missing --spec", () => {
    const exists = () => false;
    expect(() => resolveRunsResumeSpecPath("missing.yaml", cwd, exists)).toThrow(RunsError);
    try {
      resolveRunsResumeSpecPath("missing.yaml", cwd, exists);
    } catch (err) {
      expect((err as Error).message).toContain("--spec not found");
      expect((err as Error).message).toContain("/harness/missing.yaml");
    }
  });

  test("falls back to cwd/crewhaus.yaml when no --spec is given", () => {
    const exists = (p: string) => p === join(cwd, "crewhaus.yaml");
    expect(resolveRunsResumeSpecPath(undefined, cwd, exists)).toBe(join(cwd, "crewhaus.yaml"));
  });

  test("throws RunsError when neither --spec nor the fallback exists", () => {
    const exists = () => false;
    expect(() => resolveRunsResumeSpecPath(undefined, cwd, exists)).toThrow(RunsError);
    try {
      resolveRunsResumeSpecPath(undefined, cwd, exists);
    } catch (err) {
      expect((err as Error).message).toContain("no --spec given");
      expect((err as Error).message).toContain(cwd);
    }
  });
});
