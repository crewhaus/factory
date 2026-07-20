import { describe, expect, test } from "bun:test";
import type { IrChannelV0, IrNode, IrV0, IrWorkflowV0 } from "./index";
import { GENERATED_README_MARKER, collectSecretRefs, renderBundleReadme } from "./readme";

function baseCliIr(overrides: Partial<IrV0> = {}): IrV0 {
  return {
    version: 0,
    name: "smoke",
    target: "cli",
    agent: { model: "claude-sonnet-4-6", instructions: "be helpful" },
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
    ...overrides,
  };
}

function channelIr(): IrChannelV0 {
  return {
    version: 0,
    name: "helpdesk",
    target: "channel",
    agent: { model: "claude-sonnet-4-6", instructions: "answer politely" },
    tools: ["read"],
    toolConfigs: {},
    channels: {
      slack: {
        botToken: { kind: "env", name: "SLACK_BOT_TOKEN" },
        signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
      },
    },
    routing: { sessionKey: "thread" },
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
  };
}

describe("collectSecretRefs — env-ref collection (item 42)", () => {
  test("gathers env refs across variant-specific nesting (channel creds + chain rpcUrls + wallet keyRef)", () => {
    const ir = baseCliIr({
      chains: [
        {
          id: "mainnet",
          kind: "evm",
          rpcUrls: [
            { kind: "env", name: "ALCHEMY_URL" },
            { kind: "literal", value: "https://rpc.example.com" },
          ],
          rpcPolicy: "single",
          finality: { kind: "safe" },
          reorgTolerant: false,
        },
      ],
      wallets: [
        {
          id: "treasury",
          chainId: "mainnet",
          custody: "kms",
          signingPolicy: "policy-gated",
          keyRef: { kind: "env", name: "WALLET_KEY" },
        },
      ],
    });
    const refs = collectSecretRefs(ir);
    expect(refs.envNames).toEqual(["ALCHEMY_URL", "WALLET_KEY"]);
    expect(refs.literalCount).toBe(1);
  });

  test("dedupes and sorts env names deterministically", () => {
    const refs = collectSecretRefs({
      a: { kind: "env", name: "ZULU" },
      b: [
        { kind: "env", name: "ALPHA" },
        { kind: "env", name: "ZULU" },
      ],
    });
    expect(refs.envNames).toEqual(["ALPHA", "ZULU"]);
  });

  test("does NOT misfire on other kind-discriminated IR unions (finality / schema refs / triggers)", () => {
    const refs = collectSecretRefs({
      finality: { kind: "confirmations", count: 12 },
      schema: { kind: "named", name: "handoff" },
      trigger: { kind: "block", chainId: "mainnet", scanIntervalMs: 5000 },
      untyped: { kind: "untyped" },
    });
    expect(refs.envNames).toEqual([]);
    expect(refs.literalCount).toBe(0);
  });
});

describe("renderBundleReadme — env vars + literal redaction (item 42)", () => {
  test("lists the exact env vars the bundle needs", () => {
    const md = renderBundleReadme(channelIr());
    expect(md).toContain("## Environment variables");
    expect(md).toContain("- `SLACK_BOT_TOKEN`");
    expect(md).toContain("- `SLACK_SIGNING_SECRET`");
  });

  test("CRITICAL: literal secret values are redacted — never printed", () => {
    const ir = channelIr();
    const leaky: IrChannelV0 = {
      ...ir,
      channels: {
        slack: {
          botToken: { kind: "literal", value: "xoxb-hunter2-secret" },
          signingSecret: { kind: "env", name: "SLACK_SIGNING_SECRET" },
        },
      },
    };
    const md = renderBundleReadme(leaky);
    expect(md).not.toContain("hunter2");
    expect(md).not.toContain("xoxb");
    // The redaction is called out, without the value.
    expect(md).toContain("1 secret-shaped value(s)");
    expect(md).toContain("- `SLACK_SIGNING_SECRET`");
  });

  test("a spec with no env refs says so and still names the provider key", () => {
    const md = renderBundleReadme(baseCliIr());
    expect(md).toContain("No spec-declared environment variables.");
    expect(md).toContain("`ANTHROPIC_API_KEY`");
    expect(md).toContain("`claude-sonnet-4-6`");
  });
});

