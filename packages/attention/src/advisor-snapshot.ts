/**
 * The Advisor's findings for one harness as Home's sweep last gathered them, kept in
 * Home's index (`cache/index/<hrn>/attention-advisor.json`) beside the harness's read
 * models. Home writes it off the request path; Home's reads and `crewhaus inbox` read it
 * whole, capped, and add its items after the harness's own. No read gathers findings: a
 * harness Home has not checked yet says so.
 *
 * A snapshot keeps each finding's id, severity, screen, signal family, quick action and
 * evidence time. The Advisor's prose, dismissal reasons and action comments stay in the
 * harness's own Advisor ledger.
 */
import { type IndexRead, projectionRel, readIndexRecord } from "@crewhaus/control-records";
import type { AdvisorItem } from "@crewhaus/harness-advice/advisor";
import type { AdvisorFinding, AdvisorSnapshot, HarnessFacts } from "./types";

/** The snapshot's name under each harness's folder in Home's index. */
export const ADVISOR_SNAPSHOT_NAME = "attention-advisor";

/** A snapshot larger than this is not read. */
export const ADVISOR_SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** At most this many findings are kept for one harness. */
export const ADVISOR_FINDINGS_MAX = 200;

/** Where one harness's snapshot is, relative to Home's index. */
export function advisorSnapshotRel(hrn: string): string {
  return projectionRel(hrn, ADVISOR_SNAPSHOT_NAME);
}

const SEVERITIES = new Set(["critical", "warn", "suggestion"]);

/** One finding as a snapshot keeps it. */
export function findingOf(item: AdvisorItem | AdvisorFinding): AdvisorFinding {
  return {
    id: item.id,
    severity: item.severity,
    screen: item.screen,
    source: item.source,
    action:
      item.action === null
        ? null
        : {
            kind: item.action.kind,
            label: item.action.label,
            cliTwin: item.action.cliTwin,
            jobKind: item.action.jobKind,
          },
    status: item.status,
    ...(item.evidenceAt !== undefined ? { evidenceAt: item.evidenceAt } : {}),
  };
}

/** The record a sweep writes for one harness. */
export function advisorSnapshotRecord(
  at: string,
  items: readonly (AdvisorItem | AdvisorFinding)[],
): { readonly v: 1; readonly at: string; readonly items: readonly AdvisorFinding[] } {
  return { v: 1, at, items: items.slice(0, ADVISOR_FINDINGS_MAX).map(findingOf) };
}

const str = (value: unknown): value is string => typeof value === "string";

function actionOf(value: unknown): AdvisorFinding["action"] | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const a = value as Record<string, unknown>;
  if ((a["kind"] !== "job" && a["kind"] !== "link") || !str(a["label"])) return undefined;
  const cliTwin = a["cliTwin"] === null || str(a["cliTwin"]) ? a["cliTwin"] : undefined;
  const jobKind = a["jobKind"] === null || str(a["jobKind"]) ? a["jobKind"] : undefined;
  if (cliTwin === undefined || jobKind === undefined) return undefined;
  return { kind: a["kind"], label: a["label"], cliTwin, jobKind };
}

/** A finding read back, or `undefined` for a row that is not one. */
function parseFinding(value: unknown): AdvisorFinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const f = value as Record<string, unknown>;
  const action = actionOf(f["action"]);
  if (
    !str(f["id"]) ||
    !str(f["severity"]) ||
    !SEVERITIES.has(f["severity"]) ||
    !str(f["screen"]) ||
    !str(f["source"]) ||
    (f["status"] !== "open" && f["status"] !== "dismissed") ||
    action === undefined ||
    (f["evidenceAt"] !== undefined && !str(f["evidenceAt"]))
  ) {
    return undefined;
  }
  return findingOf({
    id: f["id"],
    severity: f["severity"] as AdvisorFinding["severity"],
    screen: f["screen"] as AdvisorFinding["screen"],
    source: f["source"],
    action,
    status: f["status"],
    ...(str(f["evidenceAt"]) ? { evidenceAt: f["evidenceAt"] } : {}),
  });
}

/** A snapshot record's body read back, or `undefined` for one that is not a snapshot. */
export function parseAdvisorSnapshot(
  body: Readonly<Record<string, unknown>>,
): AdvisorSnapshot | undefined {
  if (body["v"] !== 1 || !str(body["at"]) || !Array.isArray(body["items"])) return undefined;
  const items: AdvisorFinding[] = [];
  for (const row of body["items"].slice(0, ADVISOR_FINDINGS_MAX)) {
    const finding = parseFinding(row);
    if (finding !== undefined) items.push(finding);
  }
  return { at: body["at"], items };
}

/**
 * One harness's snapshot from Home's index, read whole up to its cap; `undefined` when
 * Home has not checked the harness yet or the file is not a snapshot. Creates nothing.
 */
export function readAdvisorSnapshot(hangarRoot: string, hrn: string): AdvisorSnapshot | undefined {
  let read: IndexRead;
  try {
    read = readIndexRecord(hangarRoot, advisorSnapshotRel(hrn), ADVISOR_SNAPSHOT_MAX_BYTES);
  } catch {
    return undefined;
  }
  return read.state === "present" ? parseAdvisorSnapshot(read.body) : undefined;
}

/**
 * A facts port that also answers each harness's Advisor snapshot from Home's index:
 * `idOf` names the registered harness a directory is.
 */
export function withAdvisorSnapshots(
  facts: Pick<HarnessFacts, "envVars" | "envNameSource">,
  hangarRoot: string,
  idOf: (dir: string) => string | undefined,
): HarnessFacts {
  return {
    envVars: (dir) => facts.envVars(dir),
    envNameSource: (dir, name) => facts.envNameSource(dir, name),
    advisorSnapshot: (dir) => {
      const hrn = idOf(dir);
      return hrn === undefined ? undefined : readAdvisorSnapshot(hangarRoot, hrn);
    },
  };
}
