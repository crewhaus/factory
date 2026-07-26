/**
 * B23 — PII/secret hygiene for eval datasets: the shared SYNC redaction the
 * ingestion surfaces (`distill`, the unattended `feedback.autoDistill`
 * teardown consumer, `dataset mine`) thread through sample construction,
 * plus the `crewhaus dataset audit` core — an OFFLINE regex scan of an
 * EXISTING dataset (no model calls, nothing leaves the box).
 *
 * `synthesize` / `fewshot harvest` always redacted at ingestion, but the
 * distill/mine paths copied raw production text — turn inputs and outputs,
 * comments, corrections, error reasons — straight into datasets that then
 * flow into committed `eval/dataset.jsonl` files, judge prompts, and the
 * optimizer meta-prompt. {@link redactDatasetText} closes that path with the
 * SAME detector set (`SYNTHESIZE_PII_DETECTORS`) applied synchronously: the
 * `@crewhaus/pii-redactor` API is async-only, which the pure sync `distill`
 * core cannot await (the watchme sync-redact seam precedent), so this
 * mirrors its replace mode byte-for-byte — hits deduped by (kind, value),
 * replaced longest-value-first with the redactor's own `[REDACTED:<kind>]`
 * marker — leaving non-PII text exactly as it was.
 *
 * `audit` retrofits the same guarantee onto datasets that ALREADY exist:
 * scan every free-text field (input, expected_output, string metadata
 * leaves — the same shallow walk `PiiRedactor.redactObject` does), report
 * hits per detector/field/sample WITHOUT ever echoing the matched value (the
 * report must be CI-log-safe), and let `--apply` write a redacted NEW
 * registry version (never in place, mirroring `refresh-goldens`).
 *
 * Kept in a side-effect-free module mirroring `dataset-mine.ts` /
 * `refresh-goldens.ts`; all filesystem access and the registry version
 * write live in `apps/cli/src/index.ts`.
 */
import type { Sample } from "@crewhaus/eval-dataset";
import { dedupePiiHits, redactText } from "@crewhaus/feedback-distill";
import { type PiiDetector, detectPii } from "@crewhaus/pii-redactor";
import { SYNTHESIZE_PII_DETECTORS } from "./dataset-mine";

/**
 * Deterministic SYNC redaction over the shared detector set. D39 moved the
 * algorithm + detector set into `@crewhaus/feedback-distill` so the
 * unattended daemon janitor step redacts EXACTLY what the CLI ingestion
 * surfaces do; this stays the CLI's name for it (same behavior, same
 * detectors, same `[REDACTED:<kind>]` markers).
 */
export function redactDatasetText(
  text: string,
  detectors: ReadonlyArray<PiiDetector> = SYNTHESIZE_PII_DETECTORS,
): string {
  return redactText(text, detectors);
}

/** The redactor's marker shapes: replace-mode `[REDACTED:<kind>]` (the only
 *  form {@link redactDatasetText} emits) plus the PiiRedactor hash mode's
 *  `[HASHED:<kind>:<hmac>]` for symmetry. Non-global on purpose — a shared
 *  `g` regex is stateful across `.test` calls. `feedback.ts` keeps a
 *  replace-mode sibling (`REDACTION_MARKER_RE`) for grader synthesis. */
const REDACTION_MARKER_RE = /\[(?:REDACTED:[a-z0-9_]+|HASHED:[a-z0-9_]+:[0-9a-f]+)\]/i;

/** Does this text carry a redaction marker? Ingestion CLIs use it to warn
 *  when a GOLD (`expected_output`) was altered by redaction — live agent
 *  output is never redacted, so string-comparison graders (`exact_match`,
 *  `expected_contains`) can never match such a gold at eval time. */
export function containsRedactionMarker(text: string): boolean {
  return REDACTION_MARKER_RE.test(text);
}

// -------- field walk (shared by scan + apply) --------

/** One scannable free-text field of a Sample. */
export type AuditedField = {
  /** `input`, `expected_output`, `metadata.<key>`, or `metadata.<key>[<i>]`. */
  readonly field: string;
  readonly text: string;
};

/**
 * The free-text fields the audit scans and `--apply` redacts: `input`,
 * `history[<i>].content` (B14 multi-turn samples carry prior conversation
 * turns — production text every bit as leak-prone as the final input),
 * `expected_output`, and metadata string leaves one level deep (plus items
 * of string arrays) — the same shallow walk `PiiRedactor.redactObject`
 * performs. `expected_tools` entries are machine identifiers, not prose, and
 * non-string metadata (numbers, nested objects like distill's `raw_rating`)
 * passes through both the scan and the rewrite untouched.
 */
export function sampleTextFields(s: Sample): AuditedField[] {
  const fields: AuditedField[] = [{ field: "input", text: s.input }];
  if (s.history !== undefined) {
    for (const [i, msg] of s.history.entries()) {
      fields.push({ field: `history[${i}].content`, text: msg.content });
    }
  }
  if (s.expected_output !== undefined) {
    fields.push({ field: "expected_output", text: s.expected_output });
  }
  if (s.metadata !== undefined) {
    for (const [key, value] of Object.entries(s.metadata)) {
      if (typeof value === "string") {
        fields.push({ field: `metadata.${key}`, text: value });
      } else if (Array.isArray(value)) {
        for (const [i, item] of value.entries()) {
          if (typeof item === "string") {
            fields.push({ field: `metadata.${key}[${i}]`, text: item });
          }
        }
      }
    }
  }
  return fields;
}

