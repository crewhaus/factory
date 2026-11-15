/**
 * A protected bar only tightens without its owner.
 *
 * A spec marks a quality bar as its owner's with `protected: true` on the
 * block that sets it: the in-loop `evaluation:` block, the object form of
 * `provability:`, and the `judge:` gate of a workflow step or a graph node.
 * A protected block changes without its owner only by the tightenings listed
 * here; every other difference in it is a loosening, and so is removing the
 * block or clearing its protection.
 *
 * - A judge gate may raise `threshold`, make `on_fail` stricter
 *   (`continue` < `retry_previous` < `halt`) and lower `max_retries`. Any
 *   change to its `criteria`, `model`, `judges`, `repeats`, `temperature`,
 *   `target`, `escalate_to` or any other key is a loosening. For a graph
 *   judge node, so is any change to the wiring around it, where the nodes it
 *   watches are the judge node and every node upstream of it (each node with
 *   a path of edges to it, in either document): the ordered edges leaving one
 *   of those nodes, the edges into the judge node, `entry` when it names one
 *   of those nodes, and the `parallel` groups that hold one.
 * - `evaluation` may raise `threshold`, lower `max_retries` and clear
 *   `allow_self_judge`. `on_fail` may move from `note` to `retry`, `escalate`
 *   or `halt`, and from `retry` or `escalate` to `halt`; a move between
 *   `retry` and `escalate` is the owner's. Any change to a `grader` field is a
 *   loosening.
 * - While a protected `evaluation` or `provability` block's `on_fail` is
 *   `escalate`, the escalations a turn may make are part of its bar: they may
 *   rise, and any fall is a loosening, keyed
 *   `agent.model_pool.strategy.max_escalations`. A turn makes
 *   `agent.model_pool.strategy.max_escalations` of them (1 when absent), and
 *   none without `agent.model_pool`, so removing the pool or its strategy
 *   counts as that change too.
 * - `provability` may raise `level` (`off` < `cited` < `grounded` < `checked`
 *   < `proven`), `threshold` and `grounded.coverage`, and lower
 *   `grounded.window_tokens`. Any other change is a loosening.
 * - A protected judge's settings include the `models:` profiles it reads: the
 *   `$profile` its model or panel names, or every profile when its model is
 *   `strongest` or left out (the default judge then ranks over the
 *   registry). Any change to one of those profiles, its temperature,
 *   `max_tokens`, thinking budget and limits included, is a loosening of the
 *   judge's model: `<name>.model` for a judge gate, `evaluation.grader.model`
 *   and `provability.judge`.
 *
 * An absent value reads as its default, because the schema applies none of
 * them: 0.7 for an evaluation or judge threshold, 1.0 for the provability
 * threshold, 0.8 for `grounded.coverage`, 60 for `grounded.window_tokens`,
 * 1 for a judge or evaluation `max_retries`, `retry_previous` for a judge's
 * `on_fail` and `retry` for evaluation's.
 *
 * {@link protectedBarChanges} reads two whole documents, so a value set at a
 * block, a whole `steps` list or one edit among many is judged the same way.
 * It names every loosening in a fixed order: evaluation, provability, the
 * escalation budget, the workflow steps in document order, then the graph
 * nodes in map order, and within a block the order above. A bar that is not
 * protected stays tunable in both directions.
 *
 * Workflow steps pair by name and occurrence: the k-th step named X before is
 * judged against the k-th step named X after, keyed `steps.X.judge` when X is
 * unique before and `steps.X#k.judge` when it repeats. A step without a name
 * pairs with the step at its own position after, keyed `steps.<i>.judge`.
 * A pairing holds only while it still gates the same step: when the number
 * of steps named X differs between the two documents, or the step just
 * before the pair is not the same step (by name and occurrence, or by
 * position when unnamed), the protected gate reads as removed and only its
 * owner makes the change. Graph nodes pair by their map key.
 *
 * Pure: no `node:` import, and it never imports `./index` (`surfaces.ts`
 * calls it, and `./index` loads `surfaces.ts` before its own constants exist).
 */

/** What a change does to a protected bar: its dotted path, and why it is refused. */
export type ProtectedBarChange = { readonly key: string; readonly reason: string };

type Doc = Record<string, unknown>;

