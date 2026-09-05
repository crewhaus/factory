/**
 * Pillar 2 — `spec-patch`. The structured mutation primitive that the
 * active eval optimizer uses to translate "the prompt that scored higher"
 * back into a YAML edit the user can review, commit, and re-run.
 *
 * Why patch the SPEC (not the IR)?
 *
 * The compiler does destructive normalisation in `lower()`: sub-agent
 * maps become arrays, role names get alphabetically sorted, secrets get
 * rewritten to env-var refs via `lowerSecret`, permission rules get
 * de-duped and re-ordered. The IR is intentionally lossy and ordering-
 * canonical because its job is to feed codegen, not round-trip to YAML.
 *
 * A patch at the IR layer therefore can't write back to YAML — there's
 * no path from a frozen sorted array back to the source-author's map
 * with their comments and field ordering. Patching at the SPEC layer
 * (i.e. the YAML AST) keeps the round-trip honest: a `crewhaus optimize
 * --write-back` rewrites the user's file with their comments preserved
 * and only the touched values changed.
 *
 * The `yaml` package's `parseDocument` gives us the CST we need. The
 * Document API has `setIn(path, value)`, `getIn(path)`, `deleteIn(path)`
 * that operate on the live AST; `toString()` renders back with comment
 * and key-order fidelity.
 *
 * IR-passes (in `@crewhaus/ir-passes`) stay what they are — codegen-
 * time optimisations that run AFTER lowering. They don't get conflated
 * with eval-driven mutation. The two systems share nothing; that's
 * intentional.
 *
 * Catalog layer: F2 (compiler periphery). Brief: 278.
 */
import { CrewhausError } from "@crewhaus/errors";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { isSeq, parse, parseDocument } from "yaml";
import { z } from "zod";
import { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "./redact";

// Re-exported so downstream renderers (the CLI changelog, future reporters)
// can apply the SAME redaction to strings the differ never sees (rationales,
// free-form provenance) without duplicating the pattern table a third time.
export { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "./redact";

export class SpecPatchError extends CrewhausError {
  override readonly name = "SpecPatchError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

export type SpecPatchOp = "replace" | "add" | "remove";

/**
 * A structured edit to a spec. `path` is a property-key chain (no array
 * indices today — the spec's mutation surface is all object fields). The
 * `target` discriminator must match the spec being patched; the validator
 * refuses cross-target patches so an optimizer can't pass an `IrCli`
 * patch to a `pipeline` spec.
 */
export type SpecPatch = {
  readonly target: Spec["target"];
  readonly path: ReadonlyArray<string>;
  readonly op: SpecPatchOp;
  /** Required for `"replace"` and `"add"`; ignored for `"remove"`. */
  readonly value?: unknown;
  /**
   * Optional rationale string for audit / write-back commit messages.
   * The optimizer fills this with the mutation kind + observed delta.
   */
  readonly rationale?: string;
};

const specPatchSchema = z.object({
  target: z.string().min(1),
  path: z.array(z.string().min(1)).min(1),
  op: z.enum(["replace", "add", "remove"]),
  value: z.unknown().optional(),
  rationale: z.string().optional(),
});

export type ApplySpecPatchResult = {
  /** The mutated YAML text, with comments and key order preserved. */
  readonly yaml: string;
  /** The re-parsed Spec after the patch. */
  readonly spec: Spec;
};

/**
 * Whether the YAML source TEXTUALLY carries a key at `path`. Patch producers
 * need this to pick `add` vs `replace` correctly: Zod-defaulted fields (e.g.
 * `model_pool.policy`) are always present on the PARSED spec, but `replace`
 * throws when the key is absent from the document and `add` throws when it is
 * present — only the CST knows which applies. Unparseable YAML → false.
 */
export function specHasPath(yamlText: string, path: ReadonlyArray<string>): boolean {
  try {
    return parseDocument(yamlText).hasIn([...path]);
  } catch {
    return false;
  }
}

/**
 * Apply a structured patch to a YAML spec source. Uses the `yaml`
 * package's CST so comments and key order survive the round-trip; the
 * only bytes that change are the ones the patch targets.
 *
 * Validates the resulting document against the Spec schema; throws
 * `SpecPatchError` if the mutation produces invalid spec.
 */
export function applySpecPatch(yamlText: string, patch: SpecPatch): ApplySpecPatchResult {
  const parsed = specPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new SpecPatchError(`patch shape is invalid: ${parsed.error.message}`);
  }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText);
  } catch (err) {
    throw new SpecPatchError("input YAML is not parseable", err);
  }
  // Verify the patch matches the spec's target. Cheap pre-check so we
  // fail with a useful message before the Zod validation later.
  const docTarget = doc.getIn(["target"]);
  if (typeof docTarget === "string" && docTarget !== patch.target) {
    throw new SpecPatchError(
      `patch target "${patch.target}" does not match spec target "${docTarget}"`,
    );
  }

  const path = [...patch.path];
  switch (patch.op) {
    case "replace": {
      if (!doc.hasIn(path)) {
        throw new SpecPatchError(`cannot replace ${formatPath(path)}: path does not exist`);
      }
      doc.setIn(path, patch.value);
      break;
    }
    case "add": {
      if (doc.hasIn(path)) {
        throw new SpecPatchError(
          `cannot add ${formatPath(path)}: path already exists (use "replace")`,
        );
      }
      doc.setIn(path, patch.value);
      break;
    }
    case "remove": {
      if (!doc.hasIn(path)) {
        throw new SpecPatchError(`cannot remove ${formatPath(path)}: path does not exist`);
      }
      doc.deleteIn(path);
      break;
    }
  }

  const newYaml = doc.toString();
  let spec: Spec;
  try {
    spec = parseSpec(newYaml);
  } catch (err) {
    throw new SpecPatchError(`patched YAML failed spec validation: ${(err as Error).message}`, err);
  }
  return { yaml: newYaml, spec };
}

/**
 * Type-check a patch against a parsed Spec WITHOUT applying it. Used
 * by the optimizer to refuse cross-target patches and patches that
 * reference paths outside the optimisation surface.
 *
 * The path-validity check is the "soft" version: it verifies the path
 * is structurally reachable (each segment names a defined field). It
 * does NOT instantiate the patched value — `applySpecPatch` does that
 * via `parseSpec`.
 */
export function validatePatch(spec: Spec, patch: SpecPatch): void {
  const parsed = specPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new SpecPatchError(`patch shape is invalid: ${parsed.error.message}`);
  }
  if (patch.target !== spec.target) {
    throw new SpecPatchError(
      `patch target "${patch.target}" does not match spec target "${spec.target}"`,
    );
  }
  if (!isOptimizable(spec.target, patch.path)) {
    throw new SpecPatchError(
      `path ${formatPath(patch.path)} is not listed in OPTIMIZABLE_PATHS for target "${spec.target}"; add it to packages/spec-patch/src/index.ts if it's intended to be tunable`,
    );
  }
}

function formatPath(path: ReadonlyArray<string>): string {
  return path.join(".");
}

/**
 * Loop contract 0.4 (Batch B, G40) — one edit in an `applySpecEdits` batch.
 *
 * Where `SpecPatch` is the optimizer's IMPERATIVE op (`add` vs `replace` vs
 * `remove`, each with a strict presence pre-check), `SpecEdit` is the
 * DECLARATIVE surface shared by spec authors (the studio's form fields, the
 * compiler-worker) and the optimizer: "make `path` carry `value`" (upsert —
 * creates missing intermediate collections) or, when `value` is `undefined`,
 * "make `path` absent" (idempotent — deleting an already-absent path is a
 * no-op, so a cleared form field never needs to track prior presence).
 *
 * Paths may address sequence items by non-negative integer index (numeric
 * strings work too — the CST coerces them for sequences): `["steps", 0,
 * "instructions"]`. Index `length` appends; anything past that is an error
 * (never null-padding), and a brand-new sequence can only start at index 0.
 */
export type SpecEditPathSegment = string | number;

export type SpecEdit = {
  readonly path: ReadonlyArray<SpecEditPathSegment>;
  /** New value at `path` (upsert). `undefined` — or omitting the key — DELETES the path. */
  readonly value?: unknown;
  /** Optional rationale string for audit / write-back commit messages. */
  readonly rationale?: string;
};

