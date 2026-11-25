import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINES, mintId } from "@crewhaus/control-contract";
import type { WorkRevision } from "../work-items/index";
import { type AcceptanceInput, JUDGE_DIFF_MAX, acceptanceCheck, changeText } from "./acceptance";
import {
  type RepositoryBinding,
  WorkspaceConfigError,
  _resetWorkspaceBindings,
  acceptanceIntent,
  activeBindings,
  assertHarnessCwd,
  bindWorkspaceRepositories,
  bindingDirOf,
  parseWorkspaceConfig,
  readBindings,
  writeBindings,
} from "./bindings";
import { type CheckResult, checkImageFor, runDeclaredChecks, sandboxCheckRunner } from "./checks";
import { credentialValues, scanSecrets, secretIn } from "./egress";
import { gitIsRecent, parseAddedLines, parseNumstat, strangeConfigKeys } from "./git";
import { pullBody, pullTitle } from "./pr-body";
import { appendAttempt, takePublishHold, worktreeNameOf, writeCheckFile } from "./records";
import { PLANTED, judgeThat, plantedClassifier } from "./test-helpers";

const dirs: string[] = [];
const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  _resetWorkspaceBindings();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tool-work-units-")));
  dirs.push(dir);
  return dir;
}

const BINDING: RepositoryBinding = {
  name: "app",
  host: "github",
  repo: "acme/app",
  base: "main",
  branchPrefix: "crewhaus/",
  checks: [["bun", "test"]],
  checkTimeoutMs: 1000,
  pullRequests: {
    draft: true,
    maxFiles: 20,
    maxLines: 800,
    revalidate: "rebase",
    require: ["checks", "acceptance"],
  },
  server: { api: "https://api.github.com", git: "https://github.com" },
};

describe("bindings", () => {
  const raw = { repositories: [BINDING], tokenEnv: "GITHUB_TOKEN" };

  test("the registrar creates each binding's directory and writes the one file Home reads", () => {
    const dir = harness();
    process.chdir(dir);
    bindWorkspaceRepositories({
      ...raw,
      intent: { purpose: "a planted purpose" },
      judge: { model: "judge-model" },
    });
    expect(statSync(join(dir, bindingDirOf("app"))).mode & 0o777).toBe(0o700);
    const file = join(dir, ".crewhaus/run/control/work/bindings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("planted purpose");
    expect(text).not.toContain("judge-model");
    expect(readBindings(dir)).toEqual({ v: 1, repositories: [BINDING], tokenEnv: "GITHUB_TOKEN" });
    expect(activeBindings()).toEqual({ v: 1, repositories: [BINDING], tokenEnv: "GITHUB_TOKEN" });
    expect(acceptanceIntent()).toEqual({ purpose: "a planted purpose" });
    // Nothing else is written at boot.
    expect(existsSync(join(dir, bindingDirOf("app"), "repo"))).toBe(false);
  });

  test("no block registers nothing, and the tools say what to declare", () => {
    bindWorkspaceRepositories(undefined);
    const none = activeBindings();
    expect("problem" in none && none.problem).toContain("repositories");
  });

  test("an intent that looks like a variable is that text, never its value", () => {
    const dir = harness();
    process.chdir(dir);
    bindWorkspaceRepositories({ ...raw, intent: { purpose: "$HOME" } });
    expect(acceptanceIntent()?.purpose).toBe("$HOME");
  });

  test("a directory that cannot be written leaves the tools refusing with the reason", () => {
    const dir = harness();
    writeFileSync(join(dir, ".crewhaus"), "not a directory");
    process.chdir(dir);
    bindWorkspaceRepositories(raw);
    const none = activeBindings();
    expect("problem" in none).toBe(true);
  });

  test("a block it cannot take is refused, naming the binding", () => {
    for (const bad of [
      { name: "App" },
      { host: "gitlab" },
      { repo: "acme" },
      { base: "-x" },
      { branchPrefix: "crewhaus" },
      { checks: ["bun test"] },
      { server: {} },
      { pullRequests: { ...BINDING.pullRequests, require: [] } },
    ]) {
      expect(() => parseWorkspaceConfig({ repositories: [{ ...BINDING, ...bad }] })).toThrow(
        WorkspaceConfigError,
      );
    }
    expect(() => parseWorkspaceConfig({ repositories: [BINDING, BINDING] })).toThrow(/once/);
  });

  test("a harness never works from inside a workspace", () => {
    const dir = harness();
    writeBindings(dir, { v: 1, repositories: [BINDING] });
    expect(() => assertHarnessCwd(dir)).not.toThrow();
    process.chdir(join(dir, bindingDirOf("app")));
    expect(() => assertHarnessCwd(dir)).toThrow(/never inside a workspace/);
    expect(() => bindWorkspaceRepositories(raw)).toThrow(/never inside a workspace/);
    process.chdir(cwd);
    expect(() => assertHarnessCwd(join(dir, bindingDirOf("app")))).toThrow(/never inside/);
  });
});

describe("reading a change", () => {
  const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    "-old",
    "--- not a header",
    "+new",
    "++++ b/not-a-file",
    "+third",
    "@@ -9 +10 @@",
    "-x",
    "\\ No newline at end of file",
    "+y",
    "\\ No newline at end of file",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
  ].join("\n");

  test("every added line has its file and its place, and content is never read as a header", () => {
    expect(parseAddedLines(DIFF)).toEqual([
      { file: "a.ts", line: 1, text: "new" },
      { file: "a.ts", line: 2, text: "+++ b/not-a-file" },
      { file: "a.ts", line: 3, text: "third" },
      { file: "a.ts", line: 10, text: "y" },
    ]);
  });

  test("counts read off numstat; a binary file is a file and no lines", () => {
    expect(parseNumstat("3\t1\ta.ts\0-\t-\tlogo.png\0")).toEqual({ files: 2, lines: 4 });
    expect(parseNumstat("")).toEqual({ files: 0, lines: 0 });
  });

  test("a clone's own keys are git's; another is named without what it points at", () => {
    const plain = ["core.repositoryformatversion", "core.bare", "core.hooksPath"].join("\0");
    expect(strangeConfigKeys(`${plain}\0`)).toEqual([]);
    expect(
      strangeConfigKeys(
        `${plain}\0url.http://evil.example/.insteadof\0http.proxy\0filter.x.clean\0`,
      ),
    ).toEqual(["filter.clean", "http.proxy", "url.insteadof"]);
  });

  test("git older than 2.38 is not recent", () => {
    expect(gitIsRecent("git version 2.54.0 (Apple Git-157)")).toBe(true);
    expect(gitIsRecent("git version 2.38.0")).toBe(true);
    expect(gitIsRecent("git version 2.37.7")).toBe(false);
    expect(gitIsRecent("git version 3.0.1")).toBe(true);
    expect(gitIsRecent("no such program")).toBe(false);
  });

  test("a worktree is named by its branch's last part", () => {
    expect(worktreeNameOf("crewhaus/01abc-fix-it")).toBe("01abc");
    expect(worktreeNameOf("a/b/01abc")).toBe("01abc");
  });
});