/** Redact every scannable field of a Sample (see {@link sampleTextFields}),
 *  leaving id / expected_tools / non-string metadata untouched. `history`
 *  is PRESERVED (roles verbatim, contents redacted) — dropping it would
 *  silently turn a multi-turn sample single-turn on `--apply`. */
export function redactSample(
  s: Sample,
  detectors: ReadonlyArray<PiiDetector> = SYNTHESIZE_PII_DETECTORS,
): Sample {
  const out: Sample = { id: s.id, input: redactDatasetText(s.input, detectors) };
  if (s.history !== undefined) {
    out.history = s.history.map((m) => ({
      role: m.role,
      content: redactDatasetText(m.content, detectors),
    }));
  }
  if (s.expected_output !== undefined) {
    out.expected_output = redactDatasetText(s.expected_output, detectors);
  }
  if (s.expected_tools !== undefined) out.expected_tools = [...s.expected_tools];
  if (s.metadata !== undefined) {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s.metadata)) {
      if (typeof value === "string") {
        metadata[key] = redactDatasetText(value, detectors);
      } else if (Array.isArray(value)) {
        metadata[key] = value.map((item) =>
          typeof item === "string" ? redactDatasetText(item, detectors) : item,
        );
      } else {
        metadata[key] = value;
      }
    }
    out.metadata = metadata;
  }
  return out;
}

// -------- scan --------

/** One (sample, field, detector) hit group. NEVER carries the matched text —
 *  the report this feeds must be safe to paste into a CI log. */
export type DatasetAuditHit = {
  readonly sampleId: string;
  readonly field: string;
  /** Detector kind (`ssn`, `credit_card`, `phone`, `email`, `iban`, `secret`). */
  readonly kind: string;
  /** Distinct (kind, value) matches of this detector in this field. */
  readonly count: number;
};

export type DatasetAuditReport = {
  readonly samplesScanned: number;
  readonly samplesWithHits: number;
  readonly totalHits: number;
  /** In sample order, then field-walk order, then detector order. */
  readonly hits: DatasetAuditHit[];
};

/** Offline scan of a dataset's samples with the shared detector set. Pure
 *  regex — no model calls, nothing leaves the process. */
export function auditSamples(
  samples: ReadonlyArray<Sample>,
  detectors: ReadonlyArray<PiiDetector> = SYNTHESIZE_PII_DETECTORS,
): DatasetAuditReport {
  const hits: DatasetAuditHit[] = [];
  const samplesWithHits = new Set<string>();
  let totalHits = 0;
  for (const s of samples) {
    for (const { field, text } of sampleTextFields(s)) {
      const found = dedupePiiHits(detectPii(text, detectors)).filter((h) => h.value.length > 0);
      if (found.length === 0) continue;
      const byKind = new Map<string, number>();
      for (const h of found) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1);
      for (const [kind, count] of byKind) {
        hits.push({ sampleId: s.id, field, kind, count });
        totalHits += count;
        samplesWithHits.add(s.id);
      }
    }
  }
  return {
    samplesScanned: samples.length,
    samplesWithHits: samplesWithHits.size,
    totalHits,
    hits,
  };
}

// -------- report rendering --------

/** How many sample ids a report line spells out before eliding. */
const REPORT_MAX_IDS = 8;

/**
 * Render the per-detector/per-field hit report. Lists sample ids so the
 * operator can inspect the offending samples, but NEVER the matched text —
 * a hit echoed into a CI log would be the exact leak the audit exists to
 * catch.
 */
export function renderAuditReport(report: DatasetAuditReport, label: string): string {
  if (report.totalHits === 0) {
    return `[dataset audit] ${label}: ${report.samplesScanned} sample(s) scanned — no PII/secret hits\n`;
  }
  const lines = [
    `[dataset audit] ${label}: ${report.samplesScanned} sample(s) scanned — ` +
      `${report.totalHits} PII/secret hit(s) across ${report.samplesWithHits} sample(s)`,
  ];
  // Group (kind, field) → total count + sample ids, in a stable sorted order.
  const groups = new Map<string, { kind: string; field: string; count: number; ids: string[] }>();
  for (const h of report.hits) {
    const key = `${h.kind}\u0000${h.field}`;
    const g = groups.get(key) ?? { kind: h.kind, field: h.field, count: 0, ids: [] };
    g.count += h.count;
    if (!g.ids.includes(h.sampleId)) g.ids.push(h.sampleId);
    groups.set(key, g);
  }
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key) as { kind: string; field: string; count: number; ids: string[] };
    const shown = g.ids.slice(0, REPORT_MAX_IDS).join(", ");
    const elided = g.ids.length > REPORT_MAX_IDS ? ` +${g.ids.length - REPORT_MAX_IDS} more` : "";
    lines.push(`  ${g.kind} in ${g.field}: ${g.count} hit(s) — ${shown}${elided}`);
  }
  lines.push("  (matched text is never echoed — inspect the listed samples by id)");
  return `${lines.join("\n")}\n`;
}
