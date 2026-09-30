/**
 * 0.7.1 — one spelling for MCP tool names (flag-truth-1#1, extension-path#15).
 *
 * tool-mcp registered remote tools as `<server>__<tool>`, while the docs, the
 * spec's model-profile selectors, deny rules, the egress fabric and the scope
 * audit all keyed on `mcp__<server>__<tool>` — so a deny written the way the
 * docs say never fired. The registered name is now the documented one, and
 * everything that names tools keeps accepting the old spelling.
 *
 * This file proves both halves against the real `buildMcpRegisteredTool`:
 * the documented rule fires, and each place that keeps its own copy of the
 * old-spelling rule (the permission matcher, tool-catalog, model-plan,
 * hooks-engine) agrees with the others; and the spec's server-name check
 * agrees with the one tool-mcp applies at registration.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { type HookDef, runHooks } from "@crewhaus/hooks-engine";
import type { McpHost } from "@crewhaus/mcp-host";
import { buildAdvertisement, matchesToolPattern } from "@crewhaus/model-plan";
import {
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
  evaluate,
} from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { defaultSinkScope, runChatLoop } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import { isOutwardName } from "@crewhaus/tool-builder";
import { legacyMcpToolName, toolListEntryNames } from "@crewhaus/tool-catalog";
import { buildMcpRegisteredTool, mcpServerNameProblem } from "@crewhaus/tool-mcp";
import {
  compilePattern,
  escapeGlobLiteral,
  legacyMcpToolName as matcherLegacy,
  matchesToolName,
} from "@crewhaus/tool-permission-matcher";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

const flags = { concurrencySafe: false, readOnly: false, destructive: false };

/** A host whose one server answers every call with "done" and counts calls. */
function fakeHost(): { host: McpHost; calls: () => number } {
  let n = 0;
  const client = {
    callTool: async () => {
      n++;
      return { content: "done", isError: false };
    },
  };
  return { host: { getClient: () => client } as unknown as McpHost, calls: () => n };
}