describe("renderBundleReadme — tool table (item 42)", () => {
  test("renders one sorted row per tool with scope + flags", () => {
    const ir = baseCliIr({
      tools: ["python", "bash", "mcp__github__search", "webFetch"],
      toolConfigs: { webFetch: { allowed_origins: ["https://example.com"] } },
    });
    const md = renderBundleReadme(ir);
    expect(md).toContain("## Tools");
    expect(md).toContain("| Tool | Used by | Scope | Notes |");
    expect(md).toContain("| `bash` | agent | built-in | — |");
    expect(md).toContain("| `python` | agent | built-in | sandboxed |");
    expect(md).toContain("| `mcp__github__search` | agent | external (MCP) | — |");
    expect(md).toContain("| `webFetch` | agent | external | configured via `tool_config` |");
    // Sorted: bash row precedes python row.
    expect(md.indexOf("| `bash` |")).toBeLessThan(md.indexOf("| `python` |"));
  });

  test("nested tools carry their declaring context (sub-agent / workflow step)", () => {
    const cli = baseCliIr({
      tools: ["read"],
      subAgents: [
        {
          name: "researcher",
          description: "digs",
          instructions: "dig",
          tools: ["WebSearch"],
          permissions: "inherit",
          inheritBypass: false,
        },
      ],
    });
    const md = renderBundleReadme(cli);
    expect(md).toContain("| `read` | agent | built-in | — |");
    expect(md).toContain("| `WebSearch` | sub-agent `researcher` | external | — |");

    const wf: IrWorkflowV0 = {
      version: 0,
      name: "pipeline",
      target: "workflow",
      steps: [
        {
          name: "draft",
          instructions: "draft it",
          model: "claude-sonnet-4-6",
          tools: ["read"],
          toolConfigs: {},
        },
      ],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    expect(renderBundleReadme(wf)).toContain("| `read` | step `draft` | built-in | — |");
  });

  test("justification-gated defaults are flagged", () => {
    const md = renderBundleReadme(baseCliIr({ tools: ["imageGenerate"] }));
    expect(md).toContain("justification-gated by default");
  });

  test("the Tools section is omitted when the IR references no tools", () => {
    expect(renderBundleReadme(baseCliIr())).not.toContain("## Tools");
  });
});

describe("renderBundleReadme — MCP servers (item 42)", () => {
  test("lists stdio command and sse url, but never env values or headers", () => {
    const ir = baseCliIr({
      mcp_servers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: ["mcp-github"],
          env: { GITHUB_TOKEN: { kind: "literal", value: "ghp_leaky-literal" } },
        },
        search: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: { kind: "literal", value: "Bearer leaky-header" } },
        },
      },
    });
    const md = renderBundleReadme(ir);
    expect(md).toContain("## MCP servers");
    expect(md).toContain("| `github` | stdio | `npx mcp-github` |");
    expect(md).toContain("| `search` | sse | `https://mcp.example.com/sse` |");
    expect(md).not.toContain("ghp_leaky-literal");
    expect(md).not.toContain("leaky-header");
  });

  test("0.3.0 — mcp env/header refs land in the Environment variables section (collectSecretRefs walk)", () => {
    const ir = baseCliIr({
      mcp_servers: {
        thredz: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "thredz-mcp@0.2.0"],
          env: { THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" } },
        },
        search: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: { kind: "env", name: "SEARCH_TOKEN" } },
        },
      },
    });
    const refs = collectSecretRefs(ir);
    expect(refs.envNames).toEqual(["SEARCH_TOKEN", "THREDZ_API_KEY"]);
    const md = renderBundleReadme(ir);
    expect(md).toContain("- `THREDZ_API_KEY`");
    expect(md).toContain("- `SEARCH_TOKEN`");
  });

  test("0.3.0 PR 16 — synthesized thredz config literals do NOT trip the literal warning; user literals still do", () => {
    const synthesized = baseCliIr({
      mcp_servers: {
        thredz: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "thredz-mcp@0.2.0"],
          env: {
            THREDZ_API_KEY: { kind: "env", name: "THREDZ_API_KEY" },
            THREDZ_API_BASE: { kind: "literal", value: "http://localhost:3000/api" },
            THREDZ_DEFAULT_VISIBILITY: { kind: "literal", value: "private" },
          },
        },
      },
    });
    expect(collectSecretRefs(synthesized).literalCount).toBe(0);
    expect(renderBundleReadme(synthesized)).not.toContain("supplied as literals");
    // A user-declared literal under any other key keeps warning.
    const userLiteral = baseCliIr({
      mcp_servers: {
        thredz: {
          transport: "stdio",
          command: "npx",
          args: [],
          env: { MY_KEY: { kind: "literal", value: "raw-secret" } },
        },
      },
    });
    expect(collectSecretRefs(userLiteral).literalCount).toBe(1);
  });

  test("the section is omitted when no MCP servers are configured", () => {
    expect(renderBundleReadme(baseCliIr())).not.toContain("## MCP servers");
  });
});

