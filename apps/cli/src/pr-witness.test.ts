/**
 * `--check-pr` counts only an approved proposal PR from this repository titled for the
 * exact spec and version, weighs every such PR, and a gh that fails or answers
 * nonsense is no witness.
 */
import { describe, expect, test } from "bun:test";
import { type GhSpawn, PR_WITNESS_LIMIT, readPrCheckViaGh } from "./pr-witness";

type Pr = Record<string, unknown>;

function gh(prs: Pr[] | string, status = 0): { spawn: GhSpawn; argv: string[][] } {
  const argv: string[][] = [];
  const spawn: GhSpawn = (command, args) => {
    argv.push([command, ...args]);
    return { status, stdout: typeof prs === "string" ? prs : JSON.stringify(prs) };
  };
  return { spawn, argv };
}

const GREEN = [{ conclusion: "SUCCESS" }];
const proposal = (over: Pr = {}): Pr => ({
  number: 7,
  url: "https://example.invalid/pr/7",
  headRefName: "propose/chg_abc",
  title: "propose: support 1.2.0 (optimize)",
  isCrossRepository: false,
  reviewDecision: "APPROVED",
  statusCheckRollup: GREEN,
  ...over,
});
const QUERY = { specName: "support", env: "prod", version: "1.2.0" };

describe("the proposal PR witness", () => {
  test("a green proposal PR for the spec and version witnesses it", () => {
    const { spawn, argv } = gh([proposal()]);
    expect(readPrCheckViaGh(QUERY, spawn)).toEqual({
      conclusion: "success",
      prNumber: 7,
      url: "https://example.invalid/pr/7",
    });
    const args = argv[0] ?? [];
    expect(args[0]).toBe("gh");
    expect(args[args.indexOf("--search") + 1]).toBe("head:propose/");
    const fields = (args[args.indexOf("--json") + 1] ?? "").split(",");
    expect(fields).toContain("isCrossRepository");
    expect(fields).toContain("reviewDecision");
    const limit = Number(args[args.indexOf("--limit") + 1]);
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeLessThanOrEqual(100);
    expect(limit).toBe(PR_WITNESS_LIMIT);
  });

  test("a proposal branch named for the spec and version witnesses it too", () => {
    const { spawn } = gh([proposal({ headRefName: "propose/support-1.2.0-abc123-20261101" })]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("success");
  });

  test("a PR for another version is no witness", () => {
    const { spawn } = gh([proposal({ title: "propose: support 1.2.1 (optimize)" })]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
  });

  test("a PR for another spec is no witness", () => {
    const { spawn } = gh([proposal({ title: "propose: support-2 1.2.0 (optimize)" })]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
  });

  test("a PR whose body or branch names the version, under another version's title, is no witness", () => {
    const { spawn } = gh([
      proposal({
        title: "propose: support 1.2.1 (optimize)",
        headRefName: "propose/support-1.2.0-x",
        body: "replaces support 1.2.0",
      }),
    ]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
  });

  test("a PR off a branch that is not a proposal's is no witness", () => {
    const { spawn } = gh([proposal({ headRefName: "feature/support" })]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
  });

  test("the matching PR is found among others, and its rollup decides", () => {
    const { spawn } = gh([
      proposal({ number: 1, title: "propose: support 1.1.0 (manual)" }),
      proposal({ number: 2, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
    ]);
    expect(readPrCheckViaGh(QUERY, spawn)).toMatchObject({ conclusion: "failure", prNumber: 2 });
  });

  test("a PR from another repository is no witness", () => {
    const { spawn } = gh([proposal({ isCrossRepository: true })]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
  });

  test("a PR that does not say which repository its branch is in is no witness", () => {
    const { isCrossRepository: _omitted, ...unsaid } = proposal();
    const { spawn } = gh([unsaid]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
  });

  test("a green PR without an approving review is no witness", () => {
    for (const reviewDecision of ["REVIEW_REQUIRED", "CHANGES_REQUESTED", "", null, undefined]) {
      const { spawn } = gh([proposal({ reviewDecision })]);
      expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("none");
    }
  });

  test("a second PR titled for the same spec and version never turns a red check green", () => {
    const { spawn } = gh([
      proposal({ number: 8, headRefName: "propose/chg_new" }),
      proposal({ number: 7, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
    ]);
    expect(readPrCheckViaGh(QUERY, spawn)).toMatchObject({ conclusion: "failure", prNumber: 7 });
  });

  test("a second PR titled for the same spec and version never turns a pending check green", () => {
    const { spawn } = gh([
      proposal({ number: 8, headRefName: "propose/chg_new" }),
      proposal({ number: 7, statusCheckRollup: [{ state: "PENDING" }] }),
    ]);
    expect(readPrCheckViaGh(QUERY, spawn)).toMatchObject({ conclusion: "pending", prNumber: 7 });
  });

  test("an unapproved second PR for the same spec and version withholds the witness", () => {
    const { spawn } = gh([
      proposal({ number: 8 }),
      proposal({ number: 9, headRefName: "propose/chg_new", reviewDecision: "REVIEW_REQUIRED" }),
    ]);
    expect(readPrCheckViaGh(QUERY, spawn)).toMatchObject({ conclusion: "none", prNumber: 9 });
  });

  test("approved green PRs for the same spec and version witness it", () => {
    const { spawn } = gh([
      proposal({ number: 8, headRefName: "propose/chg_new" }),
      proposal({ number: 7 }),
    ]);
    expect(readPrCheckViaGh(QUERY, spawn).conclusion).toBe("success");
  });

  test("a gh that exits non-zero or prints something other than a JSON list is no witness", () => {
    expect(readPrCheckViaGh(QUERY, gh([proposal()], 1).spawn).conclusion).toBe("none");
    expect(readPrCheckViaGh(QUERY, gh("not json").spawn).conclusion).toBe("none");
    expect(readPrCheckViaGh(QUERY, gh("{}").spawn).conclusion).toBe("none");
    const throwing: GhSpawn = () => {
      throw new Error("spawn gh ENOENT");
    };
    expect(readPrCheckViaGh(QUERY, throwing).conclusion).toBe("none");
  });
});
