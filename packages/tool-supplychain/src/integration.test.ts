import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them, and the question they
 * exist to answer: is what this project depends on, and what builds it,
 * something an outsider can reach?
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { _resetFetchConfig, _setDnsLookup } from "@crewhaus/tool-fetch";
import { SUPPLYCHAIN_TOOLS } from "./index";
import { _setFetch } from "./net";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of SUPPLYCHAIN_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-supplychain-int-"));
  process.chdir(workspace);
  _setFetch(async () => {
    throw new Error("a test reached the network");
  });
  _resetFetchConfig();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setFetch(undefined);
  _setDnsLookup(undefined);
  _resetFetchConfig();
});

const writeBunLock = (packages: Record<string, string>): void => {
  writeFileSync(
    join(workspace, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [
          name,
          [`${name}@${version}`, "", {}, ""],
        ]),
      ),
    }),
  );
};

const writeWorkflow = (name: string, body: string): void => {
  mkdirSync(join(workspace, ".github/workflows"), { recursive: true });
  writeFileSync(join(workspace, ".github/workflows", name), body);
};

/** An OSV that knows about exactly one advisory. */
function mountOsv(): void {
  _setFetch(async (url, init) => {
    if (url.endsWith("/v1/querybatch")) {
      const queries = (
        JSON.parse(String(init?.body)) as {
          queries: Array<{ package: { name: string }; version: string }>;
        }
      ).queries;
      // Version-aware, like the real thing: OSV matches the coordinate, not
      // the package, so upgrading past the fix has to stop matching.
      return new Response(
        JSON.stringify({
          results: queries.map((q) =>
            q.package.name === "lodash" && q.version === "4.17.15"
              ? { vulns: [{ id: "GHSA-lodash" }] }
              : {},
          ),
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        id: "GHSA-lodash",
        aliases: ["CVE-2020-8203"],
        summary: "Prototype pollution",
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
        affected: [
          {
            package: { ecosystem: "npm", name: "lodash" },
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
          },
        ],
      }),
      { status: 200 },
    );
  });
}

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(SUPPLYCHAIN_TOOLS.length);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    writeBunLock({ "left-pad": "1.3.0" });
    writeWorkflow("ci.yml", "on: push\npermissions: {}\n");
    mountOsv();
    for (const tool of SUPPLYCHAIN_TOOLS) {
      const result = await executeTool(lookup(tool.name), {}, { toolUseId: `min-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("an input the schema does not accept is rejected before execute runs", async () => {
    // `execute` is never reached, so the fetch double that throws is never
    // consulted — validation is the gate, not the tool body.
    const badRule = await executeTool(
      lookup("CiWorkflowAudit"),
      { rules: ["not-a-rule"] },
      { toolUseId: "t1" },
    );
    expect(badRule.isError).toBe(true);
    const badEcosystem = await executeTool(
      lookup("DependencyAudit"),
      { ecosystems: ["pypi"] },
      { toolUseId: "t2" },
    );
    expect(badEcosystem.isError).toBe(true);
    const badTimeout = await executeTool(
      lookup("DependencyAudit"),
      { timeoutMs: 999_999 },
      { toolUseId: "t3" },
    );
    expect(badTimeout.isError).toBe(true);
  });

  test("an unreachable database surfaces as isError, not as a clean report", async () => {
    writeBunLock({ lodash: "4.17.15" });
    _setFetch(async () => new Response("down", { status: 503 }));
    const result = await executeTool(lookup("DependencyAudit"), {}, { toolUseId: "t4" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("HTTP 503");
    // The thing that must never happen: a failure that parses as an answer.
    expect(String(result.content)).not.toContain("noAdvisoriesMatched");
  });
});

describe("the question these exist to answer", () => {
  test("a repository is read end to end: what it depends on, and what builds it", async () => {
    // 1. The lockfile holds a package with a published advisory against it.
    writeBunLock({ lodash: "4.17.15", "left-pad": "1.3.0" });
    mountOsv();
    const audit = JSON.parse(
      String((await executeTool(lookup("DependencyAudit"), {}, { toolUseId: "a1" })).content),
    );
    expect(audit).toMatchObject({ matchCount: 1, noAdvisoriesMatched: false });
    const match = audit.matches[0];
    expect(match).toMatchObject({
      id: "GHSA-lodash",
      fixedVersion: "4.17.21",
      versionInAffectedRange: true,
      reachabilityAnalyzed: false,
    });
    expect(match.severity.baseScore).toBe(9.8);

    // 2. The workflow that builds it hands a fork's pull request the base
    //    repository's token and then runs the fork's own code.
    writeWorkflow(
      "release.yml",
      [
        "name: Release",
        "on: pull_request_target",
        "permissions: write-all",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "        with:",
        "          ref: ${{ github.event.pull_request.head.sha }}",
        "      - run: npm install && npm run build",
        "",
      ].join("\n"),
    );
    const ci = JSON.parse(
      String(
        (
          await executeTool(
            lookup("CiWorkflowAudit"),
            { repositoryVisibility: "public", minSeverity: "critical" },
            { toolUseId: "a2" },
          )
        ).content,
      ),
    );
    expect(ci.findings.map((f: { rule: string }) => f.rule).sort()).toEqual([
      "broad-permissions",
      "pull-request-target-checkout",
    ]);
    expect(
      ci.findings.find((f: { rule: string }) => f.rule === "pull-request-target-checkout"),
    ).toMatchObject({ line: 10, job: "build" });

    // 3. Fixing both makes both tools quiet — and the dependency tool's quiet
    //    is still only about the packages it queried.
    writeBunLock({ lodash: "4.17.21", "left-pad": "1.3.0" });
    writeWorkflow(
      "release.yml",
      [
        "name: Release",
        "on: pull_request_target",
        "permissions:",
        "  pull-requests: read",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        "      - run: npm ci && npm run build",
        "",
      ].join("\n"),
    );
    const cleanAudit = JSON.parse(
      String((await executeTool(lookup("DependencyAudit"), {}, { toolUseId: "a3" })).content),
    );
    expect(cleanAudit.noAdvisoriesMatched).toBe(true);
    const cleanCi = JSON.parse(
      String(
        (
          await executeTool(
            lookup("CiWorkflowAudit"),
            { repositoryVisibility: "public" },
            { toolUseId: "a4" },
          )
        ).content,
      ),
    );
    expect(cleanCi).toMatchObject({ findingCount: 0, noFindings: true });
  });
});