const specEditSchema = z.object({
  path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1),
  value: z.unknown().optional(),
  rationale: z.string().optional(),
});

export type ApplySpecEditsOptions = {
  /**
   * The optimizer surface: every edit path must be admitted by the spec
   * target's `OPTIMIZABLE_PATHS` whitelist through {@link isOptimizable} —
   * exact match (wildcards = one segment each), the structural
   * `model_pool` / `judge` / `sub_agents` / `temperature` rule, then prefix;
   * the same rule as `validatePatch`. Author surfaces leave this off and may
   * edit any field — the atomic `parseSpec` re-validation is their safety floor.
   */
  readonly restrictToOptimizable?: boolean;
};

export type ApplySpecEditsResult = {
  /** The mutated YAML text, with comments and key order preserved. */
  readonly yaml: string;
  /** The re-parsed Spec after the whole batch. */
  readonly spec: Spec;
  /** Edits that changed the document — idempotent deletes of absent paths don't count. */
  readonly applied: number;
};

/**
 * Apply a batch of `SpecEdit`s to a YAML spec source ATOMICALLY: all edits
 * mutate one CST in order, the result is re-validated via `parseSpec` once,
 * and any failure — a malformed edit, an out-of-bounds sequence index, or a
 * batch that produces an invalid spec — throws `SpecPatchError` without
 * yielding a partially-edited text. Comments and key order survive exactly
 * as in `applySpecPatch` (same `yaml`-package CST underneath).
 *
 * A zero-edit batch is a validated no-op: the input text is returned
 * byte-identical (no CST round-trip reformatting).
 */
export function applySpecEdits(
  yamlText: string,
  edits: ReadonlyArray<SpecEdit>,
  opts: ApplySpecEditsOptions = {},
): ApplySpecEditsResult {
  edits.forEach((edit, i) => {
    const parsed = specEditSchema.safeParse(edit);
    if (!parsed.success) {
      throw new SpecPatchError(`edit #${i} shape is invalid: ${parsed.error.message}`);
    }
  });
  if (edits.length === 0) {
    let spec: Spec;
    try {
      spec = parseSpec(yamlText);
    } catch (err) {
      throw new SpecPatchError(`input YAML failed spec validation: ${(err as Error).message}`, err);
    }
    return { yaml: yamlText, spec, applied: 0 };
  }

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText);
  } catch (err) {
    throw new SpecPatchError("input YAML is not parseable", err);
  }
  // `parseDocument` collects syntax errors on `doc.errors` instead of
  // throwing — without this check they'd only surface as the CST's opaque
  // "Document with errors cannot be stringified" at toString() time.
  if (doc.errors.length > 0) {
    throw new SpecPatchError(
      `input YAML is not parseable: ${doc.errors[0]?.message ?? "unknown error"}`,
    );
  }

  if (opts.restrictToOptimizable === true) {
    const docTarget = doc.getIn(["target"]);
    if (typeof docTarget !== "string" || !(docTarget in OPTIMIZABLE_PATHS)) {
      throw new SpecPatchError(
        `cannot restrict to optimizable paths: spec target ${JSON.stringify(docTarget)} is not a known target`,
      );
    }
    edits.forEach((edit, i) => {
      if (!isOptimizable(docTarget as Spec["target"], edit.path)) {
        throw new SpecPatchError(
          `edit #${i}: path ${formatEditPath(edit.path)} is not listed in OPTIMIZABLE_PATHS for target "${docTarget}"; add it to packages/spec-patch/src/index.ts if it's intended to be tunable`,
        );
      }
    });
  }

  let applied = 0;
  edits.forEach((edit, i) => {
    const path = [...edit.path];
    const label = `edit #${i} (${formatEditPath(path)})`;
    if (edit.value === undefined) {
      // Delete-on-undefined. hasIn is false both for an absent leaf and for a
      // scalar intermediate, so the deleteIn below can never hit the CST's
      // "Expected YAML collection" throw — absent paths are a clean no-op.
      if (doc.hasIn(path)) {
        doc.deleteIn(path);
        applied += 1;
      }
      return;
    }
    guardSequenceIndices(doc, path, label);
    try {
      doc.setIn(path, edit.value);
    } catch (err) {
      throw new SpecPatchError(`${label} failed: ${(err as Error).message}`, err);
    }
    applied += 1;
  });

  const newYaml = doc.toString();
  let spec: Spec;
  try {
    spec = parseSpec(newYaml);
  } catch (err) {
    throw new SpecPatchError(`edited YAML failed spec validation: ${(err as Error).message}`, err);
  }
  return { yaml: newYaml, spec, applied };
}

/**
 * Pre-flight for `setIn` along a path that may address sequences: the CST
 * happily null-pads a sequence up to any index (`steps[5]` on a 2-step list
 * yields three `null` steps), which is never what an author or optimizer
 * meant. Reject indices past `length` (index === `length` appends) and
 * refuse to CREATE a sequence anywhere but at index 0. Map keys and the
 * CST's own errors (negative / non-integer index, scalar intermediates)
 * pass through untouched — the caller wraps those with the edit label.
 */
function guardSequenceIndices(
  doc: ReturnType<typeof parseDocument>,
  path: ReadonlyArray<SpecEditPathSegment>,
  label: string,
): void {
  for (let i = 0; i < path.length; i++) {
    const seg = path[i] as SpecEditPathSegment;
    const parent = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
    const asIndex =
      typeof seg === "number" ? seg : /^\d+$/.test(seg) ? Number.parseInt(seg, 10) : undefined;
    if (isSeq(parent)) {
      if (asIndex !== undefined && asIndex > parent.items.length) {
        throw new SpecPatchError(
          `${label}: index ${asIndex} is out of bounds for the sequence at ${
            i === 0 ? "(root)" : formatEditPath(path.slice(0, i))
          } (length ${parent.items.length}; index ${parent.items.length} appends)`,
        );
      }
    } else if (parent === undefined && typeof seg === "number" && seg !== 0) {
      throw new SpecPatchError(
        `${label}: cannot create a new sequence at ${
          i === 0 ? "(root)" : formatEditPath(path.slice(0, i))
        } starting at index ${seg} — a new sequence starts at index 0`,
      );
    }
  }
}

/** Render an edit path for messages: string keys dot-joined, integer
 *  sequence indices as `[i]` — `["steps", 0, "instructions"]` →
 *  `steps[0].instructions`. */
function formatEditPath(path: ReadonlyArray<SpecEditPathSegment>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out === "" ? seg : `.${seg}`;
    }
  }
  return out;
}

/**
 * 0.6.0 (plan §10.3, mechanism 1) — the WILDCARD segment. Inside an
 * `OPTIMIZABLE_PATHS` entry, `"*"` matches EXACTLY ONE key segment of the
 * patched path (a `models:` profile name, a `steps` index, a `nodes` / `roles`
 * name, a `rules` index) — never zero segments, never more than one, never a
 * literal `"*"` key. Two placement rules make the wildcard safe, pinned by
 * {@link wildcardPlacementIssues} (a CI guard, not a load-time throw):
 *
 *   1. a wildcard is never the LAST segment — `["models","*"]` would admit a
 *      whole profile (its `model`, `tools`, `permissions`, …) by prefix;
 *   2. a wildcard never sits ABOVE a human-owned key — the concrete tail after
 *      the last `"*"` must end in a dial, never in one of
 *      {@link WILDCARD_FORBIDDEN_LEAVES} (the identity / security / prompt keys
 *      the §10.3 table excludes) and never in a structural segment.
 */
export const WILDCARD_SEGMENT = "*";

/**
 * Keys a wildcard-bearing entry may never terminate in: the §10.3 exclusions
 * that live UNDER a dynamic key (`models.<name>`, `candidates[i]`,
 * `rules[i]`, `sub_agents.<name>`). A dial entry that ended in one of these
 * would whitelist identity or security surface across every profile at once.
 */
