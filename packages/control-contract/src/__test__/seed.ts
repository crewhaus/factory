/**
 * The two seed files, and an area written the way the README says to write one.
 * The simulated area declares something in every column a module can fill, under
 * names no real area will take, so a pin that reads the composition instead of the
 * core's own module fails when the area is added.
 */

/** The twelve areas with a placeholder, in the order the seed files list them. */
export const SEED_AREAS = [
  "attention",
  "compiler",
  "creation",
  "delegation",
  "home",
  "inspection",
  "integrations",
  "knowledge",
  "people",
  "quality",
  "runtime",
  "verification",
] as const;

export type SeedSuffix = "MODULE" | "SCHEMAS";

export function seedLines(area: string, suffix: SeedSuffix) {
  const name = `${area.toUpperCase()}_${suffix}`;
  const statement = `import { ${name} } from "./${area}.js";`;
  return {
    importLine: { commented: `// ${statement}`, live: statement },
    entryLine: { commented: `  // ${name},`, live: `  ${name},` },
  };
}

/** The seed as it was before any area landed, so a merge test never runs out of neighbours. */
export function allCommented(source: string, suffix: SeedSuffix): string {
  const lines = source.split("\n");
  for (const area of SEED_AREAS) {
    const { importLine, entryLine } = seedLines(area, suffix);
    for (const { commented, live } of [importLine, entryLine]) {
      const at = lines.indexOf(live);
      if (at > -1) lines[at] = commented;
    }
  }
  return lines.join("\n");
}

/** Bring an area in the documented way: its own two lines, and nothing else. */
export function uncomment(source: string, area: string, suffix: SeedSuffix): string {
  const lines = source.split("\n");
  const { importLine, entryLine } = seedLines(area, suffix);
  for (const { commented, live } of [importLine, entryLine]) {
    const at = lines.indexOf(commented);
    if (at === -1) throw new Error(`no placeholder: ${commented}`);
    lines[at] = live;
  }
  return lines.join("\n");
}

/** The first area whose placeholder is still commented in this seed. */
export function firstOpenArea(source: string, suffix: SeedSuffix): string | undefined {
  const lines = source.split("\n");
  return SEED_AREAS.find((area) => lines.includes(seedLines(area, suffix).importLine.commented));
}

/** What the probe leaves beside `src/`, so a run that never reached it cannot pass. */
export const PROBE_MARKER = "simulated-probe.ran";

