/**
 * Who a receipt says acted. A local user linked to a principal is stored as that `prn_`;
 * an unlinked one as `local:#<keyed digest>` under the key of the ledger's own root, so no
 * record ever holds a user or host name.
 */
import { hostname, userInfo } from "node:os";
import {
  type LocalIdentity,
  loadAccessSnapshot,
  localActorOf,
  localPrincipalOf,
} from "@crewhaus/access-control";
import { storedLocalActor } from "@crewhaus/control-records";

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
 * The stored actor for this identity under `key`. A Home whose access records link the
 * local user answers the linked principal; an absent or unreadable snapshot answers the
 * digest, never an error.
 */
export async function storedActorFor(
  hangarRoot: string,
  identity: LocalIdentity,
  key: CryptoKey,
): Promise<string> {
  const local = localActorOf(identity);
  try {
    const snapshot = loadAccessSnapshot(hangarRoot);
    if (snapshot.state === "present") {
      const principal = localPrincipalOf(snapshot.snapshot, local);
      if (principal !== undefined) return principal;
    }
  } catch {
    // An access tree that cannot be read is the same as none: the digest stands in.
  }
  return storedLocalActor(key, local);
}
