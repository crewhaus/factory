/**
 * Flattening a schema into the table a person actually wants: one row per
 * field, with its path, its type, whether it is required, and its
 * constraints in a single readable phrase.
 *
 * A schema is a tree of nested objects; a field list is flat. Turning one
 * into the other is mechanical, and doing it deterministically here means a
 * harness can put a schema in front of a model — or a reviewer — without
 * spending a model call on the formatting.
 *
 * Local `$ref` is followed. A recursive reference is reported once and not
 * expanded, since a recursive type has no finite field list.
 */
import {
  isPlainObject,
  joinPointer,
  parsePointer,
  preview,
  resolveSegments,
  typeOf,
} from "./value";

export type FieldRow = {
  /** Dotted path, with `[]` marking an array level: `order.items[].sku`. */
  path: string;
  type: string;
  required: boolean;
  /** Everything that narrows the value, in one phrase; empty when unconstrained. */
  constraints: string;
  description: string;
};

export type SummarizeResult = {
  title: string;
  rootType: string;
  rows: FieldRow[];
  truncated: boolean;
};

const DEFAULTS = { maxRows: 300, maxDepth: 8 };

function describeType(schema: Record<string, unknown>): string {
  const declared = schema["type"];
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) return declared.filter((t) => typeof t === "string").join("|");
  if (Array.isArray(schema["enum"])) return "enum";
  if (Object.hasOwn(schema, "const")) return "const";
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[keyword])) return keyword;
  }
  return "any";
}

function describeConstraints(schema: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(schema["enum"])) parts.push(`one of ${preview(schema["enum"], 80)}`);
  if (Object.hasOwn(schema, "const")) parts.push(`const ${preview(schema["const"], 40)}`);
  if (typeof schema["format"] === "string") parts.push(`format ${schema["format"]}`);
  if (typeof schema["pattern"] === "string") parts.push(`matches /${schema["pattern"]}/`);
  for (const [keyword, label] of [
    ["minimum", ">="],
    ["maximum", "<="],
    ["exclusiveMinimum", ">"],
    ["exclusiveMaximum", "<"],
  ] as const) {
    if (typeof schema[keyword] === "number") parts.push(`${label} ${String(schema[keyword])}`);
  }
  if (typeof schema["multipleOf"] === "number") parts.push(`multiple of ${schema["multipleOf"]}`);
  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (typeof schema[keyword] === "number") parts.push(`${keyword} ${String(schema[keyword])}`);
  }
  if (schema["uniqueItems"] === true) parts.push("unique items");
  if (schema["additionalProperties"] === false) parts.push("no extra properties");
  if (Object.hasOwn(schema, "default")) parts.push(`default ${preview(schema["default"], 40)}`);
  return parts.join(", ");
}

type Ctx = {
  root: unknown;
  rows: FieldRow[];
  maxRows: number;
  maxDepth: number;
  truncated: boolean;
};

/** Follow a local `$ref` once. Returns null when it cannot be resolved here. */
function deref(schema: Record<string, unknown>, ctx: Ctx): Record<string, unknown> | null {
  const ref = schema["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#")) return null;
  try {
    const found = resolveSegments(ctx.root, parsePointer(ref));
    return found.found && isPlainObject(found.value) ? found.value : null;
  } catch {
    return null;
  }
}

function push(ctx: Ctx, row: FieldRow): boolean {
  if (ctx.rows.length >= ctx.maxRows) {
    ctx.truncated = true;
    return false;
  }
  ctx.rows.push(row);
  return true;
}

function walk(
  schema: unknown,
  path: string,
  required: boolean,
  depth: number,
  seenRefs: string[],
  ctx: Ctx,
): void {
  if (ctx.truncated) return;
  if (typeof schema === "boolean") {
    push(ctx, {
      path,
      type: schema ? "any" : "never",
      required,
      constraints: schema ? "" : "accepts no value",
      description: "",
    });
    return;
  }
  if (!isPlainObject(schema)) {
    push(ctx, {
      path,
      type: typeOf(schema),
      required,
      constraints: "not a schema",
      description: "",
    });
    return;
  }

  const ref = typeof schema["$ref"] === "string" ? schema["$ref"] : null;
  if (ref !== null) {
    if (seenRefs.includes(ref)) {
      push(ctx, { path, type: `${ref} (recursive)`, required, constraints: "", description: "" });
      return;
    }
    const target = deref(schema, ctx);
    if (target === null) {
      push(ctx, { path, type: ref, required, constraints: "unresolved $ref", description: "" });
      return;
    }
    walk(target, path, required, depth, [...seenRefs, ref], ctx);
    return;
  }

  const description = typeof schema["description"] === "string" ? schema["description"] : "";
  if (path !== "") {
    if (
      !push(ctx, {
        path,
        type: describeType(schema),
        required,
        constraints: describeConstraints(schema),
        description,
      })
    ) {
      return;
    }
  }
  if (depth >= ctx.maxDepth) return;

  const properties = schema["properties"];
  if (isPlainObject(properties)) {
    const requiredNames = Array.isArray(schema["required"])
      ? schema["required"].filter((k): k is string => typeof k === "string")
      : [];
    for (const key of Object.keys(properties)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      walk(properties[key], childPath, requiredNames.includes(key), depth + 1, seenRefs, ctx);
    }
  }
  const items = schema["items"];
  if (Array.isArray(items)) {
    items.forEach((item, index) => {
      walk(item, `${path}[${index}]`, required, depth + 1, seenRefs, ctx);
    });
  } else if (items !== undefined) {
    walk(items, `${path}[]`, required, depth + 1, seenRefs, ctx);
  }
}

/**
 * Flatten `schema` into one row per field. The root itself gets no row; its
 * type is reported separately, because "the document is an object" is not a
 * field.
 */
export function summarizeSchema(
  schema: unknown,
  options: { maxRows?: number; maxDepth?: number } = {},
): SummarizeResult {
  const ctx: Ctx = {
    root: schema,
    rows: [],
    maxRows: options.maxRows ?? DEFAULTS.maxRows,
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    truncated: false,
  };
  walk(schema, "", false, 0, [], ctx);
  const rootObject = isPlainObject(schema) ? schema : {};
  return {
    title: typeof rootObject["title"] === "string" ? rootObject["title"] : "",
    rootType: isPlainObject(schema)
      ? describeType(rootObject)
      : typeof schema === "boolean"
        ? "any"
        : "unknown",
    rows: ctx.rows,
    truncated: ctx.truncated,
  };
}

/** Render the field list as a GitHub-flavoured markdown table. */
export function renderFieldTable(rows: FieldRow[]): string {
  const header = ["Field", "Type", "Required", "Constraints", "Description"];
  const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const body = rows.map((row) => [
    cell(row.path),
    cell(row.type),
    row.required ? "yes" : "",
    cell(row.constraints),
    cell(row.description),
  ]);
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...body.map((line) => (line[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  const divider = `| ${widths.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`;
  return [line(header), divider, ...body.map(line)].join("\n");
}

/** Every local definition a schema declares, for a caller listing its parts. */
export function listDefinitions(schema: unknown): string[] {
  if (!isPlainObject(schema)) return [];
  const out: string[] = [];
  for (const container of ["$defs", "definitions"]) {
    const defs = schema[container];
    if (!isPlainObject(defs)) continue;
    for (const name of Object.keys(defs)) out.push(joinPointer(joinPointer("", container), name));
  }
  return out.sort();
}
