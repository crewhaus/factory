/**
 * Home's own key and the boot tickets moved to `@crewhaus/access-control`, which decides
 * who signs in (`authenticate`, the boot exchange, device keys and sessions). They are
 * re-exported here for one release, so code that imported them from this package keeps
 * compiling; import them from `@crewhaus/access-control`.
 */
export {
  BOOT_TICKET_TTL_MS,
  type BootTickets,
  TOKEN_FILENAME,
  type TokenSetup,
  createBootTickets,
  ensureToken,
  tokenEquals,
} from "@crewhaus/access-control";
import { tokenEquals } from "@crewhaus/access-control";

/**
 * True when the request carries `Authorization: Bearer <expected>`. Home no longer
 * calls it: every request passes `authenticate()` from `@crewhaus/access-control`.
 * Kept for one release for code that imported it.
 */
export function isAuthorized(req: Request, expected: string): boolean {
  const header = req.headers.get("authorization");
  if (header === null) return false;
  const [scheme, ...rest] = header.split(" ");
  if (scheme === undefined || scheme.toLowerCase() !== "bearer") return false;
  const presented = rest.join(" ").trim();
  if (presented.length === 0) return false;
  return tokenEquals(presented, expected);
}
