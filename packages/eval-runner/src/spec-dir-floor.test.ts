/**
 * `RunEvalOptions.specDir`: every agent the default invoker starts for a spec
 * kept in another directory has that spec's record (`<specDir>/.crewhaus/run/spec`)
 * on its runtime-state floor, and a spec in the working directory adds no root.
 *
 * The real `runChatLoop` runs behind the `chatLoop` seam with a scripted model;
 * the wrapper allows every tool call by rule, so only the floor can refuse one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrV0 } from "@crewhaus/ir";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { runChatLoop } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runEval } from "./index";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const IR = (): IrV0 =>
  lower(
    parseSpec(
      "name: spec-dir-eval\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: write the file\n",
    ),
  ) as IrV0;

type Adapter = NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>;
type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/** A model that answers each call with the next scripted content (the last repeats). */
function scriptedModel(scripts: ReadonlyArray<ReadonlyArray<Block>>): Adapter {
  let i = 0;
  const adapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream() {
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i += 1;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" };
        for (let idx = 0; idx < content.length; idx += 1) {
          const block = content[idx] as Block;
          if (block.type === "text") {
            yield { kind: "content_block_start", index: idx, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            };
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            };
          }
          yield { kind: "content_block_stop", index: idx };
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
  return adapter as unknown as Adapter;
}

async function* samplesOf(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

/** What one eval saw: the Write's decisions and paths, the probe's lists, the loop's options. */
interface Seen {
  readonly decisions: string[];
  readonly written: string[];
  readonly bridgeRoots: Array<readonly string[] | undefined>;
  readonly loopOpts: Array<Record<string, unknown>>;
}

/**
 * One single-sample eval in `cwd` whose agent calls `Write <path>` and then a
 * probe that records the roots on its bridge. `sessionRootDir` fixes the
 * loop's session root (the default invoker gives each run its own).
 */
async function evalOnce(args: {
  readonly cwd: string;
  readonly outDir: string;
  readonly path: string;
  readonly specDir: string | undefined;
  readonly sessionRootDir?: string;
}): Promise<Seen> {
  const seen: Seen = { decisions: [], written: [], bridgeRoots: [], loopOpts: [] };
  const write: RegisteredTool = {
    name: "Write",
    description: "write a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }).strict() as never,
    operativeArgs: [{ field: "path", kind: "path" }],
    execute: async (input) => {
      seen.written.push((input as { path: string }).path);
      return "written";
    },
    concurrencySafe: false,
    readOnly: false,
    destructive: true,
    requiresSandbox: false,
    classifyOutput: false,
    scope: "internal",
    requireJustification: false,
  };
  const probe: RegisteredTool = {
    name: "Probe",
    description: "record the floor",
    inputSchema: z.object({}).strict() as never,
    execute: async (_input, ctx) => {
      seen.bridgeRoots.push(
        (ctx as { bridge?: { protectedRoots?: readonly string[] } } | undefined)?.bridge
          ?.protectedRoots,
      );
      return "probed";
    },
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: false,
    scope: "internal",
    requireJustification: false,
  };
  const chatLoop = (opts: Parameters<typeof runChatLoop>[0]) => {
    seen.loopOpts.push(opts as unknown as Record<string, unknown>);
    opts.runContext?.eventBus.subscribe((e: TraceEvent) => {
      if (e.kind === "permission_decision") {
        const d = e as TraceEvent & { toolName: string; decision: string };
        if (d.toolName === "Write") seen.decisions.push(d.decision);
      }
    });
    return runChatLoop({
      ...opts,
      _adapter: scriptedModel([
        [
          {
            type: "tool_use",
            id: "toolu_w",
            name: "Write",
            input: { path: args.path, content: "{}" },
          },
          { type: "tool_use", id: "toolu_p", name: "Probe", input: {} },
        ],
        [{ type: "text", text: "done" }],
      ]),
      spinner: false,
      stdout: () => {},
      settingsDir: null,
      permissionMode: "auto",
      permissionRules: {
        ...emptyRuleSet,
        flag: [{ type: "alwaysAllow", pattern: "*", source: "flag" }],
      },
      tools: [...(opts.tools ?? []), write, probe],
      ...(args.sessionRootDir !== undefined ? { sessionRootDir: args.sessionRootDir } : {}),
    });
  };
  const { compiled } = parseGradersConfig(
    'graders:\n  - name: done\n    type: contains\n    substring: "done"\n',
  );
  const home = process.cwd();
  // The floor's working directory is the process's.
  process.chdir(args.cwd);
  try {
    await runEval({
      ir: IR(),
      dataset: { name: "d", samples: samplesOf([{ id: "s1", input: "write it" }]) },
      compiledGraders: compiled,
      opts: {
        outDir: args.outDir,
        cwd: args.cwd,
        chatLoop,
        concurrency: 1,
        retryErrors: false,
        ...(args.specDir !== undefined ? { specDir: args.specDir } : {}),
      },
    });
  } finally {
    process.chdir(home);
  }
  return seen;
}

describe("an eval names its spec's directory to the floor", () => {
  test("a sample's write to the record of a spec in another directory is refused, whatever a rule says", async () => {
    const cwd = tempDir("eval-spec-dir-cwd-");
    const specDir = tempDir("eval-spec-dir-spec-");
    const target = join(specDir, ".crewhaus", "run", "spec", "surfaces.json");

    const guarded = await evalOnce({
      cwd,
      outDir: join(tempDir("eval-spec-dir-out-"), "run"),
      path: target,
      specDir,
    });
    expect(guarded.loopOpts[0]?.["specDir"]).toBe(specDir);
    expect(guarded.decisions).toEqual(["deny"]);
    expect(guarded.written).toEqual([]);

    // The same eval without the spec's directory: the rule allows the write,
    // so the refusal above comes from the spec's directory alone.
    const open = await evalOnce({
      cwd,
      outDir: join(tempDir("eval-spec-dir-out-"), "run"),
      path: target,
      specDir: undefined,
    });
    expect(open.decisions).toEqual(["allow"]);
    expect(open.written).toEqual([target]);
    // Two full evals through the live loop, slow by construction on a loaded runner.
  }, 30_000);

  test("a spec in the working directory adds no root, named directly or through a link", async () => {
    const cwd = tempDir("eval-spec-dir-cwd-");
    const links = tempDir("eval-spec-dir-links-");
    const linkToCwd = join(links, "here");
    symlinkSync(cwd, linkToCwd, "dir");
    const sessions = tempDir("eval-spec-dir-sessions-");
    // One output directory for all three, emptied between them, so the
    // sample's own store files land at the same paths each time.
    const outDir = join(tempDir("eval-spec-dir-out-"), "run");

    const lists: Array<readonly string[] | undefined> = [];
    for (const specDir of [undefined, cwd, linkToCwd]) {
      rmSync(outDir, { recursive: true, force: true });
      const seen = await evalOnce({
        cwd,
        outDir,
        path: join(cwd, "notes.txt"),
        specDir,
        sessionRootDir: sessions,
      });
      expect(seen.bridgeRoots).toHaveLength(1);
      lists.push(seen.bridgeRoots[0]);
    }
    expect((lists[0] ?? []).length).toBeGreaterThan(0);
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
    // Three full evals through the live loop, slow by construction on a loaded runner.
  }, 30_000);

  test("an eval that names no spec directory hands the loop no specDir key", async () => {
    const cwd = tempDir("eval-spec-dir-cwd-");
    const seen = await evalOnce({
      cwd,
      outDir: join(tempDir("eval-spec-dir-out-"), "run"),
      path: join(cwd, "notes.txt"),
      specDir: undefined,
    });
    expect(seen.loopOpts).toHaveLength(1);
    expect("specDir" in (seen.loopOpts[0] ?? {})).toBe(false);
    // A full eval through the live loop, slow by construction on a loaded runner.
  }, 30_000);
});
