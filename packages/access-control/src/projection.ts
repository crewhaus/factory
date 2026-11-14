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
 * file is absent or unreadable. A harness the change does not touch keeps its file and its
 * older `epoch`. Every change moves the access revision above the highest `epoch` of any
 * registered harness's file, so a lost or rewound `revision.json` never leaves a file
 * ahead of the records; a file still ahead when it is written is reported as not updated.
 *
 * When the owner set the address Home is reached at (`links.baseUrl` in the Hangar
 * settings file), the projection carries it as `homeUrl`, so a chat card can send a person
 * to review a request there. It is part of the content: a changed address rewrites the
 * file at the next access write or `crewhaus access sync`.
 */
import { statSync } from "node:fs";
import {
  type ApproverProjection,
  type DecisionClass,
  type Role,
  parseLinkSubject,
} from "@crewhaus/control-contract";
import { append, controlPaths, createApproverReader } from "@crewhaus/control-records";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { type AccessTarget, coveringGrants, credentialHolds } from "./authorize";
import { sealTornLine } from "./files";
import { readOwnerSettings } from "./owner-settings";
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
  /** Governed harnesses that could not be updated, each with why. */
  readonly failed: readonly ProjectionFailure[];
};

export const EMPTY_REPORT: ProjectionReport = Object.freeze({
  written: [],
  unchanged: [],
  failed: [],
});

type Content = Pick<
  ApproverProjection,
  "owner" | "governedSince" | "members" | "links" | "homeUrl"
>;

let writeTap: ((harness: string) => void) | undefined;

/** Test seam: count projection writes. Pass `undefined` to restore. */
export function _setProjectionWriteTapForTest(next: ((harness: string) => void) | undefined): void {
  writeTap = next;
}

function targetOf(harness: AccessHarness): AccessTarget {
  return { scope: "harness", harness: harness.id, groups: harness.groups };
}

/**
 * The highest `epoch` among the approver files of these harnesses, or 0. Unreadable files
 * count for nothing. The next access revision is set above it.
 */
export function highestProjectionEpoch(harnesses: readonly AccessHarness[], now: number): number {
  const reader = createApproverReader({ now: () => now });
  let highest = 0;
  for (const harness of harnesses) {
    const current = reader(harness.dir);
    if (current.state !== "present") continue;
    const epoch = current.projection.epoch;
    if (epoch > highest && Number.isSafeInteger(epoch + 1)) highest = epoch;
  }
  return highest;
}

/**
 * The highest class a member's grants let them decide at, counting only grants with no
 * end time: the harness's file carries no end time, so an expiring grant is never copied
 * into it as a decider.
 */
function standingRole(
  snapshot: AccessSnapshot,
  principal: string,
  target: AccessTarget,
  now: number,
): Role | null {
  const grant = coveringGrants(snapshot, principal, target, now).find(
    (row) => row.expiresAt === undefined,
  );
  return grant?.role ?? null;
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
    return decidingCredentials(snapshot, principal, harness, now).length > 0 ? "operator" : null;
  }
  const role = standingRole(snapshot, principal, target, now);
  return role === null || role === "viewer" ? null : role;
}

/** A service principal's live credentials that may resolve decisions on the harness. */
function decidingCredentials(
  snapshot: AccessSnapshot,
  principal: string,
  harness: AccessHarness,
  now: number,
): AccessSnapshot["tokens"] {
  const target = targetOf(harness);
  return snapshot.tokens.filter(
    (credential) =>
      credential.principal === principal &&
      credential.kind === "service" &&
      isLiveCredential(snapshot, credential, now) &&
      credentialHolds(credential, "h.decision.resolve", target),
  );
}

/**
 * When a member's authority to decide on the harness ends on its own, as an ISO
 * instant, or `undefined` when it does not. Only a service's does: it decides
 * through credentials that expire, so its member row carries the latest end time
 * among the live ones that may resolve decisions there, and every reader stops
 * counting it at that instant, however long ago the file was written. A member's
 * grants are copied in only when they have no end time (see `standingRole`), and
 * the owner never ends.
 */
