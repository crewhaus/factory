/**
 * 0.7.1 — `tool_config` reaches every configurable tool, on every shape
 * (config-delivery#0/#2/#9/#11/#12, shape-reach#2/#9, flag-truth-5#1,
 * security-12#7). Before this, only six builtins had a boot registrar, a
 * package's documented block (`tool_config.http`) reached nothing, and the
 * compile said nothing about it.
 */
import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS, TOOL_BOOT_REGISTRARS } from "@crewhaus/tool-categories";
import { compile } from "./index";

const cli = (body: string): string =>
  `name: c\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: i\n${body}`;

const file = (yaml: string, path: string): string =>
  compile(yaml).files.find((f) => f.path === path)?.content ?? "";

describe("every configurable package's documented block reaches its registrar", () => {
  test("a sweep over the registrar table, derived rather than listed", () => {
    let swept = 0;
    for (const [symbol, reg] of Object.entries(TOOL_BOOT_REGISTRARS)) {
      if (reg.source !== "tool_config") continue;
      const key = Object.entries(BUILTIN_TOOLS).find(
        ([, e]) => e.initSymbol === symbol && e.shapes === undefined,
      )?.[0];
      const family = reg.keys?.[0];
      expect({ symbol, key: key !== undefined, family: family !== undefined }).toEqual({
        symbol,
        key: true,
        family: true,
      });
      // The code-execution block is the one the spec layer constrains.
      const [yaml, json] =
        symbol === "registerCodeExecutionConfig"
          ? ["{ defaultTimeoutMs: 1 }", '{"defaultTimeoutMs":1}']
          : ["{ a: 1 }", '{"a":1}'];
      const ts = file(cli(`tools: [${key}]\ntool_config:\n  ${family}: ${yaml}\n`), "agent.ts");
      expect({ symbol, emitted: ts.includes(`${symbol}(${json});`) }).toEqual({
        symbol,
        emitted: true,
      });
      swept += 1;
    }
    // fetch, webFetch, codeExecution, imageGenerate, http, codehost, notify,
    // obs, defi, chainread, federationDiscover, vectorDelete, token.
    expect(swept).toBe(13);
  });

  test("tool_config.http configures the http tools, and the README says so", () => {
    const yaml = cli(
      'tools: [httpRequest, headRequest]\ntool_config:\n  http:\n    allowed_origins: ["https://api.example.com"]\n',
    );
    const result = compile(yaml);
    const ts = result.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(ts).toContain('registerHttpConfig({"allowed_origins":["https://api.example.com"]});');
    expect(ts).toContain("import { headRequest, httpRequest, registerHttpConfig }");
    expect(result.warnings.filter((w) => w.code === "tool-config-unused")).toEqual([]);
    const readme = result.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain(
      "| `httpRequest` | agent | external | every call carries a justification; configured by `tool_config.http` |",
    );
    expect(readme).toContain(
      "| `headRequest` | agent | external | configured by `tool_config.http` |",
    );
  });

  test("the registered name reaches the registrar: tool_config.WebFetch restricts WebFetch", () => {
    expect(
      file(
        cli(
          "tools: [webFetch]\ntool_config:\n  WebFetch: { allowed_domains: [docs.example.com] }\n",
        ),
        "agent.ts",
      ),
    ).toContain('registerWebFetchConfig({"allowed_domains":["docs.example.com"]});');
  });

  test("the codeExecution alias reaches code execution only", () => {
    const ts = file(
      cli(
        "tools: [webFetch, fetch, python]\ntool_config:\n  codeExecution: { defaultTimeoutMs: 5000 }\n",
      ),
      "agent.ts",
    );
    expect(ts).toContain('registerCodeExecutionConfig({"defaultTimeoutMs":5000});');
    expect(ts).not.toContain("registerWebFetchConfig(");
    expect(ts).not.toContain("registerFetchConfig(");
  });

  test("tool_config.fetch reaches DependencyAudit's mirror allow-list on its own", () => {
    expect(
      file(
        cli(
          'tools: [dependencyAudit]\ntool_config:\n  fetch: { allowed_origins: ["https://osv.example"] }\n',
        ),
        "agent.ts",
      ),
    ).toContain('registerFetchConfig({"allowed_origins":["https://osv.example"]});');
  });

  test("the browser shape registers imageGenerate's block like the cli shape does", () => {
    const yaml = [
      "name: b",
      "target: browser",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "tools: [imageGenerate]",
      "tool_config:",
      "  imageGenerate: { provider: mock }",
    ].join("\n");
    expect(file(yaml, "agent.ts")).toContain('registerImageGenerationConfig({"provider":"mock"});');
  });
});

