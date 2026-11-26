/**
 * The approvals reader and the count of the released 0.8.3 CLI, copied: what a machine that
 * has not upgraded reads the approvals file with.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ReleasedApproval = {
  readonly approver: string;
  readonly ts: string;
  readonly version?: string;
  readonly comment?: string;
};

export function releasedReadApprovals(
  rootDir: string,
  specName: string,
  env: string,
): ReleasedApproval[] {
  const path = join(rootDir, ".crewhaus/approvals", `${specName}__${env}.json`);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error(`approvals file ${path} must be a JSON array`);
  const out: ReleasedApproval[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["approver"] !== "string" || typeof rec["ts"] !== "string") continue;
    out.push({
      approver: rec["approver"],
      ts: rec["ts"],
      ...(typeof rec["version"] === "string" ? { version: rec["version"] } : {}),
      ...(typeof rec["comment"] === "string" ? { comment: rec["comment"] } : {}),
    });
  }
  return out;
}

export function releasedCount(
  approvals: readonly ReleasedApproval[],
  toVersion: string,
): readonly string[] {
  const counted = new Set<string>();
  for (const a of approvals) {
    if (a.version !== undefined && a.version !== toVersion) continue;
    counted.add(a.approver);
  }
  return [...counted].sort();
}
