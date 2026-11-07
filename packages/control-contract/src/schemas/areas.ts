/**
 * Every schema module, the core's first, composed into `SCHEMAS`. An area's rows name schema ids,
 * so its first change uncomments its own two lines here too. Each placeholder sits
 * between blank lines so two areas never conflict. Keep the blanks.
 */
import type { z } from "zod";
import { CORE_SCHEMAS } from "./core.js";

// import { ATTENTION_SCHEMAS } from "./attention.js";

// import { COMPILER_SCHEMAS } from "./compiler.js";

// import { CREATION_SCHEMAS } from "./creation.js";

// import { DELEGATION_SCHEMAS } from "./delegation.js";

// import { HOME_SCHEMAS } from "./home.js";

// import { INSPECTION_SCHEMAS } from "./inspection.js";

// import { INTEGRATIONS_SCHEMAS } from "./integrations.js";

// import { KNOWLEDGE_SCHEMAS } from "./knowledge.js";

// import { PEOPLE_SCHEMAS } from "./people.js";

// import { QUALITY_SCHEMAS } from "./quality.js";

// import { RUNTIME_SCHEMAS } from "./runtime.js";

// import { VERIFICATION_SCHEMAS } from "./verification.js";

export const AREA_SCHEMAS: readonly Readonly<Record<string, z.ZodTypeAny>>[] = [
  CORE_SCHEMAS,

  // ATTENTION_SCHEMAS,

  // COMPILER_SCHEMAS,

  // CREATION_SCHEMAS,

  // DELEGATION_SCHEMAS,

  // HOME_SCHEMAS,

  // INSPECTION_SCHEMAS,

  // INTEGRATIONS_SCHEMAS,

  // KNOWLEDGE_SCHEMAS,

  // PEOPLE_SCHEMAS,

  // QUALITY_SCHEMAS,

  // RUNTIME_SCHEMAS,

  // VERIFICATION_SCHEMAS,
];
