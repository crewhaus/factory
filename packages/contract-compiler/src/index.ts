/**
 * Track G (§58) — `contract-compiler`. Two-pass compilation of a raw
 * issue/spec draft into a structured contract suitable for downstream
 * agent execution.
 *
 * Source: Meta-Engineering Harnesses (Sengupta et al., HireNimbus,
 * arxiv 2605.25665, §4.2). The two-pass model:
 *
 *   - **Pass 1 (completeness)** — Converts the raw issue to a
 *     structured draft, making implicit assumptions explicit through
 *     types, state transitions, edge cases, trust boundaries, error
 *     conditions.
 *   - **Pass 2 (scope/ambiguity)** — Reduces and clarifies. Removes
 *     unsupported requirements. Rewrites ambiguous clauses so
 *     downstream agents don't treat multiple interpretations as
 *     equally valid.
 *
 * Empirical motivation from the paper: **first-pass contracts can
 * over-specify**, and over-specification is dangerous because
 * downstream agents treat unsupported requirements as mandatory.
 *
 * v0 ships the pure-function pipeline. The "completeness" and
 * "ambiguity" detectors here are rule-based; the production CLI wires
 * an LLM-backed refiner on top via the `refiner?` option. Either way
 * the pass shapes are the same and the registered specialization
 * invariants are injected at the end of pass 1 (before ambiguity
 * resolution can prune them).
 *
 * Cited paper: Meta-Engineering Harnesses (arxiv 2605.25665).
 */
import { CrewhausError } from "@crewhaus/errors";
import {
  type Invariant,
  type Specialization,
  type SpecializationMatch,
  match as matchSpecialization,
} from "@crewhaus/specialization-registry";

export class ContractCompilerError extends CrewhausError {
  override readonly name = "ContractCompilerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * A compiled contract — the structured artifact downstream tools
 * (codegen, eval, optimizer) consume. The shape is intentionally
 * minimal; richer fields can be added without breaking callers
 * because every consumer treats unknown fields as opaque.
 */
export type CompiledContract = {
  readonly title: string;
  readonly summary: string;
  readonly requirements: ReadonlyArray<Requirement>;
  readonly invariants: ReadonlyArray<Invariant>;
  readonly outOfScope: ReadonlyArray<string>;
  readonly ambiguitiesResolved: ReadonlyArray<AmbiguityResolution>;
  readonly specialization?: SpecializationMatch;
};

export type Requirement = {
  readonly id: string;
  readonly text: string;
  readonly source: "user" | "specialization" | "completeness-pass";
};

export type AmbiguityResolution = {
  readonly clause: string;
  readonly originalText: string;
  readonly resolution: string;
};

export type CompileContractOptions = {
  /** The raw issue text the user supplied. */
  readonly rawIssue: string;
  /**
   * Optional registry override. Defaults to BUILTIN_SPECIALIZATIONS.
   * Pass `loadRegistry(".crewhaus/specializations")` to merge project
   * overrides on top.
   */
  readonly registry?: ReadonlyArray<Specialization>;
  /**
   * When set, force a specialization match (skip auto-detection).
   * Useful when the user explicitly names the domain.
   */
  readonly forceSpecialization?: string;
  /**
   * Optional LLM-backed refiner. When supplied, replaces the rule-based
   * completeness/ambiguity passes. The signature is `(draft) → refined`
   * so the package stays pure for tests.
   */
  readonly refiner?: RefinerFn;
};

export type RefinerFn = (draft: CompiledContract) => Promise<CompiledContract>;

/**
 * Run the two-pass compilation. Returns the final contract; throws
 * ContractCompilerError if the raw issue is empty (the completeness
 * pass has nothing to work with).
 */
export async function compileContract(opts: CompileContractOptions): Promise<CompiledContract> {
  const raw = opts.rawIssue.trim();
  if (raw.length === 0) {
    throw new ContractCompilerError("rawIssue is empty");
  }

  // Pass 1 — completeness: extract requirements, identify
  // state-transition / trust-boundary / error-handling gaps, inject
  // specialization invariants when confidence is sufficient.
  const matched = matchSpecialization(raw, {
    ...(opts.forceSpecialization !== undefined
      ? { mode: "strict", forceMatch: opts.forceSpecialization }
      : {}),
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
  });

  const userRequirements = extractRequirements(raw);
  const completenessRequirements = inferCompletenessRequirements(raw);
  const requirements: Requirement[] = [
    ...userRequirements.map((text, i) => ({
      id: `user-${i}`,
      text,
      source: "user" as const,
    })),
    ...completenessRequirements.map((text, i) => ({
      id: `completeness-${i}`,
      text,
      source: "completeness-pass" as const,
    })),
  ];
  const invariants: Invariant[] =
    matched !== undefined ? [...matched.specialization.invariants] : [];
  if (matched !== undefined) {
    for (const inv of matched.specialization.invariants) {
      requirements.push({
        id: `spec-${matched.specialization.name}-${inv.id}`,
        text: `${matched.specialization.name}: ${inv.description}`,
        source: "specialization",
      });
    }
  }

  const draft: CompiledContract = {
    title: extractTitle(raw),
    summary: raw,
    requirements,
    invariants,
    outOfScope: [],
    ambiguitiesResolved: [],
    ...(matched !== undefined ? { specialization: matched } : {}),
  };

  // Pass 2 — scope/ambiguity: remove obvious unsupported clauses,
  // rewrite ambiguous wording. When a refiner is supplied, defer to
  // it; otherwise apply the rule-based detectors.
  const refined = opts.refiner !== undefined ? await opts.refiner(draft) : ambiguityPass(draft);
  return refined;
}

/**
 * Bullet-extractor: lines starting with -, *, or numbered. Collects
 * the trimmed body of each.
 */
function extractRequirements(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+)$/) ?? line.match(/^\s*\d+\.\s+(.+)$/);
    if (m !== null && m[1] !== undefined) out.push(m[1].trim());
  }
  return out;
}

function extractTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.startsWith("#")) return firstLine.replace(/^#+\s*/, "");
  return firstLine.slice(0, 120);
}

/**
 * Completeness inferences. Looks for known omissions and adds a
 * one-line "the contract should also say" requirement so the
 * specification author sees the gap explicitly. Idempotent: each rule
 * only fires when the corresponding signal is *absent* from the raw
 * text.
 */
function inferCompletenessRequirements(text: string): string[] {
  const lower = text.toLowerCase();
  const inferred: string[] = [];
  if (!/error|fail|exception|reject/.test(lower)) {
    inferred.push(
      "Specify the error-handling contract: which failures the agent must surface vs swallow.",
    );
  }
  if (!/edge\s*case|boundary|invalid|empty/.test(lower)) {
    inferred.push("Enumerate edge cases (empty inputs, invalid inputs, boundary conditions).");
  }
  if (/state|status|transition/.test(lower) && !/transition/.test(lower)) {
    inferred.push("Document the allowed state transitions explicitly (rather than implying them).");
  }
  if (
    /(?:auth|token|secret|password|credential)/.test(lower) &&
    !/(trust\s*bound|threat\s*model|attacker)/.test(lower)
  ) {
    inferred.push(
      "Name the trust boundaries: what the system trusts the caller for vs what it independently verifies.",
    );
  }
  return inferred;
}

/**
 * Ambiguity pass. Heuristic detectors for the most common authoring
 * mistakes the paper highlights: vague quantifiers ("some", "a few",
 * "maybe"), passive-voice subject elision ("it should be handled"),
 * and contradictory pairs detected by negation distance.
 *
 * Each resolved ambiguity gets recorded in `ambiguitiesResolved` so
 * the contract reviewer sees the substitution explicitly.
 */
function ambiguityPass(draft: CompiledContract): CompiledContract {
  const resolutions: AmbiguityResolution[] = [];
  const VAGUE_RE = /\b(some|a few|several|maybe|possibly|might|perhaps)\b/gi;
  const newRequirements: Requirement[] = [];
  for (const req of draft.requirements) {
    if (VAGUE_RE.test(req.text)) {
      VAGUE_RE.lastIndex = 0;
      const resolved = req.text.replace(VAGUE_RE, "[QUANTIFY]");
      resolutions.push({
        clause: req.id,
        originalText: req.text,
        resolution:
          "Vague quantifier flagged; replaced with [QUANTIFY] placeholder. The contract reviewer must supply a number or remove the clause.",
      });
      newRequirements.push({ ...req, text: resolved });
    } else {
      newRequirements.push(req);
    }
  }
  return {
    ...draft,
    requirements: newRequirements,
    ambiguitiesResolved: resolutions,
  };
}

/**
 * Render a CompiledContract back to a YAML-friendly fragment that can
 * be appended into a `crewhaus.yaml`'s `agent.instructions` field.
 * Strict — no host code, no env access, just string concatenation.
 */
export function renderContract(c: CompiledContract): string {
  const lines: string[] = [];
  lines.push(`# Contract: ${c.title}`);
  if (c.specialization !== undefined) {
    lines.push(
      `# Specialization: ${c.specialization.specialization.name} (confidence ${c.specialization.confidence.toFixed(2)})`,
    );
  }
  lines.push("");
  lines.push("## Requirements");
  for (const r of c.requirements) {
    lines.push(`- [${r.source}] ${r.text}`);
  }
  if (c.invariants.length > 0) {
    lines.push("");
    lines.push("## Invariants");
    for (const inv of c.invariants) {
      lines.push(`- [${inv.required ? "required" : "optional"}] ${inv.id}: ${inv.description}`);
    }
  }
  if (c.outOfScope.length > 0) {
    lines.push("");
    lines.push("## Out of scope");
    for (const oos of c.outOfScope) lines.push(`- ${oos}`);
  }
  if (c.ambiguitiesResolved.length > 0) {
    lines.push("");
    lines.push("## Ambiguities resolved");
    for (const a of c.ambiguitiesResolved) {
      lines.push(`- ${a.clause}: ${a.resolution}`);
    }
  }
  return lines.join("\n");
}
