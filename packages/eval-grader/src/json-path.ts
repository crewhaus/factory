import { GraderError } from "./errors";

/**
 * Hand-rolled minimal JSONPath subset. Supports:
 *   $              root
 *   .foo           child
 *   .foo.bar       chained child
 *   ["with-dash"]  bracketed child key (single or double quoted)
 *   [N]            array index (non-negative integer)
 *   [*]            wildcard — yields each element / each value
 *   ..key          recursive descent
 *
 * Returns ALL matches as an array. The empty array means "no match".
 * Rejects unsupported expressions with a clear error message.
 */
export class JsonPathError extends GraderError {
  // biome-ignore lint/complexity/noUselessConstructor: explicit constructor so Bun --coverage counts it as a covered function (field-initializer-only classes can't hit 100% function coverage otherwise)
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

type Step =
  | { kind: "child"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" }
  | { kind: "descendant"; key: string };

export function compileJsonPath(path: string): Step[] {
  if (path === "" || path === "$") return [];
  if (!path.startsWith("$")) {
    throw new JsonPathError(`expression must start with "$": "${path}"`);
  }
  const steps: Step[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      // Could be ".key" or "..key"
      if (path[i + 1] === ".") {
        // recursive descent
        i += 2;
        const start = i;
        while (i < path.length && /[A-Za-z0-9_]/.test(path[i] ?? "")) i += 1;
        const key = path.slice(start, i);
        if (key === "") {
          throw new JsonPathError(`empty descendant key in "${path}"`);
        }
        steps.push({ kind: "descendant", key });
        continue;
      }
      i += 1;
      const start = i;
      while (i < path.length && /[A-Za-z0-9_]/.test(path[i] ?? "")) i += 1;
      const key = path.slice(start, i);
      if (key === "") throw new JsonPathError(`empty key after "." in "${path}"`);
      steps.push({ kind: "child", key });
      continue;
    }
    if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) throw new JsonPathError(`unclosed bracket in "${path}"`);
      const inner = path.slice(i + 1, close).trim();
      if (inner === "*") {
        steps.push({ kind: "wildcard" });
      } else if (/^-?\d+$/.test(inner)) {
        const n = Number.parseInt(inner, 10);
        if (n < 0) throw new JsonPathError(`negative index "${inner}" in "${path}"`);
        steps.push({ kind: "index", index: n });
      } else if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        steps.push({ kind: "child", key: inner.slice(1, -1) });
      } else {
        throw new JsonPathError(
          `unsupported bracket expression "[${inner}]" — supported forms: [N], [*], ["key"], ['key']`,
        );
      }
      i = close + 1;
      continue;
    }
    throw new JsonPathError(
      `unexpected character '${ch}' at offset ${i} in "${path}" — supported subset is $, .key, [N], [*], ..key, ["key"]`,
    );
  }
  return steps;
}

export function evalJsonPath(value: unknown, path: string): unknown[] {
  const steps = compileJsonPath(path);
  let current: unknown[] = [value];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const node of current) {
      if (step.kind === "child") {
        // Own-property check only: using `in` would traverse the prototype
        // chain and spuriously match inherited keys like "constructor",
        // "toString", or "__proto__" on parsed-JSON objects.
        if (
          node !== null &&
          typeof node === "object" &&
          Object.prototype.hasOwnProperty.call(node, step.key)
        ) {
          next.push((node as Record<string, unknown>)[step.key]);
        }
      } else if (step.kind === "index") {
        if (Array.isArray(node) && step.index < node.length) {
          next.push(node[step.index]);
        }
      } else if (step.kind === "wildcard") {
        if (Array.isArray(node)) {
          for (const v of node) next.push(v);
        } else if (node !== null && typeof node === "object") {
          for (const v of Object.values(node as Record<string, unknown>)) next.push(v);
        }
      } else if (step.kind === "descendant") {
        collectDescendants(node, step.key, next);
      }
    }
    current = next;
  }
  return current;
}

function collectDescendants(node: unknown, key: string, out: unknown[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectDescendants(item, key, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    collectDescendants(v, key, out);
  }
}
