/**
 * The tools, driven against a real workspace.
 *
 * Every test builds a throwaway directory under the OS temp dir, chdir's
 * into it (the containment root is `process.cwd()`, so the tools must see the
 * temp tree as the workspace) and removes it afterwards. Nothing here writes
 * into the repository, and nothing reaches a network address.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openAuditLog } from "@crewhaus/audit-log";
import {
  auditVerify,
  bundleFreshness,
  costSummarize,
  evalBaselineCompare,
  harnessInventory,
  permissionAudit,
  preflightRun,
  sessionSummarize,
  specCompileCheck,
  specDiff,
  specSummarize,
  specValidate,
  toolInventory,
  traceQuery,
} from "./index";

const originalCwd = process.cwd();
let tmp: string;
/** Directories made outside the workspace, for the escape tests. */
const outside: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-crewhaus-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

afterAll(() => {
  for (const dir of outside) rmSync(dir, { recursive: true, force: true });
});

function outsideDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-crewhaus-outside-"));
  outside.push(dir);
  return dir;
}

function write(rel: string, content: string): string {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

async function call(tool: { execute: (i: unknown) => Promise<string> }, input: unknown) {
  return await tool.execute(input);
}

async function callJson<T = Record<string, unknown>>(
  tool: { execute: (i: unknown) => Promise<string> },
  input: unknown,
): Promise<T> {
  const raw = await call(tool, input);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`expected JSON, got: ${raw}`);
  }
}

const CLI_SPEC = [
  "name: demo",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: Be useful.",
  "tools: [read, write, bash]",
  "permissions:",
  "  mode: default",
  "  rules:",
  "    - type: alwaysAllow",
  "      pattern: Read",
].join("\n");

/** A spec that compiles but carries an accepted-but-unwired warning. */
const WORKFLOW_SPEC_WITH_WARNING = [
  "name: flow",
  "target: workflow",
  "model: claude-sonnet-4-6",
  "steps:",
  "  - name: one",
  "    instructions: do it",
  "continuity:",
  "  enabled: true",
].join("\n");

// ---------------------------------------------------------------------------
// containment — the boundary every path argument crosses
// ---------------------------------------------------------------------------

describe("path containment", () => {
  test("a spec path outside the workspace is refused", async () => {
    const dir = outsideDir();
    writeFileSync(path.join(dir, "crewhaus.yaml"), CLI_SPEC);
    const result = await call(specValidate, { path: path.join(dir, "crewhaus.yaml") });
    expect(result).toContain("escapes the workspace root");
  });

  test("a relative traversal is refused", async () => {
    expect(await call(specValidate, { path: "../escape.yaml" })).toContain(
      "escapes the workspace root",
    );
  });

  test("a symlink pointing out of the workspace is refused", async () => {
    const dir = outsideDir();
    writeFileSync(path.join(dir, "crewhaus.yaml"), CLI_SPEC);
    symlinkSync(path.join(dir, "crewhaus.yaml"), path.join(tmp, "linked.yaml"));
    expect(await call(specValidate, { path: "linked.yaml" })).toContain(
      "escapes the workspace root",
    );
  });

  test("every path-taking tool refuses an escape, not just the spec ones", async () => {
    const outsideRel = "../../etc";
    for (const [name, input] of [
      ["AuditVerify", { dir: outsideRel }],
      ["HarnessInventory", { root: outsideRel }],
      ["BundleFreshness", { dirs: [outsideRel] }],
      ["SessionSummarize", { dir: outsideRel }],
      ["TraceQuery", { dir: outsideRel }],
      ["CostSummarize", { dir: outsideRel }],
      ["PreflightRun", { harnessDir: outsideRel, env: {} }],
    ] as const) {
      const tool = {
        AuditVerify: auditVerify,
        HarnessInventory: harnessInventory,
        BundleFreshness: bundleFreshness,
        SessionSummarize: sessionSummarize,
        TraceQuery: traceQuery,
        CostSummarize: costSummarize,
        PreflightRun: preflightRun,
      }[name];
      const result = await call(tool, input);
      expect({ name, escaped: result.includes("escapes the workspace root") }).toEqual({
        name,
        escaped: true,
      });
    }
  });

  test("a file over the size cap is refused rather than read into context", async () => {
    write("huge.yaml", "#".repeat(5 * 1024 * 1024));
    expect(await call(specValidate, { path: "huge.yaml" })).toContain("over the");
  });
});

// ---------------------------------------------------------------------------
// spec tools
// ---------------------------------------------------------------------------

