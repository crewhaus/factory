/**
 * A deliberately tiny path reader: dotted keys and bracketed indices, and
 * nothing else.
 *
 *   data.items          → the `items` array
 *   meta.next_cursor    → a cursor field
 *   results[0].id       → the first result's id
 *
 * No wildcards, no filters, no recursive descent — `@crewhaus/tool-data`'s
 * `JsonQuery` is the tool for a real query language. This exists so
 * `HttpPaginate` and `HttpWaitFor` can name one field in a response without
 * a model turn, and so that naming is testable without a socket.
 *
 * A path segment is looked up literally, so a key containing a dot must be
 * written in brackets: `a["b.c"]`.
 */

export type PathSegment =
  | { readonly kind: "key"; readonly key: string }
  | {
      readonly kind: "index";
      readonly index: number;
    };

export class JsonPathError extends Error {
  override readonly name = "JsonPathError";
}

/** Parse a path into segments. Throws `JsonPathError` on malformed syntax. */
export function parsePath(path: string): readonly PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;
  let current = "";

  const flush = (): void => {
    if (current !== "") {
      segments.push({ kind: "key", key: current });
      current = "";
    }
  };

  while (i < path.length) {
    const ch = path[i] as string;
    if (ch === ".") {
      flush();
      i++;
      continue;
    }
    if (ch === "[") {
      flush();
      const close = path.indexOf("]", i);
      if (close === -1) throw new JsonPathError(`unclosed "[" in path "${path}"`);
      const inner = path.slice(i + 1, close).trim();
      if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        segments.push({ kind: "key", key: inner.slice(1, -1) });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: "index", index: Number.parseInt(inner, 10) });
      } else {
        throw new JsonPathError(
          `"[${inner}]" in path "${path}" is neither an index nor a quoted key`,
        );
      }
      i = close + 1;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  if (segments.length === 0) throw new JsonPathError("path is empty");
  return segments;
}

/**
 * Read `path` out of `value`. Returns `undefined` when any segment is
 * missing — indistinguishable, on purpose, from a field that is present and
 * literally `undefined`, which JSON cannot express anyway. A negative index
 * counts from the end.
 */
export function readPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const segment of parsePath(path)) {
    if (cursor === null || cursor === undefined) return undefined;
    if (segment.kind === "index") {
      if (!Array.isArray(cursor)) return undefined;
      const idx = segment.index < 0 ? cursor.length + segment.index : segment.index;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment.key];
  }
  return cursor;
}

/** A predicate over one field, used by `HttpWaitFor`. */
export type FieldPredicate = {
  readonly path: string;
  readonly op: "exists" | "equals" | "notEquals" | "contains" | "gte" | "lte";
  /** Ignored for `exists`. */
  readonly value?: unknown;
};

/** Evaluate a predicate. Returns false rather than throwing on a type mismatch. */
export function matchesPredicate(body: unknown, predicate: FieldPredicate): boolean {
  const actual = readPath(body, predicate.path);
  switch (predicate.op) {
    case "exists":
      return actual !== undefined;
    case "equals":
      return sameValue(actual, predicate.value);
    case "notEquals":
      return !sameValue(actual, predicate.value);
    case "contains": {
      if (typeof actual === "string") return actual.includes(String(predicate.value));
      if (Array.isArray(actual)) return actual.some((item) => sameValue(item, predicate.value));
      return false;
    }
    case "gte":
      return typeof actual === "number" && typeof predicate.value === "number"
        ? actual >= predicate.value
        : false;
    case "lte":
      return typeof actual === "number" && typeof predicate.value === "number"
        ? actual <= predicate.value
        : false;
    default:
      return false;
  }
}

/** Structural equality over JSON values; key order does not matter. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  return (
    ak.length === bk.length &&
    ak.every((k, i) => k === bk[i]) &&
    ak.every((k) => sameValue(ao[k], bo[k]))
  );
}