describe("secrets", () => {
  test("the values compared are the credential-named variables', each long line of one too", () => {
    const key = ["-----BEGIN", "a".repeat(40), "-----END"].join("\n");
    const values = credentialValues({
      PATH: "/usr/bin:/bin/something",
      API_TOKEN: "0123456789",
      SHORT_KEY: "abc",
      SIGNING_KEY: key,
      EMPTY_SECRET: undefined,
    });
    expect(values).toContain("0123456789");
    expect(values).toContain("a".repeat(40));
    expect(values).not.toContain("abc");
    expect(values.some((v) => v.includes("/usr/bin"))).toBe(false);
  });

  test("a word of a line is read when its first form only names a credential", () => {
    const url = `https://user:${"p".repeat(12)}@example.com/x`;
    expect(secretIn(`apiKey: process.env.KEY, // ${url}`, [])).toBeDefined();
    expect(secretIn("token: string;", [])).toBeUndefined();
    expect(secretIn("password = hash(password)", [])).toBeUndefined();
  });

  test("names the first place, and never the text", () => {
    const hit = scanSecrets({
      added: [
        { file: "a.ts", line: 3, text: "fine" },
        { file: "b.ts", line: 7, text: "const x = 'planted-secret-value'" },
      ],
      files: ["a.ts", "b.ts"],
      messages: "Subject\n",
      values: ["planted-secret-value"],
    });
    expect(hit).toEqual({ file: "b.ts", line: 7, why: "a credential of this harness" });
    expect(
      scanSecrets({
        added: [],
        files: ["docs/.npmrc"],
        messages: "",
        values: [],
      }),
    ).toMatchObject({ file: "docs/.npmrc" });
    expect(
      scanSecrets({
        added: [],
        files: ["a.ts"],
        messages: "x planted-secret-value",
        values: ["planted-secret-value"],
      }),
    ).toMatchObject({ file: "(a commit message)", line: 1 });
  });
});

