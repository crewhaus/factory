import {
  type OperativeArg,
  type OperativeArgKind,
  type RegisteredTool,
  ToolCatalogError,
  type ToolDefinition,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from "@crewhaus/tool-catalog";
import type { ZodType } from "zod";

/**
 * FR-002 — Pillar 3 sink-side: the built-in tool *names* that are
 * outward-reaching by definition (they cross a network or process boundary).
 * Source of truth for the scope-inference default below AND for the
 * `crewhaus compile --strict` / `crewhaus doctor --philosophy-alignment`
 * audit (which imports this set so the two never drift). These mirror the
 * external-sink table in AGENTS.md (Pillar 3) and each tool's explicit
 * `scope: "external"` annotation — keep them in sync.
 *
 * MCP tools are registered with a dynamic namespaced name
 * (`mcp__<server>__<tool>`, see tool-mcp `namespacedToolName`) so they can't
 * be enumerated in a literal set; `isOutwardName` covers them by prefix.
 */
export const OUTWARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Fetch",
  "WebFetch",
  "WebSearch",
  "SendMessage",
  "EvmSendTransaction",
  "ImageGenerate",
]);

/**
 * FR-002 — true for a tool whose effect is definitionally outward-reaching,
 * keyed on its name. Used to (a) invert the safe default in `buildTool` for
 * these names and (b) drive the compile-time scope audit. The `mcp__` prefix
 * rule catches every dynamically-named MCP tool.
 */
export function isOutwardName(name: string): boolean {
  return OUTWARD_TOOL_NAMES.has(name) || name.startsWith("mcp__");
}

/**
 * FR-002 — a single per-tool scope finding produced by `auditToolScopes`.
 * `toolName` is the offending tool's `name`; `reason` is a human-readable
 * explanation suitable for a `[strict]` diagnostic or a `doctor` line.
 */
export type ScopeFinding = { toolName: string; reason: string };

/**
 * FR-002 — Pillar 3 sink-side build-time gate, as a PURE, side-effect-free
 * function over already-resolved `RegisteredTool`s. This is the single shared
 * audit the contributor docs reference (`crewhaus compile --strict` and
 * `crewhaus doctor --philosophy-alignment`); keeping it here in tool-builder —
 * next to `isOutwardName` and `buildTool`, the two facts it keys on — means
 * every consumer audits identically rather than re-deriving the rule.
 *
 * A finding fires when a tool is I/O-capable yet its resolved `scope` is not
 * `"external"`. A tool counts as I/O-capable when EITHER:
 *
 *   (a) it declares `ioCapability` ("network" | "process") on its definition —
 *       the capability-driven path that catches an *arbitrary-named* custom
 *       `buildTool` tool that opens a socket or spawns a process; or
 *   (b) its name is definitionally outward-reaching (per `isOutwardName`:
 *       Fetch/WebFetch/WebSearch/SendMessage/EvmSendTransaction/ImageGenerate
 *       or any `mcp__*`) — the name backstop for a future built-in that forgets
 *       BOTH annotations.
 *
 * The irreducible residual a static check cannot reach is a tool that declares
 * NEITHER its capability NOR an outward name; that is the documented limit of
 * an annotation-based gate short of full dataflow analysis.
 */
export function auditToolScopes(tools: ReadonlyArray<RegisteredTool>): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  for (const tool of tools) {
    if (tool.scope === "external") continue;
    if (tool.ioCapability !== undefined) {
      findings.push({
        toolName: tool.name,
        reason: `declares ioCapability "${tool.ioCapability}" (crosses a ${tool.ioCapability} boundary) but scope is "${tool.scope}" (expected "external")`,
      });
    } else if (isOutwardName(tool.name)) {
      findings.push({
        toolName: tool.name,
        reason: `is outward-reaching by definition but scope is "${tool.scope}" (expected "external")`,
      });
    }
  }
  return findings;
}

const OPERATIVE_ARG_KINDS: ReadonlySet<OperativeArgKind> = new Set([
  "path",
  "url",
  "command",
  "text",
  "id",
]);

/** What a dotted field path resolves to inside a zod schema. */
type FieldShape = "string" | "number" | "opaque" | { readonly missing: string };

/** The zod type name, read structurally so two copies of zod agree. */
function zodTypeName(schema: unknown): string | undefined {
  const def = (schema as { _def?: { typeName?: unknown } } | undefined)?._def;
  return typeof def?.typeName === "string" ? def.typeName : undefined;
}

function zodDef(schema: unknown): Record<string, unknown> {
  return ((schema as { _def?: Record<string, unknown> })._def ?? {}) as Record<string, unknown>;
}

/**
 * Strip the wrappers that do not change which fields exist: optional,
 * nullable, default, refinements and transforms, brands, catch, readonly,
 * lazy, and the input side of a pipeline.
 */
