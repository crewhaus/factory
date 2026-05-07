/**
 * W3C Trace Context propagation helpers.
 * Spec: https://www.w3.org/TR/trace-context/
 *
 * Format: `<version>-<trace-id>-<parent-id>-<flags>`
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 *   version   2 hex digits (currently always "00")
 *   trace-id  32 hex digits, all-zero is invalid
 *   parent-id 16 hex digits, all-zero is invalid (the most-recent span id
 *             from the upstream caller — becomes our `parentSpanId`)
 *   flags     2 hex digits; bit 0 is the "sampled" flag
 */
import { randomBytes } from "node:crypto";

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/;
const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

export type ParsedTraceparent = {
  traceId: string;
  parentSpanId: string;
  flags: number;
};

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function isValidTraceId(traceId: string): boolean {
  return TRACE_ID_REGEX.test(traceId) && traceId !== ZERO_TRACE_ID;
}

export function isValidSpanId(spanId: string): boolean {
  return SPAN_ID_REGEX.test(spanId) && spanId !== ZERO_SPAN_ID;
}

export function parseTraceparent(value: string | undefined): ParsedTraceparent | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT_REGEX.exec(value.trim());
  if (!match) return undefined;
  const traceId = match[1];
  const parentSpanId = match[2];
  const flagsHex = match[3];
  if (!traceId || !parentSpanId || !flagsHex) return undefined;
  if (!isValidTraceId(traceId) || !isValidSpanId(parentSpanId)) return undefined;
  return {
    traceId,
    parentSpanId,
    flags: Number.parseInt(flagsHex, 16),
  };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  const flags = sampled ? "01" : "00";
  return `00-${traceId}-${spanId}-${flags}`;
}

/**
 * Read `process.env.TRACEPARENT`. Returns `undefined` if absent or malformed.
 */
export function readEnvTraceparent(
  env: NodeJS.ProcessEnv = process.env,
): ParsedTraceparent | undefined {
  return parseTraceparent(env["TRACEPARENT"]);
}