describe("the acceptance check", () => {
  const REVISION = {
    v: 1,
    wi: mintId("wi"),
    rev: 1,
    at: "2026-11-25T00:00:00.000Z",
    by: "sys:runtime",
    title: "Fix the dates",
    goal: "ISO dates parse everywhere",
    kind: "fix",
    fieldOrigins: { title: "memory", goal: "api", acceptance: "mcp" },
  } as WorkRevision;
  const passed: CheckResult = { k: 0, name: "bun test", exit: 0, timedOut: false, output: "" };
  const input = (over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
    binding: BINDING,
    revision: REVISION,
    headSha: "a".repeat(40),
    stat: { files: 1, lines: 2 },
    added: [{ file: "a.ts", line: 1, text: "x" }],
    checks: [passed],
    judge: judgeThat("meets").judge,
    classify: plantedClassifier().classify,
    ...over,
  });

  test("the judge reads the criteria alone without an intent, and both with one", async () => {
    const alone = judgeThat("meets");
    const revision = { ...REVISION, acceptance: ["ISO dates parse"] };
    expect(await acceptanceCheck(input({ judge: alone.judge, revision }))).toMatchObject({
      verdict: { checks: "pass", acceptance: "pass" },
    });
    expect(alone.asked[0]?.input).toBe("The change must do this:\n- ISO dates parse");
    const both = judgeThat("meets");
    await acceptanceCheck(
      input({
        judge: both.judge,
        revision,
        intent: { purpose: "PLANTED-PURPOSE", excludes: ["UI"] },
      }),
    );
    expect(both.asked[0]?.input).toContain("PLANTED-PURPOSE");
    expect(both.asked[0]?.input).toContain("Not part of its work:\n- UI");
    expect(both.asked[0]?.output).not.toContain("PLANTED-PURPOSE");
  });

  test("an item with no criteria is judged by its title and goal, each at its own origin", async () => {
    const judge = judgeThat("meets");
    const planted = plantedClassifier();
    await acceptanceCheck(input({ judge: judge.judge, classify: planted.classify }));
    expect(judge.asked[0]?.input).toContain("- Fix the dates\n- ISO dates parse everywhere");
    expect(planted.calls.map((c) => [c.text.slice(0, 13), c.origin])).toEqual([
      ["Fix the dates", "memory"],
      ["ISO dates par", "api"],
      ["1 files chang", "tool"],
    ]);
  });

  test("a criterion that is a check passes exactly when the check did, and never reaches the judge", async () => {
    const judge = judgeThat("meets");
    const revision = { ...REVISION, acceptance: ["check: bun test"] };
    expect(await acceptanceCheck(input({ judge: judge.judge, revision }))).toMatchObject({
      verdict: { acceptance: "pass" },
    });
    expect(judge.asked).toEqual([]);
    const other = { ...REVISION, acceptance: ["check: bun lint", "Something else"] };
    const refused = await acceptanceCheck(input({ judge: judge.judge, revision: other }));
    expect(refused).toMatchObject({ refused: "gate_failed", verdict: { acceptance: "fail" } });
    expect(judge.asked).toEqual([]);
  });

  test("a change that tries to steer its reviewer fails before the judge reads it", async () => {
    const judge = judgeThat("meets");
    const answer = await acceptanceCheck(
      input({ judge: judge.judge, added: [{ file: "a.ts", line: 1, text: `// ${PLANTED}` }] }),
    );
    expect(answer).toMatchObject({ refused: "gate_failed" });
    expect(judge.asked).toEqual([]);
  });

  test("no judge, a judge that throws and checks that did not run all fail closed", async () => {
    expect(await acceptanceCheck(input({ judge: undefined }))).toMatchObject({
      refused: "gate_failed",
    });
    const thrown = await acceptanceCheck(
      input({
        judge: async () => {
          throw new Error("planted provider words");
        },
      }),
    );
    expect(thrown).toMatchObject({ refused: "gate_failed" });
    expect(JSON.stringify(thrown)).not.toContain("planted provider words");
    expect(await acceptanceCheck(input({ checks: undefined }))).toMatchObject({
      refused: "gate_failed",
      verdict: { checks: "not-run", acceptance: "not-run" },
    });
  });

  test("a long change is cut, and says so", () => {
    const added = Array.from({ length: 3000 }, (_, i) => ({
      file: "a.ts",
      line: i + 1,
      text: "y".repeat(60),
    }));
    const text = changeText({ files: 1, lines: 3000 }, added);
    expect(text.length).toBeLessThan(JUDGE_DIFF_MAX + 200);
    expect(text.endsWith("[the rest of the change was cut]")).toBe(true);
  });
});

