import { describe, expect, test } from "bun:test";
import { BUILTIN_TOOLS, TOOL_BOOT_REGISTRARS } from "./builtins";
import {
  applyToolConfig,
  chainBootConfig,
  checkCandidateToolConfigs,
  checkToolConfigs,
  malformedToolConfigRefs,
  planChainInits,
  planToolConfigInits,
  renderToolConfigInit,
  resolveToolConfigEnv,
  toolConfigBlockFor,
  toolConfigEnvRefs,
} from "./config";
import { BuiltinToolError } from "./error";
import { resolveBuiltinTools } from "./shapes";

const HTTP = { allowed_origins: ["https://api.example.com"] };

describe("every configurable package is in the registrar table", () => {
  test("each row's registrar exists, and each registrar is named by a row", () => {
    const named = new Set<string>();
    for (const [key, entry] of Object.entries(BUILTIN_TOOLS)) {
      for (const symbol of [entry.initSymbol, entry.chainSymbol]) {
        if (symbol === undefined) continue;
        named.add(symbol);
        expect({ key, symbol, known: Object.hasOwn(TOOL_BOOT_REGISTRARS, symbol) }).toEqual({
          key,
          symbol,
          known: true,
        });
      }
      if (entry.initSymbol !== undefined) {
        expect(TOOL_BOOT_REGISTRARS[entry.initSymbol]?.source).toBe("tool_config");
      }
      if (entry.chainSymbol !== undefined) {
        expect(TOOL_BOOT_REGISTRARS[entry.chainSymbol]?.source).toBe("chains");
      }
    }
    expect([...named].sort()).toEqual(Object.keys(TOOL_BOOT_REGISTRARS).sort());
  });

  test("a registrar more than one row of a package names is named by every row of it", () => {
    // Derived, not listed: a package-wide registrar (registerHttpConfig for
    // tool-http) must reach every tool the package's block configures, so a
    // new tool that forgot it fails here.
    const byPackage = new Map<string, Array<{ key: string; init?: string; chain?: string }>>();
    for (const [key, e] of Object.entries(BUILTIN_TOOLS)) {
      const rows = byPackage.get(e.package) ?? [];
      rows.push({
        key,
        ...(e.initSymbol ? { init: e.initSymbol } : {}),
        ...(e.chainSymbol ? { chain: e.chainSymbol } : {}),
      });
      byPackage.set(e.package, rows);
    }
    let packageWide = 0;
    for (const [pkg, rows] of byPackage) {
      for (const field of ["init", "chain"] as const) {
        const named = rows.filter((r) => r[field] !== undefined);
        if (named.length < 2) continue;
        packageWide += 1;
        const symbol = named[0]?.[field];
        expect({ pkg, missing: rows.filter((r) => r[field] !== symbol).map((r) => r.key) }).toEqual(
          {
            pkg,
            missing: [],
          },
        );
      }
    }
    // http, codehost, notify, obs, defi, chainread, token (x2), chaincall,
    // evm, evm-tx and code-execution today.
    expect(packageWide).toBeGreaterThanOrEqual(12);
  });
});

