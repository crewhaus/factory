/**
 * The work one headless park does for a path that climbs out of the
 * workspace, counted: run as its own process by `permission-subject.test.ts`.
 *
 * Every function on `node:path` is wrapped to count the characters handed to
 * it, and the wrapping has to come before anything under test is loaded. Bun
 * fixes a module's `import * as path from "node:path"` when that namespace is
 * first made, so a wrapper installed later — in a test process that has
 * already loaded the gate — counts nothing. Hence a process of its own, and
 * nothing here imported statically but `node:` modules that are not wrapped.
 *
 * Prints one JSON line per park: the number of names, the length of the
 * path, the characters counted, how the run ended and the place recorded.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

type PathFn = (this: unknown, ...args: unknown[]) => unknown;

const nodePath = require("node:path") as Record<string, unknown>;
const counter = { on: false, chars: 0 };
for (const [name, value] of Object.entries(nodePath)) {
  if (typeof value !== "function") continue;
  const real = value as PathFn;
  nodePath[name] = function (this: unknown, ...args: unknown[]) {
    if (counter.on) {
      for (const arg of args) if (typeof arg === "string") counter.chars += arg.length;
    }
    return real.apply(this, args);
  };
}
const join = nodePath["join"] as (...parts: string[]) => string;

const { z } = await import("zod");
const { buildTool } = await import("@crewhaus/tool-builder");
const { emptyRuleSet } = await import("@crewhaus/permission-engine");
const { createRunContext } = await import("@crewhaus/run-context");
const { createPendingApprovalStore } = await import("@crewhaus/session-store");
const { runChatLoop } = await import("../index");

const write = buildTool({
  name: "Write",
  description: "tool-fs Write's shape",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  destructive: true,
  operativeArgs: [{ field: "path", kind: "path" }],
  execute: async () => "ran",
});

/** One tool_use of `input`, then "done". */
function adapterFor(input: unknown) {
  let i = 0;
  return {
    providerId: "anthropic" as const,
    features: {
      caching: "explicit" as const,
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
            ? { type: "tool_use", id: "tu_1", name: "Write", input: {} }
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

const ws = realpathSync(mkdtempSync(join(tmpdir(), "outside-place-ws-")));
const state = mkdtempSync(join(tmpdir(), "outside-place-state-"));
const cwd = process.cwd();
process.chdir(ws);
try {
  // The first park reads what a process reads once (the root's other
  // spellings); it is not printed.
  for (const [i, d] of [1, 1, 1024, 2048, 4096].entries()) {
    const raw = `../${Array.from({ length: d }, () => "a").join("/")}`;
    const store = createPendingApprovalStore({ rootDir: join(state, `approvals-${i}`) });
    let outcome = "ran";
    counter.chars = 0;
    counter.on = true;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "outside place",
        runContext: createRunContext({ sessionId: "sess_0123456789abcdef" }),
        sessionRootDir: mkdtempSync(join(state, "sess-")),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "default",
        permissionRules: emptyRuleSet,
        tools: [write],
        approvals: { store },
        // biome-ignore lint/suspicious/noExplicitAny: the scripted adapter is the provider seam's shape, built without its types.
        _adapter: adapterFor({ path: raw, content: "x" }) as any,
      });
    } catch (err) {
      outcome = (err as { report?: { class?: string } }).report?.class ?? String(err);
    } finally {
      counter.on = false;
    }
    if (i === 0) continue;
    const parked = (await store.list())[0];
    console.log(JSON.stringify({ d, chars: raw.length, work: counter.chars, outcome, ws, parked }));
  }
} finally {
  process.chdir(cwd);
  rmSync(ws, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
