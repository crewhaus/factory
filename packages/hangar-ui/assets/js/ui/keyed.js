/**
 * Keyed updates: when fresh data arrives for a list already on screen, the
 * nodes that are still wanted MOVE (or stay), and only new keys are built.
 * A rebuilt node throws away whatever was in it — a half-typed field, an
 * open editor, the control that held focus — so a background refresh must
 * never rebuild what it can keep.
 *
 * {@link keyedPlan} is the pure half: which keys go, which are new, and the
 * fewest moves that put the rest in order (everything off the longest run
 * already in order moves; the run stays put, so a refresh that changed
 * nothing moves nothing). {@link reconcile} applies it to a parent whose
 * children carry `data-key`.
 */

/** Indexes (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq) {
  const tails = [];
  const tailAt = [];
  const prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = seq[i];
    tailAt[lo] = i;
    prev[i] = lo > 0 ? tailAt[lo - 1] : -1;
  }
  const out = [];
  let at = tails.length > 0 ? tailAt[tails.length - 1] : -1;
  while (at >= 0) {
    out.push(at);
    at = prev[at];
  }
  return out.reverse();
}

/**
 * `(prevKeys, nextKeys)` → `{ remove, insert, stay, move, moves }`, all
 * lists of keys: `remove` were there and are not wanted, `insert` are new,
 * `stay` keep their place, `move` must be moved, and `moves` counts them.
 * Pure. Duplicate keys in `nextKeys` keep their first place.
 */
export function keyedPlan(prevKeys, nextKeys) {
  const prev = (Array.isArray(prevKeys) ? prevKeys : []).map(String);
  const next = [];
  const seen = new Set();
  for (const key of (Array.isArray(nextKeys) ? nextKeys : []).map(String)) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  const prevAt = new Map(prev.map((key, i) => [key, i]));
  const remove = prev.filter((key) => !seen.has(key));
  const insert = next.filter((key) => !prevAt.has(key));
  const kept = next.filter((key) => prevAt.has(key));
  const run = new Set(longestIncreasing(kept.map((key) => prevAt.get(key))).map((i) => kept[i]));
  const stay = kept.filter((key) => run.has(key));
  const move = kept.filter((key) => !run.has(key));
  return { remove, insert, stay, move, moves: move.length };
}

/**
 * Bring `parent`'s keyed children in line with `items`.
 *
 *   keyOf(item)          — the item's key (a string)
 *   create(item)         — a new node for a key not on screen
 *   update(node, item)   — refresh a kept node in place (optional)
 *
 * Children without `data-key` are left alone. Whatever held focus before
 * holds it after, if it is still in the document. Returns the plan.
 */
export function reconcile(parent, items, opts) {
  const list = Array.isArray(items) ? items : [];
  const keyOf = opts.keyOf;
  const existing = new Map();
  for (const child of [...parent.children]) {
    const key = child.dataset?.key;
    if (typeof key === "string") existing.set(key, child);
  }
  const nextKeys = list.map((item) => String(keyOf(item)));
  const plan = keyedPlan([...existing.keys()], nextKeys);
  const active = document.activeElement;
  for (const key of plan.remove) existing.get(key)?.remove();
  const moving = new Set(plan.move);
  const nodes = [];
  const placed = new Set();
  list.forEach((item, i) => {
    const key = nextKeys[i];
    if (placed.has(key)) return;
    placed.add(key);
    let node = existing.get(key);
    if (node === undefined) {
      node = opts.create(item);
      node.dataset.key = key;
    } else if (typeof opts.update === "function") opts.update(node, item);
    nodes.push({ key, node, place: !existing.has(key) || moving.has(key) });
  });
  // Walk from the end, putting each node that must move right before its
  // successor; the nodes that stay are already in order between them.
  let anchor = null;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const { node, place } = nodes[i];
    if (place) parent.insertBefore(node, anchor);
    anchor = node;
  }
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.isConnected &&
    document.activeElement !== active
  ) {
    active.focus({ preventScroll: true });
  }
  return plan;
}