const DEFAULTS = {
  evaluationThreshold: 0.7,
  judgeThreshold: 0.7,
  provabilityThreshold: 1,
  groundedCoverage: 0.8,
  groundedWindowTokens: 60,
  maxRetries: 1,
  judgeOnFail: "retry_previous",
  evaluationOnFail: "retry",
} as const;

/**
 * How a value may move without its owner: a ladder, loosest first, where a value moves
 * only to an equal or later rank, or a partial order listing, for each value, the values
 * it may move to (any move it does not list is the owner's).
 */
type Ladder =
  | { readonly rank: Readonly<Record<string, number>> }
  | { readonly tightensTo: Readonly<Record<string, ReadonlyArray<string>>> };

const JUDGE_ON_FAIL: Ladder = { rank: { continue: 0, retry_previous: 1, halt: 2 } };
/** `retry` and `escalate` are incomparable: either one only moves on to `halt`. */
const EVALUATION_ON_FAIL: Ladder = {
  tightensTo: {
    note: ["retry", "escalate", "halt"],
    retry: ["halt"],
    escalate: ["halt"],
    halt: [],
  },
};
const PROVABILITY_LEVEL: Ladder = {
  rank: {
    off: 0,
    cited: 1,
    grounded: 2,
    checked: 3,
    proven: 4,
  },
};

/** The judge gate keys that change only with the owner, in the order they are named. */
const JUDGE_OWNED = [
  "criteria",
  "model",
  "judges",
  "repeats",
  "temperature",
  "target",
  "escalate_to",
] as const;

/** The provability keys that change only with the owner, in the order they are named. */
const PROVABILITY_OWNED = [
  "on_fail",
  "max_retries",
  "scope",
  "assumptions",
  "max_assumptions",
  "render",
  "sources",
  "execution",
  "formal",
  "judge",
] as const;

function plain(v: unknown): Doc | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Doc) : undefined;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