describe("the boot rule — one block per registrar", () => {
  test("the package key, a tool's own key and its registered name all reach the registrar", () => {
    for (const key of ["http", "httpRequest", "HttpRequest", "HTTP"]) {
      const plan = planToolConfigInits([
        { tools: ["httpRequest", "headRequest"], toolConfigs: { [key]: HTTP } },
      ]);
      expect(plan.map((p) => [p.initSymbol, p.key, p.config])).toEqual([
        ["registerHttpConfig", key, HTTP],
      ]);
    }
  });

  test("the registered name reaches WebFetch's registrar (the permission-rule spelling)", () => {
    const plan = planToolConfigInits([
      { tools: ["webFetch"], toolConfigs: { WebFetch: { allowed_domains: ["docs.example.com"] } } },
    ]);
    expect(plan.map((p) => p.initSymbol)).toEqual(["registerWebFetchConfig"]);
  });

  test("tool_config.fetch reaches DependencyAudit's mirror allow-list without Fetch enabled", () => {
    const plan = planToolConfigInits([
      {
        tools: ["dependencyAudit"],
        toolConfigs: { fetch: { allowed_origins: ["https://osv-mirror.example.com"] } },
      },
    ]);
    expect(plan.map((p) => [p.package, p.initSymbol])).toEqual([
      ["@crewhaus/tool-fetch", "registerFetchConfig"],
    ]);
  });

  test("equal blocks under two keys are one registration", () => {
    const plan = planToolConfigInits([
      { tools: ["httpRequest"], toolConfigs: { http: HTTP, httpRequest: { ...HTTP } } },
    ]);
    expect(plan).toHaveLength(1);
  });

  test("different blocks under two keys are refused, naming both and the key to keep", () => {
    const check = checkToolConfigs([
      {
        tools: ["httpRequest"],
        toolConfigs: { http: HTTP, httpRequest: { allowed_origins: ["https://other.example"] } },
      },
    ]);
    expect(check.inits).toEqual([]);
    expect(check.conflicts.map((c) => c.message)).toEqual([
      "tool_config.http and tool_config.httpRequest both configure the http tools, and they differ. Keep one block, under tool_config.http.",
    ]);
    expect(() =>
      planToolConfigInits([
        {
          tools: ["httpRequest"],
          toolConfigs: { http: HTTP, httpRequest: { allowed_origins: [] } },
        },
      ]),
    ).toThrow(BuiltinToolError);
  });

  test("two sites of one process that configure a registrar differently are refused", () => {
    const check = checkToolConfigs([
      { tools: ["fetch"], toolConfigs: { fetch: HTTP }, path: "steps[0].tool_config" },
      {
        tools: ["fetch"],
        toolConfigs: { fetch: { allowed_origins: ["https://b.example"] } },
        path: "steps[1].tool_config",
      },
    ]);
    expect(check.conflicts.map((c) => c.message)).toEqual([
      expect.stringContaining(
        "steps[0].tool_config.fetch and steps[1].tool_config.fetch both configure",
      ),
    ]);
  });

  test("the codeExecution alias reaches only the code-execution registrar", () => {
    const check = checkToolConfigs([
      {
        tools: ["webFetch", "fetch", "imageGenerate", "python"],
        toolConfigs: { codeExecution: { defaultTimeoutMs: 5000 } },
      },
    ]);
    expect(check.inits.map((i) => i.initSymbol)).toEqual(["registerCodeExecutionConfig"]);
    expect(check.unused).toEqual([]);
  });

  test("a per-tool key only counts for a tool that is in tools", () => {
    const check = checkToolConfigs([
      { tools: ["python"], toolConfigs: { shell: { defaultTimeoutMs: 1 } } },
    ]);
    expect(check.inits).toEqual([]);
    expect(check.unused.map((u) => u.message)).toEqual([
      "ignored, because shell is not in tools. To configure code execution (python, javascript, shell) you use, write the block under tool_config.codeExecution.",
    ]);
  });
});

describe("keys nothing reads", () => {
  const unused = (tools: string[], toolConfigs: Record<string, unknown>) =>
    checkToolConfigs([{ tools, toolConfigs }]).unused.map((u) => u.message);

  test("a tool that takes no config", () => {
    expect(unused(["read"], { read: {} })).toEqual([
      "ignored, because read takes no tool_config. Remove the block.",
    ]);
  });

  test("a tool that is not in tools", () => {
    expect(unused(["read"], { fetch: HTTP })).toEqual([
      "ignored, because fetch is not in tools. Add fetch to tools, or remove the block.",
    ]);
  });

  test("a package key with none of its tools in tools", () => {
    expect(unused(["read"], { codehost: {} })).toEqual([
      "ignored, because no tool in tools reads it: it configures the codehost tools. Add one of them to tools, or remove the block.",
    ]);
  });

  test("a key nothing knows", () => {
    expect(unused(["fetch"], { allowlist: HTTP })).toEqual([
      "ignored, because no builtin reads this key. Write the block under a tool's key (fetch), its registered name (Fetch) or its package key (http).",
    ]);
  });

  test("a misspelled key is pointed at the key this site reads", () => {
    expect(unused(["fetch"], { fetchh: HTTP })).toEqual([
      "ignored, because no builtin reads this key. Did you mean tool_config.fetch?",
    ]);
    expect(unused(["httpRequest"], { htp: HTTP, httpReqest: HTTP })).toEqual([
      "ignored, because no builtin reads this key. Did you mean tool_config.http?",
      "ignored, because no builtin reads this key. Did you mean tool_config.httpRequest?",
    ]);
  });

  test("every key that reaches a registrar is consumed", () => {
    expect(
      unused(["httpRequest", "prList", "python"], { http: HTTP, codehost: {}, python: {} }),
    ).toEqual([]);
  });
});

