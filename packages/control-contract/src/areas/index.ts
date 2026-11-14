/**
 * Every area module, composed once per build. Each vocabulary this package
 * exports is the union of these modules, so it stays closed per build.
 *
 * An area's first change uncomments its own two lines and nothing else. Each
 * placeholder sits between blank lines so two areas editing their own lines
 * never conflict when one is brought current with `main`. Keep the blanks.
 */
import { deepFreeze } from "../util.js";
import { CORE_MODULE } from "./core.js";
import type { AreaModule } from "./types.js";

// import { ATTENTION_MODULE } from "./attention.js";

// import { COMPILER_MODULE } from "./compiler.js";

import { CREATION_MODULE } from "./creation.js";

import { DELEGATION_MODULE } from "./delegation.js";

// import { HOME_MODULE } from "./home.js";

// import { INSPECTION_MODULE } from "./inspection.js";

// import { INTEGRATIONS_MODULE } from "./integrations.js";

// import { KNOWLEDGE_MODULE } from "./knowledge.js";

import { PEOPLE_MODULE } from "./people.js";

import { QUALITY_MODULE } from "./quality.js";

// import { RUNTIME_MODULE } from "./runtime.js";

// import { VERIFICATION_MODULE } from "./verification.js";

export const AREA_MODULES = [
  CORE_MODULE,

  // ATTENTION_MODULE,

  // COMPILER_MODULE,

  CREATION_MODULE,

  DELEGATION_MODULE,

  // HOME_MODULE,

  // INSPECTION_MODULE,

  // INTEGRATIONS_MODULE,

  // KNOWLEDGE_MODULE,

  PEOPLE_MODULE,

  QUALITY_MODULE,

  // RUNTIME_MODULE,

  // VERIFICATION_MODULE,
] as const satisfies readonly AreaModule[];

deepFreeze(AREA_MODULES);

export type ComposedModule = (typeof AREA_MODULES)[number];

/** A module's optional list, or `never` for one that does not declare it. */
export type ModuleField<K extends string> = ComposedModule extends infer M
  ? M extends Record<K, infer V>
    ? V
    : never
  : never;

/** The composition as data, for code that walks it without its literal types. */
export const MODULES: readonly AreaModule[] = AREA_MODULES;