describe("what the compile refuses, and what it warns about", () => {
  test("two different blocks for one package are refused, naming both keys", () => {
    expect(() =>
      compile(
        cli(
          'tools: [httpRequest]\ntool_config:\n  http: { allowed_origins: ["https://a.example"] }\n  httpRequest: { allowed_origins: ["https://b.example"] }\n',
        ),
      ),
    ).toThrow(
      "tool_config.httpRequest: tool_config.http and tool_config.httpRequest both configure the http tools, and they differ. Keep one block, under tool_config.http.",
    );
  });

  test("two workflow steps that configure one registrar differently are refused", () => {
    const yaml = [
      "name: w",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: a",
      "    instructions: a",
      "    tools: [fetch]",
      '    tool_config: { fetch: { allowed_origins: ["https://a.example"] } }',
      "  - name: b",
      "    instructions: b",
      "    tools: [fetch]",
      '    tool_config: { fetch: { allowed_origins: ["https://b.example"] } }',
    ].join("\n");
    expect(() => compile(yaml)).toThrow(
      "steps[0].tool_config.fetch and steps[1].tool_config.fetch both configure Fetch",
    );
  });

  test("a key nothing reads is a tool-config-unused warning naming the fix", () => {
    const result = compile(
      cli("tools: [read]\ntool_config:\n  codehost: { token_env: GITHUB_TOKEN }\n"),
    );
    expect(result.warnings.filter((w) => w.code === "tool-config-unused")).toEqual([
      {
        code: "tool-config-unused",
        path: "tool_config.codehost",
        message:
          "ignored, because no tool in tools reads it: it configures the codehost tools. Add one of them to tools, or remove the block.",
      },
    ]);
  });

  test("a model pool candidate: its package key is read per call, a conflict is refused", () => {
    const pool = (block: string): string =>
      cli(
        [
          "  model_pool:",
          "    candidates:",
          "      - model: claude-haiku-4-5",
          `        tool_config: ${block}`,
          "      - model: claude-opus-4-8",
          "tools: [httpRequest]",
          "",
        ].join("\n"),
      );
    const ok = compile(pool('{ http: { allowed_origins: ["https://a.example"] } }'));
    expect(ok.warnings.filter((w) => w.code === "tool-config-unused")).toEqual([]);
    expect(() =>
      compile(
        pool(
          '{ http: { allowed_origins: ["https://a.example"] }, HttpRequest: { allowed_origins: [] } }',
        ),
      ),
    ).toThrow(
      "agent.model_pool.candidates[0].tool_config.http and agent.model_pool.candidates[0].tool_config.HttpRequest both configure httpRequest",
    );
  });
});

describe("$VAR in tool_config", () => {
  test("is read at boot, listed in the README, and never compiled in", () => {
    const yaml = cli(
      'tools: [oraclePriceRead]\ntool_config:\n  defi:\n    rpc: { "1": $ETH_RPC_URL }\n',
    );
    const result = compile(yaml);
    const ts = result.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(ts).toContain(
      'applyToolConfig(registerDefiConfig, {"rpc":{"1":"$ETH_RPC_URL"}}, "tool_config.defi", process.env);',
    );
    expect(ts).toContain('import { applyToolConfig } from "@crewhaus/tool-categories";');
    const readme = result.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("- `ETH_RPC_URL`");
  });

  test("a credential-shaped value that is not a valid reference is refused", () => {
    expect(() =>
      compile(
        cli(
          'tools: [vectorDelete]\ntool_config:\n  vectorDelete: { backend: qdrant, url: "https://q.example", collection: c, api_key: "${QDRANT_KEY}" }\n',
        ),
      ),
    ).toThrow(
      "tool_config.vectorDelete.api_key looks like an environment reference but is not one. Write $UPPER_SNAKE_CASE",
    );
  });
});
