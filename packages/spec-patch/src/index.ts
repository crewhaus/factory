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
import { parse, parseDocument } from "yaml";
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
 * Per-target whitelist of mutation paths the active optimizer is
 * allowed to touch. Adding a new field here is the explicit signal that
 * it's safe to autotune. Skipping this list means the optimizer can
 * only mutate prompts (the default), preserving the "spec safety floor"
 * that an optimizer can't accidentally rewrite security-critical fields
 * like `permissions.mode` or `model_router` rules.
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
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["compaction", "threshold"]),
    // Pillar 2 active context curation — eval-optimizer can flip the
    // semantic-dedupe + relevance-reorder pass on/off and tune its
    // similarity threshold, which dominates input-token cost on long runs.
    Object.freeze(["compaction", "curate"]),
    Object.freeze(["compaction", "dedupeThreshold"]),
    Object.freeze(["compaction", "relevanceTopK"]),
    // Pillar 3 sink-side fabric — egress policy + intent-gate thresholds
    // are tunable so the eval-optimizer can find the sweet spot between
    // false-positive denials and false-negative exfil bypasses.
    Object.freeze(["security", "egressPolicy"]),
    Object.freeze(["security", "justification"]),
    // §47 blockchain subsystem (slice 0). Whole-block replacement so the
    // optimizer can tune `chains[*].finality.count`, `chains[*].rpcPolicy`,
    // `transaction_policy.maxValueWei`, and `transaction_policy.simulationRequired`
    // by patching their parent block.
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  workflow: Object.freeze([
    Object.freeze(["steps"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]) /* whole-step replacement allowed */,
  channel: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  graph: Object.freeze([
    Object.freeze(["nodes"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  managed: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
  ]),
  pipeline: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["indexing", "chunkSize"]),
    Object.freeze(["indexing", "chunkOverlap"]),
    Object.freeze(["retrieve", "defaultK"]),
  ]),
  crew: Object.freeze([
    Object.freeze(["roles"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]) /* whole-role replacement */,
  research: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["retrieve", "maxDepth"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  batch: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["chains"]),
    Object.freeze(["transaction_policy"]),
  ]),
  voice: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
  ]),
  browser: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
  ]),
  eval: Object.freeze([
    Object.freeze(["agent", "instructions"]),
    Object.freeze(["failure_taxonomy"]),
  ]),
  // §47 onchain daemon: full cross-cutting blocks are optimizable.
  onchain: Object.freeze([
    Object.freeze(["agent", "instructions"]),
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
    Object.freeze(["failure_taxonomy"]),
    Object.freeze(["game"]),
    Object.freeze(["transaction_policy"]),
  ]),
});

function isOptimizable(target: Spec["target"], path: ReadonlyArray<string>): boolean {
  const allowed = OPTIMIZABLE_PATHS[target];
  for (const ok of allowed) {
    if (ok.length !== path.length) continue;
    let match = true;
    for (let i = 0; i < ok.length; i++) {
      if (ok[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  // Allow patches with a prefix that matches an optimizable path
  // (e.g. `["nodes", "0", "instructions"]` if `["nodes"]` is whitelisted)
  // so the optimizer can do fine-grained updates without listing every
  // sub-path.
  for (const ok of allowed) {
    if (path.length < ok.length) continue;
    let match = true;
    for (let i = 0; i < ok.length; i++) {
      if (ok[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
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
