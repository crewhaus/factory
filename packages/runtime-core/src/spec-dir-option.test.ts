/**
 * `RunChatLoopOptions.specDir`: the record of a spec kept in another directory
 * (`<specDir>/.crewhaus/run/spec`) is on the runtime-state floor for the run
 * and for every loop it starts, and a spec in the working directory adds no
 * root (the list the loop hands its tools is the same element for element).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop, runtimeStateRoots } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-spec-dir-sessions-"));
const scratch: string[] = [];
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
  rmSync(SESSION_ROOT, { recursive: true, force: true });
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/** One scripted call per entry; the last repeats. */
function scriptedAdapter(scripts: ReadonlyArray<ReadonlyArray<Block>>): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: (_req: ProviderRequest) => {
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i++;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block === undefined) continue;
          if (block.type === "text") {
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
          } else {
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
          }
          yield { kind: "content_block_stop", index: idx } as const;
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

/** What one run saw: the Write's decision and paths, and what the probe recorded. */
interface Seen {
  readonly decisions: string[];
  readonly written: string[];
  readonly bridgeRoots: Array<readonly string[] | undefined>;
  readonly scopeRoots: string[][];
}

/**
 * One single-turn loop in `cwd` that calls `Write <path>` and then the probe,
 * under `alwaysAllow *`, so only the floor can refuse the Write.
 */
async function runOnce(cwd: string, path: string, specDir: string | undefined): Promise<Seen> {
  const seen: Seen = { decisions: [], written: [], bridgeRoots: [], scopeRoots: [] };
  const write = buildTool({
    name: "Write",
    description: "write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    operativeArgs: [{ field: "path", kind: "path" }],
    destructive: true,
    execute: async (input) => {
      seen.written.push(input.path);
      return "written";
    },
  });
  const probe = buildTool({
    name: "Probe",
    description: "record the floor",
    inputSchema: z.object({}),
    readOnly: true,
    execute: async (_input, ctx) => {
      seen.bridgeRoots.push(
        (ctx as { bridge?: { protectedRoots?: readonly string[] } } | undefined)?.bridge
          ?.protectedRoots,
      );
      // What a loop started inside this run computes for itself.
      seen.scopeRoots.push(runtimeStateRoots(undefined, undefined));
      return "probed";
    },
  });
  const runContext = createRunContext();
  runContext.eventBus.subscribe((e: TraceEvent) => {
    if (e.kind === "permission_decision") {
      const d = e as TraceEvent & { toolName: string; decision: string };
      if (d.toolName === "Write") seen.decisions.push(d.decision);
    }
  });
  const home = process.cwd();
  process.chdir(cwd);
  try {
    await runChatLoop({
      model: "test-model",
      instructions: "write the file",
      _adapter: scriptedAdapter([
        [
          { type: "tool_use", id: "toolu_w", name: "Write", input: { path, content: "{}" } },
          { type: "tool_use", id: "toolu_p", name: "Probe", input: {} },
        ],
        [{ type: "text", text: "done" }],
      ]),
      runContext,
      sessionRootDir: SESSION_ROOT,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [write, probe],
      permissionMode: "auto",
      permissionRules: {
        ...emptyRuleSet,
        flag: [{ type: "alwaysAllow", pattern: "*", source: "flag" }],
      },
      settingsDir: null,
      spinner: false,
      stdout: () => {},
      ...(specDir !== undefined ? { specDir } : {}),
    });
  } finally {
    process.chdir(home);
  }
  return seen;
}

describe("a run's specDir option", () => {
  test("the record of a spec in another directory is refused to a Write, whatever a rule says", async () => {
    const cwd = tempDir("crewhaus-spec-dir-cwd-");
    const specDir = tempDir("crewhaus-spec-dir-spec-");
    const target = join(specDir, ".crewhaus", "run", "spec", "surfaces.json");

    const guarded = await runOnce(cwd, target, specDir);
    expect(guarded.decisions).toEqual(["deny"]);
    expect(guarded.written).toEqual([]);

    // The same run without the option: the rule allows the Write, so the
    // refusal above comes from the spec's directory alone.
    const open = await runOnce(cwd, target, undefined);
    expect(open.decisions).toEqual(["allow"]);
    expect(open.written).toEqual([target]);
    // Two full loops, slow by construction on a loaded runner.
  }, 20_000);

  test("a loop started inside the run puts the same record on its floor", async () => {
    const cwd = tempDir("crewhaus-spec-dir-cwd-");
    const specDir = tempDir("crewhaus-spec-dir-spec-");
    const record = join(specDir, ".crewhaus", "run", "spec");
    const decoy = join(cwd, "notes.txt");

    const guarded = await runOnce(cwd, decoy, specDir);
    expect(guarded.scopeRoots).toHaveLength(1);
    expect(guarded.scopeRoots[0]).toContain(record);

    const open = await runOnce(cwd, decoy, undefined);
    expect(open.scopeRoots).toHaveLength(1);
    expect(open.scopeRoots[0]).not.toContain(record);
    // Two full loops, slow by construction on a loaded runner.
  }, 20_000);

  test("a spec in the working directory adds no root, named directly or through a link", async () => {
    const cwd = tempDir("crewhaus-spec-dir-cwd-");
    const links = tempDir("crewhaus-spec-dir-links-");
    const linkToCwd = join(links, "here");
    symlinkSync(cwd, linkToCwd, "dir");
    const decoy = join(cwd, "notes.txt");

    const lists: Array<readonly string[] | undefined> = [];
    for (const specDir of [undefined, cwd, linkToCwd]) {
      const seen = await runOnce(cwd, decoy, specDir);
      expect(seen.bridgeRoots).toHaveLength(1);
      lists.push(seen.bridgeRoots[0]);
    }
    expect(lists[0]).toBeDefined();
    expect((lists[0] ?? []).length).toBeGreaterThan(0);
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
    // Three full loops, slow by construction on a loaded runner.
  }, 20_000);
});