export const WILDCARD_FORBIDDEN_LEAVES: ReadonlyArray<string> = Object.freeze([
  "model",
  "models",
  "tags",
  "tools",
  "tool_config",
  "permissions",
  "rate_limits",
  "cost",
  "requires",
  "capabilities",
  "fallbacks",
  "circuit_breaker",
  "instructions",
  "caching",
  "candidates",
  "when",
  "use",
  "labels",
  "reward",
  "directives",
  "model_directed",
  "allowed_profiles",
  "inherit_routing",
  "budget_share",
  "tool_flags",
  "escalate_to",
  "judges",
  "criteria",
  "on_fail",
  "seed",
]);

/**
 * 0.6.0 §10.3 — the per-profile DIALS: quality/cost knobs with no identity,
 * security or routing meaning, tunable on every `models:` profile of every
 * shape (`models:` is attached to all 14 schemas). `thinking.budget_tokens`
 * follows the standing rule for the agent block — the budget is a dial, the
 * thinking FORM (`effort`) stays human-owned. Every other profile field
 * (`model`, `tags`, `tools`, `tool_config`, `permissions`, `rate_limits`,
 * `cost`, `requires`, `capabilities`, `fallbacks`, `circuit_breaker`,
 * `instructions`, `caching`) is EXCLUDED — see {@link HUMAN_OWNED_PATHS}.
 */
const MODEL_PROFILE_DIALS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze([
  Object.freeze(["models", WILDCARD_SEGMENT, "max_tokens"]),
  Object.freeze(["models", WILDCARD_SEGMENT, "thinking", "budget_tokens"]),
  Object.freeze(["models", WILDCARD_SEGMENT, "temperature"]),
  Object.freeze(["models", WILDCARD_SEGMENT, "limits", "model_call_timeout_ms"]),
]);

/**
 * 0.6.0 §10.3 — the `model_pool` entries for one routed block (`agent`, a
 * `steps[*]` step, a `nodes.*` node, a `roles.*` role). Because the
 * structural rule ({@link STRUCTURAL_SEGMENTS}) admits a `model_pool` path
 * ONLY by exact match, every tunable pool key needs its own entry — nothing
 * under `model_pool` is reached by prefix any more, on any shape:
 *
 *   - `policy` / `routing` / `learning` — the pre-0.6.0 policy knobs
 *     (`routing` and `learning` deliberately WHOLESALE: `advise` mines the
 *     scoreboard into them). On the positional shapes these were reached by
 *     the whole-block `["steps"]` / `["nodes"]` / `["roles"]` prefix until the
 *     structural rule closed prefix reach into `model_pool`; the exact
 *     wildcard entries restore exactly the G37 intent and nothing more.
 *   - `rules[*].enabled` — a switch, not a target (`rules[*].when` / `.use`
 *     / `.id` stay human-owned).
 *   - `strategy.shadow.sample_rate`, `strategy.guide.max_tokens`,
 *     `strategy.max_escalations`, `classifier.max_tokens` — pure cost dials.
 *   - `strategy.cascade.clean_prompt` — a prompt-shape dial (draft kept or
 *     dropped before the escalation re-run).
 *
 * `candidates` (incl. `enabled`), `rules[*].{when,use,id}`,
 * `classifier.{model,labels}`, every `strategy.*` role / model slot,
 * `strategy.model_directed`, `reward.*`, `directives`, `scope` and
 * `objective` are EXCLUDED — see {@link HUMAN_OWNED_PATHS}.
 */
