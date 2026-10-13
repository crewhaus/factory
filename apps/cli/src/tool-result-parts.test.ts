/**
 * 0.7.1 review — a one-line tool result over the preview size (an
 * HttpRequest, WebFetch or MCP JSON response) showed the model only its first
 * 10 KB: `Read` has no offset, and a Read of the saved file came back cut to
 * the same preview, so item 173 of 300 was the last it could see. The store
 * now also saves the rest in parts that one Read returns whole; this drives
 * the real loop and the real Read tool down that chain, the way a model with
 * nothing but Read would.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import { read } from "@crewhaus/tool-fs";
import { z } from "zod";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const FEATURES: ProviderFeatures = {
  caching: false,
  tool_use: true,
  vision: false,
  thinking: false,
  web_search: false,
};

/** The text of the newest tool_result in a request. */
function lastToolResult(req: ProviderRequest): string {
  const last = req.messages[req.messages.length - 1];
  if (last === undefined || typeof last.content === "string") return "";
  for (const block of last.content as Array<{ type: string; content?: unknown }>) {
    if (block.type !== "tool_result") continue;
    const c = block.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (b as { text?: string }).text ?? "").join("");
  }
  return "";
}

/**
 * A model that calls `Items` once, then follows every "Read <path> for part
 * N" pointer with Read until the output ends, and records what it was shown.
 */
function pagingModel(): { adapter: ProviderAdapter; shown: string[] } {
  const shown: string[] = [];
  let call = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic" as ProviderId,
    features: FEATURES,
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      call++;
      let next: { name: string; input: unknown } | undefined;
      if (call === 1) next = { name: "Items", input: {} };
      else {
        const result = lastToolResult(req);
        shown.push(result);
        const path = /Read (\S+) for part \d+/.exec(result)?.[1];
        if (path !== undefined) next = { name: "Read", input: { path } };
      }
      return (async function* () {
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        if (next !== undefined) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: `tu_${call}`, name: next.name, input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(next.input) },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 1, output: 1 } };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
        }
        yield { kind: "message_stop" };
      })();
    },
  };
  return { adapter, shown };
}

describe("a one-line result past the preview is reachable with Read alone", () => {
  test("an 18 KB, 300-item JSON result: the model reaches item 299", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-result-parts-")));
    roots.push(ws);
    const items = Array.from({ length: 300 }, (_, id) => ({ id, name: `item-${id}`, ok: true }));
    const json = JSON.stringify(items);
    const itemsTool = buildTool({
      name: "Items",
      description: "returns every item as one JSON line",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => json,
    });
    const { adapter, shown } = pagingModel();
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "page through the result",
        runContext: createRunContext(),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "bypass",
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
        settingsDir: null,
        sessionRootDir: join(ws, "sessions"),
        tools: [itemsTool, read],
        _adapter: adapter,
      });
    } finally {
      process.chdir(cwd);
    }
    // The first view is the capped preview; every later one is a part, whole.
    expect(shown.length).toBeGreaterThanOrEqual(2);
    expect(shown[0]).toContain("[truncated, full output at ");
    expect(shown[0]).not.toContain('"id":299');
    for (const part of shown.slice(1)) expect(part).not.toContain("[truncated, full output at ");
    expect(shown[shown.length - 1]).toContain('"id":299,"name":"item-299"');
    expect(shown[shown.length - 1]).toContain("the end of the output");
    // Nothing is lost between the views: stripped of markers they are the result.
    const bodies = shown.map((s, i) =>
      i === 0 ? s.slice(0, s.indexOf("\n[part 1 of ")) : s.slice(0, s.lastIndexOf("\n[part ")),
    );
    expect(bodies.join("")).toBe(json);
  }, 20_000);
});