describe("renderBundleReadme — MCP credential masking (adversarial review F2)", () => {
  test("reviewer repro: stdio credential flags are masked in --flag=v AND --flag v form", () => {
    const ir = baseCliIr({
      mcp_servers: {
        github: {
          transport: "stdio",
          command: "npx",
          args: [
            "-y",
            "mcp-github",
            "--token=ghp_abcdefghij0123456789",
            "--api-key",
            "SUPERSECRETVALUE",
            "--verbose",
          ],
          env: {},
        },
      },
    });
    const md = renderBundleReadme(ir);
    expect(md).not.toContain("ghp_");
    expect(md).not.toContain("SUPERSECRETVALUE");
    expect(md).toContain("--token=***");
    expect(md).toContain("--api-key ***");
    // Non-credential args survive untouched.
    expect(md).toContain("npx -y mcp-github");
    expect(md).toContain("--verbose");
  });

  test("a bare arg matching a known token shape is masked even without a flag", () => {
    const ir = baseCliIr({
      mcp_servers: {
        payments: {
          transport: "stdio",
          command: "stripe-mcp",
          args: ["sk-live-DEADBEEFDEADBEEF"],
          env: {},
        },
      },
    });
    const md = renderBundleReadme(ir);
    expect(md).not.toContain("sk-live");
    expect(md).toContain("| `payments` | stdio | `stripe-mcp ***` |");
  });

  test("reviewer repro: sse URLs mask query values, userinfo passwords, and opaque path segments", () => {
    const alchemyKey = "AbCdEf0123456789AbCdEf0123456789";
    const ir = baseCliIr({
      mcp_servers: {
        rpc: {
          transport: "sse",
          url: `https://user:hunter2@rpc.example.com/v2/${alchemyKey}?apikey=TOPSECRET&region=us`,
          headers: {},
        },
      },
    });
    const md = renderBundleReadme(ir);
    expect(md).not.toContain("hunter2");
    expect(md).not.toContain("TOPSECRET");
    expect(md).not.toContain(alchemyKey);
    expect(md).toContain(
      "| `rpc` | sse | `https://user:***@rpc.example.com/v2/***?apikey=***&region=***` |",
    );
  });

  test("a plain URL without credentials renders verbatim (no false masking)", () => {
    const ir = baseCliIr({
      mcp_servers: {
        search: {
          transport: "sse",
          url: "https://mcp.example.com/sse/events",
          headers: {},
        },
      },
    });
    expect(renderBundleReadme(ir)).toContain(
      "| `search` | sse | `https://mcp.example.com/sse/events` |",
    );
  });
});

describe("renderBundleReadme — table-cell escaping (adversarial review F5)", () => {
  test("pipes, backticks, and newlines in tool names cannot break the markdown table", () => {
    const ir = baseCliIr({ tools: ["evil|name`x`", "multi\nline"] });
    const md = renderBundleReadme(ir);
    expect(md).toContain("evil\\|name\\`x\\`");
    expect(md).toContain("multi line"); // newline collapsed to a space
    // Every row of the Tools table still has the column count of its header.
    const section = md.split("## Tools")[1]?.split("##")[0] ?? "";
    const rows = section.split("\n").filter((l) => l.startsWith("|"));
    expect(rows.length).toBeGreaterThan(2);
    const cols = (line: string) => line.split(/(?<!\\)\|/).length;
    for (const row of rows) expect(cols(row)).toBe(cols(rows[0] ?? ""));
  });
});

