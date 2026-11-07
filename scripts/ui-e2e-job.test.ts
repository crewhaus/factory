/**
 * The `ui-e2e` jobs in ci.yml. A browser job is easy to make green by accident: a
 * skipped job reads as success, a required check that is itself a shard can pass
 * while another shard never ran, and a wrong runner image cannot install a browser.
 * So the workflow's shape is held here, and the aggregate's own script is executed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir);

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
};

const workflow = Bun.YAML.parse(
  readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const SHARD_IDS = { "ui-e2e-smoke": "smoke", "ui-e2e-axe": "axe", "ui-e2e-system": "system" };
const SHARDS = Object.keys(SHARD_IDS) as Array<keyof typeof SHARD_IDS>;
const ALL_NEW_JOBS = ["ui-e2e-scope", ...SHARDS, "ui-e2e"];

function job(id: string): Job {
  const found = workflow.jobs[id];
  if (found === undefined) throw new Error(`ci.yml has no job ${id}`);
  return found;
}

const browserStep = (id: string): Step => {
  const step = job(id).steps.find((s) => s.run?.includes("test:browser"));
  if (step === undefined) throw new Error(`${id} never runs the browser suite`);
  return step;
};

describe("the shards", () => {
  test.each(SHARDS)("%s runs on ubuntu-24.04, within the budget", (id) => {
    expect(job(id)["runs-on"]).toBe("ubuntu-24.04");
    expect(job(id)["timeout-minutes"]).toBeGreaterThan(0);
    expect(job(id)["timeout-minutes"]).toBeLessThanOrEqual(20);
  });

  test("each shard selects its own journeys, and no two share one", () => {
    const shards = SHARDS.map((id) => browserStep(id).env?.["HANGAR_E2E_SHARD"]);
    expect(shards).toEqual(SHARDS.map((id) => SHARD_IDS[id]));
    expect(new Set(shards).size).toBe(SHARDS.length);
  });

  test("each shard's traces go to the runner's temp directory", () => {
    for (const id of SHARDS) {
      expect(browserStep(id).env?.["HANGAR_E2E_ARTIFACTS"]).toBe("${{ runner.temp }}/hangar-e2e");
    }
  });

  test("no two shards upload an artifact under one name, which upload-artifact refuses", () => {
    const names = SHARDS.map((id) => {
      const upload = job(id).steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
      expect(upload?.if).toBe("always()");
      expect(upload?.with?.["if-no-files-found"]).toBe("ignore");
      return upload?.with?.["name"];
    });
    expect(names.every((name) => typeof name === "string")).toBe(true);
    expect(new Set(names).size).toBe(SHARDS.length);
  });

  test("each shard installs both halves of the browser, cached", () => {
    for (const id of SHARDS) {
      const steps = job(id).steps;
      const cache = steps.find((s) => s.uses?.startsWith("actions/cache@"));
      expect(cache?.with?.["path"]).toBe("~/.cache/ms-playwright");
      const install = steps.find((s) => s.run?.includes("playwright install"));
      expect(install?.run).toContain('await import("playwright")');
      expect(install?.run).toContain("bunx playwright install --with-deps chromium");
    }
  });

  test("the shards run beside `ci`, never after it", () => {
    for (const id of [...SHARDS, "ui-e2e-scope", "ui-e2e"]) {
      expect([job(id).needs ?? []].flat()).not.toContain("ci");
    }
  });
});

describe("the sweep's condition", () => {
  test("a failed scope job runs the sweep rather than skipping into a false green", () => {
    // Whole, because the operators are the logic: `&&` for `||` would skip the sweep
    // on every in-scope pull request, and the aggregate would read that as green.
    expect(job("ui-e2e-axe").if).toBe(
      "${{ !cancelled() && (needs.ui-e2e-scope.result != 'success' || needs.ui-e2e-scope.outputs.axe != 'false') }}",
    );
    expect([job("ui-e2e-axe").needs].flat()).toEqual(["ui-e2e-scope"]);
  });
});

describe("the scope job", () => {
  const scope = job("ui-e2e-scope");
  const step = scope.steps.find((s) => s.run?.includes("ui-e2e-scope.ts"));

  test("it sees both parents, and exposes its answer", () => {
    const checkout = scope.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(2);
    expect(scope.outputs?.["axe"]).toBe(`\${{ steps.${step?.id}.outputs.axe }}`);
  });

  test("its diff lists both sides of a move and cannot be quoted past the prefix check", () => {
    expect(step?.run).toContain("git diff --name-only --no-renames -z HEAD^1 HEAD");
  });

  test("no event data is interpolated into its script", () => {
    expect(step?.run).not.toContain("${{");
    expect(step?.env).toEqual({ EVENT_NAME: "${{ github.event_name }}" });
  });

  describe("its script, run the way the runner runs it, over a real repository", () => {
    const repos: string[] = [];
    afterAll(() => {
      for (const repo of repos) rmSync(repo, { recursive: true, force: true });
    });

    const git = (repo: string, ...args: string[]): void => {
      const identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
      const done = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...identity, ...args], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
    };
    const commit = (repo: string, path: string): void => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), path);
      git(repo, "add", path);
      git(repo, "commit", "-m", path);
    };
    /** A pull request's merge commit: its first parent has moved on with `onMain`. */
    const mergeCommit = (prChanges: string, onMain: string): string => {
      const repo = mkdtempSync(join(tmpdir(), "ui-e2e-scope-"));
      repos.push(repo);
      git(repo, "init", "-q", "-b", "main");
      commit(repo, "README.md");
      git(repo, "checkout", "-q", "-b", "pr");
      commit(repo, prChanges);
      git(repo, "checkout", "-q", "main");
      commit(repo, onMain);
      git(repo, "merge", "-q", "--no-ff", "-m", "merge", "pr");
      return repo;
    };
    const answer = (repo: string, event: string): string => {
      const script = readFileSync(join(ROOT, "scripts", "ui-e2e-scope.ts"), "utf8");
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(join(repo, "scripts", "ui-e2e-scope.ts"), script);
      const output = join(repo, "github-output");
      writeFileSync(output, "");
      // `bash -e` is what a run step without a `shell` gets.
      const done = Bun.spawnSync(["bash", "-e", "-c", step?.run ?? ""], {
        cwd: repo,
        env: {
          PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
          EVENT_NAME: event,
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(done.exitCode).toBe(0);
      return readFileSync(output, "utf8").trim();
    };

    // git and bun, several times over; slow by construction on a loaded runner.
    const DEADLINE = 20_000;

    test(
      "a pull request outside the scope skips, whatever its base did",
      () => {
        const repo = mergeCommit("docs/x.md", "packages/hangar-ui/moved-on.js");
        expect(answer(repo, "pull_request")).toBe("axe=false");
      },
      DEADLINE,
    );

    test(
      "a pull request inside the scope sweeps",
      () => {
        const repo = mergeCommit("packages/hangar-ui/a.js", "docs/moved-on.md");
        expect(answer(repo, "pull_request")).toBe("axe=true");
      },
      DEADLINE,
    );

    test(
      "anything but a pull request sweeps without looking",
      () => {
        const repo = mergeCommit("docs/x.md", "docs/moved-on.md");
        expect(answer(repo, "push")).toBe("axe=true");
        expect(answer(repo, "workflow_call")).toBe("axe=true");
      },
      DEADLINE,
    );

    test(
      "a diff that fails sweeps: could not determine is not no",
      () => {
        const repo = mkdtempSync(join(tmpdir(), "ui-e2e-scope-"));
        repos.push(repo);
        git(repo, "init", "-q", "-b", "main");
        commit(repo, "docs/only-commit.md");
        expect(answer(repo, "pull_request")).toBe("axe=true");
      },
      DEADLINE,
    );
  });
});

