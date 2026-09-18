/**
 * CVSS v3 base scores, computed from the vector string.
 *
 * OSV hands back whatever the upstream database recorded, and for most
 * advisories that is a CVSS vector and nothing else — no number. Without a
 * number there is no ordering, and "ranked by severity" degenerates into
 * "in the order the API answered". So the base score is computed here, from
 * the vector, by the published formula.
 *
 * Only v3.0 and v3.1 are computed. A v2 or v4 vector is REPORTED WITH NO
 * SCORE rather than run through the v3 formula: the metric letters overlap
 * (`AV:N` means the same thing in all three) but the coefficients do not, so
 * a v3 calculation over a v4 vector produces a number that looks right and is
 * not. Callers get `version` either way and can see which happened.
 *
 * Pure: a string in, a number or nothing out.
 */

export type CvssVersion = "2.0" | "3.0" | "3.1" | "4.0" | "unknown";

export type CvssParse = {
  readonly version: CvssVersion;
  /** The base score, present only for the versions this file computes. */
  readonly baseScore?: number;
  /** CRITICAL / HIGH / MEDIUM / LOW / NONE, derived from the score. */
  readonly rating?: CvssRating;
  /** Why no score, when there is none. */
  readonly note?: string;
};

export type CvssRating = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
/** Privileges Required is the one metric whose weights depend on Scope. */
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };

/**
 * The spec's Roundup, which is NOT `Math.ceil(x * 10) / 10`.
 *
 * v3.1 defines it in integer arithmetic precisely because the float version
 * rounds 4.02 up to 4.1 when the true product was 4.0 and the binary
 * representation landed a hair above it. v3.0 predates the fix and really is
 * the naive ceiling, so the two are computed differently on purpose.
 */
function roundup31(value: number): number {
  const scaled = Math.round(value * 100_000);
  if (scaled % 10_000 === 0) return scaled / 100_000;
  return (Math.floor(scaled / 10_000) + 1) / 10;
}

const roundup30 = (value: number): number => Math.ceil(value * 10) / 10;

/** The qualitative band the spec assigns to a base score. */
export function cvssRating(score: number): CvssRating {
  if (score <= 0) return "NONE";
  if (score < 4) return "LOW";
  if (score < 7) return "MEDIUM";
  if (score < 9) return "HIGH";
  return "CRITICAL";
}

function metricsOf(vector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of vector.split("/")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    out.set(
      part.slice(0, at).trim().toUpperCase(),
      part
        .slice(at + 1)
        .trim()
        .toUpperCase(),
    );
  }
  return out;
}

export function parseCvss(vectorRaw: string): CvssParse {
  const vector = vectorRaw.trim();
  if (vector === "") return { version: "unknown", note: "empty vector" };
  const metrics = metricsOf(vector);
  const prefix = metrics.get("CVSS");
  if (prefix === "4.0") {
    return {
      version: "4.0",
      note: "CVSS v4.0 uses a different scoring model; no score was computed from this vector here",
    };
  }
  if (prefix !== "3.0" && prefix !== "3.1") {
    // A v2 vector has no `CVSS:` prefix at all — it is bare `AV:N/AC:L/Au:N/…`
    // — and `Au` is the metric that only v2 has.
    if (metrics.has("AU")) {
      return {
        version: "2.0",
        note: "CVSS v2 uses different metric weights; no score was computed from this vector here",
      };
    }
    return { version: "unknown", note: `unrecognised CVSS vector "${vector}"` };
  }
  const version: CvssVersion = prefix;
  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") {
    return { version, note: "vector is missing or misspells the Scope metric (S:U or S:C)" };
  }
  const pr = scope === "C" ? PR_CHANGED : PR_UNCHANGED;
  const values = {
    av: AV[metrics.get("AV") ?? ""],
    ac: AC[metrics.get("AC") ?? ""],
    pr: pr[metrics.get("PR") ?? ""],
    ui: UI[metrics.get("UI") ?? ""],
    c: CIA[metrics.get("C") ?? ""],
    i: CIA[metrics.get("I") ?? ""],
    a: CIA[metrics.get("A") ?? ""],
  };
  const missing = Object.entries(values)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k.toUpperCase());
  if (missing.length > 0) {
    return { version, note: `vector is missing or misspells: ${missing.join(", ")}` };
  }
  const iss =
    1 - (1 - (values.c as number)) * (1 - (values.i as number)) * (1 - (values.a as number));
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  const exploitability =
    8.22 *
    (values.av as number) *
    (values.ac as number) *
    (values.pr as number) *
    (values.ui as number);
  const roundup = version === "3.1" ? roundup31 : roundup30;
  const baseScore =
    impact <= 0
      ? 0
      : roundup(
          scope === "U"
            ? Math.min(impact + exploitability, 10)
            : Math.min(1.08 * (impact + exploitability), 10),
        );
  return { version, baseScore, rating: cvssRating(baseScore) };
}

/**
 * Order a set of severity labels/scores. Lower sorts first (more severe).
 *
 * An advisory with no score at all sorts BELOW every scored one rather than
 * being dropped: "OSV recorded no severity" is not "not severe", and a list
 * that silently omitted those would be the wrong list.
 */
export function severityRank(score: number | undefined, label: string | undefined): number {
  if (score !== undefined) return 100 - score * 10;
  switch ((label ?? "").toUpperCase()) {
    case "CRITICAL":
      return 5;
    case "HIGH":
      return 25;
    case "MODERATE":
    case "MEDIUM":
      return 45;
    case "LOW":
      return 65;
    default:
      return 1_000;
  }
}
