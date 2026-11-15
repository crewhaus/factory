/**
 * The `authorizeActor` every CLI head passes `wireControl`: the one Home passes, over the
 * access records under this Home's root and the groups the machine's registry gives each
 * harness. A command the CLI dispatches from its receipt, when it submits or recovers it,
 * runs only while its actor still holds the permission. The CLI registers no permission
 * domain, so a domain's permission is refused here.
 */
import { type ControlDeps, homeAuthorizeActor } from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";

export type CliAuthorityOptions = {
  /** Home's root, where the access records live. */
  readonly hangarRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
};

export function cliAuthorizeActor(
  options: CliAuthorityOptions,
): NonNullable<ControlDeps["authorizeActor"]> {
  return homeAuthorizeActor({
    hangarRoot: options.hangarRoot,
    // Read per question. A registry that cannot be read puts the harness in no group,
    // which can only narrow what a grant covers.
    groupsOf: (hrn) => {
      try {
        return (
          openHangarRegistry({ ...(options.env !== undefined ? { env: options.env } : {}) }).get(
            hrn,
          )?.groups ?? []
        );
      } catch {
        return [];
      }
    },
    now: options.now ?? Date.now,
  });
}
