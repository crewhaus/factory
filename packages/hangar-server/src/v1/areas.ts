/**
 * Home's area slots: what each area hands Home to run while it runs and to serve its
 * versioned-API operations. One entry per area, in the order the contract composes them.
 * An area's first change uncomments its own lines and nothing else; each placeholder sits
 * between blank lines so two areas editing their own lines never conflict. Keep the blanks.
 *
 * Only the slots something iterates are here: the sweeps Home's tick runs, the receivers
 * its ingress listener answers for, handlers by operation id, ref resolvers by ref kind,
 * and capability providers. Home's boot refuses a composition with a sweep named twice or
 * run more often than once a second; a receiver whose provider is named twice or is not a
 * provider name, whose origin is not a `TrustOrigin`, whose `via` is not a receipt door or
 * whose kind is not a receipt kind; a handler for an operation no module declares, a
 * handler or a ref kind registered twice, or an area with no module
 * (`homeCompositionProblems`).
 */
import { AREA_MODULES, OPERATIONS } from "@crewhaus/control-contract";
import { type Receiver, receiverProblems } from "../ingress";
import type { Sweep } from "../scheduler-host";
import { CORE_SWEEPS, type HomePorts } from "../sweeps";
import { ACCESS_HANDLERS } from "./access-ops";
import { COMMAND_HANDLERS } from "./commands";
import type { CapabilityProvider, RefResolver, V1Handler } from "./context";
import { CONTROL_HANDLERS } from "./controls";
import { CREATION_HANDLERS } from "./creation";
import { DECISION_HANDLERS } from "./decisions";
import { HOME_DELEGATION } from "./delegations";
import { DEPLOYMENT_HANDLERS } from "./deployments";
import { DEVICE_HANDLERS } from "./device";
import { HARNESS_HANDLERS } from "./harnesses";
import { CORE_REF_RESOLVERS, META_HANDLERS } from "./meta";
import { RULE_HANDLERS } from "./rules";
import { RUN_HANDLERS } from "./runs";

export type HomeAreaRuntime = {
  readonly area: string;
  /** What Home's tick runs for this area, in order. */
  readonly sweeps?: readonly Sweep<HomePorts>[];
  /** The deliveries this area receives on Home's ingress listener. */
  readonly receivers?: readonly Receiver[];
  /** The operations this area serves, by operation id. */
  readonly handlers?: Readonly<Record<string, V1Handler>>;
  /** What `refs.resolve` answers for the ref kinds this area owns. */
  readonly refResolvers?: Readonly<Record<string, RefResolver>>;
  /** Capability keys this area answers for a harness. */
  readonly capabilityProviders?: readonly CapabilityProvider[];
};

/** The core's own entry: Home's control core, first. */
export const HOME_CORE: HomeAreaRuntime = {
  area: "core",
  sweeps: CORE_SWEEPS,
  handlers: {
    ...META_HANDLERS,
    ...HARNESS_HANDLERS,
    ...DEPLOYMENT_HANDLERS,
    ...CONTROL_HANDLERS,
    ...DECISION_HANDLERS,
    ...RULE_HANDLERS,
    ...COMMAND_HANDLERS,
    ...ACCESS_HANDLERS,
    ...DEVICE_HANDLERS,
    ...RUN_HANDLERS,
  },
  refResolvers: CORE_REF_RESOLVERS,
};

/** The creation area's entry: the spec's schema for the structured editor. */
export const HOME_CREATION: HomeAreaRuntime = { area: "creation", handlers: CREATION_HANDLERS };

