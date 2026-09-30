/**
 * 0.7.1 (C002) — an eval bridge grades the agent the spec describes: its
 * `tool_config` and its permission rules reach the runner.
 *
 * The emitted bundle is RUN, not grepped: it is written to a temp dir whose
 * `node_modules` links this working tree's packages, its dataset is seeded,
 * and it is driven against a local fake of the Anthropic Messages API that
 * asks for two tool calls and records what the agent sent back.
 *
 *   - GitStatus under an `alwaysDeny GitStatus` rule must be refused by the
 *     rule. On 0.7.0 and before this fix the bundle carried `rules: []`, so
 *     GitStatus ran.
 *   - HttpRequest, allowed by an `alwaysAllow HttpRequest` rule, to an origin
 *     that tool_config does not list must be refused by the CONFIGURED
 *     allow-list. Before, the bundle carried neither: the call was refused
 *     because HttpRequest asks by default and an eval cannot prompt, and even
 *     with the rule the empty allow-list refuses every origin.
 *
 * Neither call needs the network: the rule and the allow-list both decide
 * before any I/O.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type EvalBundleIr, emitEval } from "./index";

const REPO_ROOT = join(import.meta.dir, "../../..");
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Link every workspace package, so the bundle resolves THIS tree, offline. */
function linkWorkspacePackages(dir: string): void {
  const nodeModules = join(dir, "node_modules");
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(REPO_ROOT, "packages", entry.name);
    const manifest = join(pkgDir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined || !name.startsWith("@crewhaus/")) continue;
    const dest = join(nodeModules, name);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(pkgDir, dest, "dir");
  }
}

type ToolUse = { readonly id: string; readonly name: string; readonly input: unknown };

/** One streamed assistant message, in the Messages API's SSE framing. */
function sse(blocks: ReadonlyArray<ToolUse | string>): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
  ];
  let hasTool = false;
  blocks.forEach((b, index) => {
    if (typeof b === "string") {
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      ]);
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "text_delta", text: b } },
      ]);
    } else {
      hasTool = true;
      events.push([
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
        },
      ]);
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
        },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: hasTool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

const IR: EvalBundleIr = {
  version: 0,
  name: "policy-bridge",
  target: "eval",
  agent: {
    model: "claude-haiku-4-5-20251001",
    instructions: "Check the repository and fetch the page.",
    tools: ["gitStatus", "httpRequest"],
  },
  dataset: { name: "policy-bridge-eval", version: "v1", split: "dev" },
  graders: [{ name: "expected_contains" }],
  concurrency: 1,
  toolConfigs: { http: { allowed_origins: ["https://allowed.invalid"] } },
  permissions: {
    rules: [
      { type: "alwaysDeny", pattern: "GitStatus" },
      // HttpRequest asks by default, and an eval run cannot prompt, so without
      // this rule it is refused before tool_config is ever consulted.
      { type: "alwaysAllow", pattern: "HttpRequest" },
    ],
  },
};

describe("eval bridge — the spec's tool_config and permission rules reach the runner (C002)", () => {
  test("a run of the emitted bundle denies by the spec's rule and refuses by its allow-list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-bundle-policy-"));
    tempDirs.push(dir);
    const bundle = emitEval(IR, {
      readme: false,
      bridge: { sourceTarget: "research", kind: "single-turn-chat-loop", chatCapable: false },
    });
    for (const file of bundle.files) writeFileSync(join(dir, file.path), file.content);
    linkWorkspacePackages(dir);
    const datasetsDir = join(dir, "datasets");
    writeFileSync(
      join(dir, "seed.ts"),
      `import { createFileBackedRegistry } from "@crewhaus/dataset-registry";
await createFileBackedRegistry({ rootDir: ${JSON.stringify(datasetsDir)} }).put({
  name: "policy-bridge-eval",
  version: "v1",
  splits: { train: [], dev: [{ id: "s1", input: "go", expected: "done" }] },
});
`,
    );

    // The fake model: turn 1 asks for both tools, turn 2 answers.
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/messages")) {
          return new Response("not found", { status: 404 });
        }
        const body = (await req.json()) as (typeof requests)[number];
        requests.push(body);
        const text =
          requests.length === 1
            ? sse([
                { id: "tu_git", name: "GitStatus", input: {} },
                {
                  id: "tu_http",
                  name: "HttpRequest",
                  input: {
                    url: "https://elsewhere.invalid/page",
                    method: "GET",
                    justification: "Fetch the page the task names so the check can finish.",
                  },
                },
              ])
            : sse(["done"]);
        return new Response(text, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: dir,
        ANTHROPIC_API_KEY: "test-key-not-real",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        CREWHAUS_DATASETS_DIR: datasetsDir,
        CREWHAUS_REGISTRY_ROOT: join(dir, "registry"),
        // HttpRequest needs a justification; the operator opt-in accepts the
        // rule-based judge, so the call reaches the tool.
        CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION: "1",
      };
      const run = async (file: string) => {
        const proc = Bun.spawn([process.execPath, "--no-install", join(dir, file)], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      };
      const seeded = await run("seed.ts");
      expect(seeded.stderr).toBe("");
      expect(seeded.code).toBe(0);
      const ran = await run("agent.ts");
      if (ran.code !== 0) throw new Error(`bundle failed (${ran.code}): ${ran.stderr}`);

      // The second request carries the two tool results the agent produced.
      expect(requests.length).toBe(2);
      const last = requests[1]?.messages?.at(-1);
      const results = new Map<string, string>();
      for (const block of (last?.content ?? []) as Array<{
        type?: string;
        tool_use_id?: string;
        content?: unknown;
      }>) {
        if (block.type !== "tool_result" || block.tool_use_id === undefined) continue;
        results.set(block.tool_use_id, JSON.stringify(block.content));
      }
      expect([...results.keys()].sort()).toEqual(["tu_git", "tu_http"]);
      // The spec's alwaysDeny rule decided GitStatus: it never ran.
      expect(results.get("tu_git")).toBe(JSON.stringify("tool denied by permission policy"));
      // The spec's allow-list decided HttpRequest: a configured list that does
      // not name this origin, not the empty list a bundle without tool_config
      // has.
      expect(results.get("tu_http")).toContain(
        'denied: origin \\"https://elsewhere.invalid\\" is not in allowed_origins',
      );
      expect(results.get("tu_http")).not.toContain("empty allow-list");
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
