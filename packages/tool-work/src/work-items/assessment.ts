/**
 * One proposal object: the case a proposed work item makes for itself, the same for every
 * source (a person, the harness, an adopted task). `parseAssessment` checks the shape and
 * the rules a proposal must meet before it is written:
 *
 * - every proposal carries a `basis`; a `feature` carries an assessment whose `doNothing`
 *   says what happens if nothing is done;
 * - `inferred` and `simulated` evidence is labelled `hypothesis`, and `observed` or
 *   `reported` evidence names where it can be checked (`ref`);
 * - basis `user-pain` needs at least one observed or reported piece of evidence, and
 *   basis `compatibility-security` at least one advisory, dependency change or release note.
 *
 * A simulated reaction is never a request: it is a hypothesis, and it never counts as
 * evidence of demand. Refusals name the field (`assessment_invalid`).
 */
import {
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  type EvidenceKind,
  type EvidenceLabel,
  WORK_BASES,
  type WorkAssessment,
  type WorkBasis,
  type WorkEvidence,
  type WorkKind,
} from "@crewhaus/control-contract";

export type AssessmentRefusal = {
  readonly ok: false;
  readonly code: "assessment_invalid";
  /** The field that failed, as a path (`assessment.evidence.0.ref`). */
  readonly field: string;
  readonly message: string;
};

export type ParsedProposal =
  | { readonly ok: true; readonly assessment?: WorkAssessment; readonly basis?: WorkBasis }
  | AssessmentRefusal;

const MAX_TEXT = 2048;
const MAX_LIST = 50;
/** Evidence kinds that are guesses, never observations. */
const HYPOTHETICAL_KINDS: ReadonlySet<EvidenceKind> = new Set(["inferred", "simulated"]);
/** Evidence a basis of `compatibility-security` rests on. */
const UPSTREAM_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "advisory",
  "dependency-change",
  "release-note",
]);

function refuse(field: string, message: string): AssessmentRefusal {
  return { ok: false, code: "assessment_invalid", field, message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value
    : undefined;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const LEVEL_FIELDS = ["cost", "upkeep", "uncertainty", "reversibility"] as const;
const TEXT_FIELDS = ["audience", "outcome", "doNothing", "measure"] as const;
const KNOWN = new Set<string>([
  "problem",
  "evidence",
  "counterEvidence",
  "intentFit",
  "alternatives",
  "dependencies",
  ...LEVEL_FIELDS,
  ...TEXT_FIELDS,
]);

function parseEvidence(raw: unknown, at: string, now: string): WorkEvidence | AssessmentRefusal {
  if (!isRecord(raw)) return refuse(at, "each piece of evidence is an object");
  for (const key of Object.keys(raw)) {
    if (!["label", "kind", "ref", "note", "observedAt", "ingestedAt"].includes(key)) {
      return refuse(`${at}.${key}`, `evidence has no field "${key}"`);
    }
  }
  const label = raw["label"];
  const kind = raw["kind"];
  if (!(EVIDENCE_LABELS as readonly unknown[]).includes(label)) {
    return refuse(`${at}.label`, `label is one of ${EVIDENCE_LABELS.join(", ")}`);
  }
  if (!(EVIDENCE_KINDS as readonly unknown[]).includes(kind)) {
    return refuse(`${at}.kind`, `kind is one of ${EVIDENCE_KINDS.join(", ")}`);
  }
  const note = text(raw["note"]);
  if (note === undefined) return refuse(`${at}.note`, "say what the evidence shows, in a note");
  if (HYPOTHETICAL_KINDS.has(kind as EvidenceKind) && label !== "hypothesis") {
    return refuse(
      `${at}.label`,
      `${String(kind)} evidence is a hypothesis: label it "hypothesis", never "${String(label)}"`,
    );
  }
  const ref = raw["ref"];
  if (ref !== undefined && text(ref, 500) === undefined) {
    return refuse(`${at}.ref`, "ref is a short reference to where it can be checked");
  }
  if ((label === "observed" || label === "reported") && ref === undefined) {
    return refuse(`${at}.ref`, `${String(label)} evidence names where it can be checked (ref)`);
  }
  for (const field of ["observedAt", "ingestedAt"] as const) {
    if (raw[field] !== undefined && !isTime(raw[field])) {
      return refuse(`${at}.${field}`, `${field} is a date and time`);
    }
  }
  return {
    label: label as EvidenceLabel,
    kind: kind as EvidenceKind,
    ...(ref !== undefined ? { ref: ref as string } : {}),
    note,
    ...(raw["observedAt"] !== undefined ? { observedAt: raw["observedAt"] as string } : {}),
    ingestedAt: (raw["ingestedAt"] as string | undefined) ?? now,
  };
}

function parseEvidenceList(
  raw: unknown,
  at: string,
  now: string,
): readonly WorkEvidence[] | AssessmentRefusal {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_LIST) {
    return refuse(at, `${at} is a list of at most ${MAX_LIST} pieces of evidence`);
  }
  const out: WorkEvidence[] = [];
  for (const [i, item] of raw.entries()) {
    const parsed = parseEvidence(item, `${at}.${i}`, now);
    if ("ok" in parsed) return parsed;
    out.push(parsed);
  }
  return out;
}

function parseTextList(raw: unknown, at: string): readonly string[] | AssessmentRefusal {
  if (!Array.isArray(raw) || raw.length > 20) return refuse(at, `${at} is a list of at most 20`);
  const out: string[] = [];
  for (const [i, item] of raw.entries()) {
    const value = text(item, 500);
    if (value === undefined) return refuse(`${at}.${i}`, "each entry is a short line of text");
    out.push(value);
  }
  return out;
}

/**
 * Check an assessment's shape, filling each piece of evidence's `ingestedAt` with `now`
 * when the writer left it out. Pure.
 */
export function parseAssessment(
  raw: unknown,
  now: string,
): { readonly ok: true; readonly assessment: WorkAssessment } | AssessmentRefusal {
  if (!isRecord(raw)) return refuse("assessment", "the assessment is an object");
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) return refuse(`assessment.${key}`, `an assessment has no "${key}"`);
  }
  const problem = text(raw["problem"]);
  if (problem === undefined) {
    return refuse("assessment.problem", "say what the problem is, in a few sentences");
  }
  const evidence = parseEvidenceList(raw["evidence"], "assessment.evidence", now);
  if ("ok" in evidence) return evidence;
  const counter = parseEvidenceList(raw["counterEvidence"], "assessment.counterEvidence", now);
  if ("ok" in counter) return counter;
  const out: Record<string, unknown> = { problem, evidence, counterEvidence: counter };
  for (const field of TEXT_FIELDS) {
    if (raw[field] === undefined) continue;
    const value = text(raw[field]);
    if (value === undefined) return refuse(`assessment.${field}`, `${field} is text`);
    out[field] = value;
  }
  for (const field of LEVEL_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 3) {
      return refuse(`assessment.${field}`, `${field} is a level from 0 (none) to 3 (high)`);
    }
    out[field] = value;
  }
  if (raw["intentFit"] !== undefined) {
    const fit = raw["intentFit"];
    if (!isRecord(fit)) return refuse("assessment.intentFit", "intentFit is an object");
    const parsed: Record<string, string> = {};
    for (const [key, value] of Object.entries(fit)) {
      if (key !== "supports" && key !== "conflicts") {
        return refuse(`assessment.intentFit.${key}`, "intentFit holds supports and conflicts");
      }
      const line = text(value);
      if (line === undefined) return refuse(`assessment.intentFit.${key}`, `${key} is text`);
      parsed[key] = line;
    }
    out["intentFit"] = parsed;
  }
  for (const field of ["alternatives", "dependencies"] as const) {
    if (raw[field] === undefined) continue;
    const list = parseTextList(raw[field], `assessment.${field}`);
    if ("ok" in list) return list;
    out[field] = list;
  }
  return { ok: true, assessment: out as WorkAssessment };
}