describe("SpecValidate", () => {
  test("a valid spec reports no issues", async () => {
    const result = await callJson(specValidate, { spec: CLI_SPEC });
    expect(result).toEqual({ valid: true, issueCount: 0, issues: [] });
  });

  test("every issue is returned, with its path — not just the first", async () => {
    const result = await callJson<{ issueCount: number; issues: Array<{ path: string }> }>(
      specValidate,
      { spec: ["name: bad", "target: cli", "agent:", "  model: m"].join("\n") },
    );
    expect(result.issueCount).toBeGreaterThan(0);
    expect(result.issues[0]?.path).toContain("agent");
  });

  test("a YAML syntax error is one issue at the document root", async () => {
    const result = await callJson<{ issues: Array<{ code: string; path: string }> }>(specValidate, {
      spec: "a: [1,",
    });
    expect(result.issues[0]?.code).toBe("yaml_syntax");
    expect(result.issues[0]?.path).toBe("<root>");
  });

  test("reads the spec from a contained path just as well as inline", async () => {
    write("crewhaus.yaml", CLI_SPEC);
    expect(await callJson(specValidate, { path: "crewhaus.yaml" })).toEqual({
      valid: true,
      issueCount: 0,
      issues: [],
    });
  });

  test("passing both spec and path is a readable refusal, not a crash", async () => {
    expect(await call(specValidate, { spec: CLI_SPEC, path: "crewhaus.yaml" })).toContain(
      'pass either "spec" or "path"',
    );
  });

  test("passing neither says what to pass", async () => {
    expect(await call(specValidate, {})).toContain("pass the spec");
  });
});

