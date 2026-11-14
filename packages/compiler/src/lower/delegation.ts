import type { IrDelegationCeiling } from "@crewhaus/ir";

/** The ceiling's `max_days` when the spec names none. */
export const DEFAULT_CEILING_DAYS = 30;

/**
 * Lower `permissions.delegation` (#514): `{}` when the spec does not declare it, so a
 * spec without it lowers to the same IR, else `{delegation: {maxDays}}`. It lowers in the
 * one place every shape's permissions lower; no emitter reads it.
 */
export function lowerDelegation(
  permissions: { readonly delegation?: { readonly max_days?: number } | undefined } | undefined,
): { readonly delegation?: IrDelegationCeiling } {
  const block = permissions?.delegation;
  if (block === undefined) return {};
  return { delegation: { maxDays: block.max_days ?? DEFAULT_CEILING_DAYS } };
}
