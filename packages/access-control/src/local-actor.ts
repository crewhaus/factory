/**
 * The local actor: the OS user who owns the Hangar root, as `local:<user>@<host>`. A user
 * name rather than a numeric uid, because Windows has none. It is a person identifier: an
 * append-only record never holds it, only the readable mapping in `access/subjects.json`.
 */
import { LOCAL_ACTOR_RE } from "@crewhaus/control-contract";

const USER_MAX = 64;
const HOST_MAX = 253;

export type LocalIdentity = {
  readonly username: string;
  readonly hostname: string;
};

/**
 * `local:<user>@<host>`, always matching `LOCAL_ACTOR_RE`. The host is lowercased; a
 * character outside a part's class (`[A-Za-z0-9._-]` for the user, `[A-Za-z0-9.-]` for the
 * host) becomes `-`; each part is clamped to the grammar's length; an empty part becomes
 * `user` or `localhost`. The identity is injected: the CLI passes `os.userInfo().username`
 * and `os.hostname()`.
 *
 * First consumer: `crewhaus access`, which acts as this actor in direct mode.
 */
export function localActorOf(identity: LocalIdentity): string {
  const user =
    String(identity.username ?? "")
      .replace(/[^A-Za-z0-9._-]/gu, "-")
      .slice(0, USER_MAX) || "user";
  const host =
    String(identity.hostname ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9.-]/gu, "-")
      .slice(0, HOST_MAX) || "localhost";
  const actor = `local:${user}@${host}`;
  if (!LOCAL_ACTOR_RE.test(actor)) {
    throw new Error("access-control: the local identity does not form a local actor");
  }
  return actor;
}
