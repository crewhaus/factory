#!/usr/bin/env bun
/**
 * Test fixture: stdout that mixes valid TraceEvent JSON, prose containing
 * braces, a run-id-less crew event, and a line torn across two writes —
 * exactly the stream the pump's splitter has to survive.
 */
const runId = "run_0123456789abcdef";
process.stdout.write("banner: starting up { not an event }\n");
process.stdout.write(
  `${JSON.stringify({ kind: "run_start", runId, timestamp: "2026-08-04T00:00:00.000Z" })}\n`,
);
process.stdout.write("assistant: here is a brace { and a close } inline\n");
process.stdout.write(`${JSON.stringify({ kind: "role_start", role: "planner" })}\n`);
// Torn: the first half is flushed, the rest arrives after a tick.
process.stdout.write('{"kind":"turn_end","runId":"');
await new Promise((r) => setTimeout(r, 25));
process.stdout.write(`${runId}","turn":1}\n`);
process.stdout.write("done\n");
