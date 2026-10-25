/**
 * 0.8.0 (design/0.8.0-provability-release.md §8) — sub-agent threading under
 * a gated parent: a Task child receives the parent's provability floor and
 * skill as READ-ONLY guidance in its system prompt, only when the parent's
 * `provability` is on; the child is never gated itself, and only the parent's
 * final text is verified.
 *
 * Pinned at both seams: `spawnSubAgent` handed a parent handle directly, and
 * end to end through a parent `runChatLoop` whose Task tool spawns the child
 * (runtime-core projects the seam onto the bridge, `projectParentHandle`
 * copies it, the spawner renders it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type {
  ParentRunHandle,
  SpawnSubAgentOptions,
  SubAgentDefinition,
} from "@crewhaus/agent-context-isolation";
import { openEventLog } from "@crewhaus/event-log";
import { type RuleSet, emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { type RunProvability, runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { createTaskTool } from "@crewhaus/tool-task";
import { z } from "zod";
import { childProvabilityGuidance, spawnSubAgent } from "./index.js";

type StreamRequest = Parameters<ProviderAdapter["stream"]>[0];

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spawner-provability-"));
  made.push(dir);
  return dir;
};

/** A scripted adapter that records every request's system blocks. */
function capturing(scripts: ReadonlyArray<Anthropic.ContentBlock[]>): {
  readonly adapter: ProviderAdapter;
  readonly requests: StreamRequest[];
} {
  const requests: StreamRequest[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
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
      requests.push({ ...req, system: req.system.map((b) => ({ ...b })) } as StreamRequest);
      const content = scripts[Math.min(i++, scripts.length - 1)] ?? [];
      const toolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block?.type === "text") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          } else if (block?.type === "tool_use") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          }
        }
        yield { kind: "message_delta", stopReason: toolUse ? "tool_use" : "end_turn" } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
  return { adapter, requests };
}

const text = (t: string): Anthropic.ContentBlock[] => [
  { type: "text", text: t, citations: null } as Anthropic.TextBlock,
];
const systemTexts = (req: StreamRequest | undefined): string[] =>
  (req?.system ?? []).map((b) => b.text);

const RESEARCHER: SubAgentDefinition = {
  name: "researcher",
  description: "isolated researcher",
  instructions: "Research the thing.",
  tools: [],
};

async function parentHandle(root: string): Promise<ParentRunHandle> {
  const runContext = createRunContext();
  const rules: RuleSet = { ...emptyRuleSet };
  return {
    runContext,
    eventLog: await openEventLog(runContext.sessionId, { rootDir: root }),
    permissionMode: "default",
    permissionRules: rules,
    tools: [] as ReadonlyArray<RegisteredTool>,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
    sessionRootDir: root,
  };
}

const spawnWith = async (
  parent: ParentRunHandle,
  root: string,
  childTools: ReadonlyArray<RegisteredTool> = [],
) => {
  const { adapter, requests } = capturing([text("done")]);
  const result = await spawnSubAgent(parent, {
    def: RESEARCHER,
    prompt: "find the refund window",
    permissionMode: "bypass",
    permissionRules: { ...emptyRuleSet },
    childTools,
    sessionRootDir: root,
    _client: adapter,
  });
  await parent.eventLog.close();
  return { result, system: systemTexts(requests[0]) };
};

describe("childProvabilityGuidance", () => {
  test("names the floor, the citation grammar the parent's gate reads, and that only the parent is checked", () => {
    const g = childProvabilityGuidance({ level: "grounded" });
    expect(g.startsWith('<provability_guidance level="grounded">')).toBe(true);
    expect(g.endsWith("</provability_guidance>")).toBe(true);
    expect(g).toContain("the `grounded` floor");
    expect(g).toContain("Only the parent's final answer is checked");
    expect(g).toContain("[n]: <the URL or workspace path you fetched or read>");
    expect(g).toContain("[n]: tool:<toolUseId>");
  });

  test("appends the parent's rendered skill when there is one, and only then", () => {
    const skill = "Cite with [n]; close with [n]: <source>; run ProvabilityPreflight.";
    const withSkill = childProvabilityGuidance({ level: "cited", skill: `  ${skill}\n` });
    expect(withSkill).toContain(`\n\n${skill}\n</provability_guidance>`);
    expect(childProvabilityGuidance({ level: "cited", skill: "   " })).toBe(
      childProvabilityGuidance({ level: "cited" }),
    );
  });
});