describe("a model pool candidate's block", () => {
  test("a tool reads its own key, its registered name, then its package key", () => {
    expect(toolConfigBlockFor({ http: HTTP }, "HttpRequest")).toEqual(HTTP);
    expect(toolConfigBlockFor({ headRequest: { a: 1 }, http: HTTP }, "HeadRequest")).toEqual({
      a: 1,
    });
    expect(toolConfigBlockFor({ WebFetch: { a: 1 } }, "WebFetch")).toEqual({ a: 1 });
    expect(toolConfigBlockFor({ webFetch: { a: 1 } }, "WebFetch")).toEqual({ a: 1 });
    expect(toolConfigBlockFor({ codeExecution: { a: 1 } }, "Shell")).toEqual({ a: 1 });
    expect(toolConfigBlockFor({ codeExecution: { a: 1 } }, "WebFetch")).toBeUndefined();
    expect(toolConfigBlockFor({ http: HTTP }, "Read")).toBeUndefined();
    expect(toolConfigBlockFor({ mcp__s__t: { a: 1 } }, "mcp__s__t")).toEqual({ a: 1 });
    expect(toolConfigBlockFor(undefined, "Fetch")).toBeUndefined();
  });

  test("conflicts are per tool, and an unknown key is left for MCP and plugin tools", () => {
    const check = checkCandidateToolConfigs(
      ["httpRequest"],
      { http: HTTP, HttpRequest: { allowed_origins: [] }, mcp__x__y: {}, fetch: {} },
      "agent.model_pool.candidates[0].tool_config",
    );
    expect(check.conflicts.map((c) => c.message)).toEqual([
      "agent.model_pool.candidates[0].tool_config.http and agent.model_pool.candidates[0].tool_config.HttpRequest both configure httpRequest, and they differ. Keep one block.",
    ]);
    expect(check.unused.map((u) => u.path)).toEqual([
      "agent.model_pool.candidates[0].tool_config.fetch",
    ]);
  });
});