function adapterFor(name: string, input: unknown): ProviderAdapter {
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
      const first = i === 0;
      i++;
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

const rules = (...list: Array<[PermissionRule["type"], string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
});

describe("a documented MCP deny rule fires (flag-truth-1#1)", () => {
  const { host, calls } = fakeHost();
  const tool = buildMcpRegisteredTool(
    host,
    "github",
    { name: "create_issue", inputSchema: { type: "object" } },
    flags,
  );

  test("the registered name is the one the docs use", () => {
    expect(tool.name).toBe("mcp__github__create_issue");
  });

  async function decide(ruleSet: RuleSet, mode: PermissionMode): Promise<string | undefined> {
    const state = mkdtempSync(join(tmpdir(), "mcp-names-"));
    try {
      const runContext = createRunContext();
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((e) => events.push(e));
      await runChatLoop({
        model: "test-model",
        instructions: "mcp names",
        runContext,
        sessionRootDir: state,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: mode,
        permissionRules: ruleSet,
        tools: [tool],
        _adapter: adapterFor(tool.name, { title: "x" }),
      });
      const first = events.find((e) => e.kind === "permission_decision");
      return first?.kind === "permission_decision" ? first.decision : undefined;
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  }

  test("alwaysDeny mcp__github__* denies in auto mode, where the tool was allowed before", async () => {
    const before = calls();
    expect(await decide(rules(["alwaysDeny", "mcp__github__*"]), "auto")).toBe("deny");
    expect(calls()).toBe(before);
  });

  test("a rule in the pre-0.7.1 spelling still denies it", async () => {
    const before = calls();
    expect(await decide(rules(["alwaysDeny", "github__*"]), "auto")).toBe("deny");
    expect(await decide(rules(["alwaysDeny", "github__create_issue"]), "default")).toBe("deny");
    expect(calls()).toBe(before);
  });

  test("control: with no rule, auto mode runs the (non-destructive) tool", async () => {
    const before = calls();
    expect(await decide(emptyRuleSet, "auto")).toBe("allow");
    expect(calls()).toBe(before + 1);
  });

  test("model profiles: a tools selector keeps it, a deny removes it", () => {
    const tools = [tool, { name: "Read" }];
    const selected = buildAdvertisement(tools, { tools: ["mcp__github__*", "Read"] });
    expect(selected.tools.map((t) => t.name)).toEqual(["mcp__github__create_issue", "Read"]);
    for (const deny of ["mcp__github__*", "github__*"]) {
      const pruned = buildAdvertisement(tools, { permissions: { deny: [deny] } });
      expect(pruned.tools.map((t) => t.name)).toEqual(["Read"]);
    }
  });

  test("egress and the scope audit see an MCP tool as one", () => {
    // The #144 tier: a runtime-joined MCP sink blocks non-user content.
    expect(defaultSinkScope(tool.name)).toBe("external-dynamic");
    expect(isOutwardName(tool.name)).toBe(true);
  });

  test("the engine agrees for every mode, rule spelling and polarity", () => {
    const call = { toolName: tool.name, input: {}, readOnly: false, destructive: false };
    for (const pattern of ["mcp__github__*", "github__*", "mcp__github__create_issue"]) {
      for (const mode of ["default", "auto", "plan"] as const) {
        expect(evaluate(call, mode, rules(["alwaysDeny", pattern]))).toBe("deny");
      }
      expect(evaluate(call, "default", rules(["alwaysAllow", pattern]))).toBe("allow");
    }
  });
});

describe("a hook script that reads the tool name from its payload (0.7.1)", () => {
  const { host, calls } = fakeHost();
  const tool = buildMcpRegisteredTool(
    host,
    "github",
    { name: "create_issue", inputSchema: { type: "object" } },
    flags,
  );

  /** Run one call through the loop with `hooks`; report whether the tool ran. */
  async function run(hooks: HookDef[]): Promise<{ ran: boolean; fired: TraceEvent[] }> {
    const state = mkdtempSync(join(tmpdir(), "mcp-hooks-"));
    try {
      const runContext = createRunContext();
      const fired: TraceEvent[] = [];
      runContext.eventBus.subscribe((e) => {
        if (e.kind === "hook_fired") fired.push(e);
      });
      const before = calls();
      await runChatLoop({
        model: "test-model",
        instructions: "mcp hooks",
        runContext,
        sessionRootDir: state,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "auto",
        permissionRules: emptyRuleSet,
        tools: [tool],
        hooks,
        _adapter: adapterFor(tool.name, { title: "x" }),
      });
      return { ran: calls() > before, fired };
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  }

  const denyIf = (needle: string, event: "pre-tool" | "post-tool" = "pre-tool"): HookDef => ({
    event,
    command: `if grep -q '${needle}'; then printf '{"decision":"deny","reason":"blocked"}'; else printf '{"decision":"allow"}'; fi`,
  });

  test("a guard comparing the old spelling reads it from legacyName, before and after the call", async () => {
    const pre = await run([denyIf('"legacyName":"github__create_issue"')]);
    expect(pre.ran).toBe(false);
    const post = await run([denyIf('"legacyName":"github__create_issue"', "post-tool")]);
    expect(post.fired.map((e) => (e.kind === "hook_fired" ? e.allowed : undefined))).toEqual([
      false,
    ]);
  });

  test("a guard comparing the registered name blocks it", async () => {
    expect((await run([denyIf('"name":"mcp__github__create_issue"')])).ran).toBe(false);
  });

  test("name is the registered name now, so a guard on the old name alone lets it run", async () => {
    // The behaviour change the CHANGELOG names: such a script must compare
    // legacyName (or accept both spellings) to keep blocking.
    expect((await run([denyIf('"name":"github__create_issue"')])).ran).toBe(true);
  });
});

describe("every copy of the old-spelling rule agrees", () => {
  // Generated, not listed: servers and tools drawn from the grammar tool-mcp
  // accepts, including remote tool names that themselves contain `__` and the
  // server keys 0.7.0 ran that the spec now only warns about (`__` inside,
  // `_` at an end).
  const servers = [
    "a",
    "gh",
    "my-server",
    "my_server",
    "x1",
    "gh__enterprise",
    "_internal",
    "__lead",
    "trail_",
  ];
  const remotes = ["t", "create_issue", "a__b", "_lead", "trail_"];
  const names = servers.flatMap((s) =>
    remotes.map(
      (r) => buildMcpRegisteredTool(fakeHost().host, s, { name: r, inputSchema: {} }, flags).name,
    ),
  );

  test("tool-catalog and the matcher recover the same old spelling", () => {
    expect(names).toHaveLength(servers.length * remotes.length);
    for (const name of names) {
      const legacy = legacyMcpToolName(name);
      expect(legacy).toBeDefined();
      expect(matcherLegacy(name)).toBe(legacy);
    }
    for (const notMcp of ["Read", "gh__create_issue", "mcp__", "mcp__x__"]) {
      expect(matcherLegacy(notMcp)).toBe(legacyMcpToolName(notMcp));
    }
  });

  test("rules, tool lists and profile patterns all accept the old spelling, and only for MCP names", () => {
    for (const name of names) {
      const legacy = legacyMcpToolName(name) as string;
      expect(matchesToolName(compilePattern(escapeGlobLiteral(legacy)), name)).toBe(true);
      expect(toolListEntryNames(legacy, name)).toBe(true);
      expect(matchesToolPattern(legacy, name)).toBe(true);
    }
    // One way only: an mcp__ spelling never names a tool that is not MCP.
    expect(matchesToolName(compilePattern("mcp__gh__t"), "gh__t")).toBe(false);
    expect(toolListEntryNames("mcp__gh__t", "gh__t")).toBe(false);
    expect(matchesToolPattern("mcp__gh__t", "gh__t")).toBe(false);
  });

  test("hooks-engine agrees with the other copies on every generated name", async () => {
    // One hook per distinct old spelling; each name must fire exactly the
    // hook for its own old spelling, and a name with none must fire nothing.
    const legacies = [...new Set(names.map((n) => matcherLegacy(n) as string))];
    const hooks = legacies.map((matcher) => ({
      event: "pre-tool" as const,
      matcher,
      command: `printf '{"decision":"allow"}'`,
    }));
    const probes = [...names, "Read", "gh__create_issue", "mcp__", "mcp__x__", "mcp____t"];
    const fired = await Promise.all(
      probes.map(async (name) => ({
        name,
        matchers: (await runHooks("pre-tool", { name }, hooks)).map((r) => r.hook.matcher),
      })),
    );
    let aliased = 0;
    for (const { name, matchers } of fired) {
      const legacy = matcherLegacy(name);
      // A non-MCP probe (`gh__create_issue`) fires only a hook that names it
      // exactly; an MCP name fires the hook for its old spelling.
      const expected = legacies.filter((m) => m === name || m === legacy);
      expect({ name, matchers }).toEqual({ name, matchers: expected });
      if (legacy !== undefined && matchers.includes(legacy)) aliased++;
    }
    expect(aliased).toBe(names.length);
    // One way only: a hook on the new spelling never fires for a non-MCP name.
    const newSpelling = [{ event: "pre-tool" as const, matcher: "mcp__gh__t", command: "true" }];
    expect(await runHooks("pre-tool", { name: "gh__t" }, newSpelling)).toEqual([]);
  }, 20_000);

  test("a hook written against the old spelling still fires", async () => {
    const hook = {
      event: "pre-tool" as const,
      matcher: "gh__*",
      command: `printf '{"decision":"deny","reason":"old spelling"}'`,
    };
    const fired = await runHooks("pre-tool", { name: "mcp__gh__create_issue" }, [hook]);
    expect(fired.map((r) => r.decision)).toEqual([{ decision: "deny", reason: "old spelling" }]);
    const missed = await runHooks("pre-tool", { name: "mcp__other__create_issue" }, [hook]);
    expect(missed).toEqual([]);
  });
});

describe("the spec and tool-mcp agree on server names (extension-path#15)", () => {
  test("a key parses exactly when tool-mcp would register it", () => {
    const alphabet = ["a", "Z", "0", "-", "_", ".", " "];
    const candidates = new Set<string>();
    for (const x of alphabet)
      for (const y of alphabet) for (const z of alphabet) candidates.add(`${x}${y}${z}`);
    let accepted = 0;
    for (const key of candidates) {
      let parsed = true;
      try {
        parseSpec(
          `name: n\ntarget: cli\nagent:\n  model: m\n  instructions: i\nmcp_servers:\n  ${JSON.stringify(key)}:\n    transport: stdio\n    command: npx\n`,
        );
      } catch {
        parsed = false;
      }
      expect({ key, parsed }).toEqual({ key, parsed: mcpServerNameProblem(key) === undefined });
      if (parsed) accepted++;
    }
    // Both answers occur, so the agreement is not vacuous.
    expect(candidates.size).toBe(alphabet.length ** 3);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(candidates.size);
  });
});