/**
 * A skill laid out as the shipped `provability` skill renders for a parent
 * whose gate retries (`@crewhaus/default-skills`; evaluation-service's
 * child-skill test pins that layout): an opening about the parent's own
 * answer, then sections, with the provability tools named in list items.
 */
const PARENT_SKILL = [
  "A proof gate checks each answer before it is served. Here the floor is",
  "`grounded`: every claim needs evidence at that rung or above. An answer",
  "that falls short comes back to you with what failed, at most once; after that it is served with a failing verdict.",
  "",
  "## How to cite",
  "",
  "- `[n]: <url>` or `[n]: <workspace path>` — a page you fetched, a file you read",
  "- `[n]: proof:prf_…` — the id `ProofCheck` returned",
  "",
  "## How to pass",
  "",
  "- Fetch or read a source before you cite it, and quote its exact words when",
  "  you can: a quote is matched verbatim, a paraphrase only by word overlap.",
  "- A proof meets any floor. To prove a claim, call `ProofCheckers` and pick an",
  "  available checker, call `ProofCheck`, and cite the id it returns.",
  "- Before you finish, run `ProvabilityPreflight` on the whole draft,",
  "  definition lines included, and fix every claim it reports.",
  "- Drop a claim you cannot support.",
].join("\n");

/** A stand-in for one of the parent's provability tools, by name. */
const toolNamed = (name: string): RegisteredTool =>
  buildTool({
    name,
    description: `${name} stand-in`,
    inputSchema: z.object({}),
    execute: async () => "ok",
  });

describe("childProvabilityGuidance — only the parts of the parent's skill true for a child", () => {
  test("never what happens to a failing answer: a child's reply is not checked, retried or served", () => {
    const g = childProvabilityGuidance({ level: "grounded", skill: PARENT_SKILL });
    expect(g).not.toContain("comes back to you");
    expect(g).not.toContain("is served");
    expect(g).toContain("## How to cite");
    expect(g).toContain("## How to pass");
    expect(g).toContain(
      "  you can: a quote is matched verbatim, a paraphrase only by word overlap.",
    );
    expect(g).toContain("- Drop a claim you cannot support.");
  });

  test("a provability tool only when the child's own tool set has it", () => {
    const none = childProvabilityGuidance({ level: "grounded", skill: PARENT_SKILL });
    for (const tool of ["ProvabilityPreflight", "ProofCheckers", "ProofCheck", "proof:prf_"]) {
      expect(none).not.toContain(tool);
    }
    // Its continuation line goes with it.
    expect(none).not.toContain("definition lines included");
    const preflight = childProvabilityGuidance({ level: "grounded", skill: PARENT_SKILL }, [
      "ProvabilityPreflight",
    ]);
    expect(preflight).toContain(
      "- Before you finish, run `ProvabilityPreflight` on the whole draft,\n  definition lines included, and fix every claim it reports.",
    );
    expect(preflight).not.toContain("ProofCheck");
    const proofs = childProvabilityGuidance({ level: "grounded", skill: PARENT_SKILL }, [
      "ProofCheckers",
      "ProofCheck",
    ]);
    expect(proofs).toContain("call `ProofCheckers` and pick an");
    expect(proofs).toContain("- `[n]: proof:prf_…` — the id `ProofCheck` returned");
    expect(proofs).not.toContain("ProvabilityPreflight");
  });
});

describe("spawnSubAgent — the read-only provability seam (direct handle)", () => {
  test("a gated parent whose gate retries: the child's system prompt never says its reply comes back to it", async () => {
    // The parent's skill went in whole: a child read that ITS answer is gated
    // and retried, and was told to run ProvabilityPreflight, which a child on
    // a `tools:` allowlist need not have.
    const root = tempRoot();
    const gated = async (): Promise<ParentRunHandle> => ({
      ...(await parentHandle(root)),
      provability: { level: "grounded", skill: PARENT_SKILL },
    });
    const bare = (await spawnWith(await gated(), root)).system[0] ?? "";
    expect(bare).toContain("Only the parent's final answer is checked");
    expect(bare).toContain("## How to cite");
    expect(bare).not.toContain("comes back to you");
    expect(bare).not.toContain("ProvabilityPreflight");
    const tooled = (await spawnWith(await gated(), root, [toolNamed("ProvabilityPreflight")]))
      .system[0];
    expect(tooled).toContain("run `ProvabilityPreflight` on the whole draft");
    expect(tooled).not.toContain("comes back to you");
  });

  test("a gated parent: the child's system prompt carries the guidance after its own instructions", async () => {
    const root = tempRoot();
    const parent: ParentRunHandle = {
      ...(await parentHandle(root)),
      provability: { level: "grounded", skill: "SKILL BODY: cite every claim." },
    };
    const { result, system } = await spawnWith(parent, root);
    expect(result.finalMessage).toBe("done");
    const first = system[0] ?? "";
    expect(first.startsWith('Research the thing.\n\n<provability_guidance level="grounded">')).toBe(
      true,
    );
    expect(first).toContain("SKILL BODY: cite every claim.");
  });

  test("an ungated parent: no guidance anywhere in the child's system prompt", async () => {
    const root = tempRoot();
    const { system } = await spawnWith(await parentHandle(root), root);
    expect(system[0]).toBe("Research the thing.");
    expect(system.some((t) => t.includes("provability"))).toBe(false);
  });
});