function unwrapZod(schema: unknown, depth = 0): unknown {
  if (depth > 64) return schema;
  const def = zodDef(schema);
  switch (zodTypeName(schema)) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return unwrapZod(def["innerType"], depth + 1);
    case "ZodEffects":
      return unwrapZod(def["schema"], depth + 1);
    case "ZodBranded":
      return unwrapZod(def["type"], depth + 1);
    case "ZodPipeline":
      return unwrapZod(def["in"], depth + 1);
    case "ZodLazy":
      return unwrapZod((def["getter"] as () => unknown)(), depth + 1);
    default:
      return schema;
  }
}

function leafShape(schema: unknown): FieldShape {
  const s = unwrapZod(schema);
  switch (zodTypeName(s)) {
    case "ZodString":
    case "ZodEnum":
    case "ZodNativeEnum":
      return "string";
    case "ZodNumber":
    case "ZodBigInt":
      return "number";
    case "ZodLiteral": {
      const value = zodDef(s)["value"];
      return typeof value === "string"
        ? "string"
        : typeof value === "number"
          ? "number"
          : { missing: "is a literal that is not a string" };
    }
    case "ZodAny":
    case "ZodUnknown":
      return "opaque";
    case "ZodArray":
      return leafShape(zodDef(s)["type"]);
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = zodDef(s)["options"];
      const list = Array.isArray(options)
        ? options
        : [...((options as Map<unknown, unknown>)?.values?.() ?? [])];
      const shapes = list.map(leafShape);
      if (shapes.includes("string")) return "string";
      if (shapes.includes("opaque")) return "opaque";
      if (shapes.includes("number")) return "number";
      return { missing: "is not a string in any variant" };
    }
    default:
      return {
        missing: `is a ${(zodTypeName(s) ?? "non-zod value").replace(/^Zod/, "").toLowerCase()}, not a string`,
      };
  }
}

/** Walk `segments` into `schema`; arrays are transparent at every step. */
function resolveFieldShape(schema: unknown, segments: readonly string[], i: number): FieldShape {
  const s = unwrapZod(schema);
  const typeName = zodTypeName(s);
  if (typeName === "ZodArray") return resolveFieldShape(zodDef(s)["type"], segments, i);
  if (i === segments.length) return leafShape(s);
  const segment = segments[i] as string;
  switch (typeName) {
    case "ZodObject": {
      const shape = (zodDef(s)["shape"] as () => Record<string, unknown>)();
      if (!Object.hasOwn(shape, segment)) {
        const known = Object.keys(shape);
        return {
          missing: `has no field "${segments.slice(0, i + 1).join(".")}"${known.length > 0 ? ` (it has: ${known.join(", ")})` : ""}`,
        };
      }
      return resolveFieldShape(shape[segment], segments, i + 1);
    }
    case "ZodRecord":
      return resolveFieldShape(zodDef(s)["valueType"], segments, i + 1);
    case "ZodIntersection": {
      const left = resolveFieldShape(zodDef(s)["left"], segments, i);
      return typeof left === "string" ? left : resolveFieldShape(zodDef(s)["right"], segments, i);
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = zodDef(s)["options"];
      const list = Array.isArray(options)
        ? options
        : [...((options as Map<unknown, unknown>)?.values?.() ?? [])];
      let first: FieldShape | undefined;
      for (const option of list) {
        const shape = resolveFieldShape(option, segments, i);
        if (typeof shape === "string") return shape;
        first ??= shape;
      }
      return first ?? { missing: `has no field "${segments.slice(0, i + 1).join(".")}"` };
    }
    case "ZodAny":
    case "ZodUnknown":
      // An opaque schema (an MCP tool's `z.unknown()`) cannot be checked.
      return "opaque";
    default:
      return {
        missing: `cannot reach "${segments.slice(0, i + 1).join(".")}": "${segments.slice(0, i).join(".") || "the input"}" is not an object`,
      };
  }
}

/**
 * Check a tool's `operativeArgs` against its input schema. A declaration that
 * names a field the schema does not have would make every scoped rule for the
 * tool silently miss, so it is refused when the tool is built, not discovered
 * at the first call.
 */