describe("SpecCompileCheck", () => {
  test("a compilable spec reports ok and writes nothing", async () => {
    const before = readdirSync(tmp);
    const result = await callJson<{ ok: boolean; fileCount: number }>(specCompileCheck, {
      spec: CLI_SPEC,
      today: "2026-01-01",
    });
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(readdirSync(tmp)).toEqual(before);
  });

  test("a spec that cannot compile reports the error instead of throwing", async () => {
    const result = await callJson<{ ok: boolean; error: { message: string } }>(specCompileCheck, {
      spec: ["name: bad", "target: cli", "agent:", "  model: m"].join("\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  test("the emitted file list is available on request, and is sorted", async () => {
    const result = await callJson<{ files: string[] }>(specCompileCheck, {
      spec: CLI_SPEC,
      today: "2026-01-01",
      includeFiles: true,
    });
    expect(result.files).toEqual([...result.files].sort());
  });

  test("pinning today makes the result reproducible", async () => {
    const a = await call(specCompileCheck, { spec: CLI_SPEC, today: "2026-01-01" });
    const b = await call(specCompileCheck, { spec: CLI_SPEC, today: "2026-01-01" });
    expect(a).toBe(b);
  });

  test("a spec that compiles WITH a warning reports it, still ok", async () => {
    const result = await callJson<{
      ok: boolean;
      warnings: Array<{ code: string; path: string }>;
    }>(specCompileCheck, { spec: WORKFLOW_SPEC_WITH_WARNING, today: "2026-01-01" });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatchObject({ code: "accepted-but-unwired", path: "continuity" });
  });
});

describe("SpecSummarize", () => {
  test("reports shape, model, tools and permissions", async () => {
    const result = await callJson<{
      target: string;
      tools: string[];
      models: Array<{ model: string }>;
      permissions: { mode: string };
    }>(specSummarize, { spec: CLI_SPEC });
    expect(result.target).toBe("cli");
    expect(result.tools).toEqual(["bash", "read", "write"]);
    expect(result.models[0]?.model).toBe("claude-sonnet-4-6");
    expect(result.permissions.mode).toBe("default");
  });

  test("an unparseable spec is a readable refusal naming the problem", async () => {
    expect(await call(specSummarize, { spec: "target: nonsense" })).toContain("does not parse");
  });
});

describe("SpecDiff", () => {
  test("flags a granted tool as widening", async () => {
    const after = CLI_SPEC.replace("[read, write, bash]", "[read, write, bash, webFetch]");
    const result = await callJson<{ widens: boolean; changes: Array<{ kind: string }> }>(specDiff, {
      before: { spec: CLI_SPEC },
      after: { spec: after },
    });
    expect(result.widens).toBe(true);
    expect(result.changes.map((c) => c.kind)).toEqual(["tool-added"]);
  });

  test("an unchanged pair reports no changes", async () => {
    const result = await callJson<{ changed: boolean }>(specDiff, {
      before: { spec: CLI_SPEC },
      after: { spec: CLI_SPEC },
    });
    expect(result.changed).toBe(false);
  });

  test("each side can come from a file", async () => {
    write("a.yaml", CLI_SPEC);
    write("b.yaml", CLI_SPEC.replace("mode: default", "mode: auto"));
    const result = await callJson<{ widens: boolean }>(specDiff, {
      before: { path: "a.yaml" },
      after: { path: "b.yaml" },
    });
    expect(result.widens).toBe(true);
  });

  test("a broken side is named in the refusal", async () => {
    expect(
      await call(specDiff, { before: { spec: CLI_SPEC }, after: { spec: "target: nope" } }),
    ).toContain("after spec");
  });
});

describe("ToolInventory", () => {
  test("splits builtins from MCP tools and flags a dangling server", async () => {
    const spec = [
      "name: demo",
      "target: cli",
      "agent:",
      "  model: m",
      "  instructions: go",
      "tools: [read, mcp__thredz__post, mcp__ghost__do]",
      "mcp_servers:",
      "  thredz:",
      "    transport: stdio",
      "    command: bunx",
    ].join("\n");
    const result = await callJson<{
      builtin: string[];
      mcp: Array<{ tool: string; declared: boolean }>;
      dangling: string[];
    }>(toolInventory, { spec });
    expect(result.builtin).toEqual(["read"]);
    expect(result.dangling).toEqual(["mcp__ghost__do"]);
    expect(result.mcp.find((m) => m.tool === "mcp__thredz__post")?.declared).toBe(true);
  });

  test("category selectors are expanded the way the compiler expands them", async () => {
    const spec = CLI_SPEC.replace("tools: [read, write, bash]", "tools: [all-text]");
    const result = await callJson<{ categoriesExpanded: boolean; builtin: string[] }>(
      toolInventory,
      { spec },
    );
    expect(result.categoriesExpanded).toBe(true);
    expect(result.builtin.length).toBeGreaterThan(1);
  });

  test("without knownTools it says so rather than pretending to verify builtins", async () => {
    const result = await callJson<{ note?: string; unknown?: string[] }>(toolInventory, {
      spec: CLI_SPEC,
    });
    expect(result.note).toContain("were not checked");
    expect(result.unknown).toBeUndefined();
  });

  test("with knownTools, a granted tool outside the list is reported unknown", async () => {
    const result = await callJson<{ unknown: string[] }>(toolInventory, {
      spec: CLI_SPEC,
      knownTools: ["Read", "Write"],
    });
    expect(result.unknown).toEqual(["bash"]);
  });
});

describe("PermissionAudit", () => {
  test("an outward tool with no rule is a finding", async () => {
    const spec = CLI_SPEC.replace("[read, write, bash]", "[read, webFetch]");
    const result = await callJson<{ findings: Array<{ tool: string }>; fallback: string }>(
      permissionAudit,
      { spec },
    );
    expect(result.findings.map((f) => f.tool)).toEqual(["webFetch"]);
    expect(result.fallback).toBe("ask");
  });

  test("an MCP server's own destructive tool_flags are honoured", async () => {
    const spec = [
      "name: demo",
      "target: cli",
      "agent:",
      "  model: m",
      "  instructions: go",
      "tools: [mcp__thredz__post]",
      "mcp_servers:",
      "  thredz:",
      "    transport: stdio",
      "    command: bunx",
      "    tool_flags:",
      "      per_tool:",
      "        post:",
      "          destructive: true",
    ].join("\n");
    const result = await callJson<{ tools: Array<{ tool: string; destructive?: boolean }> }>(
      permissionAudit,
      { spec },
    );
    expect(result.tools[0]?.destructive).toBe(true);
  });

  test("a rule that names nothing granted is reported as unused", async () => {
    const spec = CLI_SPEC.replace("pattern: Read", "pattern: Nonexistent");
    const result = await callJson<{ unusedRules: Array<{ pattern: string }> }>(permissionAudit, {
      spec,
    });
    expect(result.unusedRules[0]?.pattern).toBe("Nonexistent");
  });
});

// ---------------------------------------------------------------------------
// harness-state tools
// ---------------------------------------------------------------------------

describe("PreflightRun", () => {
  test("a spec whose credentials are absent from the SUPPLIED env blocks", async () => {
    write("crewhaus.yaml", CLI_SPEC);
    const result = await callJson<{ ok: boolean; blocking: Array<{ area: string }> }>(
      preflightRun,
      {
        env: {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.some((i) => i.area === "credentials")).toBe(true);
  });

  test("supplying the credential in the env map clears it", async () => {
    write("crewhaus.yaml", CLI_SPEC);
    const result = await callJson<{ ok: boolean }>(preflightRun, {
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    });
    expect(result.ok).toBe(true);
  });

  test("the process environment is never consulted — the env argument is the env", async () => {
    write("crewhaus.yaml", CLI_SPEC);
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ambient-should-be-ignored";
    try {
      const result = await callJson<{ ok: boolean }>(preflightRun, { env: {} });
      expect(result.ok).toBe(false);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  test("a missing crewhaus.yaml is a blocking spec item, not a crash", async () => {
    const result = await callJson<{ blocking: Array<{ id: string }> }>(preflightRun, { env: {} });
    expect(result.blocking.some((i) => i.id === "spec.missing")).toBe(true);
  });

  test("blocking items carry a remediation where preflight has one", async () => {
    const result = await callJson<{ blocking: Array<{ remediation?: string }> }>(preflightRun, {
      env: {},
    });
    expect(result.blocking.some((i) => typeof i.remediation === "string")).toBe(true);
  });

  test("compiler warnings are folded in, and can be switched off", async () => {
    write("crewhaus.yaml", WORKFLOW_SPEC_WITH_WARNING);
    const withWarnings = await callJson<{ warnings: Array<{ message: string }> }>(preflightRun, {
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
      today: "2026-01-01",
    });
    expect(withWarnings.warnings.some((w) => w.message.includes("accepted-but-unwired"))).toBe(
      true,
    );

    const without = await callJson<{ warnings: Array<{ message: string }> }>(preflightRun, {
      env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
      compileWarnings: false,
    });
    expect(without.warnings.some((w) => w.message.includes("accepted-but-unwired"))).toBe(false);
  });

  test("it declares the socket capability it actually uses", () => {
    expect(preflightRun.scope).toBe("external");
    expect(preflightRun.ioCapability).toBe("network");
  });
});

describe("HarnessInventory", () => {
  test("finds harnesses, reports shape and bundle state, and sorts them", async () => {
    write("alpha/crewhaus.yaml", CLI_SPEC);
    write("beta/crewhaus.yaml", CLI_SPEC.replace("name: demo", "name: beta"));
    write("beta/dist/agent.ts", "// compiled");
    const result = await callJson<{
      count: number;
      harnesses: Array<{ dir: string; shape: string; bundle: string; specValid: boolean }>;
    }>(harnessInventory, {});
    expect(result.count).toBe(2);
    expect(result.harnesses.map((h) => h.dir)).toEqual(["alpha", "beta"]);
    expect(result.harnesses[0]?.bundle).toBe("missing-bundle");
    expect(result.harnesses[0]?.shape).toBe("cli");
    expect(result.harnesses[1]?.specValid).toBe(true);
  });

  test("state and vendor directories are never descended into", async () => {
    write("node_modules/pkg/crewhaus.yaml", CLI_SPEC);
    write(".crewhaus/tmp/crewhaus.yaml", CLI_SPEC);
    write("real/crewhaus.yaml", CLI_SPEC);
    const result = await callJson<{ harnesses: Array<{ dir: string }> }>(harnessInventory, {});
    expect(result.harnesses.map((h) => h.dir)).toEqual(["real"]);
  });

  test("a harness whose spec does not parse is still listed, marked invalid", async () => {
    write(
      "broken/crewhaus.yaml",
      ["name: broken", "target: cli", "agent:", "  model: m"].join("\n"),
    );
    const result = await callJson<{
      counts: { invalidSpecs: number };
      harnesses: Array<{ name?: string; specValid: boolean; firstIssue?: string }>;
    }>(harnessInventory, {});
    expect(result.counts.invalidSpecs).toBe(1);
    expect(result.harnesses[0]?.name).toBe("broken");
    expect(result.harnesses[0]?.firstIssue).toContain("agent.instructions");
  });

  test("a directory symlink is not followed out of the workspace", async () => {
    const dir = outsideDir();
    mkdirSync(path.join(dir, "sneaky"), { recursive: true });
    writeFileSync(path.join(dir, "sneaky", "crewhaus.yaml"), CLI_SPEC);
    symlinkSync(dir, path.join(tmp, "link"));
    const result = await callJson<{ count: number }>(harnessInventory, {});
    expect(result.count).toBe(0);
  });

  test("the same tree twice gives the same bytes", async () => {
    write("alpha/crewhaus.yaml", CLI_SPEC);
    write("beta/crewhaus.yaml", CLI_SPEC);
    expect(await call(harnessInventory, {})).toBe(await call(harnessInventory, {}));
  });

  test("paths are workspace-relative, so they feed straight into the other tools", async () => {
    write("fleet/alpha/crewhaus.yaml", CLI_SPEC);
    const result = await callJson<{
      harnesses: Array<{ dir: string; specPath: string }>;
    }>(harnessInventory, { root: "fleet" });
    expect(result.harnesses[0]).toMatchObject({
      dir: "fleet/alpha",
      specPath: "fleet/alpha/crewhaus.yaml",
    });
    const freshness = await callJson<{ bundles: Array<{ state: string }> }>(bundleFreshness, {
      dirs: [result.harnesses[0]?.dir as string],
    });
    expect(freshness.bundles[0]?.state).toBe("missing-bundle");
  });
});

describe("BundleFreshness", () => {
  function seed(dir: string, specMtime: number, bundleMtime?: number): void {
    const spec = write(`${dir}/crewhaus.yaml`, CLI_SPEC);
    utimesSync(spec, specMtime / 1000, specMtime / 1000);
    if (bundleMtime !== undefined) {
      const bundle = write(`${dir}/dist/agent.ts`, "// compiled");
      utimesSync(bundle, bundleMtime / 1000, bundleMtime / 1000);
    }
  }

  test("a bundle older than its spec is stale, with the fix", async () => {
    seed("stale", 2_000_000_000_000, 1_000_000_000_000);
    const result = await callJson<{
      bundles: Array<{ dir: string; state: string; remediation?: string }>;
    }>(bundleFreshness, { dirs: ["stale"] });
    expect(result.bundles[0]?.state).toBe("stale");
    expect(result.bundles[0]?.remediation).toContain("crewhaus compile");
  });

  test("a bundle newer than its spec is fresh", async () => {
    seed("fresh", 1_000_000_000_000, 2_000_000_000_000);
    const result = await callJson<{ bundles: Array<{ state: string }> }>(bundleFreshness, {
      dirs: ["fresh"],
    });
    expect(result.bundles[0]?.state).toBe("fresh");
  });

  test("discovers harnesses when no directories are given, and staleOnly filters", async () => {
    seed("stale", 2_000_000_000_000, 1_000_000_000_000);
    seed("fresh", 1_000_000_000_000, 2_000_000_000_000);
    const all = await callJson<{ checked: number; counts: { stale: number } }>(bundleFreshness, {});
    expect(all.checked).toBe(2);
    expect(all.counts.stale).toBe(1);
    const filtered = await callJson<{ bundles: Array<{ dir: string }> }>(bundleFreshness, {
      staleOnly: true,
    });
    expect(filtered.bundles.map((b) => b.dir)).toEqual(["stale"]);
  });

  test("a directory with no spec is reported, not skipped silently", async () => {
    mkdirSync(path.join(tmp, "empty"), { recursive: true });
    const result = await callJson<{ bundles: Array<{ state: string }> }>(bundleFreshness, {
      dirs: ["empty"],
    });
    expect(result.bundles[0]?.state).toBe("missing-spec");
  });
});

describe("AuditVerify", () => {
  async function seedAudit(): Promise<void> {
    const log = await openAuditLog({ rootDir: path.join(tmp, ".crewhaus", "audit") });
    await log.append({ kind: "tool_call", payload: { tool: "Read" } });
    await log.append({ kind: "tool_call", payload: { tool: "Write" } });
    await log.append({ kind: "tool_call", payload: { tool: "Bash" } });
  }

  function auditFiles(): string[] {
    const dir = path.join(tmp, ".crewhaus", "audit");
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(dir, n));
  }

  test("an intact chain verifies", async () => {
    await seedAudit();
    const result = await callJson<{ ok: boolean; recordsChecked: number }>(auditVerify, {});
    expect(result.ok).toBe(true);
    expect(result.recordsChecked).toBe(3);
  });

  test("an edited record is caught, with the file and line", async () => {
    await seedAudit();
    const file = auditFiles()[0] as string;
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[1] as string) as { payload: unknown };
    tampered.payload = { tool: "Bash", injected: true };
    lines[1] = JSON.stringify(tampered);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const result = await callJson<{ ok: boolean; break: { line: number; reason: string } }>(
      auditVerify,
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.break.line).toBe(2);
    expect(result.break.reason.length).toBeGreaterThan(0);
  });

  test("a missing audit directory is a readable refusal", async () => {
    expect(await call(auditVerify, {})).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// evidence tools
// ---------------------------------------------------------------------------

function evalDoc(samples: ReadonlyArray<[string, boolean, number]>): Record<string, unknown> {
  return {
    runId: "run_000000000000000a",
    samples: samples.map(([sampleId, passed, score]) => ({
      sampleId,
      grades: { overall: { passed, score, rationale: "" } },
    })),
    aggregates: { passRate: samples.filter(([, p]) => p).length / samples.length },
    config: { datasetName: "golden" },
  };
}

describe("EvalBaselineCompare", () => {
  test("a regression fails the gate and names the sample", async () => {
    const result = await callJson<{ verdict: string; regressions: Array<{ sampleId: string }> }>(
      evalBaselineCompare,
      {
        baseline: evalDoc([
          ["a", true, 1],
          ["b", true, 1],
        ]),
        candidate: evalDoc([
          ["a", true, 1],
          ["b", false, 0],
        ]),
      },
    );
    expect(result.verdict).toBe("fail");
    expect(result.regressions[0]?.sampleId).toBe("b");
  });

  test("both documents can be read from contained files", async () => {
    write("base.json", JSON.stringify(evalDoc([["a", true, 1]])));
    write("cand.json", JSON.stringify(evalDoc([["a", true, 1]])));
    const result = await callJson<{ verdict: string }>(evalBaselineCompare, {
      baselinePath: "base.json",
      candidatePath: "cand.json",
    });
    expect(result.verdict).toBe("pass");
  });

  test("a document as JSON TEXT is accepted too", async () => {
    const result = await callJson<{ verdict: string }>(evalBaselineCompare, {
      baseline: JSON.stringify(evalDoc([["a", true, 1]])),
      candidate: JSON.stringify(evalDoc([["a", true, 1]])),
    });
    expect(result.verdict).toBe("pass");
  });

  test("a document that is not an eval run is refused by name", async () => {
    expect(
      await call(evalBaselineCompare, {
        baseline: { nope: 1 },
        candidate: evalDoc([["a", true, 1]]),
      }),
    ).toContain("baseline");
  });

  test("passing both a document and a path for one side is refused", async () => {
    write("base.json", JSON.stringify(evalDoc([["a", true, 1]])));
    expect(
      await call(evalBaselineCompare, {
        baseline: evalDoc([["a", true, 1]]),
        baselinePath: "base.json",
        candidate: evalDoc([["a", true, 1]]),
      }),
    ).toContain("not both");
  });
});

describe("session tools", () => {
  function event(kind: string, payload: unknown, ts: number): string {
    return JSON.stringify({ ts, version: 1, kind, payload });
  }

  function seedSessions(): void {
    write(
      ".crewhaus/sessions/sess_0000000000000001.jsonl",
      `${[
        event("user_message", { content: "hi" }, 1_000),
        event("tool_use", { id: "tu_1", name: "Read" }, 2_000),
        event("tool_stats", { toolName: "Read", durationMs: 12, isError: false }, 2_100),
        event("error", { message: "provider 429" }, 3_000),
        event(
          "cost_accrual",
          {
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
            costUsdMicros: 450,
            inputTokens: 100,
            outputTokens: 20,
          },
          Date.UTC(2026, 0, 1, 12),
        ),
      ].join("\n")}\n`,
    );
    write(
      ".crewhaus/sessions/sess_0000000000000002.jsonl",
      `${event("user_message", { content: "second" }, 4_000)}\nnot json at all\n`,
    );
  }

  test("SessionSummarize counts kinds, tools and errors across every log", async () => {
    seedSessions();
    const result = await callJson<{
      files: number;
      malformedLines: number;
      byKind: Array<{ kind: string; count: number }>;
      tools: Array<{ name: string; calls: number }>;
      errors: Array<{ message: string }>;
    }>(sessionSummarize, {});
    expect(result.files).toBe(2);
    expect(result.malformedLines).toBe(1);
    expect(result.byKind.find((k) => k.kind === "user_message")?.count).toBe(2);
    expect(result.tools).toEqual([{ name: "Read", calls: 1, errors: 0, totalDurationMs: 12 }]);
    expect(result.errors[0]?.message).toBe("provider 429");
  });

  test("SessionSummarize can be scoped to one session id", async () => {
    seedSessions();
    const result = await callJson<{ files: number; events: number }>(sessionSummarize, {
      sessionId: "sess_0000000000000002",
    });
    expect(result.files).toBe(1);
    expect(result.events).toBe(1);
  });

  test("a session id that is really a path is refused", async () => {
    seedSessions();
    expect(await call(sessionSummarize, { sessionId: "../../etc/passwd" })).toContain(
      "it looks like a path",
    );
  });

  test("TraceQuery filters by kind and truncates long payloads", async () => {
    seedSessions();
    const result = await callJson<{
      matched: number;
      events: Array<{ kind: string; payload: string; payloadTruncated?: boolean }>;
    }>(traceQuery, { kinds: ["tool_use"], maxPayloadChars: 10 });
    expect(result.matched).toBe(1);
    expect(result.events[0]?.kind).toBe("tool_use");
    expect(result.events[0]?.payloadTruncated).toBe(true);
    expect(result.events[0]?.payload.length).toBeLessThanOrEqual(11);
  });

  test("TraceQuery honours a timestamp window and a payload substring", async () => {
    seedSessions();
    expect(
      (await callJson<{ matched: number }>(traceQuery, { sinceTs: 2_000, untilTs: 3_000 })).matched,
    ).toBe(3);
    expect((await callJson<{ matched: number }>(traceQuery, { contains: "429" })).matched).toBe(1);
  });

  test("TraceQuery pages deterministically from either end", async () => {
    seedSessions();
    const oldest = await callJson<{ events: Array<{ session: string; kind: string }> }>(
      traceQuery,
      {
        limit: 1,
      },
    );
    const newest = await callJson<{ events: Array<{ session: string; kind: string }> }>(
      traceQuery,
      {
        limit: 1,
        order: "newest",
      },
    );
    expect(oldest.events[0]?.session).toBe("sess_0000000000000001");
    expect(newest.events[0]?.session).toBe("sess_0000000000000002");
    expect(await call(traceQuery, { limit: 2 })).toBe(await call(traceQuery, { limit: 2 }));
  });

  test("CostSummarize totals by model, provider and UTC day", async () => {
    seedSessions();
    const result = await callJson<{
      accruals: number;
      totals: { costUsdMicros: number; inputTokens: number };
      byModel: Array<{ key: string; costUsdMicros: number }>;
      byDay: Array<{ key: string }>;
    }>(costSummarize, {});
    expect(result.accruals).toBe(1);
    expect(result.totals.costUsdMicros).toBe(450);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.byModel[0]?.key).toBe("claude-sonnet-4-6");
    expect(result.byDay[0]?.key).toBe("2026-01-01");
  });

  test("a harness that never tracked cost reports zero, not an estimate", async () => {
    write(".crewhaus/sessions/sess_0000000000000003.jsonl", `${event("user_message", {}, 1)}\n`);
    const result = await callJson<{ accruals: number; totals: { costUsdMicros: number } }>(
      costSummarize,
      {},
    );
    expect(result).toMatchObject({ accruals: 0, totals: { costUsdMicros: 0 } });
  });

  test("a missing sessions directory is a readable refusal", async () => {
    expect(await call(sessionSummarize, {})).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// the boundary, pushed on deliberately
// ---------------------------------------------------------------------------

describe("containment, adversarially", () => {
  test("PreflightRun refuses a crewhaus.yaml that is a symlink out of the workspace", async () => {
    // The regression this guards: `runPreflight` reads
    // `<harnessDir>/crewhaus.yaml` itself, so passing it a directory whose
    // spec is a symlink out of the workspace made it read — and REPORT —
    // a file every other tool here refuses. The findings echoed the outside
    // file's own keys and values back to the caller.
    const dir = outsideDir();
    writeFileSync(
      path.join(dir, "secret.yaml"),
      [
        "name: private",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: x",
        "mcp_servers:",
        "  leaky:",
        "    transport: stdio",
        "    command: /outside/binary",
        "    env:",
        "      LEAKED_KEY: ${SOME}",
      ].join("\n"),
    );
    mkdirSync(path.join(tmp, "h1"), { recursive: true });
    symlinkSync(path.join(dir, "secret.yaml"), path.join(tmp, "h1", "crewhaus.yaml"));

    const result = await call(preflightRun, { harnessDir: "h1", env: {} });
    expect(result).toContain("escapes the workspace root");
    // Nothing from the outside file may appear in the answer.
    expect(result).not.toContain("LEAKED_KEY");
    expect(result).not.toContain("/outside/binary");
  });

  test("PreflightRun still reports a genuinely missing spec as a blocking item", async () => {
    mkdirSync(path.join(tmp, "empty"), { recursive: true });
    const result = await callJson<{ ok: boolean; blocking: Array<{ area: string }> }>(
      preflightRun,
      {
        harnessDir: "empty",
        env: {},
      },
    );
    expect(result.ok).toBe(false);
    expect(result.blocking.some((b) => b.area === "spec")).toBe(true);
  });

  test("PreflightRun refuses a spec over the size cap instead of handing it to preflight", async () => {
    write("big/crewhaus.yaml", "#".repeat(5 * 1024 * 1024));
    expect(await call(preflightRun, { harnessDir: "big", env: {} })).toContain("over the");
  });

  test("a spec that IS contained still runs preflight normally", async () => {
    write("ok/crewhaus.yaml", CLI_SPEC);
    const result = await callJson<{ harnessDir: string }>(preflightRun, {
      harnessDir: "ok",
      env: {},
    });
    expect(result.harnessDir).toBe("ok");
  });

  test("a dangling symlink cannot be read, whatever it points at", async () => {
    symlinkSync("/nonexistent-outside-target/secret.yaml", path.join(tmp, "dangling.yaml"));
    const result = await call(specValidate, { path: "dangling.yaml" });
    expect(result).not.toContain('"valid"');
    expect(result).toContain("dangling.yaml");
  });

  test("a NUL in a path is refused at the gate, not left to fail at the syscall", async () => {
    const withNul = `spec${String.fromCharCode(0)}.yaml`;
    expect(await call(specValidate, { path: withNul })).toContain("escapes the workspace root");
  });

  test("a refusal does not echo a megabyte of caller-supplied path back into context", async () => {
    const result = await call(specValidate, { path: `${"a/".repeat(5000)}x.yaml` });
    expect(result.length).toBeLessThan(400);
  });

  test("no refusal shape leaks the workspace's absolute path", async () => {
    // Every branch of `readContained` that a caller can reach from outside,
    // including the one that used to splice a node error (which carries the
    // absolute path) straight into the message.
    mkdirSync(path.join(tmp, "adir"), { recursive: true });
    write("huge2.yaml", "#".repeat(5 * 1024 * 1024));
    for (const rel of ["nope.yaml", "adir", "huge2.yaml", "../escape.yaml"]) {
      const result = await call(specValidate, { path: rel });
      expect({ rel, leaked: result.includes(tmp) }).toEqual({ rel, leaked: false });
    }
  });
});

describe("bounded work", () => {
  test("AuditVerify refuses a chain larger than maxBytes rather than walking it", async () => {
    write(".crewhaus/audit/2026-01-01.jsonl", `${"x".repeat(4096)}\n`);
    const result = await call(auditVerify, { maxBytes: 100 });
    expect(result).toContain("over the 100 limit");
    // And the default lets the same chain through.
    expect(await call(auditVerify, {})).not.toContain("over the");
  });

  test("SpecCompileCheck counts real UTF-8 bytes, not UTF-16 code units", async () => {
    const result = await callJson<{ ok: boolean; totalBytes: number; fileCount: number }>(
      specCompileCheck,
      { spec: CLI_SPEC, today: "2026-01-01" },
    );
    expect(result.ok).toBe(true);
    // A bundle is many kilobytes of source; the only claim that matters here
    // is that the figure is a byte count of real files.
    expect(result.totalBytes).toBeGreaterThan(result.fileCount);
  });
});

describe("secret hygiene", () => {
  const SPEC_WITH_ARGV_SECRET = [
    "name: leaky",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: x",
    "mcp_servers:",
    "  vendor:",
    "    transport: stdio",
    "    command: npx",
    "    args:",
    '      - "-y"',
    '      - "@vendor/mcp-server"',
    '      - "--api-key"',
    '      - "sk-live-abcdef0123456789abcdef"',
    '      - "--token=ghp_ABCDEFGH0123456789abcdefghijklmnop"',
  ].join("\n");

  test("a credential in an MCP server's argv is redacted, not echoed", async () => {
    const result = await callJson<{
      mcpServers: Array<{ args?: string[]; redactedArgs?: number }>;
    }>(specSummarize, { spec: SPEC_WITH_ARGV_SECRET });
    const server = result.mcpServers[0];
    expect(server?.args).toEqual([
      "-y",
      "@vendor/mcp-server",
      "--api-key",
      "(redacted)",
      "--token=(redacted)",
    ]);
    expect(server?.redactedArgs).toBe(2);
  });

  test("the whole report carries neither secret verbatim", async () => {
    const raw = await call(specSummarize, { spec: SPEC_WITH_ARGV_SECRET });
    expect(raw).not.toContain("sk-live-abcdef0123456789abcdef");
    expect(raw).not.toContain("ghp_ABCDEFGH0123456789abcdefghijklmnop");
  });

  test("an sse endpoint keeps neither its query string nor its userinfo", async () => {
    const spec = [
      "name: remote",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: x",
      "mcp_servers:",
      "  remote:",
      "    transport: sse",
      '    url: "https://user:hunter2@mcp.example.com/sse?token=shhh"',
    ].join("\n");
    const raw = await call(specSummarize, { spec });
    expect(raw).toContain("https://mcp.example.com/sse");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("shhh");
  });
});

describe("permission reporting matches the engine", () => {
  const specWithRules = (rules: string): string =>
    [
      "name: demo",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: x",
      "tools: [read, bash]",
      "permissions:",
      "  mode: default",
      "  rules:",
      rules,
    ].join("\n");

  test("a rule the matcher cannot compile is reported, not silently ignored", async () => {
    const result = await callJson<{
      malformedRules: Array<{ type: string; pattern: string }>;
      findings: Array<{ tool: string; reason: string }>;
    }>(permissionAudit, {
      spec: specWithRules(["    - type: alwaysDeny", '      pattern: "Bash(rm"'].join("\n")),
    });
    expect(result.malformedRules).toEqual([{ type: "alwaysDeny", pattern: "Bash(rm" }]);
    expect(result.findings.some((f) => f.reason.includes("fails a broken deny CLOSED"))).toBe(true);
  });

  test("a broken deny gates every tool, exactly as the engine fails closed", async () => {
    const result = await callJson<{ tools: Array<{ tool: string; decision: string }> }>(
      permissionAudit,
      { spec: specWithRules(["    - type: alwaysDeny", '      pattern: "Bash(rm"'].join("\n")) },
    );
    expect(result.tools.map((t) => t.decision)).toEqual(["deny", "deny"]);
  });

  test("a broken ALLOW is dropped instead, so it covers nothing", async () => {
    const result = await callJson<{
      tools: Array<{ tool: string; decision: string }>;
      malformedRules: unknown[];
    }>(permissionAudit, {
      spec: specWithRules(["    - type: alwaysAllow", '      pattern: "Bash(rm"'].join("\n")),
    });
    expect(result.malformedRules.length).toBe(1);
    expect(result.tools.every((t) => t.decision !== "allow")).toBe(true);
  });

  test("plan mode says the rules are not reached", async () => {
    const spec = [
      "name: demo",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: x",
      "tools: [read]",
      "permissions:",
      "  mode: plan",
      "  rules:",
      "    - type: alwaysAllow",
      "      pattern: Read",
    ].join("\n");
    const result = await callJson<{
      modeOverridesRules: boolean;
      findings: Array<{ reason: string }>;
    }>(permissionAudit, { spec });
    expect(result.modeOverridesRules).toBe(true);
    expect(result.findings.some((f) => f.reason.includes("consulting a single rule"))).toBe(true);
  });
});

describe("the eval gate does not take a document's word for it", () => {
  const doc = (
    samples: Array<{ id: string; passed: boolean }>,
    passRate?: number,
  ): Record<string, unknown> => ({
    runId: "run_000000000000000c",
    samples: samples.map((s) => ({
      sampleId: s.id,
      grades: { overall: { passed: s.passed, score: s.passed ? 1 : 0 } },
    })),
    ...(passRate !== undefined ? { aggregates: { passRate } } : {}),
    config: { datasetName: "golden" },
  });

  test("a declared pass rate outside 0..1 is refused and recomputed", async () => {
    const result = await callJson<{ passRate: { candidate: number }; notes: string[] }>(
      evalBaselineCompare,
      {
        baseline: doc([{ id: "a", passed: true }], 1),
        candidate: doc([{ id: "a", passed: false }], 99),
        minPassRate: 0.9,
      },
    );
    expect(result.passRate.candidate).toBe(0);
    expect(result.notes.some((n) => n.includes("outside 0..1"))).toBe(true);
  });

  test("a declared pass rate its own samples contradict is flagged", async () => {
    const result = await callJson<{ notes: string[] }>(evalBaselineCompare, {
      baseline: doc([{ id: "a", passed: true }], 1),
      candidate: doc([{ id: "a", passed: false }], 1),
    });
    expect(result.notes.some((n) => n.includes("its own samples give 0"))).toBe(true);
  });

  test("a repeated sample id is reported, because only the last of them is compared", async () => {
    const result = await callJson<{ notes: string[]; regressions: unknown[] }>(
      evalBaselineCompare,
      {
        baseline: doc([{ id: "a", passed: true }]),
        candidate: doc([
          { id: "a", passed: false },
          { id: "a", passed: true },
        ]),
      },
    );
    expect(result.regressions).toEqual([]);
    expect(result.notes.some((n) => n.includes("repeats 1 sample id"))).toBe(true);
  });
});
