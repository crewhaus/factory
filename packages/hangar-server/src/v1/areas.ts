/**
 * Home's area slots: what each area hands Home to run while it runs. One entry per area,
 * in the order the contract composes them. An area's first change uncomments its own
 * lines and nothing else; each placeholder sits between blank lines so two areas editing
 * their own lines never conflict. Keep the blanks.
 *
 * Only the slots something iterates are here: the sweeps Home's tick runs, and the
 * receivers its ingress listener answers for. Home's boot refuses a composition with a
 * sweep named twice or run more often than once a second, and a receiver whose provider is
 * named twice or is not a provider name, whose origin is not a `TrustOrigin`, whose `via`
 * is not a receipt door or whose kind is not a receipt kind (`homeCompositionProblems`).
 */
import { type Receiver, receiverProblems } from "../ingress";
import type { Sweep } from "../scheduler-host";
import { CORE_SWEEPS, type HomePorts } from "../sweeps";

export type HomeAreaRuntime = {
  readonly area: string;
  /** What Home's tick runs for this area, in order. */
  readonly sweeps?: readonly Sweep<HomePorts>[];
  /** The deliveries this area receives on Home's ingress listener. */
  readonly receivers?: readonly Receiver[];
};

/** The core's own entry: Home's control core, first. */
export const HOME_CORE: HomeAreaRuntime = {
  area: "core",
  sweeps: CORE_SWEEPS,
};

export const HOME_AREAS: readonly HomeAreaRuntime[] = [
  HOME_CORE,

  // HOME_ATTENTION,

  // HOME_COMPILER,

  // HOME_CREATION,

  // HOME_DELEGATION,

  // HOME_HOME,

  // HOME_INSPECTION,

  // HOME_INTEGRATIONS,

  // HOME_KNOWLEDGE,

  // HOME_PEOPLE,

  // HOME_QUALITY,

  // HOME_RUNTIME,

  // HOME_VERIFICATION,
];

/** The shortest period a sweep may run at. */
export const MIN_SWEEP_EVERY_MS = 1000;

/** Every sweep, flattened in composition order. */
export function sweepsOf(areas: readonly HomeAreaRuntime[]): readonly Sweep<HomePorts>[] {
  return areas.flatMap((area) => area.sweeps ?? []);
}

/** Every receiver, flattened in composition order. */
export function receiversOf(areas: readonly HomeAreaRuntime[]): readonly Receiver[] {
  return areas.flatMap((area) => area.receivers ?? []);
}

/**
 * What is wrong with a composition, one line per problem: a sweep named twice or run more
 * often than {@link MIN_SWEEP_EVERY_MS}, and every receiver problem (`receiverProblems`).
 */
export function homeCompositionProblems(areas: readonly HomeAreaRuntime[]): readonly string[] {
  const problems: string[] = [];
  const sweeps = new Map<string, string>();
  for (const area of areas) {
    for (const sweep of area.sweeps ?? []) {
      const first = sweeps.get(sweep.name);
      if (first !== undefined) {
        problems.push(
          `sweep "${sweep.name}" registered twice (areas "${first}" and "${area.area}")`,
        );
      } else {
        sweeps.set(sweep.name, area.area);
      }
      if (!Number.isFinite(sweep.everyMs) || sweep.everyMs < MIN_SWEEP_EVERY_MS) {
        problems.push(
          `sweep "${sweep.name}" runs every ${sweep.everyMs} ms, more often than once a second (area "${area.area}")`,
        );
      }
    }
  }
  problems.push(
    ...receiverProblems(
      areas.flatMap((area) =>
        (area.receivers ?? []).map((receiver) => ({ area: area.area, receiver })),
      ),
    ),
  );
  return problems;
}
