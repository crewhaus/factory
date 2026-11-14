/**
 * The two pieces the gateway and `./managed-runs` share, in a module of their
 * own so `./managed-runs` never loads the server to use them.
 */
import { CrewhausError } from "@crewhaus/errors";

/**
 * The brand a handler made by `createManagedRuns` carries, as a non-enumerable
 * property. A branded handler is handed the run input's verdict
 * (`RunHandler`'s `inputVerdict`) and records a refused input as a failed run
 * before it answers `input_blocked`; every other handler is refused before it
 * is called. `Symbol.for`, so two copies of this package in one bundle agree.
 */
export const MANAGED_RUN_HANDLER: unique symbol = Symbol.for(
  "@crewhaus/gateway-server/managed-run-handler",
);

/**
 * What a branded handler carries of the control plane it was given: whether its
 * daemon takes a client's own run handle right now. A handler made without a
 * plane carries nothing, and its requests are decoded strictly.
 */
export const MANAGED_RUN_PLANE: unique symbol = Symbol.for(
  "@crewhaus/gateway-server/managed-run-plane",
);

/** The part of a control plane a branded handler carries. */
export type ManagedRunPlane = { readonly clientRunIds?: () => boolean };

/**
 * Whether requests for `handler` take `idempotency` and `runId`: a branded handler whose
 * plane says so (`ControlPlane.clientRunIds`). Asked per request; a throw is a no.
 */
export function clientRunIdsOf(handler: unknown): boolean {
  if (!isManagedRunHandler(handler)) return false;
  const plane = (handler as unknown as Record<symbol, ManagedRunPlane | undefined>)[
    MANAGED_RUN_PLANE
  ];
  try {
    return plane?.clientRunIds?.() === true;
  } catch {
    return false;
  }
}

/** Whether `handler` carries {@link MANAGED_RUN_HANDLER}. */
export function isManagedRunHandler(handler: unknown): boolean {
  return (
    typeof handler === "function" &&
    (handler as unknown as Record<symbol, unknown>)[MANAGED_RUN_HANDLER] === true
  );
}

/**
 * A handler's refusal with a wire `ErrorCode` of its own: the gateway answers
 * it with this `wireCode`, `message` and `data`, at the code's HTTP status.
 * The codes it maps are `input_blocked`, `unsupported`, `bad_request` and
 * `conflict`; any other answers `internal_error`.
 */
export class GatewayCodedError extends CrewhausError {
  override readonly name = "GatewayCodedError";
  readonly wireCode: string;
  readonly data: unknown;
  constructor(wireCode: string, message: string, data?: unknown) {
    super("config", message);
    this.wireCode = wireCode;
    this.data = data;
  }
}
