import type { IrSchedule } from "./index";

/**
 * One named schedule lane (#514): an `IrSchedule` plus the name its control
 * lane `schedule:<name>` and its resume scope `lane:schedule:<name>` carry
 * (#513). The name follows the lane grammar (`^[a-z][a-z0-9-]{0,31}$`), which
 * the spec enforces.
 */
export type IrScheduleLane = IrSchedule & { readonly name: string };
