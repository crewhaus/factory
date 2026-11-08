/**
 * The approver projection writer: `.crewhaus/run/control/approvers.json` in each governed
 * harness, the harness-local copy of who may decide there, which daemons and the runtime
 * read without Home. Its content is exactly control-contract's `ApproverProjection`.
 *
 * A harness is governed once a live grant other than the home owner's covers it, or a
 * principal with a live Slack link may decide there; its first `governed.jsonl` row fixes
 * `governedSince` for good, so a deleted or corrupt file never resets it, and it stays
 * governed. A single-owner install, and a harness never governed, never gets a file.
 *
 * A write rewrites only a governed harness whose content differs from its file, or whose
 * file is absent or unreadable, and never replaces a file with a higher `epoch`. A harness
 * the change does not touch keeps its file and its older `epoch`.
 */
import { statSync } from "node:fs";
import {
  type ApproverProjection,
  type DecisionClass,
  parseLinkSubject,
} from "@crewhaus/control-contract";
import { append, controlPaths, createApproverReader } from "@crewhaus/control-records";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { type AccessTarget, coveringGrants, credentialHolds, effectiveRole } from "./authorize";
import { sealTornLine } from "./files";
import { accessLedger, accessPaths } from "./paths";
import { type GovernedRow, lineBytes } from "./records";
import { type AccessSnapshot, isActivePrincipal, isLiveCredential, principalOf } from "./snapshot";

/** A registered harness, as the projection writer needs it: its id, directory and groups. */
export type AccessHarness = {
  readonly id: string;
  readonly dir: string;
  readonly groups: readonly string[];
};

export type ProjectionFailure = { readonly harness: string; readonly reason: string };

export type ProjectionReport = {
  /** Harnesses whose file was written. */
  readonly written: readonly string[];
  /** Governed harnesses whose file already held this content. */
  readonly unchanged: readonly string[];
  /** Governed harnesses whose file has a higher epoch, left alone. */
  readonly newer: readonly string[];
  /** Governed harnesses that could not be updated, each with why. */
  readonly failed: readonly ProjectionFailure[];
};

export const EMPTY_REPORT: ProjectionReport = Object.freeze({
  written: [],
  unchanged: [],
  newer: [],
  failed: [],
});

type Content = Pick<ApproverProjection, "owner" | "governedSince" | "members" | "links">;

let writeTap: ((harness: string) => void) | undefined;

/** Test seam: count projection writes. Pass `undefined` to restore. */
export function _setProjectionWriteTapForTest(next: ((harness: string) => void) | undefined): void {
  writeTap = next;
}

function targetOf(harness: AccessHarness): AccessTarget {
  return { scope: "harness", harness: harness.id, groups: harness.groups };
}

/** The highest class a principal may decide at on a harness, or `null`. */
export function decideClassOf(
  snapshot: AccessSnapshot,
  principal: string,
  harness: AccessHarness,
  now: number,
): DecisionClass | null {
  const row = principalOf(snapshot, principal);
  if (row === undefined || row.state !== "active") return null;
  if (principal === snapshot.owner) return "owner";
  const target = targetOf(harness);
  if (row.kind === "service") {
    // A service decides only operator-class questions, and only with the explicit permission.
    const holds = snapshot.tokens.some(
      (credential) =>
        credential.principal === principal &&
        credential.kind === "service" &&
        isLiveCredential(snapshot, credential, now) &&
        credentialHolds(credential, "h.decision.resolve", target),
    );
    return holds ? "operator" : null;
  }
  const role = effectiveRole(snapshot, principal, target, now);
  return role === null || role === "viewer" ? null : role;
}

function liveSlackLinks(snapshot: AccessSnapshot): { principal: string; external: string }[] {
  const out: { principal: string; external: string }[] = [];
  for (const link of snapshot.links) {
    if (link.state !== "active" || link.provider !== "slack") continue;
    if (!isActivePrincipal(snapshot, link.principal)) continue;
    const external = snapshot.subjects.links[link.id];
    if (external === undefined || parseLinkSubject(external) !== "slack") continue;
    out.push({ principal: link.principal, external });
  }
  return out;
}

