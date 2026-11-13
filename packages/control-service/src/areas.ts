/**
 * Every area's running code, composed once for every head: the CLI in direct mode and
 * Home. Executors and reconcilers live here, because the CLI runs recovery itself.
 *
 * An area's first change uncomments its own two lines and nothing else. Each placeholder
 * sits between blank lines so two areas editing their own lines never conflict when one is
 * brought current with `main`. Keep the blanks.
 */
import { AREA_MODULES, COMMAND_KINDS } from "@crewhaus/control-contract";
import { CORE_RUNTIME } from "./core-runtime";
import { PROTECTED_ENVIRONMENT_GATE } from "./deployments";
import type { ActivationGate, AreaRuntime, RetireRevoker } from "./executor";

// import { ATTENTION_RUNTIME } from "./areas/attention";

// import { COMPILER_RUNTIME } from "./areas/compiler";

// import { CREATION_RUNTIME } from "./areas/creation";

// import { DELEGATION_RUNTIME } from "./areas/delegation";

// import { HOME_RUNTIME } from "./areas/home";

// import { INSPECTION_RUNTIME } from "./areas/inspection";

// import { INTEGRATIONS_RUNTIME } from "./areas/integrations";

// import { KNOWLEDGE_RUNTIME } from "./areas/knowledge";

// import { PEOPLE_RUNTIME } from "./areas/people";

// import { QUALITY_RUNTIME } from "./areas/quality";

// import { RUNTIME_RUNTIME } from "./areas/runtime";

// import { VERIFICATION_RUNTIME } from "./areas/verification";

export const AREA_RUNTIMES: readonly AreaRuntime[] = [
  CORE_RUNTIME,

  // ATTENTION_RUNTIME,

  // COMPILER_RUNTIME,

  // CREATION_RUNTIME,

  // DELEGATION_RUNTIME,

  // HOME_RUNTIME,

  // INSPECTION_RUNTIME,

  // INTEGRATIONS_RUNTIME,

  // KNOWLEDGE_RUNTIME,

  // PEOPLE_RUNTIME,

  // QUALITY_RUNTIME,

  // RUNTIME_RUNTIME,

  // VERIFICATION_RUNTIME,
];

/**
 * What is wrong with a composition, one line per problem: a kind no area module declares,
 * a kind registered twice, an area no module names, a kind that is not safe to repeat
 * with an executor but no reconciler, which recovery could only ever mark unknown, and a
 * retire revoker name registered twice.
 */
export function compositionProblems(areas: readonly AreaRuntime[]): readonly string[] {
  const problems: string[] = [];
  const known = new Set<string>(AREA_MODULES.map((module) => module.area));
  const kinds = COMMAND_KINDS as Readonly<Record<string, { readonly idempotent: boolean }>>;
  const executors = new Map<string, string>();
  const reconcilers = new Map<string, string>();
  for (const runtime of areas) {
    if (!known.has(runtime.area)) problems.push(`area "${runtime.area}" has no module`);
    for (const [slot, seen] of [
      ["executor", executors],
      ["reconciler", reconcilers],
    ] as const) {
      const entries = slot === "executor" ? runtime.executors : runtime.reconcilers;
      for (const kind of Object.keys(entries ?? {})) {
        if (!Object.hasOwn(kinds, kind)) {
          problems.push(`${slot} for unknown command kind "${kind}" (area "${runtime.area}")`);
        }
        const first = seen.get(kind);
        if (first !== undefined) {
          problems.push(
            `${slot} for "${kind}" registered twice (areas "${first}" and "${runtime.area}")`,
          );
        } else {
          seen.set(kind, runtime.area);
        }
      }
    }
  }
  for (const [kind, area] of executors) {
    if (kinds[kind]?.idempotent === false && !reconcilers.has(kind)) {
      problems.push(
        `"${kind}" is not safe to repeat and has an executor but no reconciler (area "${area}")`,
      );
    }
  }
  const gates = new Map<string, string>();
  for (const runtime of areas) {
    for (const gate of runtime.activationGates ?? []) {
      const first = gates.get(gate.name);
      if (first !== undefined) {
        problems.push(
          `activation gate "${gate.name}" registered twice (areas "${first}" and "${runtime.area}")`,
        );
      } else {
        gates.set(gate.name, runtime.area);
      }
    }
  }
  const order = activationGates(areas);
  const coreGate = areas.some(
    (runtime) =>
      runtime.area === "core" &&
      (runtime.activationGates ?? []).some((gate) => gate.name === PROTECTED_ENVIRONMENT_GATE),
  );
  if (!coreGate) {
    problems.push(`the core's "${PROTECTED_ENVIRONMENT_GATE}" activation gate is missing`);
  } else if (order[0]?.name !== PROTECTED_ENVIRONMENT_GATE) {
    problems.push(`the core's "${PROTECTED_ENVIRONMENT_GATE}" activation gate is not first`);
  }
  const revokers = new Map<string, string>();
  for (const runtime of areas) {
    for (const revoker of runtime.retireRevokers ?? []) {
      const first = revokers.get(revoker.name);
      if (first !== undefined) {
        problems.push(
          `retire revoker "${revoker.name}" registered twice (areas "${first}" and "${runtime.area}")`,
        );
      } else {
        revokers.set(revoker.name, runtime.area);
      }
    }
  }
  return problems;
}

/** Every area's activation gates, flattened in composition order. */
export function activationGates(areas: readonly AreaRuntime[]): readonly ActivationGate[] {
  return areas.flatMap((runtime) => runtime.activationGates ?? []);
}

/** Every area's retire revokers, flattened in composition order. */
export function retireRevokers(areas: readonly AreaRuntime[]): readonly RetireRevoker[] {
  return areas.flatMap((runtime) => runtime.retireRevokers ?? []);
}
