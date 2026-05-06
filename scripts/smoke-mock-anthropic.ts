#!/usr/bin/env bun
/**
 * Smoke-test mock for the Anthropic Messages API.
 *
 * Used by Section 7 smoke test #1 (recovery): confirms that the runtime's
 * recovery-engine drives a retry-with-backoff against an upstream that fails
 * the first 2 requests, then succeeds on the 3rd.
 *
 * Usage:
 *   bun scripts/smoke-mock-anthropic.ts &
 *   ANTHROPIC_BASE_URL=http://localhost:7777 bun apps/cli/src/index.ts run examples/cli-smoke.yaml
 *
 * The mock returns a valid Anthropic-shaped streaming SSE response on success
 * (so the SDK's streaming parser is exercised end-to-end), and an HTTP 503
 * `overloaded_error` for the first 2 calls.
 */

const PORT = Number(process.env["MOCK_PORT"] ?? 7777);
const FAIL_COUNT = Number(process.env["MOCK_FAIL_COUNT"] ?? 2);

let requestCount = 0;

const SUCCESS_SSE = [
  "event: message_start",
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_mock_001",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-haiku-4-5-20251001",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}`,
  "",
  "event: content_block_start",
  `data: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })}`,
  "",
  "event: content_block_delta",
  `data: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hi from mock!" },
  })}`,
  "",
  "event: content_block_stop",
  `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
  "",
  "event: message_delta",
  `data: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 4 },
  })}`,
  "",
  "event: message_stop",
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  "",
  "",
].join("\n");

Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    if (!req.url.includes("/v1/messages")) {
      return new Response("not found", { status: 404 });
    }
    requestCount += 1;
    process.stderr.write(`[mock] request #${requestCount}\n`);
    if (requestCount <= FAIL_COUNT) {
      const body = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "smoke-test forced 503" },
      });
      return new Response(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(SUCCESS_SSE, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});

process.stdout.write(
  `[mock] listening on http://localhost:${PORT} — failing first ${FAIL_COUNT} request(s)\n`,
);