/** A value as text with its keys sorted, so two equal values read the same. */
function canonical(v: unknown): string {
  if (v === undefined) return "~";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "~";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Doc;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** `provability:` as a mapping: a rung name is shorthand for `{level: <rung>}`. */
function provabilityBlock(v: unknown): Doc | undefined {
  if (typeof v === "string") return { level: v };
  return plain(v);
}

/** A number that may only rise. */
function onlyRises(
  key: string,
  was: Doc,
  now: Doc,
  field: string,
  fallback: number,
): ProtectedBarChange | undefined {
  const before = num(was[field], fallback);
  const after = num(now[field], fallback);
  return after < before
    ? { key, reason: `a protected ${key} only rises (${before} → ${after})` }
    : undefined;
}

/** A number that may only fall. */
function onlyFalls(
  key: string,
  was: Doc,
  now: Doc,
  field: string,
  fallback: number,
): ProtectedBarChange | undefined {
  const before = num(was[field], fallback);
  const after = num(now[field], fallback);
  return after > before
    ? { key, reason: `a protected ${key} only falls (${before} → ${after})` }
    : undefined;
}

/** Whether `ladder` lets a value move from `before` to `after` without its owner. */
function tightens(ladder: Ladder, before: unknown, after: unknown): boolean {
  if (typeof before !== "string" || typeof after !== "string") return false;
  if ("rank" in ladder) {
    const rankBefore = Object.hasOwn(ladder.rank, before) ? ladder.rank[before] : undefined;
    const rankAfter = Object.hasOwn(ladder.rank, after) ? ladder.rank[after] : undefined;
    return rankBefore !== undefined && rankAfter !== undefined && rankAfter >= rankBefore;
  }
  if (!Object.hasOwn(ladder.tightensTo, before) || !Object.hasOwn(ladder.tightensTo, after)) {
    return false;
  }
  return (ladder.tightensTo[before] ?? []).includes(after);
}

/** A value that may move without its owner only as its ladder allows. */
function onlyStricter(
  key: string,
  was: Doc,
  now: Doc,
  field: string,
  ladder: Ladder,
  fallback: string,
  moves = "grows stricter",
): ProtectedBarChange | undefined {
  const before = was[field] ?? fallback;
  const after = now[field] ?? fallback;
  if (same(before, after)) return undefined;
  if (tightens(ladder, before, after)) return undefined;
  return {
    key,
    reason: `a protected ${key} only ${moves} (${String(before)} → ${String(after)})`,
  };
}

/** A value that changes only with the owner, absent to set and set to absent included. */
function ownersOnly(key: string, was: unknown, now: unknown): ProtectedBarChange | undefined {
  return same(was, now)
    ? undefined
    : { key, reason: `a protected ${key} changes only with its owner` };
}

/** Each key outside `known` (and `protected`) whose value differs, in sorted order. */
function otherKeys(
  name: string,
  was: Doc,
  now: Doc,
  known: ReadonlySet<string>,
): ProtectedBarChange[] {
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .filter((k) => k !== "protected" && !known.has(k))
    .sort();
  return keys.flatMap((k) => {
    const change = ownersOnly(`${name}.${k}`, was[k], now[k]);
    return change !== undefined ? [change] : [];
  });
}

/** The value of `models:`, absent read as none. */
const profilesOf = (doc: Doc): Doc => plain(doc["models"]) ?? {};

/**
 * The `models:` profiles a judge reads, in either document, sorted: each
 * `$profile` among `refs`, or every profile when one of them is `strongest`
 * or the judge names no model (`modelAbsent`), because the default judge
 * ranks over the whole registry.
 */
function profilesRead(
  refs: ReadonlyArray<unknown>,
  modelAbsent: boolean,
  was: Doc,
  now: Doc,
): string[] {
  if (modelAbsent || refs.includes("strongest")) {
    return [...new Set([...Object.keys(profilesOf(was)), ...Object.keys(profilesOf(now))])].sort();
  }
  const named = refs.flatMap((r) =>
    typeof r === "string" && r.startsWith("$") ? [r.slice(1)] : [],
  );
  return [...new Set(named)].sort();
}

/** The model refs a judge block holds: its `model` and each panel judge. */
function modelRefs(block: Doc | undefined): unknown[] {
  if (block === undefined) return [];
  return [block["model"], ...(Array.isArray(block["judges"]) ? block["judges"] : [])];
}

/**
 * `key` when a profile in `profiles` differs between the documents: the
 * judge reads it, so it changes only with the owner.
 */
function profileChange(
  key: string,
  name: string,
  profiles: ReadonlyArray<string>,
  was: Doc,
  now: Doc,
): ProtectedBarChange | undefined {
  const changed = profiles.find((p) => !same(profilesOf(was)[p], profilesOf(now)[p]));
  return changed === undefined
    ? undefined
    : {
        key,
        reason: `the models.${changed} profile a protected ${name} reads changes only with its owner`,
      };
}

/** `changes` with `extra` added when no change already carries its key. */
function withChange(
  changes: ProtectedBarChange[],
  extra: ProtectedBarChange | undefined,
): ProtectedBarChange[] {
  return extra === undefined || changes.some((c) => c.key === extra.key)
    ? changes
    : [...changes, extra];
}

const defined = (changes: ReadonlyArray<ProtectedBarChange | undefined>): ProtectedBarChange[] =>
  changes.filter((c): c is ProtectedBarChange => c !== undefined);

/**
 * One protected block: removed or unprotected (its one key, nothing else
 * checked), or every way `bars` finds it loosened.
 */
function blockChanges(
  name: string,
  was: Doc,
  now: Doc | undefined,
  bars: (was: Doc, now: Doc) => ProtectedBarChange[],
): ProtectedBarChange[] {
  if (now === undefined) return [{ key: name, reason: `the protected ${name} is removed` }];
  if (now["protected"] !== true) {
    return [{ key: `${name}.protected`, reason: `the protection of ${name} is removed` }];
  }
  return bars(was, now);
}

const JUDGE_KNOWN: ReadonlySet<string> = new Set([
  "threshold",
  "on_fail",
  "max_retries",
  ...JUDGE_OWNED,
]);

/**
 * A judge gate's loosenings, in the order the module docblock gives; `docs`
 * are the two whole documents, for the profiles the gate reads.
 */
function judgeBars(
  name: string,
  was: Doc,
  now: Doc,
  docs: readonly [Doc, Doc],
): ProtectedBarChange[] {
  const profiles = profilesRead(
    [...modelRefs(was), ...modelRefs(now)],
    was["model"] === undefined || now["model"] === undefined,
    ...docs,
  );
  return withChange(
    [
      ...defined([
        onlyRises(`${name}.threshold`, was, now, "threshold", DEFAULTS.judgeThreshold),
        onlyStricter(`${name}.on_fail`, was, now, "on_fail", JUDGE_ON_FAIL, DEFAULTS.judgeOnFail),
        onlyFalls(`${name}.max_retries`, was, now, "max_retries", DEFAULTS.maxRetries),
        ...JUDGE_OWNED.map((field) => ownersOnly(`${name}.${field}`, was[field], now[field])),
      ]),
      ...otherKeys(name, was, now, JUDGE_KNOWN),
    ],
    profileChange(`${name}.model`, name, profiles, ...docs),
  );
}

const EVALUATION_KNOWN: ReadonlySet<string> = new Set([
  "threshold",
  "on_fail",
  "max_retries",
  "grader",
  "allow_self_judge",
]);

function evaluationBars(was: Doc, now: Doc, docs: readonly [Doc, Doc]): ProtectedBarChange[] {
  const graderBefore = plain(was["grader"]) ?? {};
  const graderAfter = plain(now["grader"]) ?? {};
  // Only a model judge reads a profile.
  const judged = graderBefore["type"] === "llm_judge" || graderAfter["type"] === "llm_judge";
  const profiles = judged
    ? profilesRead(
        [...modelRefs(graderBefore), ...modelRefs(graderAfter)],
        graderBefore["model"] === undefined || graderAfter["model"] === undefined,
        ...docs,
      )
    : [];
  const graderFields = [
    ...new Set([...Object.keys(graderBefore), ...Object.keys(graderAfter)]),
  ].sort();
  const selfJudge =
    now["allow_self_judge"] === true && was["allow_self_judge"] !== true
      ? {
          key: "evaluation.allow_self_judge",
          reason: "a protected evaluation.allow_self_judge is set only by its owner",
        }
      : undefined;
  const changes = [
    ...defined([
      onlyRises("evaluation.threshold", was, now, "threshold", DEFAULTS.evaluationThreshold),
      onlyStricter(
        "evaluation.on_fail",
        was,
        now,
        "on_fail",
        EVALUATION_ON_FAIL,
        DEFAULTS.evaluationOnFail,
      ),
      onlyFalls("evaluation.max_retries", was, now, "max_retries", DEFAULTS.maxRetries),
      ...(plain(was["grader"]) === undefined || plain(now["grader"]) === undefined
        ? [ownersOnly("evaluation.grader", was["grader"], now["grader"])]
        : graderFields.map((field) =>
            ownersOnly(`evaluation.grader.${field}`, graderBefore[field], graderAfter[field]),
          )),
      selfJudge,
    ]),
    ...otherKeys("evaluation", was, now, EVALUATION_KNOWN),
  ];
  return withChange(
    changes,
    profileChange("evaluation.grader.model", "evaluation.grader", profiles, ...docs),
  );
}

const PROVABILITY_KNOWN: ReadonlySet<string> = new Set([
  "level",
  "threshold",
  "grounded",
  ...PROVABILITY_OWNED,
]);

/** `grounded` with its two dials left out. */
function groundedRest(v: unknown): unknown {
  const g = plain(v);
  if (g === undefined) return v;
  const { coverage: _coverage, window_tokens: _window, ...rest } = g;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function provabilityBars(was: Doc, now: Doc, docs: readonly [Doc, Doc]): ProtectedBarChange[] {
  const ga = plain(was["grounded"]) ?? {};
  const gb = plain(now["grounded"]) ?? {};
  // The waiver judge names its model, so it reads only the profile it names.
  const profiles = profilesRead(
    [...modelRefs(plain(was["judge"])), ...modelRefs(plain(now["judge"]))],
    false,
    ...docs,
  );
  const changes = [
    ...defined([
      onlyStricter("provability.level", was, now, "level", PROVABILITY_LEVEL, "off", "rises"),
      onlyRises("provability.threshold", was, now, "threshold", DEFAULTS.provabilityThreshold),
      onlyRises("provability.grounded.coverage", ga, gb, "coverage", DEFAULTS.groundedCoverage),
      onlyFalls(
        "provability.grounded.window_tokens",
        ga,
        gb,
        "window_tokens",
        DEFAULTS.groundedWindowTokens,
      ),
      ownersOnly(
        "provability.grounded",
        groundedRest(was["grounded"]),
        groundedRest(now["grounded"]),
      ),
      ...PROVABILITY_OWNED.map((field) =>
        ownersOnly(`provability.${field}`, was[field], now[field]),
      ),
    ]),
    ...otherKeys("provability", was, now, PROVABILITY_KNOWN),
  ];
  return withChange(
    changes,
    profileChange("provability.judge", "provability.judge", profiles, ...docs),
  );
}

/** A graph's edges as mappings, absent read as none. */
function edgesOf(doc: Doc): Doc[] {
  return Array.isArray(doc["edges"]) ? (doc["edges"] as unknown[]).map((e) => plain(e) ?? {}) : [];
}

/**
 * The wiring around a graph judge node: the nodes it watches are the judge
 * node and every node upstream of it, each node with a path of edges to it in
 * either document. Its wiring changes when the ordered edges leaving one of
 * those nodes differ, the edges into the judge node differ, `entry` differs
 * while either document's entry is one of them, or the `parallel` groups that
 * hold one of them differ.
 */
function judgeWiringChange(name: string, id: string, was: Doc, now: Doc): ProtectedBarChange[] {
  const edgesBefore = edgesOf(was);
  const edgesAfter = edgesOf(now);
  const both = [...edgesBefore, ...edgesAfter];
  const gated = new Set<string>([id]);
  // Walk the edges backwards from the judge node until no node is added.
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of both) {
      const from = e["from"];
      if (typeof from === "string" && !gated.has(from) && gated.has(e["to"] as string)) {
        gated.add(from);
        grew = true;
      }
    }
  }
  const holds = (v: unknown): boolean => typeof v === "string" && gated.has(v);
  const leaving = (edges: Doc[]) => edges.filter((e) => holds(e["from"]));
  const entering = (edges: Doc[]) => edges.filter((e) => e["to"] === id);
  const groups = (doc: Doc) =>
    Array.isArray(doc["parallel"])
      ? (doc["parallel"] as unknown[]).filter((g) => Array.isArray(g) && g.some(holds))
      : [];
  const entryMoved =
    (holds(was["entry"]) || holds(now["entry"])) && !same(was["entry"], now["entry"]);
  const moved =
    !same(leaving(edgesBefore), leaving(edgesAfter)) ||
    !same(entering(edgesBefore), entering(edgesAfter)) ||
    entryMoved ||
    !same(groups(was), groups(now));
  return moved
    ? [
        {
          key: `${name}.edges`,
          reason: `the edges around the protected ${name} change only with its owner`,
        },
      ]
    : [];
}

