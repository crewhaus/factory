/**
 * 0.7.1 — every shape resolves builtins through one table, and a shape that
 * cannot run one says so by name (shape-reach#0/#3/#7/#8, flag-truth-6#7).
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { BUILTIN_TOOLS, checkBuiltinTool } from "@crewhaus/tool-categories";
import { assertCfWorkerToolsEdgeSafe, checkShapeTools, compile, lower, toolSitesOf } from "./index";

const builtinKeys = Object.keys(BUILTIN_TOOLS);

const graph = (tools: string): string =>
  [
    "name: g",
    "target: graph",
    "model: claude-sonnet-4-6",
    "entry: plan",
    "nodes:",
    "  plan:",
    "    instructions: plan it",
    `    tools: ${tools}`,
    "  write:",
    "    instructions: write it",
    "edges:",
    "  - { from: plan, to: write }",
  ].join("\n");

const cli = (tools: string, extra = ""): string =>
  `name: c\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: i\n${extra}tools: ${tools}\n`;

const agentTs = (yaml: string): string =>
  compile(yaml).files.find((f) => f.path === "agent.ts")?.content ?? "";

describe("0.7.0 tools and categories compile on every host shape", () => {
  test("graph: a category with an exclusion, a single 0.7.0 tool, and all-compute", () => {
    const data = agentTs(graph("[all-data, -csvWrite]"));
    expect(data).toContain("@crewhaus/tool-data");
    expect(data).not.toContain("csvWrite");
    expect(agentTs(graph("[gitStatus]"))).toContain(
      'import { gitStatus } from "@crewhaus/tool-git";',
    );
    expect(agentTs(graph("[all-compute]"))).toContain("abiDecode");
  });

  test("a builtin the shape cannot run is refused by name, with the site's path", () => {
    expect(() => compile(cli("[evmCall]"))).toThrow(
      'tools: tool "evmCall" is a builtin, but the cli shape cannot run it: only the graph, workflow and crew shapes carry it.',
    );
  });

  test("evmSendTransaction still compiles where 0.7.0 compiled it, with a warning (flag-truth-6#7)", () => {
    const result = compile(graph("[evmSendTransaction]"));
    const warning = result.warnings.find(
      (w) => w.code === "tool-unwired" && w.message.includes("evmSendTransaction"),
    );
    expect(warning?.path).toBe("nodes.plan.tools");
    expect(warning?.message).toContain("no custody provider that can sign ships in this release");
    expect(agentTs(graph("[evmSendTransaction]"))).toContain("evmSendTransaction");
  });

  test("a chain reader with no chains block compiles with a warning that says what to write", () => {
    const result = compile(graph("[evmCall]"));
    const warning = result.warnings.find((w) => w.code === "tool-unwired");
    expect(warning?.path).toBe("nodes.plan.tools");
    expect(warning?.message).toBe(
      'tool "evmCall" reads a chain, and the spec declares none, so every call returns an error. Declare it — chains: [{ id: "1", kind: evm, rpcUrls: [$ETH_RPC_URL], finality: { kind: finalized } }].',
    );
  });

  test("on a shape that cannot declare chains, the warning says to remove the tool instead", () => {
    const yaml = [
      "name: b",
      "target: browser",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "tools: [gasMarketRead]",
    ].join("\n");
    const warning = compile(yaml).warnings.find((w) => w.code === "tool-unwired");
    expect(warning?.message).toBe(
      'tool "gasMarketRead" reads a chain, and the browser shape cannot declare one, so every call returns an error. Remove it from tools, or use a shape that takes a chains block, such as cli.',
    );
    expect(
      compile(cli("[gasMarketRead]")).warnings.find((w) => w.code === "tool-unwired")?.message,
    ).toContain("Declare it — chains: [");
  });

  test("with a chains block the chain tools are bound at boot, the RPC URL read from the environment", () => {
    const yaml = `${graph("[evmCall, evmSimulate]")}\nchains:\n  - id: "1"\n    kind: evm\n    rpcUrls: [$ETH_RPC_URL]\n    finality: { kind: finalized }\nwallets:\n  - { id: ops, chainId: "1", custody: user-controlled }\n`;
    const result = compile(yaml);
    expect(result.warnings.filter((w) => w.code === "tool-unwired")).toEqual([]);
    const ts = result.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(ts).toContain('import { bindEvmChains, evmCall } from "@crewhaus/tool-evm";');
    expect(ts).toContain('import { bindEvmTxChains, evmSimulate } from "@crewhaus/tool-evm-tx";');
    expect(ts).toContain(
      'applyToolConfig(bindEvmChains, {"chains":[{"chainId":"1","rpcUrls":["$ETH_RPC_URL"]',
    );
    expect(ts).toContain("applyToolConfig(bindEvmTxChains, ");
    expect(ts).toContain('"wallets":[{"id":"ops","chainId":"1","custody":"user-controlled"');
  });

  test("a name that is not a builtin is still 'unknown', with a hint", () => {
    expect(() => compile(graph("[jsonQury]"))).toThrow(
      /nodes\.plan\.tools: unknown tool "jsonQury" — Did you mean "jsonQuery"\?/,
    );
  });

  // security-12#14's sibling: 0.7.0 compiled this to `import {  } from
  // "undefined"` and `defaultCatalog.register(undefined)`.
  test("an Object.prototype name is an unknown tool, not an empty import", () => {
    for (const yaml of [cli("[read, constructor]"), graph("[read, __proto__]")]) {
      let message = "";
      try {
        compile(yaml);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/tools: unknown tool "(constructor|__proto__)"/);
      expect(message).not.toContain("undefined");
    }
  });
});

describe("toolSitesOf", () => {
  test("names each site the way the spec author wrote it", () => {
    const ir = lower(parseSpec(graph("[read]")));
    expect(toolSitesOf(ir).map((s) => s.path)).toEqual(["nodes.plan.tools", "nodes.write.tools"]);
  });
});

describe("sub-agent tools (shape-reach#3)", () => {
  const withSub = (subTools: string, parentTools = "[read, grep]"): string =>
    cli(
      parentTools,
      `  sub_agents:\n    helper:\n      description: d\n      instructions: help\n      tools: ${subTools}\n`,
    );

  test("a category in a sub-agent list lowers to the registered names the child is filtered by", () => {
    const ir = lower(parseSpec(withSub("[all-fs, -write, -edit, -glob]")));
    if (ir.target !== "cli") throw new Error("cli");
    expect(ir.subAgents[0]?.tools).toEqual(["Grep", "Read"]);
    expect(checkShapeTools(ir).warnings).toEqual([]);
  });

  test("a sub-agent tool the parent never registers is a warning naming the fix", () => {
    const result = compile(withSub("[bash]"));
    const warning = result.warnings.find((w) => w.code === "sub-agent-tool-ungranted");
    expect(warning?.path).toBe("agent.sub_agents.helper.tools");
    expect(warning?.message).toContain("Add bash to the parent's tools");
  });
});

describe("shapes without a tool catalog say so (shape-reach#7)", () => {
  // The smoke fixture's chain block, plus a tools: list.
  const onchain = [
    "name: oc",
    "target: onchain",
    "agent: { model: claude-sonnet-4-6, instructions: i }",
    "chains:",
    "  - id: base-mainnet",
    "    kind: evm",
    "    rpcUrls: [$SMOKE_BASE_RPC]",
    "    rpcPolicy: single",
    "    finality: { kind: confirmations, count: 12 }",
    "    reorgTolerant: true",
    "contracts:",
    '  - { id: treasury, chainId: base-mainnet, address: "0xtreasury0000000000000000000000000000smoke", abiRef: "abi://safe" }',
    "triggers:",
    "  - { kind: event, chainId: base-mainnet, contract: treasury, event: Transfer }",
    "tools: [gitStatus]",
  ].join("\n");

  test("onchain tools: is an accepted-but-unwired warning, and the README does not claim it", () => {
    let result: ReturnType<typeof compile>;
    try {
      result = compile(onchain);
    } catch (err) {
      // The fixture's chain block must parse; if the schema moved, say so.
      throw new Error(`onchain fixture no longer compiles: ${(err as Error).message}`);
    }
    const warning = result.warnings.find((w) => w.path === "tools");
    expect(warning?.code).toBe("accepted-but-unwired");
    const readme = result.files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("| `gitStatus` | agent | not wired |");
  });

  // C140 — both chain shapes, both keys, and nothing when neither is declared.
  const game = [
    "name: og",
    "target: onchain-game",
    "agent: { model: claude-sonnet-4-6, instructions: i }",
    "chain:",
    "  id: c1",
    "  kind: evm",
    '  rpcUrls: ["https://rpc.test"]',
    "  finality: { kind: finalized }",
    "wallet: { id: w1, chainId: c1, custody: user-controlled }",
    "game:",
    '  contract: { id: g1, chainId: c1, address: "0x1", abiRef: "abi://erc20" }',
    "  stateReader: readState",
  ].join("\n");
  const base = { onchain: onchain.replace("\ntools: [gitStatus]", ""), "onchain-game": game };
  const unwiredPaths = (spec: string): string[] =>
    compile(spec)
      .warnings.filter((w) => w.code === "accepted-but-unwired")
      .map((w) => w.path)
      .filter((p) => p === "tools" || p === "tool_config")
      .sort();

  for (const [shape, spec] of Object.entries(base)) {
    test(`${shape}: tools and tool_config each warn, and only when declared`, () => {
      const both = `${spec}\ntools: [gitStatus]\ntool_config: { gitStatus: { maxEntries: 5 } }`;
      const result = compile(both);
      const warned = result.warnings.filter(
        (w) =>
          w.code === "accepted-but-unwired" && (w.path === "tools" || w.path === "tool_config"),
      );
      expect(warned.map((w) => w.path).sort()).toEqual(["tool_config", "tools"]);
      for (const w of warned) expect(w.message).toContain(`on the ${shape} shape`);
      const readme = result.files.find((f) => f.path === "README.md")?.content ?? "";
      expect(readme).toContain("| `gitStatus` | agent | not wired |");
      expect(readme).not.toContain("| `gitStatus` | agent | built-in |");
      // Controls: nothing declared, and an empty list, warn about neither.
      expect(unwiredPaths(spec)).toEqual([]);
      expect(unwiredPaths(`${spec}\ntools: []`)).toEqual([]);
    });
  }
});

describe("assertCfWorkerToolsEdgeSafe", () => {
  const cliIr = (tools: string) => lower(parseSpec(cli(tools)));

  test("a 0.7.0 host builtin is a warning with the reason, not a silent drop (shape-reach#4)", () => {
    const warnings = assertCfWorkerToolsEdgeSafe(cliIr("[webFetch, gitStatus]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("edge-unsafe-tool");
    expect(warnings[0]?.message).toContain("it starts a host process");
    expect(warnings[0]?.message).toContain("so the worker leaves it out");
  });

  test("the host tools the edge always refused still refuse", () => {
    expect(() => assertCfWorkerToolsEdgeSafe(cliIr("[read, bash]"))).toThrow(
      /cf-worker target cannot run 2 host tool\(s\)/,
    );
  });

  test("a builtin the edge cannot sign with is left out with a warning", () => {
    // On a shape that carries it: the graph flavour of the worker.
    const warnings = assertCfWorkerToolsEdgeSafe(lower(parseSpec(graph("[evmSendTransaction]"))));
    expect(warnings.map((w) => w.code)).toEqual(["edge-unsafe-tool"]);
  });
});

describe("the edge flavour of a shape refuses what that shape refuses, in the same words (0.7.1)", () => {
  // The worker emits for these three shapes; the spec's own shape decides.
  const flavours = {
    cli: (tools: string) => cli(tools),
    graph: (tools: string) => graph(tools),
    workflow: (tools: string) =>
      [
        "name: w",
        "target: workflow",
        "model: claude-sonnet-4-6",
        "steps:",
        "  - name: draft",
        "    instructions: draft it",
        `    tools: ${tools}`,
      ].join("\n"),
  } as const;

  /** The message `compile` stops with, or undefined when it compiles. */
  const localError = (yaml: string): string | undefined => {
    try {
      compile(yaml);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const edgeError = (yaml: string): string | undefined => {
    try {
      assertCfWorkerToolsEdgeSafe(lower(parseSpec(yaml)));
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  test("sendMessage on a cli spec: both refuse it, word for word", () => {
    const yaml = cli("[sendMessage]");
    const expected =
      'tools: tool "sendMessage" is a builtin, but the cli shape cannot run it: only the channel shape carries it. Use that shape, or remove it from tools.';
    expect(localError(yaml)).toBe(expected);
    expect(edgeError(yaml)).toBe(expected);
  });

  test("every builtin a flavour's shape refuses, the edge refuses with the same message", () => {
    let refused = 0;
    for (const [shape, spec] of Object.entries(flavours)) {
      for (const key of builtinKeys) {
        const verdict = checkBuiltinTool(key, shape as "cli" | "graph" | "workflow");
        if (verdict.kind !== "refused") continue;
        refused += 1;
        const yaml = spec(`[${key}]`);
        const local = localError(yaml);
        expect(local).toContain(verdict.message);
        expect(edgeError(yaml)).toBe(local);
      }
    }
    // sendMessage on all three, and the evm family on cli.
    expect(refused).toBe(
      3 + Object.values(BUILTIN_TOOLS).filter((e) => e.shapes?.includes("graph") === true).length,
    );
  }, 60_000);
});