describe("$VAR references", () => {
  const block = {
    allowed_origins: ["$API_ORIGIN", "https://literal.example"],
    token_env: "GITHUB_TOKEN",
    price: "$5",
    nested: { "odd key": "$NESTED_REF" },
  };

  test("only a whole $UPPER_SNAKE string is a reference", () => {
    expect(toolConfigEnvRefs(block, "tool_config.http")).toEqual([
      { path: "tool_config.http.allowed_origins[0]", name: "API_ORIGIN" },
      { path: 'tool_config.http.nested["odd key"]', name: "NESTED_REF" },
    ]);
  });

  test("resolution reads the environment and never writes a value into the message", () => {
    const env = { API_ORIGIN: "https://secret-host.example", NESTED_REF: "x" };
    const { value, secrets } = resolveToolConfigEnv(block, "tool_config.http", env);
    expect(value).toEqual({
      allowed_origins: ["https://secret-host.example", "https://literal.example"],
      token_env: "GITHUB_TOKEN",
      price: "$5",
      nested: { "odd key": "x" },
    });
    expect(secrets.map((s) => s.name)).toEqual(["API_ORIGIN", "NESTED_REF"]);
    expect(() => resolveToolConfigEnv(block, "tool_config.http", { API_ORIGIN: "" })).toThrow(
      "tool_config.http.allowed_origins[0] reads $API_ORIGIN, but API_ORIGIN is not set. Set API_ORIGIN in the environment the harness starts in.",
    );
  });

  test("a registrar error that quotes a value read from the environment is rewritten", () => {
    const secret = "https://rpc.example/v2/SECRETKEY123";
    const registrar = (cfg: { url: string }) => {
      throw new Error(`invalid origin "${cfg.url}"`);
    };
    let caught: unknown;
    try {
      applyToolConfig(registrar, { url: "$RPC_URL" }, "tool_config.defi", { RPC_URL: secret });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BuiltinToolError);
    const e = caught as Error;
    expect(e.message).toBe('tool_config.defi: invalid origin "$RPC_URL"');
    expect(`${e.message}${e.stack}${String(e.cause)}`).not.toContain("SECRETKEY123");
  });

  test("a registrar error that quotes no secret is passed through untouched", () => {
    const original = new RangeError("bad");
    const registrar = () => {
      throw original;
    };
    expect(() => applyToolConfig(registrar, { a: "$A" }, "w", { A: "zzz" })).toThrow(original);
  });

  test("a credential-shaped key whose $ value is not a reference is flagged", () => {
    expect(
      malformedToolConfigRefs(
        { api_key: "${API_KEY}", token: "$token", price: "$5", apiKey: "$GOOD" },
        "tool_config.x",
      ).map((n) => n.path),
    ).toEqual(["tool_config.x.api_key", "tool_config.x.token"]);
  });

  test("a block without a reference renders byte-identically to 0.7.0", () => {
    expect(
      renderToolConfigInit({
        key: "fetch",
        package: "@crewhaus/tool-fetch",
        initSymbol: "registerFetchConfig",
        config: HTTP,
        where: "tool_config.fetch",
      }),
    ).toEqual({
      line: 'registerFetchConfig({"allowed_origins":["https://api.example.com"]});',
      readsEnv: false,
    });
  });

  test("a block with a reference is read at boot, not compiled in", () => {
    const r = resolveBuiltinTools("cli", [
      { tools: ["httpRequest"], toolConfigs: { http: { allowed_origins: ["$ORIGIN"] } } },
    ]);
    expect(r.inits).toEqual([
      'applyToolConfig(registerHttpConfig, {"allowed_origins":["$ORIGIN"]}, "tool_config.http", process.env);',
    ]);
    expect(r.imports).toContain('import { applyToolConfig } from "@crewhaus/tool-categories";');
  });

  test("the edge refuses a reference: a Worker has no environment at boot", () => {
    expect(() =>
      resolveBuiltinTools("cf-worker", [
        { tools: ["fetch"], toolConfigs: { fetch: { allowed_origins: ["$ORIGIN"] } } },
      ]),
    ).toThrow(
      /tool_config\.fetch\.allowed_origins\[0\] reads \$ORIGIN .* compile without --emit-as cf-worker/,
    );
  });
});

describe("the chain blocks", () => {
  const blocks = {
    chains: [
      {
        id: "1",
        kind: "evm" as const,
        rpcUrls: [
          { kind: "env" as const, name: "ETH_RPC_URL" },
          { kind: "literal" as const, value: "https://public.example" },
        ],
        rpcPolicy: "fallback" as const,
        finality: { kind: "finalized" as const },
        reorgTolerant: true,
      },
    ],
    wallets: [
      {
        id: "ops",
        chainId: "1",
        custody: "local" as const,
        signingPolicy: "explicit-user-approval" as const,
        keyRef: { kind: "env" as const, name: "WALLET_KEY" },
      },
    ],
  };

  test("an RPC URL reference stays a reference, and a wallet's key is left out", () => {
    const config = chainBootConfig(blocks);
    expect(config).toEqual({
      chains: [
        {
          chainId: "1",
          rpcUrls: ["$ETH_RPC_URL", "https://public.example"],
          rpcPolicy: "fallback",
          finality: { kind: "finalized" },
          reorgTolerant: true,
        },
      ],
      wallets: [
        { id: "ops", chainId: "1", custody: "local", signingPolicy: "explicit-user-approval" },
      ],
    });
    expect(JSON.stringify(config)).not.toContain("WALLET_KEY");
  });

  test("no chains, no registration", () => {
    expect(chainBootConfig({})).toBeUndefined();
    expect(planChainInits(["evmMulticall"], undefined)).toEqual([]);
  });

  test("each chain registrar the tools need is called once, with the whole block", () => {
    const inits = planChainInits(["evmMulticall", "gasMarketRead", "erc20Balance", "read"], blocks);
    expect(inits.map((i) => i.initSymbol)).toEqual(["bindChainCallChains", "bindTokenChains"]);
    const r = resolveBuiltinTools("graph", [{ tools: ["evmCall", "evmSimulate"] }], blocks);
    expect(r.inits).toEqual([
      expect.stringMatching(/^applyToolConfig\(bindEvmChains, \{"chains":\[/),
      expect.stringMatching(/^applyToolConfig\(bindEvmTxChains, /),
    ]);
  });
});
