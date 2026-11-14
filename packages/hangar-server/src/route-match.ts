/**
 * The one matcher every `/api` request goes through: the choke point uses it to find the
 * row it authorizes against, and the receipts middleware to find the row it writes a
 * receipt for, so the two can never disagree about which route a request is.
 *
 * The server's own dispatch order: the M3 table first (literal-first, a param that fails
 * its shape guard does not match), then the hand-written routes, literal-first too.
 */
import { M3_ROUTES, matchM3 } from "./m3-routes";
import { ROUTE_BY_KEY, type RouteRow, matchRoute } from "./route-table";
import { matchOperation } from "./v1/match";

const M3_KEYS: ReadonlySet<string> = new Set(M3_ROUTES.map((route) => route.key));

export type RequestMatch = {
  readonly row: RouteRow;
  readonly params: Readonly<Record<string, string>>;
};

/**
 * The route-table row for a request, or `undefined` when no row declares it. `segments` is
 * the decoded path split without the empty first piece (`["api", "h", "hrn_…", "spec"]`).
 * HEAD and OPTIONS are no row's method, so they never match.
 */
export function matchRequest(
  method: string,
  segments: readonly string[],
): RequestMatch | undefined {
  // The versioned API, sign-in aside: its operation table is its route table.
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] !== "auth") {
    return matchOperation(method, segments);
  }
  const m3 = matchM3(method, segments);
  if (m3 !== undefined) {
    const row = ROUTE_BY_KEY.get(m3.route.key);
    return row === undefined ? undefined : { row, params: m3.params };
  }
  return matchRoute(method, segments, (row) => !M3_KEYS.has(row.key));
}
