/**
 * `homeAuthorizeActor`: the one `authorizeActor` every head passes `wireControl`, so a
 * command dispatched from its receipt, when it is submitted, recovered or started as a job,
 * is checked against Home's access records as they are at that moment, from Home and from
 * the CLI alike.
 */
import { type DomainChecker, loadAccessSnapshot, queuedActorHolds } from "@crewhaus/access-control";
import { parseRef } from "@crewhaus/control-contract";
import type { ControlDeps } from "./wire";

export type HomeAuthorizeOptions = {
  /** Home's root, where the access records live. */
  readonly hangarRoot: string;
  /** The groups a registered harness is in, for a grant on a group. */
  readonly groupsOf: (hrn: string) => readonly string[];
  readonly now: () => number;
  /** The checkers of the permission domains this head registers; without one, a domain permission is refused. */
  readonly domains?: ReadonlyMap<string, DomainChecker>;
};

/**
 * Whether a receipt's actor still holds its permission on what its target names, through
 * exactly the credential it names when it names one, over a fresh read of the access
 * records: `true`, `false`, or `undefined` while the records are not there to answer.
 */
export function homeAuthorizeActor(
  options: HomeAuthorizeOptions,
): NonNullable<ControlDeps["authorizeActor"]> {
  return (actor, permission, target, credentialRef) => {
    const read = loadAccessSnapshot(options.hangarRoot);
    if (read.state !== "present") return undefined;
    const parsed = parseRef(target);
    const harness =
      "error" in parsed
        ? undefined
        : parsed.kind === "harness"
          ? parsed.id
          : parsed.scope !== "home"
            ? parsed.scope
            : undefined;
    const at =
      harness === undefined
        ? ({ scope: "home" } as const)
        : { scope: "harness" as const, harness, groups: options.groupsOf(harness) };
    return queuedActorHolds(
      read.snapshot,
      credentialRef !== undefined ? { actor, credentialRef } : { actor },
      permission,
      at,
      {
        now: options.now(),
        ...(options.domains !== undefined ? { domains: options.domains } : {}),
      },
    );
  };
}
