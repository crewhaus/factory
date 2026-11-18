/**
 * Whether the local user may make a change only a harness's owner makes (a
 * protected criterion loosened, a lineage re-anchored over one), decided the way
 * a change to what the harness's settings file allows is decided:
 *
 *  - a command started by an agent's tool (`CREWHAUS_AGENT_TOOL` set and
 *    non-empty): refused before anything is read, because a person makes this
 *    change;
 *  - the harness is governed by the nearest approver projection
 *    (`.crewhaus/run/control/approvers.json`) in its directory or any
 *    directory above it, links resolved, so a directory inside a governed
 *    harness is governed by it;
 *  - no projection there or above: single-owner mode, so the local user is the
 *    owner;
 *  - a projection that cannot be read, or that does not name the Home that
 *    wrote it: refused until `crewhaus access sync` rewrites it;
 *  - otherwise: allowed only for the owner of the harness that projection
 *    belongs to, as the access records of the Home that wrote it link the
 *    local user, and `principal` names them for the record.
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LocalIdentity } from "@crewhaus/access-control";
import { type ApproverRead, readApproverProjection } from "@crewhaus/control-records";
import { type ControlService, currentLocalIdentity } from "@crewhaus/control-service";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { directControl } from "./daemon-cmd";

export type OwnerCheck =
  | { readonly ok: true; readonly principal?: string }
  | { readonly ok: false; readonly reason: string };

/** What the owner check decides through; each defaults to this process's own. */
export type OwnerCheckDeps = {
  /** The decision service; defaults to this terminal's, under `env`'s Hangar root. */
  readonly control?: Pick<ControlService, "decisions">;
  /** The local user; defaults to this process's OS user. */
  readonly identity?: LocalIdentity;
};

/** Why a local user who is not the harness's owner is refused. */
export const NOT_THE_OWNER =
  "the local user is not this harness's owner in the Home that manages it";

/** Why a projection that does not name the Home that wrote it is refused. */
export const UNNAMED_HOME =
  "this harness's list of who may approve does not say which Home wrote it; rewrite it with `crewhaus access sync`";

export function ownerCheck(
  harnessDir: string,
  reader: (harnessDir: string) => ApproverRead = readApproverProjection,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: OwnerCheckDeps = {},
): OwnerCheck {
  const agentTool = env[AGENT_TOOL_ENV];
  if (agentTool !== undefined && agentTool !== "") {
    return {
      ok: false,
      reason: "this command was started by an agent's tool; a person makes this change",
    };
  }
  const governing = governingProjection(harnessDir, reader);
  if (governing === undefined) return { ok: true };
  const { dir, read } = governing;
  if (read.state === "unreadable") {
    return {
      ok: false,
      reason: `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``,
    };
  }
  if (read.projection.accessRoot === undefined) return { ok: false, reason: UNNAMED_HOME };
  const identity = deps.identity ?? currentLocalIdentity();
  const control = deps.control ?? directControl({ env, identity });
  const actor = { kind: "local" as const, identity };
  if (!control.decisions.mayManageRules(dir, actor)) {
    return { ok: false, reason: NOT_THE_OWNER };
  }
  const { principal } = control.decisions.principalOf(actor, dir);
  return principal !== undefined ? { ok: true, principal } : { ok: true };
}

/**
 * The nearest directory, from `harnessDir` (links resolved) up to the filesystem
 * root, that holds an approver projection, with what `reader` read there;
 * `undefined` when none does.
 */
function governingProjection(
  harnessDir: string,
  reader: (harnessDir: string) => ApproverRead,
): { readonly dir: string; readonly read: Exclude<ApproverRead, { state: "absent" }> } | undefined {
  let dir = resolve(harnessDir);
  try {
    dir = realpathSync(dir);
  } catch {
    // A directory that does not exist yet is walked as written.
  }
  for (;;) {
    const read = reader(dir);
    if (read.state !== "absent") return { dir, read };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