describe("checks in the sandbox", () => {
  test("there is a runner with docker or podman, and none with noop or a value that names none", () => {
    expect(sandboxCheckRunner({})).toBeDefined();
    expect(sandboxCheckRunner({ CREWHAUS_SANDBOX: "podman" })).toBeDefined();
    expect(sandboxCheckRunner({ CREWHAUS_SANDBOX: "noop" })).toBeUndefined();
    expect(sandboxCheckRunner({ CREWHAUS_SANDBOX: "none" })).toBeUndefined();
  });

  test("the image is the binding's own, else one that has the check's program", () => {
    expect(checkImageFor({ ...BINDING, checkImage: "oven/bun:1" }, ["bun", "test"])).toBe(
      "oven/bun:1",
    );
    expect(checkImageFor(BINDING, ["npm", "test"])).toBe("node:22-alpine");
    expect(checkImageFor(BINDING, ["python3", "-m", "pytest"])).toBe("python:3.13-slim");
    expect(checkImageFor(BINDING, ["make"])).toBe("alpine:3.19");
  });

  test("a check that could not be started is not a failing one", async () => {
    const answer = await runDeclaredChecks({
      binding: BINDING,
      worktree: "/nowhere",
      runner: async () => ({ ran: false, reason: "no daemon" }),
    });
    expect(answer).toMatchObject({ ran: false });
    expect(answer.ran === false && answer.reason).toContain("bun test");
  });
});

describe("a pull request's text", () => {
  const verdict = { checks: "pass", acceptance: "pass", sha: "a".repeat(40) } as const;

  test("is rendered from records, with the concerns and no mention that notifies anyone", () => {
    const body = pullBody({
      text: { title: "T", summary: "By @someone, for @team/all", concerns: ["Ask @max?\nreally"] },
      wi: "wi_x",
      homeLink: "https://home.example/#/h/hrn_1/work/items/wi_x",
      parent: "wi_parent",
      plan: ["continuity:goal-1"],
      runs: ["run_1"],
      decisions: ["appr_1"],
      checks: [{ name: "bun test", exit: 0 }],
      verdict,
      rebasedOnto: "b".repeat(40),
    });
    expect(body).not.toMatch(/@[A-Za-z0-9]/);
    for (const part of [
      "[wi_x](https://home.example/#/h/hrn_1/work/items/wi_x)",
      "`wi_parent`",
      "`continuity:goal-1`",
      "`run_1`",
      "`appr_1`",
      "- `bun test`: passed",
      "Acceptance check: passed.",
      "Open concerns:",
      `Rebased onto \`${"b".repeat(40)}\``,
    ]) {
      expect(body).toContain(part);
    }
    expect(pullTitle("  a\n b  ")).toBe("a b");
    expect(pullTitle("x".repeat(500)).length).toBe(120);
  });
});

describe("the records", () => {
  test("every machine names its entry and lists each state's self-transition", () => {
    for (const name of ["workspace", "work-publish", "work-pr"] as const) {
      const machine = MACHINES[name];
      const ends = new Set<string>(machine.terminal as readonly string[]);
      for (const state of machine.states) {
        if (ends.has(state)) continue;
        expect((machine.transitions as Record<string, readonly string[]>)[state]).toContain(state);
      }
    }
  });

  test("an attempt moves only as its machine says, and a stray key is never written", async () => {
    const dir = harness();
    const wi = mintId("wi");
    const line = {
      v: 1,
      at: "2026-11-25T00:00:00.000Z",
      id: `${wi}:1`,
      wi,
      attempt: 1,
      state: "started",
      by: "sys:runtime",
      via: "tool",
    } as const;
    await expect(appendAttempt(dir, { ...line, state: "done" })).rejects.toThrow(/cannot move/);
    await appendAttempt(dir, line);
    await expect(appendAttempt(dir, { ...line, state: "not-done" })).rejects.toThrow(/cannot move/);
    await expect(appendAttempt(dir, { ...line, title: "words" } as never)).rejects.toThrow(
      /outside its set: title/,
    );
    await appendAttempt(dir, { ...line, state: "failed", code: "checks_failed" });
    await expect(appendAttempt(dir, { ...line, state: "pushed" })).rejects.toThrow(/cannot move/);
  });

  test("a content file is contained, private and cut to its size", () => {
    const dir = harness();
    const wi = mintId("wi");
    const name = writeCheckFile(dir, wi, "1-0.log", "x".repeat(400 * 1024));
    const at = join(dir, ".crewhaus/run/control/work/checks", wi, name);
    expect(statSync(at).mode & 0o777).toBe(0o600);
    expect(statSync(at).size).toBeLessThanOrEqual(256 * 1024);
    expect(() => writeCheckFile(dir, wi, "../escape", "x")).toThrow();
    expect(() => writeCheckFile(dir, "wi_x", "1-0.log", "x")).toThrow();
  });

  test("the hold is one per item until it is released", async () => {
    const dir = harness();
    const wi = mintId("wi");
    const first = await takePublishHold(dir, wi, Date.now);
    expect(first).toBeDefined();
    expect(await takePublishHold(dir, wi, Date.now)).toBeUndefined();
    await first?.release();
    expect(await takePublishHold(dir, wi, Date.now)).toBeDefined();
  });
});