describe("the aggregate", () => {
  const aggregate = job("ui-e2e");
  const [only] = aggregate.steps;
  const script = only?.run ?? "";

  test("its name is the one check the ruleset can require", () => {
    expect(aggregate.name).toBe("ui-e2e");
  });

  test("it waits for every shard and runs whatever happened to them", () => {
    expect([aggregate.needs].flat().sort()).toEqual(
      ["ui-e2e-axe", "ui-e2e-scope", "ui-e2e-smoke", "ui-e2e-system"].sort(),
    );
    expect(aggregate.if).toBe("always()");
    expect(aggregate.steps).toHaveLength(1);
  });

  test("it reads results from its environment, not interpolated into the script", () => {
    expect(script).not.toBe("");
    expect(script).not.toContain("${{");
    expect(only?.env).toEqual({
      SMOKE: "${{ needs.ui-e2e-smoke.result }}",
      AXE: "${{ needs.ui-e2e-axe.result }}",
      SYSTEM: "${{ needs.ui-e2e-system.result }}",
    });
  });

  const verdict = (env: { SMOKE: string; AXE: string; SYSTEM: string }): number =>
    Bun.spawnSync(["bash", "-c", script], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode;

  test("all green passes, and a sweep that skipped is green", () => {
    expect(verdict({ SMOKE: "success", AXE: "success", SYSTEM: "success" })).toBe(0);
    expect(verdict({ SMOKE: "success", AXE: "skipped", SYSTEM: "success" })).toBe(0);
  });

  test.each(["failure", "cancelled", "skipped"])("%s in smoke or system fails", (result) => {
    expect(verdict({ SMOKE: result, AXE: "success", SYSTEM: "success" })).not.toBe(0);
    expect(verdict({ SMOKE: "success", AXE: "success", SYSTEM: result })).not.toBe(0);
    expect(verdict({ SMOKE: result, AXE: "skipped", SYSTEM: "success" })).not.toBe(0);
  });

  test.each(["failure", "cancelled"])("%s in the sweep fails", (result) => {
    expect(verdict({ SMOKE: "success", AXE: result, SYSTEM: "success" })).not.toBe(0);
  });

  test("it says which one failed", () => {
    const failed = Bun.spawnSync(["bash", "-c", script], {
      env: { PATH: process.env["PATH"] ?? "", SMOKE: "failure", AXE: "skipped", SYSTEM: "success" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(`${failed.stdout}${failed.stderr}`).toContain("smoke");
  });
});

describe("every new job", () => {
  test("every action is pinned to a commit", () => {
    let uses = 0;
    for (const id of ALL_NEW_JOBS) {
      for (const step of job(id).steps) {
        if (step.uses === undefined) continue;
        uses += 1;
        expect({ id, uses: step.uses, pinned: /@[0-9a-f]{40}$/.test(step.uses) }).toEqual({
          id,
          uses: step.uses,
          pinned: true,
        });
      }
    }
    // A guard over no steps would hold for anything.
    expect(uses).toBeGreaterThan(10);
  });

  test("every job declares a bound and a name", () => {
    for (const id of ALL_NEW_JOBS) {
      expect(job(id)["timeout-minutes"]).toBeGreaterThan(0);
      expect(typeof job(id).name).toBe("string");
    }
  });

  test("no job takes a secret, so a fork's pull request runs all of them", () => {
    for (const id of ALL_NEW_JOBS) {
      expect(JSON.stringify(job(id))).not.toContain("secrets.");
    }
  });
});
