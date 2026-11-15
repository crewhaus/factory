/**
 * Test-only: drive an emitted worker.js in a `bun` subprocess with every
 * network call stubbed.
 *
 * The emitted worker imports `@crewhaus/*` packages, which resolve from this
 * package's node_modules, so the worker, its job and the driver are written
 * to a scratch directory under `src/` (a hidden `.cfw-run-*`, which the
 * source scans skip) and run with a real `bun`. The driver:
 *   - answers `api.anthropic.com` with the job's scripted SSE turns, one per
 *     model call, and keeps each request body;
 *   - records every other request (method and URL) and answers it with a
 *     stub page, so nothing leaves the machine;
 *   - replaces `@crewhaus/tool-web`'s DNS lookup with a counting fake that
 *     answers a fixed public address, so no DNS query leaves either;
 *   - when the job sets `clockStep`, replaces `Date.now` (before the worker
 *     loads) with a clock that only the model stub moves, by `clockStep` per
 *     model call;
 *   - sends one request built from the job (method, path, headers, raw body)
 *     with the job's `env`, and reports the response.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DRIVER_SRC = String.raw`
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const job = JSON.parse(await Bun.file(here + "job.json").text());
const result = { calls: 0, outbound: [], dnsLookups: 0, modelBodies: [] };
try {
  let clock = 1700000000000;
  if (job.clockStep) Date.now = () => clock;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
    if (url.startsWith("https://api.anthropic.com/")) {
      const turn = job.turns[result.calls] ?? [];
      result.calls += 1;
      result.modelBodies.push(init && typeof init.body === "string" ? init.body : "");
      if (job.clockStep) clock += job.clockStep;
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(c) {
          for (const o of turn) c.enqueue(enc.encode("event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n"));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    result.outbound.push(method + " " + url);
    return new Response("stub page body", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const web = await import("@crewhaus/tool-web");
  web._setDnsLookup(async () => {
    result.dnsLookups += 1;
    return { address: "93.184.215.14", family: 4 };
  });
  const worker = (await import(here + "worker.mjs")).default;
  const method = job.method ?? "POST";
  const req = new Request("https://harness.example" + (job.path ?? "/chat"), {
    method,
    headers: job.headers ?? {},
    ...(method === "POST" ? { body: job.body ?? "" } : {}),
  });
  const res = await worker.fetch(req, job.env ?? {});
  result.status = res.status;
  result.headers = Object.fromEntries(res.headers.entries());
  result.raw = await res.text();
} catch (e) {
  result.error = e && e.message ? e.message : String(e);
}
process.stdout.write(JSON.stringify(result));
`;

export type DriveJob = {
  readonly method?: "GET" | "POST" | "OPTIONS";
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The raw request body, sent as given. */
  readonly body?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Scripted Anthropic SSE turns, one per model call. */
  readonly turns?: ReadonlyArray<ReadonlyArray<Frame>>;
  /** Milliseconds the fake clock moves on each model call; unset keeps the real clock. */
  readonly clockStep?: number;
};

export type DriveResult = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly raw: string;
  /** Model calls made. */
  readonly calls: number;
  /** Every request other than a model call, as `METHOD URL`. */
  readonly outbound: ReadonlyArray<string>;
  /** DNS lookups the tools asked for. */
  readonly dnsLookups: number;
  /** Each model request's JSON body, in order. */
  readonly modelBodies: ReadonlyArray<string>;
  readonly error?: string;
};

/** Run `worker` (an emitted worker.js) against one request; `dir` is the package's `src`. */
export async function drive(dir: string, worker: string, job: DriveJob): Promise<DriveResult> {
  const scratch = mkdtempSync(join(dir, ".cfw-run-"));
  writeFileSync(join(scratch, "worker.mjs"), worker);
  writeFileSync(join(scratch, "job.json"), JSON.stringify({ turns: [], ...job }));
  writeFileSync(join(scratch, "driver.mjs"), DRIVER_SRC);
  try {
    const proc = Bun.spawn([process.execPath, join(scratch, "driver.mjs")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (!out) throw new Error(`driver produced no output; stderr:\n${err}`);
    return JSON.parse(out) as DriveResult;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The body a client posts to `/chat`. */
export function chatBody(content = "hi"): string {
  return JSON.stringify({ messages: [{ role: "user", content }] });
}

export type Frame = Record<string, unknown>;

export function textTurn(text: string): Frame[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

export function toolTurn(id: string, name: string, input: Record<string, unknown>): Frame[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

export type SseEvent = { readonly name: string; readonly data: Record<string, unknown> };

export function parseSse(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let name = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) out.push({ name, data: JSON.parse(data) as Record<string, unknown> });
  }
  return out;
}

/** The tool_result blocks the worker fed back to the model, from the request after a tool turn. */
export function toolResults(modelBody: string | undefined): Array<Record<string, unknown>> {
  if (modelBody === undefined || modelBody === "") return [];
  const body = JSON.parse(modelBody) as { messages?: Array<{ role: string; content: unknown }> };
  const last = body.messages?.[body.messages.length - 1];
  return Array.isArray(last?.content)
    ? (last.content as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool_result")
    : [];
}

/** The text of a tool_result block's content. */
export function resultText(block: Record<string, unknown> | undefined): string {
  const content = block?.["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => String((c as Record<string, unknown>)["text"] ?? "")).join("");
  }
  return "";
}
