/**
 * The leaf-by-leaf rule for a value patched at a whole block (#514).
 *
 * `OPTIMIZABLE_PATHS` admits some blocks wholesale (`steps`, `nodes`, `roles`,
 * `game`, `transaction_policy`, `model_pool.learning`, …). A value at such a
 * path is admitted only when every leaf it adds, removes or changes could be
 * patched on its own: no refused row matches the leaf, and some admitted
 * entry reaches it with no structural segment between the entry and the leaf.
 * A value that keeps a person's settings as the spec has them passes; one that
 * changes a step's `model`, `tools` or pool roster does not.
 *
 * The functions take two documents rather than a spec and a patch because
 * their callers hold different forms: a parsed `Spec` (`validatePatch`), a
 * raw YAML document (`applySpecEdits` on a text that is not a spec yet), and
 * plain data (`SpecPatchApply`).
 */
import type { Spec } from "@crewhaus/spec";
import {
  STRUCTURAL_REASONS,
  STRUCTURAL_SEGMENTS,
  type SpecEditPathSegment,
  humanOwnedReason,
  isOptimizable,
  refusedLeafIn,
  refusedLeafReason,
} from "./index";

/** One leaf that differs between two documents: absent on a side reads `undefined`. */
export type ChangedLeaf = {
  readonly path: ReadonlyArray<string>;
  readonly before: unknown;
  readonly after: unknown;
};

/** A changed leaf the optimizer may not change, and why. */
export type BlockLeafRefusal = {
  /** The leaf's dotted path. */
  readonly leaf: string;
  /** The same leaf as segments. */
  readonly path: ReadonlyArray<string>;
  readonly reason: string;
  /** Which rule refused it: a refused row, no admitted route, or the caller's own rule. */
  readonly rule: "refused-leaf" | "not-tunable" | "caller";
};