/** Every file a new area brings, by its path under `src/`. */
export function simulatedAreaFiles(area: string): Readonly<Record<string, string>> {
  const upper = area.toUpperCase();
  return {
    [`areas/${area}.ts`]: `import type { AreaModule } from "./types.js";

export const ${upper}_MODULE = {
  area: "${area}",
  operations: [
    {
      id: "simulated.list",
      method: "GET",
      path: "/api/v1/simulated",
      permission: "h.simulated.read",
      receipt: "none",
      idempotency: "none",
      request: "listQuery",
      response: "simulatedRow",
      cliTwin: null,
      noTwinReason: "A simulated area has no command.",
      qualifiers: ["filtered"],
    },
    {
      id: "simulated.act",
      method: "POST",
      path: "/api/v1/simulated/act",
      permission: "h.simulated.read",
      receipt: "workspace",
      idempotency: "accepted",
      request: "simulatedRequest",
      response: "commandAccepted",
      cliTwin: null,
      noTwinReason: "A simulated area has no command.",
      qualifiers: ["self"],
    },
    {
      id: "simulated.watch",
      method: "GET",
      path: "/api/v1/simulated/events",
      permission: "h.simulated.read",
      receipt: "none",
      idempotency: "none",
      request: "streamQuery",
      response: "eventFrame",
      stream: "sse",
      cliTwin: null,
      noTwinReason: "A simulated area has no command.",
      qualifiers: [],
    },
    {
      id: "simulated.quiet",
      method: "POST",
      path: "/api/v1/simulated/quiet",
      permission: "authenticated",
      receipt: "none",
      noReceiptReason: "A simulated row with nothing to record.",
      idempotency: "none",
      request: "emptyRequest",
      response: "simulatedRow",
      cliTwin: null,
      noTwinReason: "A simulated area has no command.",
      qualifiers: [],
    },
  ],
  refKinds: [{ kind: "simulated", scope: "home", ids: [{ prefix: "sim", grammar: "ulid" }] }],
  eventFamilies: [
    {
      family: "simulated",
      types: [{ type: "simulated.happened", sensitivity: "restricted" }],
    },
  ],
  machines: {
    simulated: {
      states: ["open", "closed"],
      entry: ["open"],
      terminal: ["closed"],
      transitions: { open: ["closed"], closed: [] },
      recoveryOwner: { open: "operator", closed: "none" },
    },
  },
  commandKinds: [
    {
      id: "simulated.act",
      permission: "h.simulated.read",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
  ],
  permissions: [
    { id: "h.simulated.read", scope: "harness", floor: "viewer", service: "never" },
    { id: "h.simulated.assert", scope: "harness", floor: "none", service: "grantable" },
  ],
  scopedActs: ["simulated.read"],
  reasonCodes: { supersede: ["simulated-reason"], expiry: ["simulated-expiry"] },
  capabilityKeys: ["simulated.capability"],
  grammars: [{ prefix: "sim", grammar: "ulid" }],
} as const satisfies AreaModule;
`,
    [`schemas/${area}.ts`]: `import { z } from "zod";
import { storedActor } from "./core.js";

export const simulatedRequest = z.object({ note: z.string().optional() }).strict();

export const simulatedRow = z.object({ id: z.string(), by: storedActor }).passthrough();

export const ${upper}_SCHEMAS = { simulatedRequest, simulatedRow } as const;
`,
    [`schemas/${area}.type-checks.ts`]: `import type { z } from "zod";
import type * as S from "./${area}.js";
import type { Expect, Same } from "./type-checks.js";

export type SimulatedTypeChecks = [
  Expect<Same<z.infer<typeof S.simulatedRequest>, { readonly note?: string }>>,
  Expect<Same<z.infer<typeof S.simulatedRow>, { readonly id: string; readonly by: string }>>,
];
`,
    [`__test__/${area}.examples.ts`]: `export const EXAMPLES = {
  simulatedRequest: {},
  simulatedRow: { id: "one", by: "sys:runtime" },
};
`,
    "simulated-probe.test.ts": `import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITY_NAMES,
  COMMAND_KINDS,
  DECISION_LOG_REASONS,
  EVENT_TYPES,
  ID_GRAMMARS,
  MACHINES,
  OPERATIONS,
  PERMISSIONS,
  REF_KINDS,
  SCOPED_ACTS,
} from "./index.js";
import { SCHEMAS } from "./schemas/index.js";

test("the simulated area reached every vocabulary", () => {
  expect(OPERATIONS.map((op) => op.id)).toContain("simulated.act");
  expect(REF_KINDS as readonly string[]).toContain("simulated");
  expect(EVENT_TYPES as readonly string[]).toContain("simulated.happened");
  expect(Object.keys(MACHINES)).toContain("simulated");
  expect(Object.keys(COMMAND_KINDS)).toContain("simulated.act");
  expect(PERMISSIONS as readonly string[]).toContain("h.simulated.read");
  expect(SCOPED_ACTS as readonly string[]).toContain("simulated.read");
  expect(CAPABILITY_NAMES as readonly string[]).toContain("simulated.capability");
  expect(ID_GRAMMARS.map((decl) => decl.prefix)).toContain("sim");
  expect(DECISION_LOG_REASONS.supersede).toContain("simulated-reason");
  expect(Object.keys(SCHEMAS)).toContain("simulatedRow");
  writeFileSync(join(import.meta.dir, "..", "${PROBE_MARKER}"), "ran");
});
`,
  };
}
