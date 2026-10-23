import {
  type OperativeArg,
  type OperativeArgKind,
  type OperativeOpening,
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
 *
 * Only the three facts it keys on are read, so a caller that has a tool's
 * flags as data (the builtin manifest, for a tool it cannot import) audits
 * it the same way.
 */
export function auditToolScopes(
  tools: ReadonlyArray<{
    readonly name: string;
    readonly scope: string;
    readonly ioCapability?: string;
  }>,
): ScopeFinding[] {
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
  "recipient",
  "text",
  "id",
]);

/**
 * The kinds whose value can be qualified by another field (`within`). For a
 * `command` the field is the directory it runs in (see OperativeArg).
 */
const QUALIFIABLE_KINDS: ReadonlySet<OperativeArgKind> = new Set([
  "path",
  "command",
  "recipient",
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
 * Why `name` cannot qualify another operative field, or `undefined` when it
 * can: it must be a top-level field holding one string or number, not a
 * list, since the qualified value is `<qualifier>/<value>`.
 */
function scalarFieldShape(inputSchema: unknown, name: string): string | undefined {
  const s = unwrapZod(inputSchema);
  if (zodTypeName(s) !== "ZodObject") return "is not an object";
  const shape = (zodDef(s)["shape"] as () => Record<string, unknown>)();
  if (!Object.hasOwn(shape, name)) return `has no top-level field "${name}"`;
  if (zodTypeName(unwrapZod(shape[name])) === "ZodArray") {
    return `field "${name}" is a list; a qualifier must hold one value`;
  }
  const leaf = leafShape(shape[name]);
  return leaf === "string" || leaf === "number"
    ? undefined
    : `field "${name}" is not a string or a number`;
}

/** The schema of top-level field `name` (callers have checked it exists). */
function fieldOf(inputSchema: unknown, name: string): unknown {
  const shape = (zodDef(unwrapZod(inputSchema))["shape"] as () => Record<string, unknown>)();
  return shape[name];
}

/**
 * Why `name` cannot switch a walk into hidden names, or `undefined` when it
 * can: it must be a top-level boolean field.
 */
function booleanFieldShape(inputSchema: unknown, name: string): string | undefined {
  const s = unwrapZod(inputSchema);
  if (zodTypeName(s) !== "ZodObject") return "is not an object";
  const shape = (zodDef(s)["shape"] as () => Record<string, unknown>)();
  if (!Object.hasOwn(shape, name)) return `has no top-level field "${name}"`;
  return zodTypeName(unwrapZod(shape[name])) === "ZodBoolean"
    ? undefined
    : `field "${name}" is not a boolean`;
}

/**
 * Why `name` cannot hold a command's environment, or `undefined` when it can:
 * it must be a top-level field holding a map of names to string values.
 */
function mapFieldShape(inputSchema: unknown, name: string): string | undefined {
  const s = unwrapZod(inputSchema);
  if (zodTypeName(s) !== "ZodObject") return "is not an object";
  const shape = (zodDef(s)["shape"] as () => Record<string, unknown>)();
  if (!Object.hasOwn(shape, name)) return `has no top-level field "${name}"`;
  const field = unwrapZod(shape[name]);
  if (zodTypeName(field) !== "ZodRecord") {
    return `field "${name}" is not a map of variable names to values`;
  }
  return leafShape(zodDef(field)["valueType"]) === "string"
    ? undefined
    : `field "${name}" does not map names to string values`;
}

/**
 * Check a `path` field's `opens` (the fixed places inside the directory it
 * names that the tool opens), and return it frozen. Each is a relative path
 * that stays below the directory — no `..` segment, not absolute — since a
 * deny reads it joined to whatever directory the call names.
 */
function checkOpenings(
  at: string,
  kind: OperativeArgKind,
  opens: OperativeArg["opens"],
  fail: (what: string) => never,
): OperativeArg["opens"] {
  if (opens === undefined) return undefined;
  if (kind !== "path") fail(`${at}.opens: only a "path" names a directory with files in it`);
  if (!Array.isArray(opens) || opens.length === 0) {
    fail(`${at}.opens must list one or more { path } inside the directory, or be left out`);
  }
  const out: OperativeOpening[] = [];
  for (const [j, opening] of opens.entries()) {
    const where = `${at}.opens[${j}]`;
    if (opening === null || typeof opening !== "object") {
      fail(`${where} must be an object like { path: ".crewhaus/settings.json" }`);
    }
    const { path, beneath } = opening;
    if (typeof path !== "string" || path === "") fail(`${where}.path must name a file or store`);
    if (
      /^([\\/]|[A-Za-z]:)/.test(path) ||
      path.split(/[\\/]/).some((s) => s === ".." || s === "")
    ) {
      fail(
        `${where}.path "${path}" must be relative to the directory and stay below it: no leading "/", no ".." or empty segment`,
      );
    }
    if (beneath !== undefined && beneath !== "all" && beneath !== "visible") {
      fail(`${where}.beneath is "all", "visible" or left out`);
    }
    out.push(Object.freeze({ path, ...(beneath !== undefined ? { beneath } : {}) }));
  }
  return Object.freeze(out);
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
    const { relocates } = arg;
    if (relocates !== undefined) {
      if (relocates !== true) fail(`${at}.relocates is either true or left out`);
      if (kind !== "path" && kind !== "url") {
        fail(`${at}.relocates: only a "path" or "url" field can relocate a tool`);
      }
      if (arg.default === undefined) {
        fail(
          `${at}.relocates needs a default: the place the tool uses when "${field}" is omitted, which a deny or ask rule must see`,
        );
      }
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
    const { within } = arg;
    if (within !== undefined) {
      if (!QUALIFIABLE_KINDS.has(kind)) {
        fail(
          `${at}.within: a "${kind}" value cannot be qualified; only ${[...QUALIFIABLE_KINDS].join(", ")} can`,
        );
      }
      if (typeof within !== "string" || !/^[A-Za-z_$][\w$]*$/.test(within)) {
        fail(`${at}.within must name one top-level input field, e.g. "owner"`);
      }
      if (within === field) fail(`${at}.within names "${field}" itself`);
      const qualifier = scalarFieldShape(inputSchema, within);
      if (qualifier !== undefined) fail(`${at}.within: the input schema ${qualifier}`);
    }
    const { withinDefault } = arg;
    if (withinDefault !== undefined) {
      if (kind !== "path" || within === undefined) {
        fail(
          `${at}.withinDefault: only a "path" declared \`within\` a directory field has a directory the tool uses when the call leaves that field out`,
        );
      }
      if (
        typeof withinDefault !== "string" ||
        withinDefault === "" ||
        withinDefault === "*" ||
        /^([\\/]|[A-Za-z]:)/.test(withinDefault) ||
        withinDefault.split(/[\\/]/).some((s) => s === "..")
      ) {
        fail(
          `${at}.withinDefault must be a directory relative to the workspace that stays in it: no leading "/", no ".." segment, not "*"`,
        );
      }
    }
    const { prefix } = arg;
    if (prefix !== undefined) {
      if (prefix !== true) fail(`${at}.prefix is either true or left out`);
      if (kind !== "id" && kind !== "recipient" && kind !== "text") {
        fail(
          `${at}.prefix: only an "id", "recipient" or "text" value can be a prefix; a "${kind}" value is read whole`,
        );
      }
      if (arg.default !== "*") {
        fail(
          `${at}.prefix needs default "*": a prefix left out filters nothing, so the call acts on every value`,
        );
      }
    }
    const { beneath, defaultAtRoot } = arg;
    if (beneath !== undefined) {
      if (beneath !== "all" && beneath !== "visible") {
        fail(`${at}.beneath is "all", "visible" or left out`);
      }
      if (kind !== "path") {
        fail(`${at}.beneath: only a "path" can name a directory with things beneath it`);
      }
      // A relocating field may walk too: a store the tool reads whole,
      // whatever record the call names beside it (DatasetMine's sessions).
    }
    const { hiddenWhen } = arg;
    if (hiddenWhen !== undefined) {
      if (beneath !== "visible") {
        fail(
          `${at}.hiddenWhen: only a walk that skips hidden names (beneath: "visible") can be switched into them`,
        );
      }
      if (typeof hiddenWhen !== "string" || !/^[A-Za-z_$][\w$]*$/.test(hiddenWhen)) {
        fail(`${at}.hiddenWhen must name one top-level input field, e.g. "includeHidden"`);
      }
      const switched = booleanFieldShape(inputSchema, hiddenWhen);
      if (switched !== undefined) fail(`${at}.hiddenWhen: the input schema ${switched}`);
    }
    const { beneathWhen } = arg;
    if (beneathWhen !== undefined) {
      if (beneath === undefined) {
        fail(
          `${at}.beneathWhen: only a path declared beneath (a directory the tool acts inside) can be switched into it`,
        );
      }
      if (relocates !== undefined) {
        fail(`${at}.beneathWhen: a relocating store is read whole or not at all`);
      }
      if (typeof beneathWhen !== "string" || !/^[A-Za-z_$][\w$]*$/.test(beneathWhen)) {
        fail(`${at}.beneathWhen must name one top-level input field, e.g. "clear"`);
      }
      if (beneathWhen === hiddenWhen) {
        fail(`${at}.beneathWhen names "${beneathWhen}", which is already used`);
      }
      const switched = booleanFieldShape(inputSchema, beneathWhen);
      if (switched !== undefined) fail(`${at}.beneathWhen: the input schema ${switched}`);
    }
    const opens = checkOpenings(at, kind, arg.opens, fail);
    if (opens !== undefined && arg.glob === true) {
      fail(`${at}.opens: a glob pattern is not a directory with fixed files in it`);
    }
    if (defaultAtRoot !== undefined) {
      if (defaultAtRoot !== true) fail(`${at}.defaultAtRoot is either true or left out`);
      if (kind !== "path" || within === undefined || arg.default === undefined) {
        fail(
          `${at}.defaultAtRoot: only a "path" declared \`within\` another field, with a default, has a default to read from the root`,
        );
      }
    }
    const { glob } = arg;
    if (glob !== undefined) {
      if (glob !== true) fail(`${at}.glob is either true or left out`);
      if (kind !== "path" || within !== undefined || relocates === true || beneath !== undefined) {
        fail(
          `${at}.glob: only a plain "path" field can hold a pattern (no within, relocates or beneath)`,
        );
      }
    }
    const { secretRef } = arg;
    if (secretRef !== undefined) {
      if (secretRef !== true) fail(`${at}.secretRef is either true or left out`);
      if (kind !== "id" || within !== undefined || prefix !== undefined) {
        fail(
          `${at}.secretRef: only a plain "id" (no within or prefix) holds a secret reference such as env:NAME or file:<path>`,
        );
      }
    }
    const { service } = arg;
    if (service !== undefined) {
      // A URL can only be the API itself: it names its own field, and a call
      // that leaves it out goes where the tool's `serviceDefaults` say.
      const apiRoot = kind === "url";
      if (kind !== "id" && kind !== "recipient" && !apiRoot) {
        fail(
          `${at}.service: only an "id" or a "recipient" lives on a service a call can name, and a "url" is the API itself; a "${kind}" value is read as it is`,
        );
      }
      if (prefix !== undefined || secretRef !== undefined || relocates !== undefined) {
        fail(`${at}.service cannot be combined with prefix, secretRef or relocates`);
      }
      if (typeof service !== "string" || !/^[A-Za-z_$][\w$]*$/.test(service)) {
        fail(`${at}.service must name one top-level input field, e.g. "baseUrl"`);
      }
      if (apiRoot && (service !== field || arg.default !== undefined)) {
        fail(
          `${at}.service: a "url" with a service is the API itself, so it names its own field "${field}" and has no default (serviceDefaults say where a call that leaves it out goes)`,
        );
      }
      if (!apiRoot && (service === field || service === within)) {
        fail(`${at}.service names "${service}", which is already used`);
      }
      const holds = scalarFieldShape(inputSchema, service);
      if (holds !== undefined || leafShape(fieldOf(inputSchema, service)) !== "string") {
        fail(
          `${at}.service: the input schema ${holds ?? `field "${service}" is not a string`}; it must hold the URL of the API the call is sent to`,
        );
      }
    }
    const { overlay } = arg;
    if (overlay !== undefined) {
      if (kind !== "id" && kind !== "recipient") {
        fail(
          `${at}.overlay: only an "id" or a "recipient" has an owner's own copy; a "${kind}" value is read as it is`,
        );
      }
      if (
        prefix !== undefined ||
        secretRef !== undefined ||
        relocates !== undefined ||
        service !== undefined
      ) {
        fail(`${at}.overlay cannot be combined with prefix, secretRef, relocates or service`);
      }
      if (typeof overlay !== "string" || !/^[A-Za-z_$][\w$]*$/.test(overlay)) {
        fail(`${at}.overlay must name one top-level input field, e.g. "tenant"`);
      }
      if (overlay === field || overlay === within) {
        fail(`${at}.overlay names "${overlay}", which is already used`);
      }
      const holds = scalarFieldShape(inputSchema, overlay);
      if (holds !== undefined) fail(`${at}.overlay: the input schema ${holds}`);
    }
    const { ignoredWhen } = arg;
    if (ignoredWhen !== undefined) {
      if (typeof ignoredWhen !== "string" || !/^[A-Za-z_$][\w$]*$/.test(ignoredWhen)) {
        fail(`${at}.ignoredWhen must name one top-level input field, e.g. "webhookUrlEnv"`);
      }
      if (
        ignoredWhen === field ||
        ignoredWhen === within ||
        ignoredWhen === service ||
        ignoredWhen === overlay
      ) {
        fail(`${at}.ignoredWhen names "${ignoredWhen}", which is already used`);
      }
      // Checked against the other declarations below, once all are read.
    }
    const { source } = arg;
    if (source !== undefined && source !== true) fail(`${at}.source is either true or left out`);
    const { reads, readsWhen } = arg;
    if (reads !== undefined || readsWhen !== undefined) {
      if (reads !== undefined && reads !== true) fail(`${at}.reads is either true or left out`);
      if (kind !== "path" || relocates !== undefined || source !== undefined) {
        fail(
          `${at}.reads: only a plain "path" the tool reads from (not relocates or source) is read-only to the floor`,
        );
      }
      if (reads !== undefined && readsWhen !== undefined) {
        fail(
          `${at}.readsWhen: a field always read needs no switch; declare one of reads, readsWhen`,
        );
      }
      if (
        readsWhen !== undefined &&
        (typeof readsWhen !== "string" || !/^[A-Za-z_$][\w$]*$/.test(readsWhen))
      ) {
        fail(`${at}.readsWhen must name one top-level input field, e.g. "outputDir"`);
      }
      if (readsWhen === field) fail(`${at}.readsWhen names "${readsWhen}", which is already used`);
    }
    const { shell } = arg;
    if (shell !== undefined) {
      if (shell !== true) fail(`${at}.shell is either true or left out`);
      if (kind !== "command") {
        fail(`${at}.shell: only a "command" is a line a shell parses; a "${kind}" value is not`);
      }
    }
    const { env } = arg;
    if (env !== undefined) {
      if (kind !== "command") {
        fail(`${at}.env: only a "command" runs in an environment; a "${kind}" value has none`);
      }
      if (typeof env !== "string" || !/^[A-Za-z_$][\w$]*$/.test(env)) {
        fail(`${at}.env must name one top-level input field, e.g. "envSet"`);
      }
      if (env === field || env === within) fail(`${at}.env names "${env}", which is already used`);
      const environment = mapFieldShape(inputSchema, env);
      if (environment !== undefined) fail(`${at}.env: the input schema ${environment}`);
    }
    const { stdin } = arg;
    if (stdin !== undefined) {
      if (kind !== "command") {
        fail(`${at}.stdin: only a "command" reads its input; a "${kind}" value has none`);
      }
      if (typeof stdin !== "string" || !/^[A-Za-z_$][\w$]*$/.test(stdin)) {
        fail(`${at}.stdin must name one input field, e.g. "stdin"`);
      }
      if (stdin === field || stdin === within || stdin === env) {
        fail(`${at}.stdin names "${stdin}", which is already used`);
      }
      // Beside the command (a pipeline step's own `stdin`) or at the top.
      const beside = [...segments.slice(0, -1), stdin];
      const holds = [beside, [stdin]].some(
        (path) => resolveFieldShape(inputSchema, path, 0) === "string",
      );
      if (!holds) {
        fail(
          `${at}.stdin: the input schema has no string field "${stdin}" beside "${field}" or at the top level`,
        );
      }
    }
    out.push(
      Object.freeze({
        field,
        kind,
        ...(arg.default !== undefined ? { default: arg.default } : {}),
        ...(within !== undefined ? { within } : {}),
        ...(withinDefault !== undefined ? { withinDefault } : {}),
        ...(service !== undefined ? { service } : {}),
        ...(overlay !== undefined ? { overlay } : {}),
        ...(ignoredWhen !== undefined ? { ignoredWhen } : {}),
        ...(relocates === true ? { relocates } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(stdin !== undefined ? { stdin } : {}),
        ...(prefix === true ? { prefix } : {}),
        ...(beneath !== undefined ? { beneath } : {}),
        ...(hiddenWhen !== undefined ? { hiddenWhen } : {}),
        ...(beneathWhen !== undefined ? { beneathWhen } : {}),
        ...(opens !== undefined ? { opens } : {}),
        ...(defaultAtRoot === true ? { defaultAtRoot } : {}),
        ...(glob === true ? { glob } : {}),
        ...(shell === true ? { shell } : {}),
        ...(secretRef === true ? { secretRef } : {}),
        ...(source === true ? { source } : {}),
        ...(reads === true ? { reads } : {}),
        ...(readsWhen !== undefined ? { readsWhen } : {}),
      }),
    );
  }
  // A field the tool ignores when the call names another: that other one is
  // where the call acts instead, so it must be one every rule reads. It comes
  // first, so a reader that shows a call's first operative value (an
  // approval card) names where the call goes.
  for (const [i, arg] of out.entries()) {
    const { ignoredWhen } = arg;
    if (ignoredWhen === undefined) continue;
    const at = out.findIndex((other) => other.field === ignoredWhen);
    const instead = out[at];
    if (instead === undefined || instead.source === true || instead.ignoredWhen !== undefined) {
      fail(
        `[${i}].ignoredWhen: "${ignoredWhen}" must be another operative field of this tool, the one a call that names it acts on, read by every rule (no source, no ignoredWhen)`,
      );
    }
    if (at > i) {
      fail(
        `[${i}].ignoredWhen: declare "${ignoredWhen}" before "${arg.field}", which it overrides`,
      );
    }
  }
  // A source is where the tool takes a value from; something else must say
  // where it acts, or no scoped allow could ever grant the tool.
  if (out.length > 0 && out.every((arg) => arg.source === true)) {
    fail(
      `[0].source: "${(out[0] as OperativeArg).field}" is where the tool takes a value from, and no other operative field says where it acts; declare that field, or this one without source`,
    );
  }
  // A relocating field moves the tool off the store its OTHER operative
  // fields name a record in, and an allow is about that record. With no such
  // field the store is the only place the tool names: every rule is about
  // it, and a tool that reads or writes what is inside it (StateExport's
  // whole state directory) must say so with `beneath`, which a relocating
  // field cannot carry.
  if (
    out.length > 0 &&
    out.some((arg) => arg.relocates === true) &&
    out.every((arg) => arg.relocates === true || arg.source === true)
  ) {
    const first = out[0] as OperativeArg;
    fail(
      `[0].relocates: "${first.field}" is the only place this tool names — no other operative field names a record in it — so a rule is about "${first.field}" itself. Declare it without relocates, and with beneath: "all" if the tool reads or writes what is inside it`,
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
 *   `readOnly: true` is a grant (plan and auto mode run the tool without
 *   asking), so a tool that spawns a program the WORKSPACE supplies — a
 *   project's linter, a binary in node_modules/.bin — is never read-only,
 *   however read-only the program's job is.
 * - `destructive: false` is the PERMISSIVE value. In auto mode a tool that is
 *   neither read-only nor destructive is allowed with no prompt, so a tool
 *   that deletes, overwrites or spends must say `destructive: true` to be
 *   asked about.
 * - `requiresSandbox: false` and `requireJustification: false` are
 *   permissive too: the sandbox floor and the intent gate apply only to a
 *   tool that opts in. A destructive tool that goes to a place the model
 *   chose (`scope: "external"` with a `url` or `recipient` operative
 *   argument) MUST opt in to `requireJustification`.
 * - `scope` defaults to `"internal"` — the egress classifier does not scan
 *   the tool's payload — except for a definitionally outward name (see
 *   {@link isOutwardName}), which defaults to `"external"`. A tool that
 *   crosses a network or process boundary must say `scope: "external"` and
 *   declare `ioCapability`.
 * - `classifyOutput: true` — the post-tool injection classifier runs unless
 *   the tool opts out. This is the one flag whose default is the cautious
 *   value.
 *
 * apps/cli/src/flag-rules.test.ts holds these rules over every builtin, and
 * lists the builtins auto mode runs without asking.
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
  const { serviceDefaults } = def;
  if (serviceDefaults !== undefined) checkServiceDefaults(def.name, serviceDefaults, operativeArgs);
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
    // Section 18: the sandbox floor is opt-in — a tool that needs it must
    // say `requiresSandbox: true`. Classification is default-on; a tool that
    // legitimately bypasses it must opt out explicitly.
    requiresSandbox: def.requiresSandbox ?? false,
    classifyOutput: def.classifyOutput ?? true,
    // Pillar 3 sink-side fabric: defaults to "internal", which the egress
    // classifier does NOT scan, so a tool that crosses a network/process
    // boundary must opt in to "external" explicitly. egress-classifier reads
    // this flag to decide whether to route the call's payload through its
    // substring scan.
    //
    // FR-002 defense-in-depth: for tools whose NAME is definitionally
    // outward-reaching (Fetch/WebFetch/WebSearch/SendMessage/
    // EvmSendTransaction/ImageGenerate + any `mcp__*`), the *default* is
    // inverted to "external" so a future built-in that forgets the explicit
    // annotation still lowers external. An explicit `def.scope` always wins
    // (override still works), so the six built-ins that already set
    // `scope: "external"` are unchanged — no runtime behavior shifts. Every
    // other tool defaults to "internal".
    scope: def.scope ?? (isOutwardName(def.name) ? "external" : "internal"),
    // Pillar 3 intent gate: off unless the tool opts in. A destructive tool
    // that goes to a place the model chose must (see tool-http's HttpRequest,
    // tool-notify's ChatPost and EmailSend, tool-evm-tx,
    // tool-message-channel).
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
    // 0.7.1 — where a call that names no API goes, for the gate to read it.
    ...(serviceDefaults !== undefined ? { serviceDefaults } : {}),
  };
}

/**
 * A tool's `serviceDefaults` say where a call goes when it leaves its
 * `service` field out, so the tool must declare one, and only one field can
 * be it: the defaults name one API.
 */
function checkServiceDefaults(
  name: string,
  serviceDefaults: unknown,
  operativeArgs: ReadonlyArray<OperativeArg> | undefined,
): void {
  const fail = (what: string): never => {
    throw new ToolCatalogError(`tool "${name}": serviceDefaults ${what}`);
  };
  if (typeof serviceDefaults !== "function") fail("must be a function");
  const services = new Set(
    (operativeArgs ?? []).flatMap((arg) => (arg.service !== undefined ? [arg.service] : [])),
  );
  if (services.size === 0) {
    fail(
      "say where a call goes when it names no API, but no operative field declares a `service` for a call to name one in",
    );
  }
  if (services.size > 1) {
    fail(`name one API, but the operative fields declare ${services.size} service fields`);
  }
}