function poolDials(block: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> {
  const pool = [...block, "model_pool"];
  return Object.freeze([
    Object.freeze([...pool, "policy"]),
    Object.freeze([...pool, "routing"]),
    Object.freeze([...pool, "learning"]),
    Object.freeze([...pool, "rules", WILDCARD_SEGMENT, "enabled"]),
    Object.freeze([...pool, "strategy", "shadow", "sample_rate"]),
    Object.freeze([...pool, "strategy", "guide", "max_tokens"]),
    Object.freeze([...pool, "strategy", "max_escalations"]),
    Object.freeze([...pool, "strategy", "cascade", "clean_prompt"]),
    Object.freeze([...pool, "classifier", "max_tokens"]),
  ]);
}

/**
 * 0.6.0 §10.3 — a `kind: judge` gate's dials on a positional block (`steps[*]`
 * / `nodes.*`): `threshold` and `max_retries` mirror the agent-shape
 * `evaluation.threshold` / `evaluation.max_retries` entries (the structural
 * `judge` segment closed their prefix reach; these restore it exactly), and
 * `repeats` mirrors `evaluation.grader.repeats`. `criteria`, `model`,
 * `judges`, `temperature`, `target`, `on_fail` and `escalate_to` are EXCLUDED.
 */
function judgeGateDials(block: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> {
  const judge = [...block, "judge"];
  return Object.freeze([
    Object.freeze([...judge, "threshold"]),
    Object.freeze([...judge, "max_retries"]),
    Object.freeze([...judge, "repeats"]),
  ]);
}

const STEP: ReadonlyArray<string> = Object.freeze(["steps", WILDCARD_SEGMENT]);
const NODE: ReadonlyArray<string> = Object.freeze(["nodes", WILDCARD_SEGMENT]);
const ROLE: ReadonlyArray<string> = Object.freeze(["roles", WILDCARD_SEGMENT]);
const AGENT: ReadonlyArray<string> = Object.freeze(["agent"]);

/**
 * Per-target whitelist of mutation paths the active optimizer is
 * allowed to touch. Adding a new field here is the explicit signal that
 * it's safe to autotune. Skipping this list means the optimizer can
 * only mutate prompts (the default), preserving the "spec safety floor"
 * that an optimizer can't accidentally rewrite security-critical fields
 * like `permissions.mode` or `model_router` rules.
 *
 * "Watch me" (`watchme:` on cli/channel/managed, design/watch-me.md §4.3) —
 * EVERY `watchme.*` path is deliberately EXCLUDED; none may be whitelisted
 * piecemeal later without revisiting that design section:
 *   - `watchme.enabled` / `watchme.capture` — the observer must not be tuned
 *     by the loop it observes (self-referential optimization), and capture
 *     fidelity is a consent/data-plane posture, not a quality dial.
 *   - `watchme.judge.model` — the model roster is never auto-patched (the
 *     standing `agent.model` / model-roster exclusion).
 *   - `watchme.judge.sample_rate` / `watchme.judge.budget_usd` — spend-class
 *     knobs, human-only (sample_rate MULTIPLIES judge calls, so it is a
 *     spend dial wearing a quality dial's clothes).
 *   - `watchme.scope` / `watchme.share` — privacy/trust-boundary switches
 *     (`share` crosses the harness boundary to Thredz).
 * The paired `crewhaus advise` watchme rule is text-only for exactly this
 * reason: there is no whitelisted path for it to patch.
 */
export const OPTIMIZABLE_PATHS: Readonly<
  Record<Spec["target"], ReadonlyArray<ReadonlyArray<string>>>
> = Object.freeze({
  cli: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // Item 14 — `crewhaus advise`'s truncation-pressure rule patches the
    // per-turn output-token cap when max_tokens truncations recur; safe to
    // autotune (a bigger cap can only trade cost for completeness).
    Object.freeze(["agent", "max_tokens"]),
    // Loop contract 0.4 (Batch A) — the explicit thinking-token budget is a
    // pure quality/cost dial (>= 1024 enforced by the spec); the optimizer
    // may raise/lower it but never flips the thinking FORM (effort presets
    // stay human-owned via the exactly-one-form superRefine).
    Object.freeze(["agent", "thinking", "budget_tokens"]),
    Object.freeze(["failure_taxonomy"]),
    // Loop contract 0.4 (Batch A) — real as of the `compaction.threshold`
    // spec field (0.5–0.99): when to trigger autocompaction is a classic
    // token-cost vs context-completeness dial.
    Object.freeze(["compaction", "threshold"]),
    // Pillar 2 active context curation — eval-optimizer can flip the
    // semantic-dedupe + relevance-reorder pass on/off and tune its
    // similarity threshold, which dominates input-token cost on long runs.
    Object.freeze(["compaction", "curate"]),
    Object.freeze(["compaction", "dedupeThreshold"]),
    Object.freeze(["compaction", "relevanceTopK"]),
    // Loop contract 0.4 (Batch A) — tool-iteration ceiling: quality (task
    // completion) vs runaway-cost dial. NOTE ["security","egressPolicy"]
    // was REMOVED here: the spec never grew that key (strict schemas
    // reject it), and the OPTIMIZABLE_PATHS guard test requires every
    // listed path to round-trip through parseSpec. Re-add it WITH the spec
    // field when the egress-fabric FRs ship it.
    Object.freeze(["limits", "max_tool_iterations"]),
    // Pillar 3 intent gate — tunable so the eval-optimizer can find the
    // sweet spot between false-positive denials and false-negative exfil
    // bypasses.
    Object.freeze(["security", "justification"]),
    // §47 blockchain subsystem (slice 0). Whole-block replacement so the
    // optimizer can tune `chains[*].finality.count`, `chains[*].rpcPolicy`,
    // `transaction_policy.maxValueWei`, and `transaction_policy.simulationRequired`
    // by patching their parent block.
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Adaptive model routing — the pool's POLICY knobs are tunable (advise
    // mines the reward scoreboard into these; optimize --from-advice gates
    // them), but deliberately NOT ["agent","model_pool"] wholesale and NOT
    // ["agent","model_pool","candidates"]: the candidate ROSTER is
    // human-owned, mirroring the standing ["agent","model"] exclusion —
    // learning tunes selection within the declared set, never the set.
    // 0.6.0 §10.3 — the exact pool entries (policy/routing/learning plus the
    // hybrid dials); see `poolDials`. `["agent","model_pool","routing"]` and
    // `["agent","model_pool","learning"]` stay WHOLESALE — the plan's
    // `learning.seed` exclusion is therefore not enforced by this table (a
    // narrower entry would break `advise`'s scoreboard mining); it is
    // documented as an accepted gap until the eval runner (PR 12) needs it.
    ...poolDials(AGENT),
    // 0.6.0 §10.3 — `agent.temperature`: a threshold-shaped leaf like the
    // existing params (exclusive with `thinking` on one block — the spec
    // refine rejects a patch that lands both, so the optimizer can move one
    // dial only when the other is absent).
    Object.freeze(["agent", "temperature"]),
    // 0.6.0 §10.3 — per-profile dials on every `models:` profile.
    ...MODEL_PROFILE_DIALS,
    // 0.3.0 memory release (design §7.5, PR 20) — the memory/continuity
    // QUALITY knobs, registered on the five emit-wired memory shapes (cli,
    // channel, managed, research, crew — mirrored below with a pointer to
    // this table). Every one is a scalar that survives lower() 1:1, with its
    // bounds owned by the spec schema (+ the compiler's lower-time floors),
    // so an out-of-bounds patch fails applySpecPatch's re-parse:
    //   memory.recallK               int 1..50 — facts fused into recall
    //   memory.autoCaptureThreshold  int >= 1  — capture sensitivity
    //   memory.ttl                   duration string ("90d"; >= 1h floor) —
    //                                the fact-forgetting horizon
    //   memory.wiki.recallK          int 1..50 — wiki hits fused into recall
    //   memory.dream.budget_usd      number >= 0 — dream model-phase spend
    //                                cap (0 = deterministic only)
    //   continuity.focusMaxChars     int >= 1 (default 4096) — hard cap on
    //                                the volatile tail block (token cost vs
    //                                plan/ledger completeness)
    // Deliberately EXCLUDED — the optimizer tunes quality, never semantics:
    // thredz.* (credentials; thredz.messaging = a destructive send-tool
    // switch), memory.backend (store flip), memory.dream.every + .mode
    // (side-effecting schedule / model-spend switch), continuity
    // .proof/.scope/.enabled (behavioral switches), compaction
    // .preserve_user_messages (safety), learning.sources (allowlist =
    // security). Batch G adds more of the same category: expose.* (G30 — the
    // deployment/exposure surface, not a quality knob), plugins (G32 — a
    // capability allowlist = supply-chain security, human-owned like
    // learning.sources / the model roster), and sub_agents.*.federation (G31
    // — cross-deployment wiring / trust boundary). None are optimizer-reachable.
    Object.freeze(["memory", "recallK"]),
    Object.freeze(["memory", "autoCaptureThreshold"]),
    Object.freeze(["memory", "ttl"]),
    Object.freeze(["memory", "wiki", "recallK"]),
    Object.freeze(["memory", "dream", "budget_usd"]),
    Object.freeze(["continuity", "focusMaxChars"]),
    // Loop contract 0.4 (Batch B, G40) — the in-loop evaluation dials. The
    // pass bar (llm_judge graders only — the spec rejects threshold on
    // deterministic graders, so a mis-aimed patch fails the re-parse) and
    // the retry cap are classic quality-vs-cost knobs. Deliberately NOT
    // ["evaluation"] wholesale and NOT ["evaluation","grader"]: the grader
    // (criteria/type) and on_fail behaviour are human-owned semantics —
    // the optimizer tunes how strict the gate is, never what it judges.
    Object.freeze(["evaluation", "threshold"]),
    Object.freeze(["evaluation", "max_retries"]),
    // 0.6.0 §10.3 — `evaluation.grader.repeats`: a measurement dial (verdicts
    // per judge, folded by median). `judges`, `temperature`, `target`,
    // `criteria`, `model` and `on_fail` / `allow_self_judge` stay human-owned.
    Object.freeze(["evaluation", "grader", "repeats"]),
    // Loop contract 0.4 (Batch E) — the agent-shape RAG (`knowledge:`) dials
    // + the per-turn recall cadence. All scalars that survive lower() 1:1
    // with their bounds owned by the spec schema, so an out-of-bounds patch
    // fails applySpecPatch's re-parse. `default_k` (hits/turn) and the chunker
    // window are classic recall-quality vs token-cost dials; `refreshEvery`
    // trades recall freshness against per-turn recall cost. Deliberately NOT
    // ["knowledge"] wholesale and NOT ["knowledge","sources"]: the corpus
    // (an allowlist of what the agent may read) is human-owned, mirroring the
    // learning.sources / model-roster exclusions.
    Object.freeze(["knowledge", "default_k"]),
    Object.freeze(["knowledge", "chunk", "size"]),
    Object.freeze(["knowledge", "chunk", "overlap"]),
    Object.freeze(["memory", "refreshEvery"]),
  ]),
  workflow: Object.freeze([
    // Whole-step replacement — this ALSO reaches item 9's (G37) per-step
    // model routing (model_pool policy/routing/learning, tiers, fallbacks):
    // no narrower entry is possible (the roster/step index is positional) and
    // whole-step replacement already spans model/instructions, so the policy
    // knobs ride here rather than as standalone paths.
    Object.freeze(["steps"]),
    // 0.6.0 §10.3 — the structural rule closed prefix reach into a step's
    // `model_pool` / `judge` / `temperature`; these exact wildcard entries
    // (`*` = one step index) are the dials the table promises per step.
    ...poolDials(STEP),
    ...judgeGateDials(STEP),
    Object.freeze([...STEP, "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Loop contract 0.4 (Batch A) — see the cli entry.
    Object.freeze(["limits", "max_tool_iterations"]),
  ]) /* whole-step replacement allowed */,
  channel: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // Loop contract 0.4 (Batch A) — see the cli entries.
    Object.freeze(["agent", "thinking", "budget_tokens"]),
    Object.freeze(["limits", "max_tool_iterations"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Adaptive model routing + 0.6.0 hybrid dials — see the cli entry.
    ...poolDials(AGENT),
    Object.freeze(["agent", "temperature"]),
    ...MODEL_PROFILE_DIALS,
    // 0.3.0 memory/continuity quality knobs — types/bounds at the cli entry.
    Object.freeze(["memory", "recallK"]),
    Object.freeze(["memory", "autoCaptureThreshold"]),
    Object.freeze(["memory", "ttl"]),
    Object.freeze(["memory", "wiki", "recallK"]),
    Object.freeze(["memory", "dream", "budget_usd"]),
    Object.freeze(["continuity", "focusMaxChars"]),
    // Loop contract 0.4 (Batch B, G40) — evaluation dials; see the cli entry.
    Object.freeze(["evaluation", "threshold"]),
    Object.freeze(["evaluation", "max_retries"]),
    Object.freeze(["evaluation", "grader", "repeats"]),
    // Loop contract 0.4 (Batch E) — knowledge/recall dials; see the cli entry.
    Object.freeze(["knowledge", "default_k"]),
    Object.freeze(["knowledge", "chunk", "size"]),
    Object.freeze(["knowledge", "chunk", "overlap"]),
    Object.freeze(["memory", "refreshEvery"]),
  ]),
  graph: Object.freeze([
    Object.freeze(["nodes"]),
    // 0.6.0 §10.3 — per-node dials (`*` = one node name); see the workflow entry.
    ...poolDials(NODE),
    ...judgeGateDials(NODE),
    Object.freeze([...NODE, "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Loop contract 0.4 (Batch A) — see the cli entry.
    Object.freeze(["limits", "max_tool_iterations"]),
  ]),
  managed: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // Loop contract 0.4 (Batch A) — see the cli entries.
    Object.freeze(["agent", "thinking", "budget_tokens"]),
    Object.freeze(["limits", "max_tool_iterations"]),
    Object.freeze(["failure_taxonomy"]),
    // Adaptive model routing + 0.6.0 hybrid dials — see the cli entry.
    ...poolDials(AGENT),
    Object.freeze(["agent", "temperature"]),
    ...MODEL_PROFILE_DIALS,
    // 0.3.0 memory/continuity quality knobs — types/bounds at the cli entry.
    Object.freeze(["memory", "recallK"]),
    Object.freeze(["memory", "autoCaptureThreshold"]),
    Object.freeze(["memory", "ttl"]),
    Object.freeze(["memory", "wiki", "recallK"]),
    Object.freeze(["memory", "dream", "budget_usd"]),
    Object.freeze(["continuity", "focusMaxChars"]),
    // Loop contract 0.4 (Batch B, G40) — evaluation dials; see the cli entry.
    Object.freeze(["evaluation", "threshold"]),
    Object.freeze(["evaluation", "max_retries"]),
    Object.freeze(["evaluation", "grader", "repeats"]),
    // Loop contract 0.4 (Batch E) — knowledge/recall dials; see the cli entry.
    Object.freeze(["knowledge", "default_k"]),
    Object.freeze(["knowledge", "chunk", "size"]),
    Object.freeze(["knowledge", "chunk", "overlap"]),
    Object.freeze(["memory", "refreshEvery"]),
  ]),
  pipeline: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — the pipeline agent carries a `model_pool` and a
    // `temperature` (params/overlay only per §11.3): the same policy knobs
    // and dials as the cli agent.
    ...poolDials(AGENT),
    Object.freeze(["agent", "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["indexing", "chunkSize"]),
    Object.freeze(["indexing", "chunkOverlap"]),
    Object.freeze(["retrieve", "defaultK"]),
  ]),
  crew: Object.freeze([
    // Whole-role replacement — this ALSO reaches item 9's (G37) per-role
    // model routing (model_pool policy/routing/learning, tiers, fallbacks):
    // the role name is a dynamic map key, so no static narrower path exists,
    // and whole-role replacement already spans model/instructions, so the
    // policy knobs ride here rather than as standalone paths.
    Object.freeze(["roles"]),
    // 0.6.0 §10.3 — per-role dials (`*` = one role name); see the workflow entry.
    ...poolDials(ROLE),
    Object.freeze([...ROLE, "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Loop contract 0.4 (Batch A) — see the cli entry.
    Object.freeze(["limits", "max_tool_iterations"]),
    // 0.3.0 memory/continuity quality knobs — types/bounds at the cli entry.
    Object.freeze(["memory", "recallK"]),
    Object.freeze(["memory", "autoCaptureThreshold"]),
    Object.freeze(["memory", "ttl"]),
    Object.freeze(["memory", "wiki", "recallK"]),
    Object.freeze(["memory", "dream", "budget_usd"]),
    Object.freeze(["continuity", "focusMaxChars"]),
    // Loop contract 0.4 (Batch E) — per-turn recall cadence; see the cli entry.
    Object.freeze(["memory", "refreshEvery"]),
  ]) /* whole-role replacement */,
  research: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — the pooled single-agent shapes (research, batch, browser)
    // carry `agent.model_pool` + `agent.temperature`: same dials as cli.
    ...poolDials(AGENT),
    Object.freeze(["agent", "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    // NOTE ["retrieve","maxDepth"] was REMOVED here (Batch A): the research
    // retrieve block never grew a maxDepth field (strict schema rejects
    // it), and the OPTIMIZABLE_PATHS guard test requires every listed path
    // to round-trip through parseSpec. Re-add it WITH the spec field.
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Loop contract 0.4 (Batch A) — see the cli entry.
    Object.freeze(["limits", "max_tool_iterations"]),
    // 0.3.0 memory/continuity quality knobs — types/bounds at the cli entry.
    Object.freeze(["memory", "recallK"]),
    Object.freeze(["memory", "autoCaptureThreshold"]),
    Object.freeze(["memory", "ttl"]),
    Object.freeze(["memory", "wiki", "recallK"]),
    Object.freeze(["memory", "dream", "budget_usd"]),
    Object.freeze(["continuity", "focusMaxChars"]),
    // Loop contract 0.4 (Batch E) — per-turn recall cadence; see the cli entry.
    Object.freeze(["memory", "refreshEvery"]),
  ]),
  batch: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — see the research entry.
    ...poolDials(AGENT),
    Object.freeze(["agent", "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
    // Loop contract 0.4 (Batch A) — see the cli entry.
    Object.freeze(["limits", "max_tool_iterations"]),
  ]),
  voice: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — `models:` is attached to every shape; the profile dials
    // are the only 0.6.0 entries here (voice has no pool and no temperature).
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
  ]),
  browser: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — see the research entry.
    ...poolDials(AGENT),
    Object.freeze(["agent", "temperature"]),
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    // Loop contract 0.4 (Batch A) — see the cli entry.
    Object.freeze(["limits", "max_tool_iterations"]),
  ]),
  eval: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — profile dials only (see the voice entry).
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
  ]),
  // §47 onchain daemon: full cross-cutting blocks are optimizable.
  onchain: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — profile dials only (see the voice entry).
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["triggers"]),
    Object.freeze(["transaction_policy"]),
    Object.freeze(["idempotencyWindowMs"]),
  ]),
  // §47 onchain-game: instructions, game.objective, and the policy are
  // the productive knobs; move-timeout-ms is the realtime quality knob.
  "onchain-game": Object.freeze([
    Object.freeze(["agent", "instructions"]),
    // 0.6.0 §10.3 — profile dials only (see the voice entry).
    ...MODEL_PROFILE_DIALS,
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["game"]),
    Object.freeze(["transaction_policy"]),
  ]),
});