export const HOME_AREAS: readonly HomeAreaRuntime[] = [
  HOME_CORE,

  // HOME_ATTENTION,

  // HOME_COMPILER,

  HOME_CREATION,

  HOME_DELEGATION,

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
 * The operations declared and not served yet, each with a plain reason. The router answers
 * each with 501 `unsupported` (`reason: "not_served"`), never a silent 404. An area's
 * change that serves one deletes its line.
 */
export const V1_NOT_SERVED: Readonly<Record<string, string>> = {
  "runs.events": "Following a run's events through the API is not served yet.",

  "events.fleet": "Following Home's events through the API is not served yet.",
  "events.harness": "Following a harness's events through the API is not served yet.",

  "people.vault.setup": "People profiles are not served through the API yet.",
  "people.vault.get": "People profiles are not served through the API yet.",
  "people.vault.rotate": "People profiles are not served through the API yet.",
  "people.persons.list": "People profiles are not served through the API yet.",
  "people.persons.create": "People profiles are not served through the API yet.",
  "people.persons.get": "People profiles are not served through the API yet.",
  "people.persons.update": "People profiles are not served through the API yet.",
  "people.claims.list": "People profiles are not served through the API yet.",
  "people.claims.create": "People profiles are not served through the API yet.",
  "people.claims.revise": "People profiles are not served through the API yet.",
  "people.claims.review": "People profiles are not served through the API yet.",
  "people.review.list": "People profiles are not served through the API yet.",
  "people.exports.preview": "People profiles are not served through the API yet.",
  "people.exports.create": "People profiles are not served through the API yet.",
  "people.activity.list": "People profiles are not served through the API yet.",
  "people.erasure.plan": "People profiles are not served through the API yet.",
  "people.erasure.run": "People profiles are not served through the API yet.",
};

/**
 * The operations Home answers before authentication, on the sign-in routes: served by
 * their sign-in row, never by a handler here.
 */
export const SIGN_IN_OPERATIONS: readonly string[] = [
  "auth.challenge",
  "auth.session",
  "auth.exchange",
  "auth.acceptInvite",
  "auth.refresh",
  "auth.signOut",
  "auth.device.start",
  "auth.device.poll",
];

/** Every operation's handler, flattened in composition order. */
export function handlersOf(areas: readonly HomeAreaRuntime[]): ReadonlyMap<string, V1Handler> {
  const out = new Map<string, V1Handler>();
  for (const area of areas) {
    for (const [id, handler] of Object.entries(area.handlers ?? {})) {
      if (!out.has(id)) out.set(id, handler);
    }
  }
  return out;
}

/** Every ref kind's resolver, flattened in composition order. */
export function refResolversOf(
  areas: readonly HomeAreaRuntime[],
): ReadonlyMap<string, RefResolver> {
  const out = new Map<string, RefResolver>();
  for (const area of areas) {
    for (const [kind, resolver] of Object.entries(area.refResolvers ?? {})) {
      if (!out.has(kind)) out.set(kind, resolver);
    }
  }
  return out;
}

/** Every capability provider, in composition order. */
export function capabilityProvidersOf(
  areas: readonly HomeAreaRuntime[],
): readonly CapabilityProvider[] {
  return areas.flatMap((area) => area.capabilityProviders ?? []);
}

/**
 * What is wrong with a composition, one line per problem: a sweep named twice or run more
 * often than {@link MIN_SWEEP_EVERY_MS}; every receiver problem (`receiverProblems`); a
 * handler for an operation no module declares; a handler, a ref kind or a capability key
 * registered twice; an area no module names; and a not-served entry for an operation that
 * has a handler.
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
  const known = new Set<string>(AREA_MODULES.map((module) => module.area));
  const operations = new Set(OPERATIONS.map((op) => op.id));
  const kinds = new Set<string>(
    AREA_MODULES.flatMap((module) => module.refKinds.map((k) => k.kind as string)),
  );
  const handlers = new Map<string, string>();
  const resolvers = new Map<string, string>();
  const capabilities = new Map<string, string>();
  for (const area of areas) {
    if (!known.has(area.area)) problems.push(`area "${area.area}" has no module`);
    for (const id of Object.keys(area.handlers ?? {})) {
      if (!operations.has(id))
        problems.push(`handler for unknown operation "${id}" (area "${area.area}")`);
      const first = handlers.get(id);
      if (first !== undefined) {
        problems.push(`handler for "${id}" registered twice (areas "${first}" and "${area.area}")`);
      } else {
        handlers.set(id, area.area);
      }
      if (Object.hasOwn(V1_NOT_SERVED, id))
        problems.push(`"${id}" is served and listed as not served`);
    }
    for (const kind of Object.keys(area.refResolvers ?? {})) {
      if (!kinds.has(kind))
        problems.push(`resolver for unknown ref kind "${kind}" (area "${area.area}")`);
      const first = resolvers.get(kind);
      if (first !== undefined) {
        problems.push(
          `resolver for "${kind}" registered twice (areas "${first}" and "${area.area}")`,
        );
      } else {
        resolvers.set(kind, area.area);
      }
    }
    for (const provider of area.capabilityProviders ?? []) {
      const first = capabilities.get(provider.key);
      if (first !== undefined) {
        problems.push(
          `capability "${provider.key}" registered twice (areas "${first}" and "${area.area}")`,
        );
      } else {
        capabilities.set(provider.key, area.area);
      }
    }
  }
  return problems;
}
