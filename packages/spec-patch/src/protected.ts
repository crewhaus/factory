/**
 * Protected bars only tighten.
 *
 * A spec marks a quality bar as its owner's with `protected: true` on the
 * block that sets it: the in-loop `evaluation:` block, the object form of
 * `provability:`, and the `judge:` gate of a workflow step or a graph node.
 * For a protected block, a change may raise `threshold` and
 * `provability.grounded.coverage` and may lower
 * `provability.grounded.window_tokens`; it may not move any of them the other
 * way, remove the block, or clear its protection. An absent value reads as
 * its default (0.7 for an evaluation or judge threshold, 1.0 for the
 * provability threshold, 0.8 for `grounded.coverage`, 60 for
 * `grounded.window_tokens`), because the schema applies none of them.
 *
 * {@link protectedBarChange} reads two whole documents, so a value set at a
 * block, a whole `steps` list or one edit among many is judged the same way.
 * A bar that is not protected stays tunable in both directions.
 *
 * Workflow steps pair by name and occurrence: the k-th step named X before is
 * judged against the k-th step named X after, keyed `steps.X.judge` when X is
 * unique before and `steps.X#k.judge` when it repeats. A step without a name
 * pairs with the step at its own position after, keyed `steps.<i>.judge`.
 * Graph nodes pair by their map key.
 *
 * Pure: no `node:` import, and it never imports `./index` (`surfaces.ts`
 * calls it, and `./index` loads `surfaces.ts` before its own constants exist).
 */

/** What a change does to a protected bar: its dotted path, and why it is refused. */
export type ProtectedBarChange = { readonly key: string; readonly reason: string };

const DEFAULTS = {
  evaluationThreshold: 0.7,
  judgeThreshold: 0.7,
  provabilityThreshold: 1,
  groundedCoverage: 0.8,
  groundedWindowTokens: 60,
} as const;

function plain(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

/** `provability:` as a mapping: a rung name is shorthand for `{level: <rung>}`. */
function provabilityBlock(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "string") return { level: v };
  return plain(v);
}

/** A threshold that may only rise. */
function onlyRises(
  key: string,
  was: Record<string, unknown>,
  now: Record<string, unknown>,
  field: string,
  fallback: number,
): ProtectedBarChange | undefined {
  const before = num(was[field], fallback);
  const after = num(now[field], fallback);
  return after < before
    ? { key, reason: `a protected ${key} only rises (${before} → ${after})` }
    : undefined;
}

/** One protected block: removed, unprotected, or a bar moved the loose way. */
function blockChange(
  name: string,
  was: Record<string, unknown>,
  now: Record<string, unknown> | undefined,
  bars: (
    was: Record<string, unknown>,
    now: Record<string, unknown>,
  ) => ProtectedBarChange | undefined,
): ProtectedBarChange | undefined {
  if (now === undefined) return { key: name, reason: `the protected ${name} is removed` };
  if (now["protected"] !== true) {
    return { key: `${name}.protected`, reason: `the protection of ${name} is removed` };
  }
  return bars(was, now);
}

const judgeBars =
  (name: string) =>
  (was: Record<string, unknown>, now: Record<string, unknown>): ProtectedBarChange | undefined =>
    onlyRises(`${name}.threshold`, was, now, "threshold", DEFAULTS.judgeThreshold);

/**
 * The first way `after` loosens a bar `before` protects, or `undefined` when
 * none does. Both are parsed spec documents (schema defaults applied or not).
 */
export function protectedBarChange(
  before: unknown,
  after: unknown,
): ProtectedBarChange | undefined {
  const was = plain(before);
  if (was === undefined) return undefined;
  const now = plain(after) ?? {};

  const evaluation = plain(was["evaluation"]);
  if (evaluation?.["protected"] === true) {
    const change = blockChange("evaluation", evaluation, plain(now["evaluation"]), (a, b) =>
      onlyRises("evaluation.threshold", a, b, "threshold", DEFAULTS.evaluationThreshold),
    );
    if (change !== undefined) return change;
  }

  const provability = provabilityBlock(was["provability"]);
  if (provability?.["protected"] === true) {
    const change = blockChange(
      "provability",
      provability,
      provabilityBlock(now["provability"]),
      (a, b) => {
        const threshold = onlyRises(
          "provability.threshold",
          a,
          b,
          "threshold",
          DEFAULTS.provabilityThreshold,
        );
        if (threshold !== undefined) return threshold;
        const ga = plain(a["grounded"]) ?? {};
        const gb = plain(b["grounded"]) ?? {};
        const coverage = onlyRises(
          "provability.grounded.coverage",
          ga,
          gb,
          "coverage",
          DEFAULTS.groundedCoverage,
        );
        if (coverage !== undefined) return coverage;
        const windowBefore = num(ga["window_tokens"], DEFAULTS.groundedWindowTokens);
        const windowAfter = num(gb["window_tokens"], DEFAULTS.groundedWindowTokens);
        return windowAfter > windowBefore
          ? {
              key: "provability.grounded.window_tokens",
              reason: `a protected provability.grounded.window_tokens only falls (${windowBefore} → ${windowAfter})`,
            }
          : undefined;
      },
    );
    if (change !== undefined) return change;
  }

  // Judge gates: workflow steps by name and occurrence, graph nodes by key.
  const stepsBefore = Array.isArray(was["steps"]) ? (was["steps"] as unknown[]).map(plain) : [];
  const stepsAfter = Array.isArray(now["steps"]) ? (now["steps"] as unknown[]).map(plain) : [];
  const stepName = (s: Record<string, unknown> | undefined): string | undefined =>
    typeof s?.["name"] === "string" ? (s["name"] as string) : undefined;
  const totalBefore = new Map<string, number>();
  for (const s of stepsBefore) {
    const n = stepName(s);
    if (n !== undefined) totalBefore.set(n, (totalBefore.get(n) ?? 0) + 1);
  }
  const seenBefore = new Map<string, number>();
  for (const [i, step] of stepsBefore.entries()) {
    const stepId = stepName(step);
    const occurrence = stepId === undefined ? 0 : (seenBefore.get(stepId) ?? 0) + 1;
    if (stepId !== undefined) seenBefore.set(stepId, occurrence);
    const judge = plain(step?.["judge"]);
    if (judge?.["protected"] !== true) continue;
    let match: Record<string, unknown> | undefined;
    let id: string;
    if (stepId === undefined) {
      match = stepsAfter[i];
      id = String(i);
    } else {
      match = stepsAfter.filter((s) => stepName(s) === stepId)[occurrence - 1];
      id = (totalBefore.get(stepId) ?? 0) > 1 ? `${stepId}#${occurrence}` : stepId;
    }
    const name = `steps.${id}.judge`;
    const change = blockChange(name, judge, plain(match?.["judge"]), judgeBars(name));
    if (change !== undefined) return change;
  }
  const nodesBefore = plain(was["nodes"]) ?? {};
  const nodesAfter = plain(now["nodes"]) ?? {};
  for (const [id, raw] of Object.entries(nodesBefore)) {
    const judge = plain(plain(raw)?.["judge"]);
    if (judge?.["protected"] !== true) continue;
    const name = `nodes.${id}.judge`;
    const change = blockChange(
      name,
      judge,
      plain(plain(nodesAfter[id])?.["judge"]),
      judgeBars(name),
    );
    if (change !== undefined) return change;
  }
  return undefined;
}