/**
 * 0.6.0 (plan §10.3, mechanism 2) — the STRUCTURAL rule: a path that passes
 * through any of these segments is optimizable only by EXACT match against a
 * listed entry, never by prefix. The whole-block entries `["steps"]`,
 * `["nodes"]` and `["roles"]` exist because the step index / node name / role
 * name is positional, and whole-block replacement was meant to span
 * `model`/`instructions` — not the human-owned structure that now hangs off
 * every routed block:
 *
 *   - `model_pool` — the candidate ROSTER (mirroring the standing
 *     `["agent","model"]` exclusion), and from 0.6.0 the hybrid container:
 *     `rules.*.use` (rule targets), `strategy.*` role slots and
 *     `model_directed` (registers the `Escalate`/`Consult` tool surface),
 *     `reward.*` (the floor), `directives` (admits user-directed input),
 *     `classifier.{model,labels}` (judge identity), `scope`. The plan's
 *     verdict table classifies every one of these as excluded.
 *   - `judge` — a `kind: judge` gate's `escalate_to` (a routing target),
 *     `judges` (judge identity), `temperature`/`target`.
 *   - `sub_agents` — a sub-agent definition is a tool-surface / identity block
 *     (`tools`, `permissions`, `model`, `inherit_bypass`, and from 0.6.0
 *     `allowed_profiles`, `budget_share`, `inherit_routing`, its own routing).
 *   - `temperature` — a quality dial the plan lists as optimizable, but ONLY
 *     via the exact entries (`["agent","temperature"]`, the per-step / node /
 *     role wildcard entries, `models.*.temperature`): every OTHER
 *     `temperature` leaf — a candidate's, a sub-agent's, a judge's pinned
 *     sampling temperature — is human-owned, and a prefix-reached patch
 *     would land on one of those.
 *
 * One rule, no negative-list semantics: the exact entries
 * `["agent","model_pool",{policy,routing,learning}]` keep working, and a
 * whole-block `["steps"]` replacement (whose PATH carries none of these
 * segments) is unchanged. The wildcard segment ({@link WILDCARD_SEGMENT}) and
 * the exact entries the §10.3 table promises (`poolDials`, `judgeGateDials`,
 * `MODEL_PROFILE_DIALS`) ride on top of this rule — it is what makes that
 * table true for the positional shapes. Note the reconciliation the exact
 * match performs: `["agent","temperature"]` IS listed, so the structural
 * `temperature` segment blocks only the prefix route, never the entry.
 */