/** A gate that passes everything — the parent's gate is not under test here, the threading is. */
function passingGate(skill?: string): RunProvability & { readonly verified: string[] } {
  const verified: string[] = [];
  return {
    level: "cited",
    onFail: "note",
    maxRetries: 0,
    threshold: 1,
    render: "none",
    nudge: () => "cite",
    ...(skill !== undefined ? { skill } : {}),
    verified,
    verify: async (turn) => {
      verified.push(turn.finalText);
      return {
        version: 1,
        level: "cited",
        verdict: "pass",
        score: 1,
        threshold: 1,
        achieved: "cited",
        claims: [],
        claimCount: 0,
        met: 0,
        unmet: 0,
        assumptions: 0,
        sources: 0,
        judgeWaived: 0,
        retryIndex: turn.retryIndex,
        createdAt: "2026-10-22T12:00:00.000Z",
        bundleHash: `sha256:${"0".repeat(64)}`,
      };
    },
  };
}

describe("spawnSubAgent — end to end through a parent runChatLoop + Task tool", () => {
  const runParent = async (root: string, provability: RunProvability | undefined) => {
    const subAgents = new Map([[RESEARCHER.name, RESEARCHER]]);
    const child = capturing([
      text("the window is 14 days [1]\n\n[1]: https://acme.example/policy"),
    ]);
    const parent = capturing([
      [
        {
          type: "tool_use",
          id: "tu_task",
          name: "Task",
          input: { description: "research", prompt: "dig in", subagent_type: "researcher" },
        } as Anthropic.ToolUseBlock,
      ],
      text("Refunds take 14 days [1].\n\n[1]: https://acme.example/policy"),
    ]);
    const reply = await runChatLoop({
      model: "test-model",
      instructions: "delegate to the researcher",
      _adapter: parent.adapter,
      sessionRootDir: root,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go research" }],
      tools: [createTaskTool({ subAgents })],
      permissionMode: "bypass",
      installSigintHandler: false,
      stdout: () => {},
      subAgents,
      ...(provability !== undefined ? { provability } : {}),
      spawnSubAgent: (p, opts: SpawnSubAgentOptions) =>
        spawnSubAgent(p, { ...opts, _client: child.adapter }),
    });
    return { reply, childSystem: systemTexts(child.requests[0]), parentRequests: parent.requests };
  };

  test("parent provability on: the child is told the floor and the skill; only the parent's answer is verified", async () => {
    const gate = passingGate("SKILL: close with a definitions block.");
    const run = await runParent(tempRoot(), gate);
    expect(run.childSystem[0]).toContain('<provability_guidance level="cited">');
    expect(run.childSystem[0]).toContain("SKILL: close with a definitions block.");
    // The gate graded exactly one answer — the parent's — never the child's.
    expect(gate.verified).toEqual([
      "Refunds take 14 days [1].\n\n[1]: https://acme.example/policy",
    ]);
    // The parent's own prompt is not where the child guidance goes.
    expect(systemTexts(run.parentRequests[0]).some((t) => t.includes("provability_guidance"))).toBe(
      false,
    );
  });

  test("parent provability on without a skill: the floor alone", async () => {
    const run = await runParent(tempRoot(), passingGate());
    expect(run.childSystem[0]).toContain('<provability_guidance level="cited">');
    expect(run.childSystem[0]).not.toContain("SKILL");
  });

  test("parent provability off: the child's system prompt is its instructions alone", async () => {
    const run = await runParent(tempRoot(), undefined);
    expect(run.reply).toContain("Refunds take 14 days");
    expect(run.childSystem[0]).toBe("Research the thing.");
    expect(run.childSystem.some((t) => t.includes("provability"))).toBe(false);
  });
});