function checkOperativeArgs(
  name: string,
  inputSchema: unknown,
  operativeArgs: ReadonlyArray<OperativeArg>,
): ReadonlyArray<OperativeArg> {
  const fail = (what: string): never => {
    throw new ToolCatalogError(`tool "${name}": operativeArgs ${what}`);
  };
  if (!Array.isArray(operativeArgs)) fail("must be an array of { field, kind }");
  const seen = new Set<string>();
  const out: OperativeArg[] = [];
  for (const [i, arg] of operativeArgs.entries()) {
    const at = `[${i}]`;
    if (arg === null || typeof arg !== "object")
      fail(`${at} must be an object like { field: "path", kind: "path" }`);
    const { field, kind } = arg;
    if (typeof field !== "string" || field === "")
      fail(`${at}.field must name an input field, e.g. "path"`);
    const segments = field.split(".");
    if (segments.some((segment) => segment === "")) {
      fail(`${at}.field "${field}" has an empty segment; write nested fields as "a.b"`);
    }
    if (!OPERATIVE_ARG_KINDS.has(kind)) {
      fail(`${at}.kind "${String(kind)}" is not one of ${[...OPERATIVE_ARG_KINDS].join(", ")}`);
    }
    if (arg.default !== undefined && typeof arg.default !== "string") {
      fail(`${at}.default must be a string (the value the tool uses when "${field}" is omitted)`);
    }
    if (seen.has(field)) fail(`names "${field}" twice; list each field once`);
    seen.add(field);
    const shape = resolveFieldShape(inputSchema, segments, 0);
    if (typeof shape === "object") {
      fail(`${at}: the input schema ${shape.missing}. Name a field the tool actually reads.`);
    }
    if (shape === "number" && kind !== "id") {
      fail(`${at}: "${field}" is a number; only kind "id" can hold a number`);
    }
    out.push(
      Object.freeze({
        field,
        kind,
        ...(arg.default !== undefined ? { default: arg.default } : {}),
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Converts a ToolDefinition into a RegisteredTool, filling in every flag the
 * definition leaves out.
 *
 * The defaults are NOT all fail-closed, and auto mode is where that shows:
 *
 * - `readOnly: false` is the cautious value — plan mode denies the tool.
 * - `destructive: false` is the PERMISSIVE value. In auto mode a tool that is
 *   neither read-only nor destructive is allowed with no prompt, so a tool
 *   that deletes, overwrites or spends must say `destructive: true` to be
 *   asked about.
 * - `requiresSandbox: false` and `requireJustification: false` are
 *   permissive too: the sandbox floor and the intent gate apply only to a
 *   tool that opts in.
 * - `scope` defaults to `"internal"`, except for a definitionally outward name
 *   (see {@link isOutwardName}), which defaults to `"external"`.
 * - `classifyOutput: true` — the post-tool injection classifier runs unless
 *   the tool opts out.
 *
 * `operativeArgs`, when given, is checked against `inputSchema` here: a
 * field the schema does not have throws, so a typo cannot quietly turn every
 * scoped permission rule for the tool into a miss.
 */
export function buildTool<TInput>(def: ToolDefinition<TInput>): RegisteredTool {
  const operativeArgs =
    def.operativeArgs !== undefined
      ? checkOperativeArgs(def.name, def.inputSchema, def.operativeArgs)
      : undefined;
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as ZodType<unknown>,
    execute: def.execute as (
      input: unknown,
      ctx?: ToolExecuteContext,
    ) => Promise<ToolExecuteResult>,
    concurrencySafe: def.concurrencySafe ?? false,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
    // Section 18: fail-closed for the sandbox flag and default-on for
    // classification. Tools that legitimately bypass classification must
    // opt out explicitly.
    requiresSandbox: def.requiresSandbox ?? false,
    classifyOutput: def.classifyOutput ?? true,
    // Pillar 3 sink-side fabric: fail-closed at "internal" so tools that
    // actually cross a network/process boundary must opt in to "external"
    // explicitly. egress-classifier reads this flag to decide whether to
    // route the call's payload through its substring scan.
    //
    // FR-002 defense-in-depth: for tools whose NAME is definitionally
    // outward-reaching (Fetch/WebFetch/WebSearch/SendMessage/
    // EvmSendTransaction/ImageGenerate + any `mcp__*`), the *default* is
    // inverted to "external" so a future built-in that forgets the explicit
    // annotation still lowers external. An explicit `def.scope` always wins
    // (override still works), so the six built-ins that already set
    // `scope: "external"` are unchanged — no runtime behavior shifts. Every
    // other (pure-compute) tool still fails closed to "internal".
    scope: def.scope ?? (isOutwardName(def.name) ? "external" : "internal"),
    // Pillar 3 intent gate: fail-closed at false. Destructive or external
    // tools should opt in explicitly (see tool-fetch, tool-evm-tx,
    // tool-message-channel, federation-router).
    requireJustification: def.requireJustification ?? false,
    ...(def.jsonSchema !== undefined ? { jsonSchema: def.jsonSchema } : {}),
    // FR-002 — pass through the io-capability fact verbatim (optional, like
    // jsonSchema). The audit reads it to require scope:"external" on any tool
    // that declares it crosses a boundary, not just the hardcoded outward
    // names. Omitted on the definition ⇒ omitted here.
    ...(def.ioCapability !== undefined ? { ioCapability: def.ioCapability } : {}),
    // 0.6.0 §5.1 — pass the model-feature requirement through verbatim, like
    // ioCapability. Omitted on the definition ⇒ omitted here, so the runtime
    // advertises the tool to every candidate (the prior behavior).
    ...(def.requiresModelFeatures !== undefined
      ? { requiresModelFeatures: def.requiresModelFeatures }
      : {}),
    // Per-call concurrency classifier (Task): passed through verbatim, like
    // jsonSchema/ioCapability. Omitted on the definition ⇒ omitted here, so
    // the orchestrator falls back to the static concurrency flags.
    ...(def.concurrencyClassifier !== undefined
      ? { concurrencyClassifier: def.concurrencyClassifier }
      : {}),
    // 0.7.1 — the field(s) a permission rule's argument glob constrains,
    // checked against the schema above. Omitted ⇒ omitted, and rules fall
    // back to the tool's string values.
    ...(operativeArgs !== undefined ? { operativeArgs } : {}),
  };
}
