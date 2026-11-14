/**
 * The integrations area's zod schemas. Requests are strict; responses pass unknown
 * fields through. `integrations.type-checks.ts` holds each one to its type.
 */
import { z } from "zod";
import {
  PLUGIN_EVENT_FAMILIES,
  PLUGIN_GRANT_LIST_MAX,
  PLUGIN_NAME_RE,
  PLUGIN_READS,
  PLUGIN_REVIEW_STATES,
} from "../areas/integrations.js";
import { HARNESS_ID_RE } from "../index.js";

function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

/** A list of distinct values, at most `PLUGIN_GRANT_LIST_MAX` long. */
function distinct<T extends z.ZodTypeAny>(item: T) {
  return z
    .array(item)
    .max(PLUGIN_GRANT_LIST_MAX)
    .refine((list) => new Set(list).size === list.length, "lists a value twice");
}

const harnessId = z.string().regex(HARNESS_ID_RE);
/** A pane id: one safe path segment. */
const paneId = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
/** An origin: scheme, host and optional port, nothing more. */
const origin = z.string().regex(/^https?:\/\/[^/*?#\s]+$/);
const toolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

const grantFields = {
  harnesses: z.union([distinct(harnessId), z.literal("all")]),
  panes: distinct(paneId),
  events: distinct(oneOf(PLUGIN_EVENT_FAMILIES)),
  reads: distinct(oneOf(PLUGIN_READS)),
  net: distinct(origin),
  tools: distinct(toolName),
};

/** The fields as a response shows them: the same lists, read back. */
const grantSet = z
  .object({
    harnesses: z.union([z.array(z.string()), z.literal("all")]),
    panes: z.array(z.string()),
    events: z.array(z.string()),
    reads: z.array(z.string()),
    net: z.array(z.string()),
    tools: z.array(z.string()),
  })
  .passthrough();

export const pluginGrantRequest = z
  .object({ ...grantFields, expect: z.number().int().positive().optional() })
  .strict();

export const pluginReview = z
  .object({
    plugin: z.string().regex(PLUGIN_NAME_RE),
    version: z.string(),
    entrypointDigest: z.string().nullable(),
    signed: z.boolean(),
    crewhausRange: z.string().nullable(),
    state: oneOf(PLUGIN_REVIEW_STATES),
    legacy: z.boolean(),
    asks: grantSet,
    granted: grantSet.nullable(),
    served: grantSet,
    gen: z.number().int().positive().nullable(),
    envNames: z.array(z.string()),
    verb: z.string(),
  })
  .passthrough();

export const INTEGRATIONS_SCHEMAS = Object.freeze({
  pluginGrantRequest,
  pluginReview,
});
