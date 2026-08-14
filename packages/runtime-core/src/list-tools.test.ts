/**
 * #405 — `ListTools` + the resumed-session toolset marker.
 *
 * The incident these exist for: a session enumerated its toolset on a build
 * where tools were absent, the daemon was rebuilt with them added, and on
 * resume the transcript's stale enumeration beat the live schema — the agent
 * denied the new tools forever, and refusing to "fabricate" calls to tools it
 * believed absent is behaviour we WANT, so arguing could not fix it. Runtime
 * truth in a tool_result (ListTools) and a runtime-injected marker at resume
 * are the two mechanisms that break the deadlock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { BUILTIN_BOOKKEEPING_RULES } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { runChatLoop } from "./index";
import { LIST_TOOLS_NAME, buildListToolsTool, renderToolList } from "./list-tools";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "list-tools-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ADAPTER_FEATURES = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
} as const;

type ScriptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

const text = (t: string): ScriptBlock => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown): ScriptBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** Scripted streaming adapter (the approvals-test harness), recording every
 *  request's messages + tools so assertions can inspect what the MODEL saw. */
function scriptedAdapter(scripts: ReadonlyArray<ReadonlyArray<ScriptBlock>>): {
  adapter: ProviderAdapter;
  requests: Array<{ messages: unknown[]; tools: Array<{ name: string }> | undefined }>;
} {
  let i = 0;
  const requests: Array<{ messages: unknown[]; tools: Array<{ name: string }> | undefined }> = [];
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: ADAPTER_FEATURES,
    estimateTokens: () => 0,
    stream: (req: ProviderRequest) => {
      requests.push({
        messages: [...(req.messages as unknown[])],
        tools:
          req.tools !== undefined
            ? (req.tools as Array<{ name: string }>).map((t) => ({ name: t.name }))
            : undefined,
      });
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      i++;
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
            yield { kind: "content_block_stop", index: idx } as const;
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
            yield { kind: "content_block_stop", index: idx } as const;
          }
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
  return { adapter, requests };
}

/** A one-call script: call `name`, then answer. */
const callThen = (name: string) => scriptedAdapter([[use("tu_1", name, {})], [text("done")]]);
/** A plain-answer script. */
const answer = () => scriptedAdapter([[text("ok")]]);

const aTool = (name: string) =>
  buildTool({
    name,
    description: `the ${name} tool. It does ${name} things.`,
    inputSchema: z.object({}).strict(),
    execute: async () => "ok",
  });