/** Whether this change governs the harness: a non-owner grant covers it, or a Slack-linked decider. */
export function governsNow(snapshot: AccessSnapshot, harness: AccessHarness, now: number): boolean {
  if (snapshot.owner === undefined) return false;
  const target = targetOf(harness);
  for (const principal of snapshot.principals) {
    if (principal.id === snapshot.owner || principal.kind !== "member") continue;
    if (coveringGrants(snapshot, principal.id, target, now).length > 0) return true;
  }
  return liveSlackLinks(snapshot).some(
    (link) => decideClassOf(snapshot, link.principal, harness, now) !== null,
  );
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The content a projection must hold now. Sorted, so equal access gives equal bytes. */
export function projectionContent(
  snapshot: AccessSnapshot,
  harness: AccessHarness,
  governedSince: string,
  now: number,
): Content {
  const owner = snapshot.owner as string;
  const members: { principal: string; decide: DecisionClass }[] = [];
  for (const principal of snapshot.principals) {
    if (principal.id === owner) continue;
    const decide = decideClassOf(snapshot, principal.id, harness, now);
    if (decide !== null) members.push({ principal: principal.id, decide });
  }
  members.sort((a, b) => byText(a.principal, b.principal));
  const deciders = new Set([owner, ...members.map((member) => member.principal)]);
  const links = liveSlackLinks(snapshot)
    .filter((link) => deciders.has(link.principal))
    .map((link) => ({ external: link.external, principal: link.principal }))
    .sort((a, b) => byText(a.external, b.external) || byText(a.principal, b.principal));
  return { owner, governedSince, members, links };
}

function normalize(content: Content): string {
  return JSON.stringify({
    owner: content.owner,
    governedSince: content.governedSince,
    members: content.members
      .map((member) => ({ principal: member.principal, decide: member.decide }))
      .sort((a, b) => byText(a.principal, b.principal)),
    links: content.links
      .map((link) => ({ external: link.external, principal: link.principal }))
      .sort((a, b) => byText(a.external, b.external) || byText(a.principal, b.principal)),
  });
}

function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function writeOne(
  harness: AccessHarness,
  content: Content,
  epoch: number,
  generatedAt: string,
): ProjectionFailure | undefined {
  if (!dirExists(harness.dir)) {
    return { harness: harness.id, reason: "the harness directory is missing" };
  }
  const paths = controlPaths(harness.dir);
  const made = ensureDirContained(harness.dir, paths.controlDir, { mode: 0o700 });
  if (!made.ok) return { harness: harness.id, reason: made.reason };
  const projection: ApproverProjection = {
    v: 1,
    epoch,
    generatedAt,
    harness: harness.id,
    ...content,
  };
  writeTap?.(harness.id);
  const written = writeFileSafe(
    harness.dir,
    paths.approversFile,
    `${JSON.stringify(projection, null, 2)}\n`,
    { overwrite: true, mode: 0o600 },
  );
  return written.ok ? undefined : { harness: harness.id, reason: written.reason };
}

export type WriteProjectionsInput = {
  readonly root: string;
  readonly snapshot: AccessSnapshot;
  readonly harnesses: readonly AccessHarness[];
  /** The epoch the files carry: the access revision after the change. */
  readonly epoch: number;
  readonly now: number;
  /** The stored actor of a `governed.jsonl` row this call appends. */
  readonly by: string;
};

/**
 * Bring every governed harness's projection to the snapshot. Called under the access
 * lock: it appends `governed.jsonl` rows. A failure never undoes anything; it is reported
 * per harness, and `crewhaus access sync` retries.
 */
export function writeApproverProjections(input: WriteProjectionsInput): ProjectionReport {
  const { root, snapshot, epoch, now, by } = input;
  if (snapshot.owner === undefined) return EMPTY_REPORT;
  const at = new Date(now).toISOString();
  const reader = createApproverReader({ now: () => now });
  const governed = new Map(snapshot.governed.map((row) => [row.id, row]));
  const ledger = accessLedger(root, "governed");
  const report = { written: [] as string[], unchanged: [] as string[], newer: [] as string[] };
  const failed: ProjectionFailure[] = [];
  const seen = new Set<string>();
  for (const harness of input.harnesses) {
    if (seen.has(harness.id)) continue;
    seen.add(harness.id);
    let row: GovernedRow | undefined = governed.get(harness.id);
    if (row === undefined) {
      if (!governsNow(snapshot, harness, now)) continue;
      const fresh: GovernedRow = { id: harness.id, state: "governed", since: at, at, by };
      const sealed = sealTornLine(root, accessPaths().ledgers.governed);
      const appended = sealed.ok && lineBytes(fresh) < 4096 ? append(ledger, fresh) : undefined;
      if (appended === undefined || !appended.ok) {
        failed.push({
          harness: harness.id,
          reason: !sealed.ok
            ? sealed.reason
            : appended === undefined
              ? "its governed row is too large"
              : appended.reason,
        });
        continue;
      }
      row = fresh;
      governed.set(harness.id, fresh);
    }
    const content = projectionContent(snapshot, harness, row.since, now);
    const current = reader(harness.dir);
    if (current.state === "present") {
      const same =
        current.projection.harness === harness.id &&
        normalize(current.projection) === normalize(content);
      if (same) {
        report.unchanged.push(harness.id);
        continue;
      }
      if (current.projection.epoch > epoch) {
        report.newer.push(harness.id);
        continue;
      }
    }
    const failure = writeOne(harness, content, epoch, at);
    if (failure === undefined) report.written.push(harness.id);
    else failed.push(failure);
  }
  return { ...report, failed };
}