/**
 * The escalations a turn of `doc` may make: none without `agent.model_pool`,
 * else its `strategy.max_escalations` (1 when absent).
 */
function escalationBudget(doc: Doc): number {
  const pool = plain(plain(doc["agent"])?.["model_pool"]);
  if (pool === undefined) return 0;
  const cap = plain(pool["strategy"])?.["max_escalations"];
  return typeof cap === "number" && Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 1;
}

const ESCALATIONS_KEY = "agent.model_pool.strategy.max_escalations";

/**
 * The escalation budget's fall, when a protected block (each of `escalating`,
 * named for the reason) escalates on a failing verdict after the change.
 */
function escalationBudgetChange(
  escalating: ReadonlyArray<string>,
  was: Doc,
  now: Doc,
): ProtectedBarChange | undefined {
  if (escalating.length === 0) return undefined;
  const before = escalationBudget(was);
  const after = escalationBudget(now);
  return after < before
    ? {
        key: ESCALATIONS_KEY,
        reason: `the escalations a protected ${escalating.join(" and ")} with on_fail: escalate makes only rise (${before} → ${after})`,
      }
    : undefined;
}

/**
 * Every way `after` loosens a bar `before` protects, in the order the module
 * docblock gives; empty when none does. Both are parsed spec documents (schema
 * defaults applied or not, alike on both sides).
 */
