/**
 * runtime-core's compaction codegen twin takes a structural input and imports
 * nothing, so nothing at its own site ties it to the IR or to the loop. This
 * holds both ends at compile time: the IR's compaction block is a valid input,
 * and the options it returns are `runChatLoop` options under the same names
 * and types. It lives here because target-cli is the package that depends on
 * both `@crewhaus/ir` and `@crewhaus/runtime-core`. Types only; nothing imports
 * this file.
 */
import type { IrCompaction } from "@crewhaus/ir";
import type { RunChatLoopOptions } from "@crewhaus/runtime-core";
import type {
  CompactionSettings,
  compactionRunOptions,
} from "@crewhaus/runtime-core/compaction-codegen";

type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
  ? true
  : false;

type Expect<Check extends true> = Check;

type Assignable<From, To> = [From] extends [To] ? true : false;

type LoopCompactionOptions = Pick<
  RunChatLoopOptions,
  | "compactionModel"
  | "compactionParams"
  | "compactionThreshold"
  | "snipKeepHead"
  | "snipKeepTail"
  | "curate"
>;

/** The lowered block is a valid input. */
export type IrCompactionIsInput = Expect<Assignable<IrCompaction, CompactionSettings>>;

/** The options are the loop's own. */
export type OptionsAreLoopOptions = Expect<
  Assignable<ReturnType<typeof compactionRunOptions>, LoopCompactionOptions>
>;

/** A mistyped field is not a valid input, so the checks above bite. */
type MistypedParams = Assignable<
  { readonly params: { readonly maxTokens: string } },
  CompactionSettings
>;

export type MistypedParamsFails = Expect<Equals<MistypedParams, false>>;

/** A wrong effort preset is not one the loop takes either. */
type WrongEffort = Assignable<
  { readonly compactionParams: { readonly thinking: { readonly effort: "max" } } },
  LoopCompactionOptions
>;

export type WrongEffortFails = Expect<Equals<WrongEffort, false>>;
