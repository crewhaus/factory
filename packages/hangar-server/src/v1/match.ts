/**
 * The versioned API's route table is its operation table: a `/api/v1/…` request matches an
 * operation row of `@crewhaus/control-contract`, through the same path params the contract
 * declares (a three-segment `{ref}` included), and answers a route-table row built from it,
 * so Home's one choke point authorizes it like any other row.
 */
import {
  COMMAND_KINDS,
  OPERATIONS,
  type OperationRow,
  isPathParam,
  pathParamSpans,
} from "@crewhaus/control-contract";
import type { RequestMatch } from "../route-match";
import type { RouteRow } from "../route-table";

type Piece = { readonly literal: string } | { readonly param: string };

type Template = {
  readonly op: OperationRow;
  readonly row: RouteRow;
  readonly pieces: readonly Piece[];
  readonly literals: number;
};

/** The route-table row an operation is authorized as. */
export function rowOf(op: OperationRow): RouteRow {
  const kind = Object.hasOwn(COMMAND_KINDS, op.id) ? op.id : undefined;
  return {
    key: op.id,
    method: op.method,
    path: op.path,
    permission: op.permission,
    qualifiers: op.qualifiers,
    receipt: op.receipt,
    ...(kind !== undefined ? { kind } : {}),
    ...(op.secretFields !== undefined ? { secretFields: op.secretFields } : {}),
    ...(op.noReceiptReason !== undefined ? { noReceiptReason: op.noReceiptReason } : {}),
    cliTwin: op.cliTwin,
    v1: true,
  };
}

const TEMPLATES: readonly Template[] = OPERATIONS.map((op) => {
  const pieces = op.path
    .split("/")
    .filter((part) => part !== "")
    .map((part): Piece => {
      const param = /^\{(\w+)\}$/.exec(part)?.[1];
      return param === undefined ? { literal: part } : { param };
    });
  return {
    op,
    row: rowOf(op),
    pieces,
    literals: pieces.filter((piece) => "literal" in piece).length,
  };
});

/** Every operation by its id. */
export const OPERATION_BY_ID: ReadonlyMap<string, OperationRow> = new Map(
  OPERATIONS.map((op) => [op.id, op]),
);

/** The v1 route-table row of every operation, by its id. */
export const V1_ROWS: ReadonlyMap<string, RouteRow> = new Map(
  TEMPLATES.map((template) => [template.op.id, template.row]),
);

function matchPieces(
  pieces: readonly Piece[],
  segments: readonly string[],
): Record<string, string> | undefined {
  const walk = (
    p: number,
    s: number,
    params: Record<string, string>,
  ): Record<string, string> | undefined => {
    if (p === pieces.length) return s === segments.length ? params : undefined;
    const piece = pieces[p] as Piece;
    if ("literal" in piece) {
      return segments[s] === piece.literal ? walk(p + 1, s + 1, params) : undefined;
    }
    for (const span of pathParamSpans(piece.param)) {
      const taken = segments.slice(s, s + span);
      if (taken.length !== span || taken.some((part) => part === "")) continue;
      if (!isPathParam(piece.param, taken)) continue;
      const found: Record<string, string> | undefined = walk(p + 1, s + span, {
        ...params,
        [piece.param]: taken.join("/"),
      });
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(0, 0, {});
}

/**
 * The operation a request names, as a route-table row and its params, or `undefined` when
 * no operation declares it. `segments` is the decoded path split without the empty first
 * piece (`["api", "v1", "harnesses"]`). Among matches, the most literal segments win.
 */
export function matchOperation(
  method: string,
  segments: readonly string[],
): RequestMatch | undefined {
  let best: { row: RouteRow; params: Record<string, string> } | undefined;
  let score = -1;
  for (const template of TEMPLATES) {
    if (template.op.method !== method) continue;
    const params = matchPieces(template.pieces, segments);
    if (params !== undefined && template.literals > score) {
      best = { row: template.row, params };
      score = template.literals;
    }
  }
  return best;
}
