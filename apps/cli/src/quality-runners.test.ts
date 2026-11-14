/**
 * `crewhaus changes check`'s runners: every agent a check starts has the
 * checked spec's record (`<the spec's real directory>/.crewhaus/run/spec`) on
 * its runtime-state floor, for a spec reached through a link and for a change
 * filed against a spec in a subdirectory.
 *
 * The real `runChatLoop` runs behind the `chatLoop` seam with a scripted model
 * whose one tool call records the protected roots the loop hands its tools.
 *
 * Also: what a candidate spec adds to the tool surface its base had: a recording of tool
 * results stands in for a check only when this is empty.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { addedToolSurface, qualityRunners } from "./quality-runners";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const SPEC =
  "name: checked\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: answer\n";
const GRADERS = 'graders:\n  - name: done\n    type: contains\n    substring: "done"\n';

type Adapter = NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>;

/** A model that calls `Probe` once, then answers "done". */
function probeOnceModel(): Adapter {
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
      const first = i === 0;
      i += 1;
      return (async function* () {
        yield { kind: "message_start" };
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "toolu_p", name: "Probe", input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          };
        }
        yield { kind: "content_block_stop", index: 0 };
        yield {
          kind: "message_delta",
          stopReason: first ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
  return adapter as unknown as Adapter;
}

/** Run one check eval of `spec` (relative to `harness`) and return the roots its loop protected. */
async function checkedRoots(harness: string, spec: string | undefined): Promise<string[]> {
  const seen: string[][] = [];
  const probe: RegisteredTool = {
    name: "Probe",
    description: "record the floor",
    inputSchema: z.object({}).strict() as never,
    execute: async (_input, ctx) => {
      seen.push([
        ...((ctx as { bridge?: { protectedRoots?: readonly string[] } } | undefined)?.bridge
          ?.protectedRoots ?? []),
      ]);
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
  const runners = qualityRunners({
    harnessDir: harness,
    ...(spec !== undefined ? { spec } : {}),
    gradersYaml: GRADERS,
    externalWrites: new Map(),
    chatLoop: (opts) =>
      runChatLoop({
        ...opts,
        _adapter: probeOnceModel(),
        spinner: false,
        stdout: () => {},
        settingsDir: null,
        tools: [...(opts.tools ?? []), probe],
      }),
  });
  const home = process.cwd();
  // The floor's working directory is the process's: the harness, as under the CLI.
  process.chdir(harness);
  try {
    await runners.evalSpec({
      label: "candidate",
      specYaml: SPEC,
      gradersYaml: GRADERS,
      samples: [{ id: "s1", input: "go" }],
      datasetName: "d",
      datasetHash: "sha256:0",
      outDir: join(tempDir("quality-runners-out-"), "run"),
    });
  } finally {
    process.chdir(home);
  }
  expect(seen).toHaveLength(1);
  return seen[0] ?? [];
}

function spec(tools: string[], servers: Record<string, string>): string {
  const lines = [
    "name: shop",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: Help the customer.",
    `tools: [${tools.join(", ")}]`,
  ];
  const names = Object.keys(servers);
  if (names.length > 0) {
    lines.push("mcp_servers:");
    for (const name of names) {
      lines.push(`  ${name}:`, "    transport: stdio", `    command: ${servers[name]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("addedToolSurface", () => {
  const base = spec(["read"], { fs: "npx" });

  test("equal specs add nothing", () => {
    expect(addedToolSurface(base, base)).toEqual([]);
  });

  test("a spec that drops a tool adds nothing", () => {
    expect(addedToolSurface(spec(["read", "write"], { fs: "npx" }), base)).toEqual([]);
  });

  test("a new MCP server is named", () => {
    expect(addedToolSurface(base, spec(["read"], { fs: "npx", web: "npx" }))).toEqual(["web"]);
  });

  test("an MCP server under the same name with another command is named", () => {
    expect(addedToolSurface(base, spec(["read"], { fs: "bunx" }))).toEqual(["fs"]);
  });

  test("a tool the base does not name is named", () => {
    expect(addedToolSurface(base, spec(["read", "write"], { fs: "npx" }))).toEqual(["write"]);
  });

  test("a spec that cannot be read answers that it cannot tell", () => {
    expect(addedToolSurface(base, "name: [unclosed\n")).toBeUndefined();
    expect(addedToolSurface("target: 3\n", base)).toBeUndefined();
  });
});

describe("a change check protects the checked spec's record", () => {
  test("a crewhaus.yaml reached through a link: its target directory's record is on the floor", async () => {
    const harness = tempDir("quality-runners-linked-");
    const real = join(harness, "specs", "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "crewhaus.yaml"), SPEC);
    symlinkSync(join(real, "crewhaus.yaml"), join(harness, "crewhaus.yaml"));
    const roots = await checkedRoots(harness, undefined);
    expect(roots).toContain(join(real, ".crewhaus", "run", "spec"));
    // A full eval through the live loop, slow by construction on a loaded runner.
  }, 30_000);

  test("a change filed against a spec in a subdirectory: that directory's record is on the floor", async () => {
    const harness = tempDir("quality-runners-sub-");
    mkdirSync(join(harness, "sub"));
    writeFileSync(join(harness, "sub", "x.yaml"), SPEC);
    const roots = await checkedRoots(harness, join("sub", "x.yaml"));
    expect(roots).toContain(join(harness, "sub", ".crewhaus", "run", "spec"));
    // A full eval through the live loop, slow by construction on a loaded runner.
  }, 30_000);
});
