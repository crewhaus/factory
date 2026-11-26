/**
 * Who a receipt says acted. A local user linked to a principal is stored as that `prn_`;
 * an unlinked one as `local:#<keyed digest>` under the key of the ledger's own root, so no
 * record ever holds a user or host name.
 *
 * On a harness with an approver projection, the link counts only when it is read from the
 * Hangar root that projection names (`accessRoot`): the access records under any other
 * root name nobody there, and the digest stands in.
 */
import { realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import {
  type LocalIdentity,
  loadAccessSnapshot,
  localActorOf,
  localPrincipalOf,
} from "@crewhaus/access-control";
import { readApproverProjection, readDigestKey, storedLocalActor } from "@crewhaus/control-records";

/** This process's OS user, as access-control names a local actor. */
export function currentLocalIdentity(): LocalIdentity {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    // No passwd entry (a container's arbitrary uid): fall back to the environment.
    username = process.env["USER"] ?? process.env["USERNAME"] ?? "";
  }
  return { username, hostname: hostname() };
}

/**
 * The principal the access records under `hangarRoot` link `identity` to, as harness
 * `harnessDir` counts it, or `undefined`. The root is resolved to its real path once and
 * the records read are the ones under that path. With `harnessDir` set and an approver
 * projection present there, the link counts only when the projection's `accessRoot` is
 * that same path; a projection that cannot be read counts no link.
 */
function linkedPrincipal(
  hangarRoot: string,
  harnessDir: string | undefined,
  identity: LocalIdentity,
): string | undefined {
  let real: string;
  try {
    real = realpathSync(hangarRoot);
  } catch {
    // A root that does not resolve holds no access records.
    return undefined;
  }
  if (harnessDir !== undefined) {
    const projection = readApproverProjection(harnessDir);
    if (projection.state === "unreadable") return undefined;
    if (projection.state === "present" && projection.projection.accessRoot !== real) {
      return undefined;
    }
  }
  const snapshot = loadAccessSnapshot(real);
  if (snapshot.state !== "present") return undefined;
  return localPrincipalOf(snapshot.snapshot, localActorOf(identity));
}

/**
 * The stored actor for this identity under `key`, for a command on harness `harnessDir`
 * (`undefined` for Home's own workspace ledger). A Home whose access records link the
 * local user answers the linked principal, on a harness with an approver projection only
 * when those records are under the root the projection names; anything else (no link, an
 * absent or unreadable snapshot, a projection that names another root, none or cannot be
 * read) answers the digest, never an error.
 */
export async function storedActorFor(
  hangarRoot: string,
  harnessDir: string | undefined,
  identity: LocalIdentity,
  key: CryptoKey,
): Promise<string> {
  try {
    const principal = linkedPrincipal(hangarRoot, harnessDir, identity);
    if (principal !== undefined) return principal;
  } catch {
    // An access tree or projection that cannot be read is the same as none: the digest stands in.
  }
  return storedLocalActor(key, localActorOf(identity));
}

/**
 * The stored actor {@link storedActorFor} answers for this identity on a harness, as a
 * reader finds it: under the key the harness already has, and none made. `undefined` where
 * no member is linked and there is no key yet, or it cannot be read.
 *
 * First consumer: `crewhaus inbox`, which shows a person what they hid from themselves.
 */
export async function readStoredActor(
  hangarRoot: string,
  harnessDir: string,
  identity: LocalIdentity,
): Promise<string | undefined> {
  const key = await readDigestKey(harnessDir);
  if (key.state === "present") return storedActorFor(hangarRoot, harnessDir, identity, key.hmac);
  try {
    return linkedPrincipal(hangarRoot, harnessDir, identity);
  } catch {
    return undefined;
  }
}