function sessionEvents(sessionId: string): Array<{ kind: string; payload: unknown }> {
  const dir = join(root, "sessions");
  const file = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.includes(sessionId) && f.endsWith(".jsonl"))
    .map((f) => join(dir, f))[0];
  if (file === undefined) throw new Error(`no event log for ${sessionId}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { kind: string; payload: unknown });
}

async function turn(opts: {
  tools: ReturnType<typeof aTool>[];
  adapter: ProviderAdapter;
  sessionId?: string;
  toolsetScope?: string;
}): Promise<{ sessionId: string; result: string }> {
  const runContext = createRunContext(
    opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {},
  );
  const result = await runChatLoop({
    model: "test-model",
    instructions: "list-tools test",
    runContext,
    sessionRootDir: join(root, "sessions"),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: "default",
    tools: opts.tools,
    _adapter: opts.adapter,
    ...(opts.toolsetScope !== undefined ? { toolsetScope: opts.toolsetScope } : {}),
    ...(opts.sessionId !== undefined ? { resume: { sessionId: opts.sessionId } } : {}),
  } as Parameters<typeof runChatLoop>[0]);
  return { sessionId: runContext.sessionId, result };
}

describe("the ListTools tool", () => {
  test("reports the live advertised toolset — runtime truth, not transcript prior", () => {
    const out = renderToolList([
      {
        name: "beta",
        description: "b. second sentence.",
        readOnly: true,
        destructive: false,
        gated: false,
      },
      { name: "alpha", description: "a.", readOnly: false, destructive: true, gated: true },
    ]);
    expect(out).toContain("advertised on THIS request");
    expect(out).toContain("the conversation is stale");
    // Sorted, flagged, first-sentence only.
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("beta"));
    expect(out).toContain("- alpha [destructive, requires justification] — a.");
    expect(out).toContain("- beta [read-only] — b.");
    expect(out).not.toContain("second sentence");
  });

  test("is advertised on every tool-carrying loop and is CALLABLE headless without parking", async () => {
    // permissionMode "default" + no rules would fall back to `ask` — the
    // builtin allow is what keeps an introspection tool from parking in the
    // very deadlock it exists to break.
    const { sessionId } = await turn({
      tools: [aTool("notify")],
      adapter: callThen(LIST_TOOLS_NAME).adapter,
    });
    const events = sessionEvents(sessionId);
    const result = events.find((e) => e.kind === "tool_result");
    const content = (result?.payload as { content?: unknown })?.content;
    expect(String(content)).toContain("advertised on THIS request");
    expect(String(content)).toContain("- ListTools");
    expect(String(content)).toContain("- notify");
    expect(events.some((e) => e.kind === "run_failed")).toBe(false);
  });

  test("has a builtin allow rule, like the rest of the bookkeeping family", () => {
    expect(
      BUILTIN_BOOKKEEPING_RULES.some(
        (r) => r.pattern === LIST_TOOLS_NAME && r.type === "alwaysAllow",
      ),
    ).toBe(true);
  });

  test("a ZERO-tool loop stays zero-tool — chat-only specs must not become tool-requiring", async () => {
    const { adapter, requests } = answer();
    await turn({ tools: [], adapter });
    expect(requests[0]?.tools).toBeUndefined();
  });

  test("a caller's own ListTools wins the name — first-party is never shadowed", async () => {
    const mine = buildTool({
      name: LIST_TOOLS_NAME,
      description: "the caller's own",
      inputSchema: z.object({}).strict(),
      execute: async () => "caller wins",
    });
    const { adapter, requests } = answer();
    await turn({ tools: [mine], adapter });
    const names = (requests[0]?.tools ?? []).map((t) => t.name);
    expect(names.filter((n) => n === LIST_TOOLS_NAME)).toHaveLength(1);
  });

  test("the late-bound thunk sees the final list, including ListTools itself", async () => {
    let seen: string[] = [];
    const tool = buildListToolsTool(() => {
      seen = ["from-thunk"];
      return [];
    });
    await tool.execute({}, undefined);
    expect(seen).toEqual(["from-thunk"]);
  });
});

describe("the resumed-session toolset marker", () => {
  test("a toolset record is written once per session, not once per turn", async () => {
    const { adapter } = answer();
    const first = await turn({ tools: [aTool("alpha")], adapter });
    await turn({
      tools: [aTool("alpha")],
      adapter: answer().adapter,
      sessionId: first.sessionId,
    });
    const records = sessionEvents(first.sessionId).filter((e) => e.kind === "toolset");
    expect(records).toHaveLength(1);
    expect((records[0]?.payload as { toolNames: string[] }).toolNames).toEqual([
      "ListTools",
      "alpha",
    ]);
  });

  test("a resume with a CHANGED toolset injects the marker the model sees", async () => {
    // THE INCIDENT, replayed: park on a build without the tools, resume on a
    // build with them.
    const first = await turn({ tools: [aTool("alpha")], adapter: answer().adapter });

    const rec = answer();
    await turn({
      tools: [aTool("alpha"), aTool("agent_list"), aTool("message_send")],
      adapter: rec.adapter,
      sessionId: first.sessionId,
    });

    // The model's request contains the marker in the replayed history.
    const texts = JSON.stringify(rec.requests[0]?.messages ?? []);
    expect(texts).toContain("toolset changed while this session was idle");
    expect(texts).toContain("+agent_list");
    expect(texts).toContain("+message_send");
    expect(texts).toContain("Call ListTools to verify");

    // …and it is durably logged as a SYNTHETIC user message (turn-deriving
    // readers skip it), with a fresh toolset record beside it.
    const events = sessionEvents(first.sessionId);
    const marker = events.find(
      (e) => e.kind === "user_message" && (e.payload as { synthetic?: boolean }).synthetic === true,
    );
    expect(marker).toBeDefined();
    expect((marker?.payload as { toolset?: { added: string[] } }).toolset?.added).toEqual([
      "agent_list",
      "message_send",
    ]);
    expect(events.filter((e) => e.kind === "toolset")).toHaveLength(2);
  });

  test("removed tools are named too", async () => {
    const first = await turn({
      tools: [aTool("alpha"), aTool("beta")],
      adapter: answer().adapter,
    });
    const rec = answer();
    await turn({ tools: [aTool("alpha")], adapter: rec.adapter, sessionId: first.sessionId });
    const texts = JSON.stringify(rec.requests[0]?.messages ?? []);
    expect(texts).toContain("−beta");
  });

  test("an UNCHANGED toolset injects nothing — no marker noise on ordinary resumes", async () => {
    const first = await turn({ tools: [aTool("alpha")], adapter: answer().adapter });
    const rec = answer();
    await turn({ tools: [aTool("alpha")], adapter: rec.adapter, sessionId: first.sessionId });
    expect(JSON.stringify(rec.requests[0]?.messages ?? [])).not.toContain("toolset changed");
  });

  test("a session predating the record gets no marker on its first resume, and is covered after", async () => {
    // Simulate a pre-#405 session: strip the toolset record the first run
    // wrote, as if it had never existed.
    const first = await turn({ tools: [aTool("alpha")], adapter: answer().adapter });
    const dir = join(root, "sessions");
    const file = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.includes(first.sessionId) && f.endsWith(".jsonl"))
      .map((f) => join(dir, f))[0] as string;
    const kept = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes('"toolset"'))
      .join("\n");
    await Bun.write(file, `${kept}\n`);

    const rec = answer();
    await turn({
      tools: [aTool("alpha"), aTool("beta")],
      adapter: rec.adapter,
      sessionId: first.sessionId,
    });
    // Nothing to compare against ⇒ no marker; but the record now exists.
    expect(JSON.stringify(rec.requests[0]?.messages ?? [])).not.toContain("toolset changed");
    expect(sessionEvents(first.sessionId).some((e) => e.kind === "toolset")).toBe(true);
  });

  // A CREW is the shape that forces per-context scoping: every role
  // activation resumes the SAME session log and carries its own tools, so an
  // unscoped comparison would announce a "change" on every single handoff.
  test("crew roles sharing one session do not read each other's toolsets", async () => {
    const first = await turn({
      tools: [aTool("writer_tool")],
      adapter: answer().adapter,
      toolsetScope: "writer",
    });
    // Role 2 activates on the same session with entirely different tools.
    const critic = answer();
    await turn({
      tools: [aTool("critic_tool")],
      adapter: critic.adapter,
      sessionId: first.sessionId,
      toolsetScope: "critic",
    });
    expect(JSON.stringify(critic.requests[0]?.messages ?? [])).not.toContain("toolset changed");
    // Handing back to role 1 — still unchanged FOR THAT ROLE.
    const back = answer();
    await turn({
      tools: [aTool("writer_tool")],
      adapter: back.adapter,
      sessionId: first.sessionId,
      toolsetScope: "writer",
    });
    expect(JSON.stringify(back.requests[0]?.messages ?? [])).not.toContain("toolset changed");
    // Each role owns exactly one record, tagged with its scope.
    const records = sessionEvents(first.sessionId).filter((e) => e.kind === "toolset");
    expect(records.map((r) => (r.payload as { scope?: string }).scope).sort()).toEqual([
      "critic",
      "writer",
    ]);
  });

  test("a scoped role still hears about its OWN toolset changing", async () => {
    const first = await turn({
      tools: [aTool("writer_tool")],
      adapter: answer().adapter,
      toolsetScope: "writer",
    });
    const rec = answer();
    await turn({
      tools: [aTool("writer_tool"), aTool("wiki_write")],
      adapter: rec.adapter,
      sessionId: first.sessionId,
      toolsetScope: "writer",
    });
    const texts = JSON.stringify(rec.requests[0]?.messages ?? []);
    expect(texts).toContain("toolset changed while this session was idle");
    expect(texts).toContain("+wiki_write");
  });

  test("a toolset recorded inside an A2A bracket is not mistaken for this context's", async () => {
    const first = await turn({ tools: [aTool("alpha")], adapter: answer().adapter });
    // Splice in a nested peer's record, exactly as a crew A2A turn writes it:
    // bracketed by a2a_turn_start / a2a_turn_end.
    const dir = join(root, "sessions");
    const file = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.includes(first.sessionId) && f.endsWith(".jsonl"))
      .map((f) => join(dir, f))[0] as string;
    const nested = [
      JSON.stringify({ kind: "a2a_turn_start", payload: { from: "a", to: "b" } }),
      JSON.stringify({ kind: "toolset", payload: { toolNames: ["ListTools", "peer_only"] } }),
      JSON.stringify({ kind: "a2a_turn_end", payload: { from: "a", to: "b" } }),
    ].join("\n");
    await Bun.write(file, `${readFileSync(file, "utf8").trimEnd()}\n${nested}\n`);

    const rec = answer();
    await turn({ tools: [aTool("alpha")], adapter: rec.adapter, sessionId: first.sessionId });
    // Compared against OUR last record (alpha), not the peer's.
    expect(JSON.stringify(rec.requests[0]?.messages ?? [])).not.toContain("toolset changed");
  });
});
