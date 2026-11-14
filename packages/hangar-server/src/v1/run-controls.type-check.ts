/**
 * Home answers a harness's run controls from `SHAPE_RUN_CONTROLS`, by the harness's
 * compiler shape. This holds that table to the compiler's targets at compile time: a new
 * target shape fails `tsc -b` until the table has a row for it, or it joins the targets
 * with no run controls below. Types only; nothing imports this file.
 */
import type { RunControlShape } from "@crewhaus/control-contract";
import type { IrNode } from "@crewhaus/ir";

/** Targets with no run controls: graded, or answering to a chain. */
type NoRunControls = "eval" | "onchain" | "onchain-game";

type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
  ? true
  : false;

type Expect<Check extends true> = Check;

export type RunControlShapeCheck = Expect<
  Equals<RunControlShape, Exclude<IrNode["target"], NoRunControls>>
>;

/** A table that missed a shape would not equal the targets: the check bites. */
type MissingCli = Equals<Exclude<RunControlShape, "cli">, Exclude<IrNode["target"], NoRunControls>>;

export type RunControlShapeCheckBites = Expect<Equals<MissingCli, false>>;
