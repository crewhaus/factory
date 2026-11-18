/**
 * Governed-harness fixtures for the CLI's owner checks: a Home's access records under a
 * temporary Hangar root, a local user linked to a principal there, and a harness's
 * approver list written as those records would write it.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalIdentity, ensureAccessSetUp, localActorOf } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";

const MADE: string[] = [];

/** A fresh temporary directory, by its real path, removed by {@link removeGovernedDirs}. */
export function governedTmp(prefix = "crewhaus-governed-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  MADE.push(dir);
  return dir;
}

/** Remove every directory {@link governedTmp} made. */
export function removeGovernedDirs(): void {
  for (const dir of MADE.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A Home whose access records link `owner` (a local user) as its owner. */
export async function governedHome(
  owner: LocalIdentity,
): Promise<{ readonly hangarRoot: string; readonly owner: string }> {
  const hangarRoot = join(governedTmp("crewhaus-governed-home-"), "hangar");
  const done = await ensureAccessSetUp(hangarRoot, { localActor: localActorOf(owner) });
  if (!done.ok) throw new Error(done.reason);
  return { hangarRoot, owner: done.result.owner };
}

/**
 * Plant an active `local` link from `identity` to `principal`, an active member of
 * `hangarRoot`'s records, as the access records hold one.
 */
export function linkTo(
  hangarRoot: string,
  identity: LocalIdentity,
  principal: string,
  by: string,
): void {
  const link = mintId("lnk");
  const at = new Date().toISOString();
  const dir = join(hangarRoot, "access");
  appendFileSync(
    join(dir, "principals.jsonl"),
    `${JSON.stringify({ id: principal, kind: "member", state: "active", at, by })}\n`,
  );
  appendFileSync(
    join(dir, "links.jsonl"),
    `${JSON.stringify({
      id: link,
      principal,
      provider: "local",
      subjectRef: "e".repeat(64),
      verifiedVia: "owner",
      state: "active",
      at,
      by,
    })}\n`,
  );
  const file = join(dir, "subjects.json");
  const subjects = JSON.parse(readFileSync(file, "utf8")) as { links: Record<string, string> };
  subjects.links[link] = localActorOf(identity);
  writeFileSync(file, `${JSON.stringify(subjects, null, 2)}\n`);
}

/** Plant a new member whose active `local` link is `identity`; answers its principal. */
export function linkMember(hangarRoot: string, identity: LocalIdentity, by: string): string {
  const principal = mintId("prn");
  linkTo(hangarRoot, identity, principal, by);
  return principal;
}

/**
 * Write a harness's approver list as Home's access records would: its owner, its members
 * by class, and the real path of the Hangar root that wrote it (`accessRoot`), when given.
 */
export function project(
  harness: string,
  owner: string,
  members: ReadonlyArray<{ readonly principal: string; readonly decide: string }> = [],
  accessRoot?: string,
): void {
  const control = join(harness, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(
    join(control, "approvers.json"),
    `${JSON.stringify({
      v: 1,
      epoch: 1,
      generatedAt: new Date().toISOString(),
      harness: "hrn_00000000000000d1",
      owner,
      governedSince: new Date(Date.now() - 86_400_000).toISOString(),
      members,
      links: [],
      ...(accessRoot !== undefined ? { accessRoot: realpathSync(accessRoot) } : {}),
    })}\n`,
  );
}
