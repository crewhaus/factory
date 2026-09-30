/**
 * 0.7.1 — `tool_config` reaches every configurable tool, on every shape
 * (config-delivery#0/#2/#9/#11/#12, shape-reach#2/#9, flag-truth-5#1,
 * security-12#7). Before this, only six builtins had a boot registrar, a
 * package's documented block (`tool_config.http`) reached nothing, and the
 * compile said nothing about it.
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { BUILTIN_TOOLS, TOOL_BOOT_REGISTRARS } from "@crewhaus/tool-categories";
import { compile, lower, toolSitesOf } from "./index";

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
    // obs, defi, chainread, federationDiscover, objectstore, secure,
    // vectorDelete, proc, token, chaincall.
    expect(swept).toBe(17);
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

  // config-delivery#11 / permission-integration#10 — 0.7.0's README read two
  // hand-kept six-name lists: every newer external tool said "built-in",
  // imageGenerate was "justification-gated" (it never was), chatPost's real
  // gate went unmentioned, and any tool_config key read as "configured" with
  // no registrar behind it.
  test("the README states each tool's real scope, gate and configuration", () => {
    const result = compile(
      cli(
        "tools: [httpRequest, chatPost, imageGenerate, webFetch, tableProfile]\ntool_config:\n  webFetch: { allowed_domains: [a.example] }\n  tableProfile: { a: 1 }\n",
      ),
    );
    const readme = result.files.find((f) => f.path === "README.md")?.content ?? "";
    const row = (key: string): string =>
      readme.split("\n").find((l) => l.startsWith(`| \`${key}\` |`)) ?? "";
    expect(row("chatPost")).toBe(
      "| `chatPost` | agent | external | every call carries a justification |",
    );
    expect(row("httpRequest")).toBe(
      "| `httpRequest` | agent | external | every call carries a justification |",
    );
    expect(row("imageGenerate")).toBe("| `imageGenerate` | agent | external | — |");
    expect(row("webFetch")).toBe(
      "| `webFetch` | agent | external | configured by `tool_config.webFetch` |",
    );
    // A block no registrar receives is not reported as configuring anything;
    // the compile says it is ignored instead.
    expect(row("tableProfile")).toBe("| `tableProfile` | agent | built-in | — |");
    expect(
      result.warnings.some(
        (w) => w.code === "tool-config-unused" && w.message.includes("tableProfile"),
      ),
    ).toBe(true);
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

  // config-delivery#9 — 0.7.0's cli and managed emitters handed the
  // codeExecution block to every tool with a registrar: webFetch, fetch AND
  // imageGenerate. Both spellings, both emitters, and a sibling's own block
  // still reaching it.
  test("neither spelling of the alias reaches imageGenerate, webFetch or fetch, on cli or managed", () => {
    const managed = (config: string): string =>
      [
        "name: m",
        "target: managed",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  tools: [webFetch, fetch, imageGenerate, python]",
        "  tool_config:",
        `    ${config}`,
        "tenants:",
        "  - id: t1",
        "    budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }",
      ].join("\n");
    const specs = {
      cli: (config: string) =>
        cli(`tools: [webFetch, fetch, imageGenerate, python]\ntool_config:\n  ${config}\n`),
      managed,
    };
    for (const [shape, spec] of Object.entries(specs)) {
      for (const alias of ["codeExecution", "code_execution"]) {
        const ts = file(spec(`${alias}: { defaultTimeoutMs: 4321 }`), "agent.ts");
        expect({
          shape,
          alias,
          calls: ts.split("registerCodeExecutionConfig(").length - 1,
        }).toEqual({
          shape,
          alias,
          calls: 1,
        });
        expect(ts).toContain('registerCodeExecutionConfig({"defaultTimeoutMs":4321});');
        for (const other of [
          "registerWebFetchConfig",
          "registerFetchConfig",
          "registerImageGenerationConfig",
        ]) {
          expect({ shape, alias, other, present: ts.includes(other) }).toEqual({
            shape,
            alias,
            other,
            present: false,
          });
        }
      }
    }
    const both = file(
      cli(
        "tools: [webFetch, python]\ntool_config:\n  webFetch: { allowed_domains: [a.example] }\n  code_execution: { warmPoolSize: 1 }\n",
      ),
      "agent.ts",
    );
    expect(both).toContain('registerWebFetchConfig({"allowed_domains":["a.example"]});');
    expect(both).toContain('registerCodeExecutionConfig({"warmPoolSize":1});');
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

  test("a candidate's code-execution cap under one tool's key, with the others listed, is a warning", () => {
    const pool = (block: string): string =>
      cli(
        [
          "  model_pool:",
          "    candidates:",
          "      - model: claude-haiku-4-5",
          `        tool_config: ${block}`,
          "      - model: claude-opus-4-8",
          "tools: [python, shell]",
          "",
        ].join("\n"),
      );
    const partial = (block: string) =>
      compile(pool(block)).warnings.filter((w) => w.code === "tool-config-partial-cap");
    expect(partial("{ python: { max_timeout_ms: 1000 } }")).toEqual([
      {
        code: "tool-config-partial-cap",
        path: "agent.model_pool.candidates[0].tool_config.python",
        message:
          "caps Python only: a model pool candidate's block applies to the tool it is written under, so Shell keeps the boot cap for this candidate. To cap all of them, write it under agent.model_pool.candidates[0].tool_config.codeExecution.",
      },
    ]);
    expect(partial("{ codeExecution: { max_timeout_ms: 1000 } }")).toEqual([]);
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
      /^tool_config\.vectorDelete\.api_key: looks like an environment reference, but is not one\. Write \$UPPER_SNAKE_CASE/,
    );
  });
});

describe("a block its registrar would refuse at boot fails the compile", () => {
  // 0.7.0 ignored these blocks, so the bundle booted; 0.7.1 applies them, and
  // the registrar refuses them. Compile says so, with the key and the fix,
  // rather than the harness stopping at start.
  test("an allow-list entry with no scheme", () => {
    expect(() =>
      compile(
        cli(
          "tools: [httpRequest]\ntool_config:\n  http:\n    allowed_origins: [api.example.com]\n",
        ),
      ),
    ).toThrow(
      'tool_config.http.allowed_origins[0]: "api.example.com" is not an origin: it has no scheme. Write "https://api.example.com".',
    );
  });

  test("a key the registrar refuses: chainread cannot open private addresses", () => {
    expect(() =>
      compile(
        cli("tools: [evmGetBlock]\ntool_config:\n  chainread:\n    allow_private_hosts: true\n"),
      ),
    ).toThrow(
      "tool_config.chainread.allow_private_hosts: is not accepted: a spec cannot open loopback or private addresses.",
    );
  });

  test("the path is the site's own, on a nested shape too", () => {
    const yaml = [
      "name: w",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: fetch",
      "    instructions: i",
      "    tools: [httpRequest]",
      "    tool_config:",
      "      http: { allowed_origins: [api.example.com] }",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(/^steps\[0\]\.tool_config\.http\.allowed_origins\[0\]: /);
  });
});

describe("README rows and boot errors name the block where the spec wrote it", () => {
  // The path each shape's diagnostics use (toolSitesOf), not a flat
  // `tool_config`: channel and managed nest the block under `agent`.
  const block =
    "http:\n      allowed_origins: [https://api.example.com]\n      headers: { Authorization: $API_TOKEN }";
  const specs: Record<string, string> = {
    channel: [
      "name: ch",
      "target: channel",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  tools: [httpRequest]",
      "  tool_config:",
      `    ${block.replaceAll("\n      ", "\n      ")}`,
      "channels:",
      "  slack:",
      "    botToken: $SLACK_BOT_TOKEN",
      "    signingSecret: $SLACK_SIGNING_SECRET",
      "routing:",
      "  sessionKey: thread",
    ].join("\n"),
    managed: [
      "name: m",
      "target: managed",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  tools: [httpRequest]",
      "  tool_config:",
      `    ${block}`,
      "tenants:",
      "  - id: t1",
      "    budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }",
    ].join("\n"),
    workflow: [
      "name: w",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: call",
      "    instructions: i",
      "    tools: [httpRequest]",
      "    tool_config:",
      `      ${block.replaceAll("\n      ", "\n        ")}`,
    ].join("\n"),
  };
  for (const [shape, yaml] of Object.entries(specs)) {
    test(shape, () => {
      const [site] = toolSitesOf(lower(parseSpec(yaml)));
      const where = `${site?.path.replace(/tools$/, "tool_config")}.http`;
      expect(where).not.toBe("tool_config.http");
      const result = compile(yaml);
      const code = result.files
        .filter((f) => f.path.endsWith(".ts"))
        .map((f) => f.content)
        .join("\n");
      expect(code).toContain(`, "${where}", process.env);`);
      const readme = result.files.find((f) => f.path === "README.md")?.content ?? "";
      expect(readme).toContain(`configured by \`${where}\``);
    });
  }
});