export function decideUntilOf(
  snapshot: AccessSnapshot,
  principal: string,
  harness: AccessHarness,
  now: number,
): string | undefined {
  const row = principalOf(snapshot, principal);
  if (row === undefined || row.kind !== "service" || principal === snapshot.owner) return undefined;
  let latest: number | undefined;
  for (const credential of decidingCredentials(snapshot, principal, harness, now)) {
    // A credential with no end time decides until it is revoked: nothing ends on its own.
    if (credential.expiresAt === undefined) return undefined;
    const ends = Date.parse(credential.expiresAt);
    if (Number.isFinite(ends) && (latest === undefined || ends > latest)) latest = ends;
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
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

/**
 * The content a projection must hold now. Sorted, so equal access gives equal bytes.
 * `homeUrl` is the address Home is reached at, when the owner set one.
 */
export function projectionContent(
  snapshot: AccessSnapshot,
  harness: AccessHarness,
  governedSince: string,
  now: number,
  homeUrl?: string,
): Content {
  const owner = snapshot.owner as string;
  const members: { principal: string; decide: DecisionClass; until?: string }[] = [];
  for (const principal of snapshot.principals) {
    if (principal.id === owner) continue;
    const decide = decideClassOf(snapshot, principal.id, harness, now);
    if (decide === null) continue;
    const until = decideUntilOf(snapshot, principal.id, harness, now);
    members.push({ principal: principal.id, decide, ...(until !== undefined ? { until } : {}) });
  }
  members.sort((a, b) => byText(a.principal, b.principal));
  const deciders = new Set([owner, ...members.map((member) => member.principal)]);
  const links = liveSlackLinks(snapshot)
    .filter((link) => deciders.has(link.principal))
    .map((link) => ({ external: link.external, principal: link.principal }))
    .sort((a, b) => byText(a.external, b.external) || byText(a.principal, b.principal));
  return { owner, governedSince, members, links, ...(homeUrl !== undefined ? { homeUrl } : {}) };
}

function normalize(content: Content): string {
  return JSON.stringify({
    owner: content.owner,
    governedSince: content.governedSince,
    members: content.members
      .map((member) => ({
        principal: member.principal,
        decide: member.decide,
        ...(member.until !== undefined ? { until: member.until } : {}),
      }))
      .sort((a, b) => byText(a.principal, b.principal)),
    links: content.links
      .map((link) => ({ external: link.external, principal: link.principal }))
      .sort((a, b) => byText(a.external, b.external) || byText(a.principal, b.principal)),
    ...(content.homeUrl !== undefined ? { homeUrl: content.homeUrl } : {}),
  });
}

/**
 * The owner's `links.baseUrl` under the Hangar root, as the projection carries it. Owner
 * settings that cannot be read leave it out; they never fail a projection write.
 */
function ownerHomeUrl(root: string): string | undefined {
  try {
    const read = readOwnerSettings(root);
    return read.ok ? read.settings.baseUrl : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Whether any approver list is behind the snapshot right now: a governed harness whose
 * file is absent, unreadable or holds other content than the snapshot gives at `now`
 * (a group move, or a deciding credential past its end, changes that content), or a
 * harness a grant has newly come to cover. A read: no lock, no write, one reader made for
 * this call, so a file is read now. A harness whose directory is missing is not counted:
 * no write could reach it.
 */
export function projectionsBehind(input: {
  readonly root: string;
  readonly snapshot: AccessSnapshot;
  readonly harnesses: readonly AccessHarness[];
  readonly now: number;
}): boolean {
  const { root, snapshot, now } = input;
  if (snapshot.owner === undefined) return false;
  const reader = createApproverReader({ now: () => now });
  const homeUrl = ownerHomeUrl(root);
  const governed = new Map(snapshot.governed.map((row) => [row.id, row]));
  for (const harness of input.harnesses) {
    if (!dirExists(harness.dir)) continue;
    const row = governed.get(harness.id);
    if (row === undefined) {
      if (governsNow(snapshot, harness, now)) return true;
      continue;
    }
    const current = reader(harness.dir);
    if (current.state !== "present") return true;
    const content = projectionContent(snapshot, harness, row.since, now, homeUrl);
    if (
      current.projection.harness !== harness.id ||
      normalize(current.projection) !== normalize(content)
    ) {
      return true;
    }
  }
  return false;
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
  const homeUrl = ownerHomeUrl(root);
  const governed = new Map(snapshot.governed.map((row) => [row.id, row]));
  const ledger = accessLedger(root, "governed");
  const report = { written: [] as string[], unchanged: [] as string[] };
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
    const content = projectionContent(snapshot, harness, row.since, now, homeUrl);
    const current = reader(harness.dir);
    if (current.state === "present") {
      const same =
        current.projection.harness === harness.id &&
        normalize(current.projection) === normalize(content);
      if (same) {
        report.unchanged.push(harness.id);
        continue;
      }
      // The revision is set above every file before this runs, so a file still ahead of
      // it was not written by these records: report it rather than write behind it.
      if (current.projection.epoch > epoch) {
        failed.push({
          harness: harness.id,
          reason: "its list names a later revision than the access records",
        });
        continue;
      }
    }
    const failure = writeOne(harness, content, epoch, at);
    if (failure === undefined) report.written.push(harness.id);
    else failed.push(failure);
  }
  return { ...report, failed };
}
