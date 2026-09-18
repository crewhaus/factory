import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { CHANGESET_TOOLS } from "./index";

let catalog: ToolCatalog;
let workspace: string;
const originalCwd = process.cwd();
let savedGlobal: string | undefined;
let savedSystem: string | undefined;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

function git(args: string[], cwd: string): void {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

beforeAll(() => {
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
  catalog = new ToolCatalog();
  for (const tool of CHANGESET_TOOLS) catalog.register(tool);
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-changeset-int-")));
  process.chdir(workspace);
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "docs"), { recursive: true });
  writeFileSync(
    join(workspace, "src/index.ts"),
    "export function renderReport() {\n  return 1;\n}\n",
  );
  writeFileSync(join(workspace, "docs/guide.md"), "Call `renderReport` to build one.\n");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(CHANGESET_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of CHANGESET_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    const inputs: Record<string, unknown> = {
      DiffLint: { diff: "" },
      DocsSymbolCheck: { docs: ["docs/guide.md"], source: "src" },
    };
    for (const tool of CHANGESET_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("an input the schema rejects never reaches execute", async () => {
    const result = await executeTool(
      lookup("DiffLint"),
      { diff: "", disable: ["notARule"] },
      { toolUseId: "bad-rule" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refusal comes back as a readable sentence, not as an error", async () => {
    // A caller mistake is normal traffic for a review tool: the model has to
    // be able to read what went wrong and try again, which a thrown error
    // would not let it do.
    const result = await executeTool(
      lookup("DiffLint"),
      { cwd: "src" },
      { toolUseId: "not-a-repo" },
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("not a git repository");
  });

  test("the permission layer can refuse a call before the tool runs", async () => {
    const result = await executeTool(
      lookup("DocsSymbolCheck"),
      { docs: ["docs/guide.md"], source: "src" },
      { toolUseId: "denied", allowedPatterns: ["DiffLint"] },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("not permitted");
  });
});

describe("the line number is the product", () => {
  test("a finding points at the line the file actually has", async () => {
    // The end-to-end promise: a caller can fix a finding from the number
    // alone, without re-reading the file first. This test re-reads it so it
    // can prove the number.
    const repo = join(workspace, "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-b", "main"], repo);
    git(["config", "user.name", "A U Thor"], repo);
    git(["config", "user.email", "author@example.com"], repo);
    const before = ["one", "two", "three", "four", "five"].map((n) => `const ${n} = 1;`);
    writeFileSync(join(repo, "app.ts"), `${before.join("\n")}\n`);
    git(["add", "-A"], repo);
    git(["commit", "-m", "initial"], repo);

    const after = [...before];
    after.splice(3, 0, "debugger; // inserted between four and five");
    writeFileSync(join(repo, "app.ts"), `${after.join("\n")}\n`);

    const result = await executeTool(lookup("DiffLint"), { cwd: "repo" }, { toolUseId: "lines" });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(String(result.content)) as {
      findings: Array<{ rule: string; line: number; file: string }>;
    };
    const finding = payload.findings.find((f) => f.rule === "debugger");
    expect(finding).toBeDefined();
    const lines = readFileSync(join(repo, finding?.file ?? ""), "utf-8").split("\n");
    expect(lines[(finding?.line ?? 0) - 1]).toContain("debugger;");
  });
});

describe("the two tools compose", () => {
  test("a change set that removes a symbol, and the doc that still names it", async () => {
    // The pair as a harness would use them: DiffLint says nothing is wrong
    // with the new lines, and DocsSymbolCheck says the docs are now stale.
    writeFileSync(
      join(workspace, "src/index.ts"),
      "export function renderSummary() {\n  return 1;\n}\n",
    );
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1,1 +1,1 @@",
      "-export function renderReport() {",
      "+export function renderSummary() {",
      "",
    ].join("\n");

    const lint = await executeTool(lookup("DiffLint"), { diff }, { toolUseId: "compose-lint" });
    expect(JSON.parse(String(lint.content))).toMatchObject({ clean: true });

    const docs = await executeTool(
      lookup("DocsSymbolCheck"),
      { docs: ["docs/guide.md"], source: "src", minResolvedRatio: 0 },
      { toolUseId: "compose-docs" },
    );
    const payload = JSON.parse(String(docs.content)) as {
      missing: Array<{ symbol: string; doc: string }>;
    };
    expect(payload.missing.map((m) => [m.doc, m.symbol])).toEqual([
      ["docs/guide.md", "renderReport"],
    ]);
  });
});