export function protectedBarChanges(before: unknown, after: unknown): ProtectedBarChange[] {
  const was = plain(before);
  if (was === undefined) return [];
  const now = plain(after) ?? {};
  const out: ProtectedBarChange[] = [];

  const evaluation = plain(was["evaluation"]);
  if (evaluation?.["protected"] === true) {
    out.push(
      ...blockChanges("evaluation", evaluation, plain(now["evaluation"]), (a, b) =>
        evaluationBars(a, b, [was, now]),
      ),
    );
  }

  const provability = provabilityBlock(was["provability"]);
  if (provability?.["protected"] === true) {
    out.push(
      ...blockChanges("provability", provability, provabilityBlock(now["provability"]), (a, b) =>
        provabilityBars(a, b, [was, now]),
      ),
    );
  }

  // A protected block that escalates after the change keeps its escalations.
  const escalating = [
    ...(evaluation?.["protected"] === true && plain(now["evaluation"])?.["on_fail"] === "escalate"
      ? ["evaluation"]
      : []),
    ...(provability?.["protected"] === true &&
    provabilityBlock(now["provability"])?.["on_fail"] === "escalate"
      ? ["provability"]
      : []),
  ];
  const budget = escalationBudgetChange(escalating, was, now);
  if (budget !== undefined) out.push(budget);

  // Judge gates: workflow steps by name and occurrence, graph nodes by key.
  const stepsBefore = Array.isArray(was["steps"]) ? (was["steps"] as unknown[]).map(plain) : [];
  const stepsAfter = Array.isArray(now["steps"]) ? (now["steps"] as unknown[]).map(plain) : [];
  const stepName = (s: Doc | undefined): string | undefined =>
    typeof s?.["name"] === "string" ? (s["name"] as string) : undefined;
  // Each step's identity: its name and occurrence, or its position when unnamed.
  const identities = (steps: ReadonlyArray<Doc | undefined>) => {
    const seen = new Map<string, number>();
    return steps.map((s, i) => {
      const n = stepName(s);
      if (n === undefined) return { occurrence: 0, ident: `@${i}` };
      const occurrence = (seen.get(n) ?? 0) + 1;
      seen.set(n, occurrence);
      return { occurrence, ident: `${n}#${occurrence}` };
    });
  };
  const countOf = (steps: ReadonlyArray<Doc | undefined>, n: string) =>
    steps.filter((s) => stepName(s) === n).length;
  const idsBefore = identities(stepsBefore);
  const idsAfter = identities(stepsAfter);
  for (const [i, step] of stepsBefore.entries()) {
    const judge = plain(step?.["judge"]);
    if (judge?.["protected"] !== true) continue;
    const stepId = stepName(step);
    const occurrence = idsBefore[i]?.occurrence ?? 0;
    let j: number;
    let id: string;
    if (stepId === undefined) {
      j = i;
      id = String(i);
    } else {
      j = -1;
      for (const [k, s] of stepsAfter.entries()) {
        if (stepName(s) === stepId && idsAfter[k]?.occurrence === occurrence) j = k;
      }
      const total = countOf(stepsBefore, stepId);
      id = total > 1 ? `${stepId}#${occurrence}` : stepId;
      // A repeated name pairs only while each document holds it as often.
      if (total !== countOf(stepsAfter, stepId)) j = -1;
    }
    // A pairing holds only while it gates the same step.
    const gatesSame =
      j >= 0 && (i === 0 ? j === 0 : j > 0 && idsBefore[i - 1]?.ident === idsAfter[j - 1]?.ident);
    const match = gatesSame ? stepsAfter[j] : undefined;
    const name = `steps.${id}.judge`;
    out.push(
      ...blockChanges(name, judge, plain(match?.["judge"]), (a, b) =>
        judgeBars(name, a, b, [was, now]),
      ),
    );
  }
  const nodesBefore = plain(was["nodes"]) ?? {};
  const nodesAfter = plain(now["nodes"]) ?? {};
  for (const [id, raw] of Object.entries(nodesBefore)) {
    const judge = plain(plain(raw)?.["judge"]);
    if (judge?.["protected"] !== true) continue;
    const name = `nodes.${id}.judge`;
    out.push(
      ...blockChanges(name, judge, plain(plain(nodesAfter[id])?.["judge"]), (a, b) => [
        ...judgeBars(name, a, b, [was, now]),
        ...judgeWiringChange(name, id, was, now),
      ]),
    );
  }
  return out;
}

/**
 * The first way `after` loosens a bar `before` protects, or `undefined` when
 * none does: the first of {@link protectedBarChanges}.
 */
export function protectedBarChange(
  before: unknown,
  after: unknown,
): ProtectedBarChange | undefined {
  return protectedBarChanges(before, after)[0];
}