export const STRUCTURAL_SEGMENTS: ReadonlyArray<string> = Object.freeze([
  "model_pool",
  "judge",
  "sub_agents",
  "temperature",
]);

/**
 * 0.6.0 §10.3 — the EXCLUDED half of the verdict table, stated in code rather
 * than left to the whitelist's default-deny (the 0.3.0 discipline). Each row
 * is a segment pattern matched as a CONTIGUOUS sub-sequence ANYWHERE in a leaf
 * path (`"*"` = any one segment), so one row covers the same key on every
 * host: `["model_pool","rules","*","use"]` excludes `agent.model_pool.rules[i].use`
 * on cli and `steps[i].model_pool.rules[j].use` on workflow alike. A row that
 * names a block (`["model_pool","candidates"]`) excludes every leaf under it.
 *
 * This table is NOT consulted by {@link isOptimizable} — the whitelist is the
 * only admission rule, and anything it does not list is refused. The rows
 * exist so the table's closing invariant can be TESTED: every leaf the
 * 0.6.0 spec delta introduced (enumerated from the zod schema) must be
 * classified exactly once — matched by the whitelist XOR by a row here — and
 * the test fails on a leaf that is unclassified or claimed twice, so this
 * table, the whitelist and the schema cannot drift apart. The Hangar spec
 * editor and `crewhaus advise` read the reasons.
 */
export const HUMAN_OWNED_PATHS: ReadonlyArray<{
  readonly pattern: ReadonlyArray<string>;
  readonly reason: string;
}> = Object.freeze([
  // -- the roster (already excluded today; the 0.6.0 per-candidate fields
  //    ride inside it, including `enabled`) --
  {
    pattern: ["agent", "model"],
    reason: "the model roster is human-owned (the standing agent.model exclusion)",
  },
  {
    pattern: ["model_pool", "candidates"],
    reason:
      "the candidate roster — every inline profile field and `enabled` included — is human-owned; learning tunes selection within the declared set, never the set",
  },
  {
    pattern: ["model_pool", "objective"],
    reason:
      "the reward weights decide the quality/cost/latency trade-off the learner optimises — a spend policy, not a dial (sibling of reward)",
  },
  // -- models.<name>: identity, security surface, routing semantics, prompt --
  {
    pattern: ["models", "*", "model"],
    reason: "a profile's model is identity — the roster is never auto-patched",
  },
  {
    pattern: ["models", "*", "tags"],
    reason: "tags decide what `strong` means: the default floor arm and the target of `strongest`",
  },
  {
    pattern: ["models", "*", "tools"],
    reason: "a profile's toolset is tool surface — security, not quality",
  },
  { pattern: ["models", "*", "tool_config"], reason: "tool config decides what tools may reach" },
  {
    pattern: ["models", "*", "permissions"],
    reason:
      "permissions are the security floor; a profile may only narrow them, and only a human decides how",
  },
  {
    pattern: ["models", "*", "rate_limits"],
    reason: "rate limits are a spend / abuse control, never a quality dial",
  },
  { pattern: ["models", "*", "cost"], reason: "a per-profile spend cap is human-owned policy" },
  {
    pattern: ["models", "*", "requires"],
    reason: "capability requirements are routing semantics (N1 eligibility)",
  },
  {
    pattern: ["models", "*", "capabilities"],
    reason: "a declared capability override is a fact about a model, not a dial",
  },
  {
    pattern: ["models", "*", "fallbacks"],
    reason: "the failover chain decides which provider answers when the first is down",
  },
  {
    pattern: ["models", "*", "circuit_breaker"],
    reason: "the breaker decides when an arm is withdrawn from service",
  },
  {
    pattern: ["models", "*", "instructions"],
    reason:
      "prompt text stays human-owned like evaluation.grader — an accepted inconsistency with agent.instructions, documented rather than widened",
  },
  {
    pattern: ["models", "*", "caching"],
    reason: "cache posture is a cost/latency contract with the provider, classified explicitly",
  },
  {
    pattern: ["models", "*", "thinking", "effort"],
    reason:
      "the thinking FORM stays human-owned (only the explicit budget is a dial — the standing agent.thinking rule)",
  },
  // -- model_pool: rule targets, judge identity, the floor, the two switches
  //    that admit model- or user-directed input --
  { pattern: ["model_pool", "rules", "*", "id"], reason: "a rule id is persisted identity" },
  {
    pattern: ["model_pool", "rules", "*", "when"],
    reason:
      "a rule's condition decides which turns leave the cheap lane — a routing target, human-owned",
  },
  {
    pattern: ["model_pool", "rules", "*", "use"],
    reason: "a rule's target names which arm serves — the roster decision, human-owned",
  },
  { pattern: ["model_pool", "classifier", "model"], reason: "judge identity" },
  {
    pattern: ["model_pool", "classifier", "labels"],
    reason: "the label text is the classifier's prompt and its verdict vocabulary",
  },
  {
    pattern: ["model_pool", "strategy", "cascade", "draft"],
    reason: "a strategy role slot names a roster member",
  },
  {
    pattern: ["model_pool", "strategy", "cascade", "escalate_to"],
    reason: "a strategy role slot names a roster member",
  },
  { pattern: ["model_pool", "strategy", "guide", "model"], reason: "a strategy model slot" },
  {
    pattern: ["model_pool", "strategy", "guide", "every"],
    reason: "guide cadence decides a transcript-cache rewrite per turn — classified explicitly",
  },
  {
    pattern: ["model_pool", "strategy", "guide", "budget_usd"],
    reason: "a spend cap is human-owned policy",
  },
  {
    pattern: ["model_pool", "strategy", "shadow", "candidate"],
    reason: "the audition candidate is a roster decision",
  },
  { pattern: ["model_pool", "strategy", "shadow", "grade_with"], reason: "judge identity" },
  {
    pattern: ["model_pool", "strategy", "committee"],
    reason: "committee membership, its judge and its tie-breaker are roster and judge identity",
  },
  {
    pattern: ["model_pool", "strategy", "model_directed"],
    reason:
      "registers the Escalate / Consult tools — a tool-surface decision that admits model-directed input",
  },
  {
    pattern: ["model_pool", "reward"],
    reason:
      "the reward block (quality source, priors, the floor, reset) bounds what the learner may exploit — never tuned by the loop it bounds",
  },
  {
    pattern: ["model_pool", "directives"],
    reason: "admits user-directed per-message steering — a trust-boundary switch",
  },
  {
    pattern: ["model_pool", "scope"],
    reason: "the scoped routeKey prefix is arm identity (stamped by the compiler)",
  },
  // -- evaluation / judge gates: what is judged and by whom --
  {
    pattern: ["evaluation", "grader", "type"],
    reason:
      "the grader kind is human-owned semantics (the optimizer tunes how strict the gate is, never what it judges)",
  },
  { pattern: ["evaluation", "grader", "criteria"], reason: "prompt text — what the judge judges" },
  {
    pattern: ["evaluation", "grader", "value"],
    reason: "a deterministic grader's match rule is what it judges",
  },
  { pattern: ["evaluation", "grader", "model"], reason: "judge identity" },
  { pattern: ["evaluation", "grader", "judges"], reason: "judge identity (the panel)" },
  {
    pattern: ["evaluation", "grader", "temperature"],
    reason: "the judge's pinned sampling temperature is measurement integrity, not a quality dial",
  },
  {
    pattern: ["evaluation", "grader", "target"],
    reason: "what the judge grades (output vs trajectory) is measurement semantics",
  },
  {
    pattern: ["evaluation", "on_fail"],
    reason: "the below-threshold behaviour (incl. escalate) is human-owned semantics",
  },
  {
    pattern: ["evaluation", "allow_self_judge"],
    reason: "a measurement-integrity waiver, never a knob",
  },
  { pattern: ["judge", "criteria"], reason: "prompt text — what the gate judges" },
  { pattern: ["judge", "model"], reason: "judge identity" },
  { pattern: ["judge", "judges"], reason: "judge identity (the panel)" },
  {
    pattern: ["judge", "temperature"],
    reason: "the judge's pinned sampling temperature is measurement integrity",
  },
  { pattern: ["judge", "target"], reason: "what the gate grades is measurement semantics" },
  {
    pattern: ["judge", "on_fail"],
    reason: "the below-threshold behaviour is human-owned semantics",
  },
  {
    pattern: ["judge", "escalate_to"],
    reason: "the re-run's forced arm is a roster decision",
  },
  // -- budget: spend policy, whole block --
  { pattern: ["budget", "usd"], reason: "the run cap is human-owned spend policy" },
  { pattern: ["budget", "judge_share"], reason: "a spend split is human-owned policy" },
  {
    pattern: ["budget", "scope"],
    reason: "run vs session bounds a cap's blast radius — an operator's call",
  },
  {
    pattern: ["budget", "on_exceed"],
    reason: "what happens at the cap (stop / degrade to a model) is roster and spend policy",
  },
  // -- sub-agents: a tool-surface / identity block, wholesale --
  {
    pattern: ["sub_agents"],
    reason:
      "a sub-agent definition is tool surface, identity and (0.6.0) its own routing, budget share, inheritance and profile allowlist — human-owned wholesale",
  },
  // -- MCP trust flags, crew router model --
  {
    pattern: ["tool_flags"],
    reason: "MCP trust flags narrow a tool's trust posture — security surface",
  },
  {
    pattern: ["routing", "model"],
    reason: "the crew llm router's model is a roster decision",
  },
  // -- observability.slo: production alerting and mitigation thresholds --
  {
    pattern: ["observability", "slo"],
    reason:
      "an SLO threshold decides when production is alerted, paused or rolled back — an operator's call, never an eval loop's (the routing rates added in 0.6.0 follow the existing keys)",
  },
]);

