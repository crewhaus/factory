/**
 * The delegation ceiling (#514, #517): how long an owner's delegation rules on this
 * harness may last, lowered from `permissions.delegation`. Carried on `IrPermissions`
 * only when the spec declares it, so it moves the policy revision and nothing an emitter
 * prints. The control plane reads it from the active deployment's record.
 */
export type IrDelegationCeiling = {
  /** 1 to 90; 30 when the spec names none. */
  readonly maxDays: number;
};