export type AdmitBlockPatchOptions = {
  /** A stricter caller's rule, asked for each changed leaf after the shared ones. */
  readonly leafRule?: (leaf: ChangedLeaf) => string | undefined;
  /**
   * The `after` document as written, before schema defaults applied, when
   * `after` is a parsed spec. A leaf `after` adds that `before` lacks and
   * `written` does not hold is a default appearing under a block the patch
   * created, not a change anyone made, and is not judged. A default that
   * VANISHES (its block removed) is still a change.
   */
  readonly written?: unknown;
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value at `path`, reading a sequence by index. `undefined` when absent. */
function valueAt(doc: unknown, path: ReadonlyArray<SpecEditPathSegment>): unknown {
  let cur = doc;
  for (const seg of path) {
    const key = String(seg);
    if (Array.isArray(cur)) {
      const i = Number(key);
      cur = Number.isInteger(i) && i >= 0 && String(i) === key ? cur[i] : undefined;
    } else if (isMapping(cur)) {
      cur = Object.hasOwn(cur, key) ? cur[key] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Every leaf of `value`, keyed by its path. A scalar, `null`, an empty mapping
 * and an empty sequence are leaves; a key whose value is `undefined` is absent.
 */
function collectLeaves(
  value: unknown,
  path: string[],
  out: Map<string, { path: string[]; value: unknown }>,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(JSON.stringify(path), { path, value });
      return;
    }
    value.forEach((item, i) => collectLeaves(item, [...path, String(i)], out));
    return;
  }
  if (isMapping(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      out.set(JSON.stringify(path), { path, value });
      return;
    }
    for (const [k, v] of entries) collectLeaves(v, [...path, k], out);
    return;
  }
  out.set(JSON.stringify(path), { path, value });
}

/** Two leaf values are the same: equal scalars, or two empty containers of one kind. */
function sameLeaf(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 0 && b.length === 0;
  if (isMapping(a) && isMapping(b)) {
    return Object.keys(a).length === 0 && Object.keys(b).length === 0;
  }
  return false;
}

/**
 * Every leaf under `at` that differs between two documents (added, removed or
 * changed), with its full path. Mappings are walked by key and sequences by
 * index (the index as a string segment). An empty container is a leaf, except
 * where the other side holds a non-empty container of the same kind: emptying
 * or filling it is told by the leaves under it. Sorted by dotted path with a
 * code-unit comparison, so the order never depends on the locale.
 */
export function changedLeaves(
  before: unknown,
  after: unknown,
  at: ReadonlyArray<SpecEditPathSegment>,
): ReadonlyArray<ChangedLeaf> {
  const base = at.map((seg) => String(seg));
  const a = new Map<string, { path: string[]; value: unknown }>();
  const b = new Map<string, { path: string[]; value: unknown }>();
  collectLeaves(valueAt(before, at), base, a);
  collectLeaves(valueAt(after, at), base, b);
  const out: ChangedLeaf[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (x !== undefined && y !== undefined && sameLeaf(x.value, y.value)) continue;
    const path = (x ?? y)?.path ?? [];
    // A container emptied or filled is told by the leaves under it: the empty
    // side is a leaf only where the other side holds no container of its kind.
    if (x === undefined || y === undefined) {
      const empty = (x ?? y)?.value;
      const other = valueAt(x === undefined ? before : after, path);
      if (Array.isArray(empty) ? Array.isArray(other) : isMapping(empty) && isMapping(other)) {
        continue;
      }
    }
    out.push({ path, before: x?.value, after: y?.value });
  }
  const dotted = (leaf: ChangedLeaf): string => leaf.path.join(".");
  const json = (leaf: ChangedLeaf): string => JSON.stringify(leaf.path);
  return out.sort((l, r) => {
    const [p, q] = [dotted(l), dotted(r)];
    if (p !== q) return p < q ? -1 : 1;
    const [s, t] = [json(l), json(r)];
    return s < t ? -1 : s > t ? 1 : 0;
  });
}

/**
 * Whether the optimizer can write the leaf at `leaf` (a real path, no
 * wildcards): the path itself is admitted, or an admitted ancestor can be
 * replaced wholesale and the tail from that ancestor down crosses no
 * structural segment. So `["agent","model_pool","learning"]` (exact, wholesale)
 * reaches `learning.explorationRate`, while `["steps"]` does not reach
 * `steps.0.model`.
 */
export function leafReachable(
  target: Spec["target"],
  leaf: ReadonlyArray<SpecEditPathSegment>,
): boolean {
  const segs = leaf.map((seg) => String(seg));
  for (let len = segs.length; len >= 1; len--) {
    if (segs.slice(len).some((seg) => STRUCTURAL_SEGMENTS.includes(seg))) break;
    if (isOptimizable(target, segs.slice(0, len))) return true;
  }
  return false;
}

/** Why a leaf no admitted entry reaches is refused. */
function notTunableReason(target: Spec["target"], leaf: ReadonlyArray<string>): string {
  const structural = leaf.find((seg) => STRUCTURAL_SEGMENTS.includes(seg));
  const fromSegment = structural !== undefined ? STRUCTURAL_REASONS[structural] : undefined;
  return (
    fromSegment ??
    humanOwnedReason(leaf) ??
    `${leaf.join(".")} is not listed in OPTIMIZABLE_PATHS for target "${target}"`
  );
}

/**
 * The first changed leaf under `at` the optimizer may not change, or
 * `undefined` when every one may. For each leaf, in {@link changedLeaves}
 * order: a refused row (`refused-leaf`, the row's reason), then
 * {@link leafReachable} (`not-tunable`), then the caller's `leafRule`
 * (`caller`).
 */
export function admitBlockPatch(
  target: Spec["target"],
  before: unknown,
  after: unknown,
  at: ReadonlyArray<SpecEditPathSegment>,
  opts: AdmitBlockPatchOptions = {},
): BlockLeafRefusal | undefined {
  for (const leaf of changedLeaves(before, after, at)) {
    if (
      opts.written !== undefined &&
      leaf.before === undefined &&
      valueAt(opts.written, leaf.path) === undefined
    ) {
      continue;
    }
    const base = { leaf: leaf.path.join("."), path: leaf.path };
    const row = refusedLeafIn(leaf.path);
    if (row !== undefined) {
      return { ...base, reason: refusedLeafReason(row), rule: "refused-leaf" };
    }
    if (!leafReachable(target, leaf.path)) {
      return { ...base, reason: notTunableReason(target, leaf.path), rule: "not-tunable" };
    }
    const own = opts.leafRule?.(leaf);
    if (own !== undefined) return { ...base, reason: own, rule: "caller" };
  }
  return undefined;
}

/**
 * A copy of `doc` with `value` set at `path` (intermediate mappings created),
 * or with `path` deleted for a `remove`. Plain data in, plain data out; the
 * input is not touched.
 */
export function withPatchApplied(
  doc: unknown,
  path: ReadonlyArray<SpecEditPathSegment>,
  op: "replace" | "add" | "remove",
  value: unknown,
): unknown {
  const root: unknown = structuredClone(doc ?? {});
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    const holder = cur as Record<string, unknown>;
    let next = Array.isArray(cur) || isMapping(cur) ? holder[key] : undefined;
    if (next === undefined) {
      if (op === "remove") return root;
      next = {};
      holder[key] = next;
    } else if (next === null || typeof next !== "object") {
      // A scalar on the way (a `provability: grounded` shorthand): the CST
      // refuses this write, so the document stays as it is.
      return root;
    }
    cur = next;
  }
  const last = String(path[path.length - 1]);
  if (op === "remove") {
    if (Array.isArray(cur)) {
      const i = Number(last);
      if (Number.isInteger(i) && i >= 0 && i < cur.length) cur.splice(i, 1);
    } else if (isMapping(cur)) {
      delete cur[last];
    }
    return root;
  }
  if (Array.isArray(cur) || isMapping(cur)) {
    (cur as Record<string, unknown>)[last] = structuredClone(value);
  }
  return root;
}