/** A leaf path is human-owned when some {@link HUMAN_OWNED_PATHS} row matches it. */
export function humanOwnedReason(path: ReadonlyArray<SpecEditPathSegment>): string | undefined {
  for (const row of HUMAN_OWNED_PATHS) {
    if (containsPattern(path, row.pattern)) return row.reason;
  }
  return undefined;
}

/** One segment of a pattern against one segment of a path (`"*"` matches any one segment). */
function segmentMatches(pattern: string, actual: SpecEditPathSegment): boolean {
  return pattern === WILDCARD_SEGMENT || pattern === String(actual);
}

/** `pattern` appears as a contiguous sub-sequence of `path` (wildcards honoured). */
function containsPattern(
  path: ReadonlyArray<SpecEditPathSegment>,
  pattern: ReadonlyArray<string>,
): boolean {
  if (pattern.length === 0 || pattern.length > path.length) return false;
  outer: for (let start = 0; start + pattern.length <= path.length; start++) {
    for (let i = 0; i < pattern.length; i++) {
      if (!segmentMatches(pattern[i] as string, path[start + i] as SpecEditPathSegment)) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** `entry` matches the first `entry.length` segments of `path` (wildcards honoured). */
function entryIsPrefixOf(
  entry: ReadonlyArray<string>,
  path: ReadonlyArray<SpecEditPathSegment>,
): boolean {
  if (path.length < entry.length) return false;
  for (let i = 0; i < entry.length; i++) {
    if (!segmentMatches(entry[i] as string, path[i] as SpecEditPathSegment)) return false;
  }
  return true;
}

/**
 * The wildcard placement guard (plan §10.3, mechanism 1): every issue is a
 * whitelist entry that would let `"*"` sit above a human-owned key. Returns
 * `[]` for the shipped table — pinned by the spec-patch tests, so a future
 * entry that breaks the rule fails CI rather than widening the surface.
 */
export function wildcardPlacementIssues(
  table: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = OPTIMIZABLE_PATHS,
): string[] {
  const issues: string[] = [];
  for (const [target, entries] of Object.entries(table)) {
    for (const entry of entries) {
      const stars = entry.filter((seg) => seg === WILDCARD_SEGMENT).length;
      if (stars === 0) continue;
      const label = `${target}: [${entry.join(", ")}]`;
      const last = entry[entry.length - 1] as string;
      if (last === WILDCARD_SEGMENT) {
        issues.push(
          `${label} ends in a wildcard — it would admit a whole dynamic subtree by prefix`,
        );
        continue;
      }
      if (WILDCARD_FORBIDDEN_LEAVES.includes(last)) {
        issues.push(
          `${label} terminates in the human-owned key "${last}" under a wildcard — the §10.3 table excludes it`,
        );
      }
      // `temperature` is the one structural segment that is a scalar LEAF (it
      // is structural to block the prefix route, not because it is a block),
      // so a wildcard entry may terminate in it; the block segments may not.
      if (STRUCTURAL_SEGMENTS.includes(last) && last !== "temperature") {
        issues.push(
          `${label} terminates in the structural block "${last}" under a wildcard — a structural block is never whitelisted wholesale`,
        );
      }
      if (entry.length < 3) {
        issues.push(
          `${label} is too short to name a dial — a wildcard entry needs a concrete parent AND a concrete leaf`,
        );
      }
    }
  }
  return issues;
}

/**
 * The single admission rule behind `validatePatch`, `applySpecEdits({
 * restrictToOptimizable })`, the Hangar spec editor's trust badge, the
 * feedback / watch-me advice tiers and the orchestrator's stage guard:
 *
 *   1. an EXACT match against a listed entry admits the path (wildcards
 *      match one segment each);
 *   2. a path through a STRUCTURAL segment ({@link STRUCTURAL_SEGMENTS}) is
 *      admitted by exact match ONLY — never by prefix;
 *   3. otherwise a listed entry that is a PREFIX of the path admits it
 *      (`["nodes","0","instructions"]` under `["nodes"]`), so the optimizer
 *      can make fine-grained updates without listing every sub-path.
 *
 * Exported so every consumer shares one matcher — a hand-rolled prefix copy
 * would neither honour the wildcard nor close the structural leak.
 */
export function isOptimizable(
  target: Spec["target"],
  path: ReadonlyArray<SpecEditPathSegment>,
): boolean {
  const allowed = OPTIMIZABLE_PATHS[target];
  if (allowed === undefined || path.length === 0) return false;
  for (const ok of allowed) {
    if (ok.length === path.length && entryIsPrefixOf(ok, path)) return true;
  }
  // The structural rule (see STRUCTURAL_SEGMENTS): past this point only a
  // PREFIX match can admit the path, and a path through a human-owned
  // structural block is never admitted by prefix.
  if (path.some((seg) => typeof seg === "string" && STRUCTURAL_SEGMENTS.includes(seg))) {
    return false;
  }
  for (const ok of allowed) {
    if (entryIsPrefixOf(ok, path)) return true;
  }
  return false;
}

/**
 * Format a YAML header comment to prepend to a written-back file. The
 * orchestrator's `--write-back` writes this above the original spec so
 * a human reviewer can see when and by what an optimisation pass ran.
 */
export function formatWriteBackHeader(opts: {
  readonly runId: string;
  readonly mutator: string;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
  readonly iterations: number;
  readonly timestamp?: string;
}): string {
  const ts = opts.timestamp ?? new Date().toISOString();
  const delta = (opts.scoreAfter - opts.scoreBefore).toFixed(3);
  return [
    `# crewhaus optimize: runId ${opts.runId}`,
    `# - mutator: ${opts.mutator}`,
    `# - iterations: ${opts.iterations}`,
    `# - score: ${opts.scoreBefore.toFixed(3)} → ${opts.scoreAfter.toFixed(3)} (Δ ${delta})`,
    `# - generated: ${ts}`,
    "",
  ].join("\n");
}

/**
 * Item 46 — the fields `formatWriteBackHeader` stamped into a written-back
 * spec's leading comment block, recovered by `parseWriteBackHeader`. Only
 * `runId` is guaranteed (it lives on the stamp's first line); the rest are
 * best-effort so a hand-trimmed header still yields its surviving fields.
 */
export type WriteBackHeaderInfo = {
  readonly runId: string;
  readonly mutator?: string;
  readonly iterations?: number;
  readonly scoreBefore?: number;
  readonly scoreAfter?: number;
  readonly generated?: string;
};

/**
 * Inverse of `formatWriteBackHeader`: scan the LEADING comment block of a
 * YAML text for the optimize write-back stamp and return its fields, or
 * `undefined` when the text was never written back. Only the leading block
 * is scanned — a `# crewhaus optimize:` line further down (e.g. quoted
 * inside an instructions prompt) is document content, not a header.
 */
export function parseWriteBackHeader(yamlText: string): WriteBackHeaderInfo | undefined {
  let runId: string | undefined;
  let mutator: string | undefined;
  let iterations: number | undefined;
  let scoreBefore: number | undefined;
  let scoreAfter: number | undefined;
  let generated: string | undefined;
  for (const rawLine of yamlText.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (!line.startsWith("#")) break; // end of the leading comment block
    const stamp = /^# crewhaus optimize: runId (\S+)$/.exec(line);
    if (stamp?.[1] !== undefined) {
      runId = stamp[1];
      continue;
    }
    // Field lines only count once the stamp line has been seen, so ordinary
    // leading comments (`# - mutator: ...` in a user's own notes) don't
    // masquerade as header fields.
    if (runId === undefined) continue;
    const field = /^# - ([a-z]+): (.*)$/.exec(line);
    if (field?.[1] === undefined || field[2] === undefined) continue;
    const value = field[2].trim();
    if (field[1] === "mutator") {
      mutator = value;
    } else if (field[1] === "iterations") {
      const n = Number.parseInt(value, 10);
      if (!Number.isNaN(n)) iterations = n;
    } else if (field[1] === "score") {
      const scores = /^([0-9.eE+-]+) → ([0-9.eE+-]+)/.exec(value);
      const before = scores?.[1] !== undefined ? Number.parseFloat(scores[1]) : Number.NaN;
      const after = scores?.[2] !== undefined ? Number.parseFloat(scores[2]) : Number.NaN;
      if (!Number.isNaN(before)) scoreBefore = before;
      if (!Number.isNaN(after)) scoreAfter = after;
    } else if (field[1] === "generated") {
      generated = value;
    }
  }
  if (runId === undefined) return undefined;
  return {
    runId,
    ...(mutator !== undefined ? { mutator } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(scoreBefore !== undefined ? { scoreBefore } : {}),
    ...(scoreAfter !== undefined ? { scoreAfter } : {}),
    ...(generated !== undefined ? { generated } : {}),
  };
}

/**
 * Item 46 — one field-level difference between two spec versions (see
 * `diffSpecYaml`). `path` is dot-joined property keys with array indices
 * rendered as `[i]` (e.g. `steps[2].prompt`). `before`/`after` carry the
 * FORMATTED (truncated, credential-REDACTED — see `renderDiffValue`) values,
 * ready for a changelog line — the differ is a reporting primitive, not a
 * patch source.
 */
export type SpecDiffEntry = {
  readonly kind: "added" | "removed" | "changed";
  readonly path: string;
  /** Formatted old value — absent for `"added"`. */
  readonly before?: string;
  /** Formatted new value — absent for `"removed"`. */
  readonly after?: string;
};

/** Diff values longer than this render truncated with a trailing ellipsis. */
export const DIFF_VALUE_MAX_LENGTH = 72;

/**
 * Render a value for a diff line: scalars as JSON (strings quoted), maps and
 * sequences as compact JSON, truncated to `maxLength` with an ellipsis so a
 * multi-paragraph instructions prompt doesn't flood the changelog. Pure
 * formatting — credential redaction happens upstream in `renderDiffValue`,
 * which is what the differ itself calls.
 */
export function formatDiffValue(value: unknown, maxLength: number = DIFF_VALUE_MAX_LENGTH): string {
  const rendered = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
  if (rendered.length <= maxLength) return rendered;
  return `${rendered.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * Item 46 — structural (field-level) diff between two YAML documents.
 * Parses both texts and walks the value trees: maps diff by key, sequences
 * by index, everything else is a leaf compared by value. Comments and
 * formatting are invisible here BY DESIGN — two texts that parse to the
 * same values produce an empty diff. Throws `SpecPatchError` when either
 * text is unparseable.
 */
export function diffSpecYaml(beforeYaml: string, afterYaml: string): ReadonlyArray<SpecDiffEntry> {
  let before: unknown;
  let after: unknown;
  try {
    before = parse(beforeYaml);
  } catch (err) {
    throw new SpecPatchError("diff: previous YAML is not parseable", err);
  }
  try {
    after = parse(afterYaml);
  } catch (err) {
    throw new SpecPatchError("diff: new YAML is not parseable", err);
  }
  const out: SpecDiffEntry[] = [];
  walkDiff(before, after, "", out, []);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function leafEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Adversarial-review F1 — render a diff value with credentials removed.
 * `diffSpecYaml`'s output lands verbatim in `.crewhaus/specs/<name>/
 * CHANGELOG.md` on every compile and echoes through `crewhaus spec log`, so
 * the redaction has to happen HERE in the differ, for every consumer:
 *
 *   - a value under a credential-carrying key — final or parent segment
 *     (`agent.api_key`, `mcp_servers.*.env.TOKEN`, sse `headers.*`) —
 *     renders as `[redacted]`, never the value;
 *   - every other value has nested credential keys redacted and
 *     credential-shaped tokens masked out of its strings (an `sk-…` pasted
 *     into `instructions` prose) BEFORE `formatDiffValue` truncates.
 *
 * `keyTrail` is the chain of property keys down to the value; array indices
 * are not keys and don't appear in it.
 */
function renderDiffValue(value: unknown, keyTrail: ReadonlyArray<string>): string {
  const finalKey = keyTrail[keyTrail.length - 1];
  const parentKey = keyTrail[keyTrail.length - 2];
  if (
    (finalKey !== undefined && isCredentialKey(finalKey)) ||
    (parentKey !== undefined && isCredentialKey(parentKey))
  ) {
    return REDACTED_VALUE;
  }
  return formatDiffValue(redactTree(value));
}

/** Deep-copy `value` with credential-keyed leaves replaced by `[redacted]`
 *  and credential-shaped tokens masked inside the remaining strings, so an
 *  added/removed SUBTREE (a whole MCP server map with an `env` block) can't
 *  smuggle secrets through its compact-JSON rendering. */
function redactTree(value: unknown, underCredentialKey = false): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactTree(v, underCredentialKey));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactTree(v, underCredentialKey || isCredentialKey(k));
    }
    return out;
  }
  if (underCredentialKey) return REDACTED_VALUE;
  return typeof value === "string" ? maskCredentialTokens(value) : value;
}

function walkDiff(
  a: unknown,
  b: unknown,
  path: string,
  out: SpecDiffEntry[],
  keyTrail: ReadonlyArray<string>,
): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    // Union of keys, a's ordering first — deterministic output.
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const childTrail = [...keyTrail, key];
      if (!(key in a)) {
        out.push({ kind: "added", path: childPath, after: renderDiffValue(b[key], childTrail) });
      } else if (!(key in b)) {
        out.push({
          kind: "removed",
          path: childPath,
          before: renderDiffValue(a[key], childTrail),
        });
      } else {
        walkDiff(a[key], b[key], childPath, out, childTrail);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= a.length) {
        out.push({ kind: "added", path: childPath, after: renderDiffValue(b[i], keyTrail) });
      } else if (i >= b.length) {
        out.push({ kind: "removed", path: childPath, before: renderDiffValue(a[i], keyTrail) });
      } else {
        walkDiff(a[i], b[i], childPath, out, keyTrail);
      }
    }
    return;
  }
  // Leaf (or type-mismatch, e.g. map → sequence): compare whole values.
  if (!leafEqual(a, b)) {
    out.push({
      kind: "changed",
      path: path === "" ? "(root)" : path,
      before: renderDiffValue(a, keyTrail),
      after: renderDiffValue(b, keyTrail),
    });
  }
}