/** Whether a piece of evidence is a hypothesis: labelled so, or a kind that can only be one. */
export function isHypothesis(evidence: WorkEvidence): boolean {
  return evidence.label === "hypothesis" || HYPOTHETICAL_KINDS.has(evidence.kind);
}

/** The evidence that counts as demand: observed or reported, never a hypothesis. */
export function demandEvidence(assessment: WorkAssessment | undefined): readonly WorkEvidence[] {
  return (assessment?.evidence ?? []).filter(
    (e) => (e.label === "observed" || e.label === "reported") && !isHypothesis(e),
  );
}

/** How a piece of evidence reads in words: a hypothesis never reads as an observation. */
export function evidenceWords(evidence: WorkEvidence): string {
  if (isHypothesis(evidence)) return "hypothesis — not observed";
  return evidence.label === "observed" ? "observed" : "reported";
}

/**
 * The proposal rules: a basis on every proposal, `doNothing` on a feature, and evidence
 * that fits the basis. `assessment` is already parsed. Pure.
 */
export function checkProposal(input: {
  readonly kind: WorkKind;
  readonly basis: unknown;
  readonly assessment: WorkAssessment | undefined;
}): ParsedProposal {
  if (!(WORK_BASES as readonly unknown[]).includes(input.basis)) {
    return refuse(
      "basis",
      `a proposal says why it matters: basis is one of ${WORK_BASES.join(", ")}`,
    );
  }
  const basis = input.basis as WorkBasis;
  const assessment = input.assessment;
  if (input.kind === "feature" && assessment?.doNothing === undefined) {
    return refuse(
      "assessment.doNothing",
      "a feature says what happens if nothing is done (assessment.doNothing)",
    );
  }
  if (basis === "user-pain" && demandEvidence(assessment).length === 0) {
    return refuse(
      "assessment.evidence",
      "basis user-pain needs at least one observed or reported piece of evidence; a hypothesis is not one",
    );
  }
  if (
    basis === "compatibility-security" &&
    !(assessment?.evidence ?? []).some((e) => UPSTREAM_KINDS.has(e.kind) && !isHypothesis(e))
  ) {
    return refuse(
      "assessment.evidence",
      "basis compatibility-security needs an advisory, a dependency change or a release note as evidence",
    );
  }
  return {
    ok: true,
    ...(assessment !== undefined ? { assessment } : {}),
    basis,
  };
}

/** Whether any evidence was observed: the one thing that lets a feature be accepted by policy. */
export function hasObservedEvidence(assessment: WorkAssessment | undefined): boolean {
  return (assessment?.evidence ?? []).some((e) => e.label === "observed" && !isHypothesis(e));
}
