/**
 * The approver projection: the harness's own copy of who may decide what, for daemons
 * and the runtime, which must never depend on Hangar being up. Absent means single-owner
 * mode, present means enforced, unreadable fails closed; the consequences are the
 * consumers'. Local actors are never projected. A member's `until`, when present,
 * is the instant its authority ends: `memberMayDecide` (control-contract) counts it
 * only before then, so a member whose credential has ended stops counting at that
 * instant, however long ago the file was written.
 */
import {
  type ApproverProjection,
  DECISION_CLASSES,
  type VerifyApprovers,
  isId,
  parseLinkSubject,
} from "@crewhaus/control-contract";
import { cachedPerPath, isCount, readWholeRecord } from "./fail-closed";
import { asObject } from "./io";
import { controlPaths } from "./paths";

const PROJECTION_MAX_BYTES = 1024 * 1024;

/** This constraint is the check that an answer can go straight to `verifyDecision`. */
type HandsToVerify<T extends VerifyApprovers> = T;

export type ApproverRead = HandsToVerify<
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly projection: ApproverProjection }
  | { readonly state: "unreadable"; readonly reason: string }
>;

/** The fault in a body, or `undefined` when it is a projection. Unknown keys stay on it. */
function projectionFault(body: Record<string, unknown>): string | undefined {
  if (body["v"] !== 1) return "its version is not 1";
  if (!isCount(body["epoch"])) return "epoch is not a non-negative integer";
  if (typeof body["generatedAt"] !== "string") return "generatedAt is not a string";
  if (typeof body["governedSince"] !== "string") return "governedSince is not a string";
  if (!isId("hrn", body["harness"])) return "harness is not a harness id";
  if (!isId("prn", body["owner"])) return "owner is not a principal id";
  const { members, links } = body;
  if (!Array.isArray(members)) return "members is not an array";
  if (!Array.isArray(links)) return "links is not an array";
  const classes: readonly unknown[] = DECISION_CLASSES;
  for (const raw of members) {
    const member = asObject(raw);
    if (member === undefined) return "a member is not an object";
    if (!isId("prn", member["principal"])) return "a member's principal is not a principal id";
    if (!classes.includes(member["decide"])) return "a member's decide is not a decision class";
    // An end time is enforced by every reader, so one that is not text fails closed here.
    if (member["until"] !== undefined && typeof member["until"] !== "string") {
      return "a member's until is not a string";
    }
  }
  for (const raw of links) {
    const link = asObject(raw);
    if (link === undefined) return "a link is not an object";
    if (!isId("prn", link["principal"])) return "a link's principal is not a principal id";
    const provider = parseLinkSubject(link["external"]);
    if (provider === null) return "a link's external is not a link subject";
    if (provider === "local") return "a link's external is a local actor, which is never projected";
  }
  return undefined;
}

/** A loopback host as a URL spells it: `localhost`, `127.x.x.x` or `[::1]`. */
function loopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * `homeUrl` as a reader may use it: an https origin, or http on a loopback host, with no
 * user name or password. Anything else is `undefined`.
 */
function homeUrlOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") return undefined;
  const ok = url.protocol === "https:" || (url.protocol === "http:" && loopbackHost(url.hostname));
  return ok ? url.origin : undefined;
}

function readApproversNow(harnessDir: string): ApproverRead {
  const rel = controlPaths(harnessDir).approversFile;
  const read = readWholeRecord(harnessDir, rel, PROJECTION_MAX_BYTES);
  if (read.state !== "body") return read;
  const fault = projectionFault(read.body);
  if (fault !== undefined) return { state: "unreadable", reason: `${rel}: ${fault}` };
  // A Home address that is not one is left out, never a fault: a card falls back to the
  // host and the verb.
  const { homeUrl: given, ...rest } = read.body;
  const homeUrl = homeUrlOf(given);
  const projection = { ...rest, ...(homeUrl !== undefined ? { homeUrl } : {}) };
  return { state: "present", projection: projection as unknown as ApproverProjection };
}

/**
 * A reader over `approvers.json`: synchronous, no lock, creates nothing, consults no
 * environment variable, and caches for one second per path by the injected clock.
 *
 * First consumer: the runtime's consume check.
 */
export function createApproverReader(
  options: { readonly now?: () => number } = {},
): (harnessDir: string) => ApproverRead {
  return cachedPerPath(readApproversNow, options.now ?? (() => Date.now()));
}

/**
 * The default reader. An answer can be handed straight to `verifyDecision` as `approvers`.
 *
 * First consumer: the runtime's consume check.
 */
export const readApproverProjection: (harnessDir: string) => ApproverRead = createApproverReader();