describe("renderBundleReadme — per-target run snippet (item 42)", () => {
  test("cli launches agent.ts; channel launches daemon.ts", () => {
    expect(renderBundleReadme(baseCliIr())).toContain("bun agent.ts");
    expect(renderBundleReadme(channelIr())).toContain("bun daemon.ts");
  });

  test("the default Run section documents the bun install step (manifest flow)", () => {
    // `crewhaus compile` writes a package.json pinning the bundle's
    // @crewhaus deps; the README must tell the reader to install it before
    // the launch line, or a standalone out-dir dies on the first import.
    const md = renderBundleReadme(baseCliIr());
    const run = md.slice(md.indexOf("## Run"));
    expect(run.indexOf("bun install")).toBeGreaterThan(-1);
    expect(run.indexOf("bun install")).toBeLessThan(run.indexOf("bun agent.ts"));
  });

  test("every IR target has a run command (table is total over the union)", () => {
    // Cheap exhaustiveness probe: a minimal duck-typed IR per target must
    // render without throwing and include a Run section. Targets whose
    // emitters ship a daemon.ts entrypoint launch it; the rest agent.ts.
    const daemonTargets = new Set(["channel", "managed", "crew", "voice"]);
    const targets: ReadonlyArray<IrNode["target"]> = [
      "cli",
      "workflow",
      "channel",
      "graph",
      "managed",
      "pipeline",
      "crew",
      "research",
      "batch",
      "voice",
      "browser",
      "eval",
      "onchain",
      "onchain-game",
    ];
    for (const target of targets) {
      const ir = {
        ...baseCliIr(),
        target,
        // workflow/graph/crew read model off their collections.
        steps: [],
        nodes: [],
        roles: [],
        edges: [],
      } as unknown as IrNode;
      const md = renderBundleReadme(ir);
      expect(md).toContain(daemonTargets.has(target) ? "bun daemon.ts" : "bun agent.ts");
    }
  });

  test("the usage override replaces the default Run section (cf-worker / plugin emitters)", () => {
    const md = renderBundleReadme(baseCliIr(), {
      usage: { heading: "Deploy", body: "```sh\nwrangler deploy\n```" },
    });
    expect(md).toContain("## Deploy");
    expect(md).toContain("wrangler deploy");
    expect(md).not.toContain("bun agent.ts");
  });
});

describe("renderBundleReadme — structure (item 42)", () => {
  test("carries the generation marker, harness table, and workspace note", () => {
    const md = renderBundleReadme(baseCliIr({ name: "my-bot" }));
    expect(md.startsWith(GENERATED_README_MARKER)).toBe(true);
    expect(md).toContain("# my-bot");
    expect(md).toContain("| Name | `my-bot` |");
    expect(md).toContain("| Target | `cli` |");
    expect(md).toContain("| Model | `claude-sonnet-4-6` |");
    expect(md).toContain("`.crewhaus/sessions/`");
    expect(md).toContain("`.crewhaus/feedback/`");
  });

  test("workspace note can be suppressed and extra sections appended", () => {
    const md = renderBundleReadme(baseCliIr(), {
      description: "A custom description.",
      includeWorkspaceNote: false,
      extraSections: [{ heading: "Origin", body: "From a spec." }],
    });
    expect(md).toContain("A custom description.");
    expect(md).not.toContain(".crewhaus/sessions");
    expect(md).toContain("## Origin");
    expect(md).toContain("From a spec.");
  });

  test("multi-model shapes list every distinct model once", () => {
    const wf: IrWorkflowV0 = {
      version: 0,
      name: "duo",
      target: "workflow",
      steps: [
        {
          name: "a",
          instructions: "x",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
        },
        {
          name: "b",
          instructions: "y",
          model: "claude-haiku-4-5",
          tools: [],
          toolConfigs: {},
        },
        {
          name: "c",
          instructions: "z",
          model: "claude-sonnet-4-6",
          tools: [],
          toolConfigs: {},
        },
      ],
      mcp_servers: {},
      permissions: { rules: [] },
      compaction: {},
    };
    const md = renderBundleReadme(wf);
    expect(md).toContain("| Models | `claude-sonnet-4-6`, `claude-haiku-4-5` |");
  });
});
