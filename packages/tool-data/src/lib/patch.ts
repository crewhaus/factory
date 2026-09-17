/**
 * JSON Pointer (RFC 6901), JSON Patch (RFC 6902) and JSON Merge Patch
 * (RFC 7386).
 *
 * All three are implemented in full. Patching is transactional: the document
 * is cloned, every operation is applied in order, and a failure anywhere
 * leaves the caller's input untouched and reports which operation index
 * failed — which is the behaviour RFC 6902 §5 requires.
 */

import { deepClone, deepEqual, isPlainObject } from "./json";

export class PatchError extends Error {
  readonly opIndex: number;
  constructor(message: string, opIndex: number) {
    super(message);
    this.opIndex = opIndex;
  }
}

/** Decode one JSON Pointer reference token: `~1` is `/`, `~0` is `~`. */
export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Encode one reference token for embedding in a pointer. */
export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Split a JSON Pointer into its decoded tokens. `""` is the whole document. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON Pointer must be empty or start with '/', got ${JSON.stringify(pointer)}`);
  }
  return pointer.slice(1).split("/").map(unescapeToken);
}

/** Build a pointer from already-decoded tokens. */
export function formatPointer(tokens: ReadonlyArray<string>): string {
  return tokens.map((t) => `/${escapeToken(t)}`).join("");
}

/** Resolve a pointer, returning `{ found: false }` rather than throwing when it misses. */
export function resolvePointer(
  doc: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false; reason: string } {
  let tokens: string[];
  try {
    tokens = parsePointer(pointer);
  } catch (err) {
    return { found: false, reason: (err as Error).message };
  }
  let cur: unknown = doc;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        return { found: false, reason: `"${token}" is not an array index` };
      }
      const i = Number(token);
      if (i >= cur.length) return { found: false, reason: `index ${i} is past the end` };
      cur = cur[i];
      continue;
    }
    if (isPlainObject(cur)) {
      if (!Object.hasOwn(cur, token)) return { found: false, reason: `no member "${token}"` };
      cur = cur[token];
      continue;
    }
    return { found: false, reason: `cannot descend into a ${cur === null ? "null" : typeof cur}` };
  }
  return { found: true, value: cur };
}

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

/**
 * The container that holds a pointer's final token, plus that token.
 *
 * A syntactically invalid pointer is the caller's mistake, so it comes back
 * as a `PatchError` carrying the operation index — the same shape every
 * other failure here has — rather than as the bare `Error` `parsePointer`
 * raises, which would escape the tool as a crash.
 */
function locateParent(
  doc: unknown,
  pointer: string,
  opIndex: number,
): { parent: unknown; token: string } {
  let tokens: string[];
  try {
    tokens = parsePointer(pointer);
  } catch (err) {
    throw new PatchError((err as Error).message, opIndex);
  }
  if (tokens.length === 0) throw new PatchError("cannot address the root's parent", opIndex);
  const parentPointer = formatPointer(tokens.slice(0, -1));
  const found = resolvePointer(doc, parentPointer);
  if (!found.found) {
    throw new PatchError(`path "${pointer}" does not exist: ${found.reason}`, opIndex);
  }
  return { parent: found.value, token: tokens[tokens.length - 1] as string };
}

function addAt(parent: unknown, token: string, value: unknown, pointer: string, i: number): void {
  if (Array.isArray(parent)) {
    if (token === "-") {
      parent.push(value);
      return;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(token)) {
      throw new PatchError(`"${token}" is not an array index in "${pointer}"`, i);
    }
    const idx = Number(token);
    if (idx > parent.length) {
      throw new PatchError(`index ${idx} is past the end of the array in "${pointer}"`, i);
    }
    parent.splice(idx, 0, value);
    return;
  }
  if (isPlainObject(parent)) {
    parent[token] = value;
    return;
  }
  throw new PatchError(`cannot add to a ${typeof parent} at "${pointer}"`, i);
}

function removeAt(parent: unknown, token: string, pointer: string, i: number): unknown {
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9][0-9]*)$/.test(token)) {
      throw new PatchError(`"${token}" is not an array index in "${pointer}"`, i);
    }
    const idx = Number(token);
    if (idx >= parent.length) {
      throw new PatchError(`index ${idx} is past the end of the array in "${pointer}"`, i);
    }
    return parent.splice(idx, 1)[0];
  }
  if (isPlainObject(parent)) {
    if (!Object.hasOwn(parent, token)) {
      throw new PatchError(`no member "${token}" to remove at "${pointer}"`, i);
    }
    const old = parent[token];
    delete parent[token];
    return old;
  }
  throw new PatchError(`cannot remove from a ${typeof parent} at "${pointer}"`, i);
}

/**
 * Apply an RFC 6902 patch. Returns the new document; the input is never
 * mutated. Throws `PatchError` (carrying the failing operation's index) if
 * any operation cannot be applied, leaving nothing half-done.
 */
export function applyJsonPatch(doc: unknown, ops: ReadonlyArray<PatchOp>): unknown {
  let working = deepClone(doc);
  ops.forEach((op, i) => {
    switch (op.op) {
      case "test": {
        const found = resolvePointer(working, op.path);
        if (!found.found) throw new PatchError(`test failed: "${op.path}" ${found.reason}`, i);
        if (!deepEqual(found.value, op.value)) {
          throw new PatchError(`test failed: "${op.path}" is not the expected value`, i);
        }
        return;
      }
      case "add": {
        if (op.path === "") {
          working = deepClone(op.value);
          return;
        }
        const { parent, token } = locateParent(working, op.path, i);
        addAt(parent, token, deepClone(op.value), op.path, i);
        return;
      }
      case "remove": {
        if (op.path === "") throw new PatchError("cannot remove the whole document", i);
        const { parent, token } = locateParent(working, op.path, i);
        removeAt(parent, token, op.path, i);
        return;
      }
      case "replace": {
        if (op.path === "") {
          working = deepClone(op.value);
          return;
        }
        const existing = resolvePointer(working, op.path);
        if (!existing.found) {
          throw new PatchError(`cannot replace "${op.path}": ${existing.reason}`, i);
        }
        const { parent, token } = locateParent(working, op.path, i);
        removeAt(parent, token, op.path, i);
        addAt(parent, token, deepClone(op.value), op.path, i);
        return;
      }
      case "move": {
        if (op.path.startsWith(`${op.from}/`)) {
          throw new PatchError(`cannot move "${op.from}" into its own child "${op.path}"`, i);
        }
        // RFC 6902 §4.4: the "from" location MUST exist, and that holds even
        // when it equals "path". Taking the no-op shortcut first would let a
        // move of something that is not there report success.
        const src = resolvePointer(working, op.from);
        if (!src.found) throw new PatchError(`cannot move from "${op.from}": ${src.reason}`, i);
        if (op.path === op.from) return;
        const from = locateParent(working, op.from, i);
        const moved = removeAt(from.parent, from.token, op.from, i);
        if (op.path === "") {
          working = moved;
          return;
        }
        const dst = locateParent(working, op.path, i);
        addAt(dst.parent, dst.token, moved, op.path, i);
        return;
      }
      case "copy": {
        const src = resolvePointer(working, op.from);
        if (!src.found) throw new PatchError(`cannot copy from "${op.from}": ${src.reason}`, i);
        if (op.path === "") {
          working = deepClone(src.value);
          return;
        }
        const dst = locateParent(working, op.path, i);
        addAt(dst.parent, dst.token, deepClone(src.value), op.path, i);
        return;
      }
      default: {
        const bad = op as { op?: unknown };
        throw new PatchError(`unknown operation ${JSON.stringify(bad.op)}`, i);
      }
    }
  });
  return working;
}

/**
 * Apply an RFC 7386 merge patch: an object merges key by key, `null` deletes
 * a key, and any non-object patch replaces the target outright. Arrays are
 * replaced whole — that is the RFC's behaviour, not a shortcut here.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return deepClone(patch);
  const base: Record<string, unknown> = isPlainObject(target)
    ? (deepClone(target) as Record<string, unknown>)
    : {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/**
 * Derive the RFC 7386 merge patch that turns `from` into `to`. Returns the
 * smallest object that does so; `null` entries mark deletions. Where either
 * side is not an object the result is `to` itself, since a merge patch
 * cannot express a partial array or scalar change.
 */
export function diffMergePatch(from: unknown, to: unknown): unknown {
  if (!isPlainObject(from) || !isPlainObject(to)) return deepClone(to);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(to)) {
    if (!Object.hasOwn(from, key)) {
      out[key] = deepClone(to[key]);
      continue;
    }
    if (deepEqual(from[key], to[key])) continue;
    out[key] = diffMergePatch(from[key], to[key]);
  }
  for (const key of Object.keys(from)) {
    if (!Object.hasOwn(to, key)) out[key] = null;
  }
  return out;
}
