/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. It runs
 * against a real repository for the same reason `index.test.ts` does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { GIT_TOOLS } from "./index";

const DATE = "2026-02-03T04:05:06+00:00";

function git(args: string[], cwd: string, env: Record<string, string> = {}): number {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode;
}

function initRepo(dir: string): void {
  git(["init", "-b", "main"], dir);
  git(["config", "user.name", "A U Thor"], dir);
  git(["config", "user.email", "author@example.com"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir, {
    GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_DATE: DATE,
  });
}

let catalog: ToolCatalog;
let workspace: string;
let originalCwd: string;
let savedGlobal: string | undefined;
let savedSystem: string | undefined;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeAll(() => {
  originalCwd = process.cwd();
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedSystem = process.env["GIT_CONFIG_SYSTEM"];
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
});

afterAll(() => {
  if (savedGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
  else process.env["GIT_CONFIG_GLOBAL"] = savedGlobal;
  if (savedSystem === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_SYSTEM");
  else process.env["GIT_CONFIG_SYSTEM"] = savedSystem;
});

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-git-int-")));
  process.chdir(workspace);
  mkdirSync(join(workspace, "repo"));
  initRepo(join(workspace, "repo"));
  catalog = new ToolCatalog();
  for (const tool of GIT_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(GIT_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of GIT_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(lookup("GitStatus"), { cwd: "repo" }, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"branch":"main"');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("GitLog"), { cwd: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("GitLog");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("GitCommit"), { cwd: "repo" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("an over-long timeout is rejected by the schema, not by git", async () => {
    const result = await executeTool(
      lookup("GitStatus"),
      { cwd: "repo", timeout: 999_999_999 },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("GitStatus"),
      { cwd: "repo" },
      { toolUseId: "t5", allowedPatterns: ["GitLog"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("GitStatus"),
      { cwd: "repo" },
      { toolUseId: "t6", allowedPatterns: ["GitStatus"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a containment refusal comes back as a readable result, not a thrown error", async () => {
    const result = await executeTool(
      lookup("GitStatus"),
      { cwd: "../elsewhere" },
      { toolUseId: "t7" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("outside the workspace root");
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    writeFileSync(join(workspace, "repo", "staged.txt"), "x\n");
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " hello",
      "+added",
      "",
    ].join("\n");

    const calls: Record<string, unknown> = {
      GitAdd: { cwd: "repo", paths: ["staged.txt"] },
      GitApplyPatch: { cwd: "repo", patch, check: true },
      GitBlame: { cwd: "repo", path: "README.md" },
      GitBranchCreate: { cwd: "repo", name: "created" },
      GitBranchDelete: { cwd: "repo", name: "created" },
      GitBranchList: { cwd: "repo" },
      GitCherryPick: { cwd: "repo", refs: ["HEAD"] },
      GitCommit: { cwd: "repo", message: "from integration", date: DATE },
      GitConflicts: { cwd: "repo" },
      GitDiff: { cwd: "repo", mode: "numstat" },
      GitFileHistory: { cwd: "repo", path: "README.md" },
      GitLog: { cwd: "repo", maxCount: 5 },
      GitMergeBase: { cwd: "repo", a: "HEAD", b: "HEAD" },
      GitRemoteList: { cwd: "repo" },
      GitResetPaths: { cwd: "repo", paths: ["staged.txt"] },
      GitRevParse: { cwd: "repo", refs: ["HEAD"] },
      GitShow: { cwd: "repo", ref: "HEAD" },
      GitStashList: { cwd: "repo" },
      GitStashPop: { cwd: "repo" },
      GitStashPush: { cwd: "repo", message: "integration" },
      GitStatus: { cwd: "repo" },
      GitSwitch: { cwd: "repo", branch: "main" },
      GitTagCreate: { cwd: "repo", name: "v0.0.1" },
      GitTagList: { cwd: "repo" },
      GitWorktreeAdd: { cwd: "repo", path: "wt", createBranch: "wt-branch" },
      GitWorktreeList: { cwd: "repo" },
      GitWorktreeRemove: { cwd: "repo", path: "wt" },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(GIT_TOOLS.map((t) => t.name).sort());

    for (const tool of GIT_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { cwd: "repo", maxCount: 5 };
    const a = await executeTool(lookup("GitLog"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("GitLog"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("a read leaves the repository exactly as it found it", async () => {
    const before = await executeTool(lookup("GitStatus"), { cwd: "repo" }, { toolUseId: "s1" });
    await executeTool(
      lookup("GitDiff"),
      { cwd: "repo", mode: "patch", range: "HEAD" },
      { toolUseId: "s2" },
    );
    await executeTool(lookup("GitBlame"), { cwd: "repo", path: "README.md" }, { toolUseId: "s3" });
    const after = await executeTool(lookup("GitStatus"), { cwd: "repo" }, { toolUseId: "s4" });
    expect(after.content).toBe(before.content);
  });
});
