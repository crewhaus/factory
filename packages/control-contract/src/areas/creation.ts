/**
 * The creation area: how a harness's spec is read and written through the versioned
 * API (#515). Static data, like every area module.
 *
 * Its first operation, `specs.schema`, answers the schema the structured editor
 * renders for one harness (the one Home checks that spec with: the harness's own once
 * it runs its own code here, Home's otherwise), the effective configuration with each
 * setting marked declared or defaulted, the spec's revision every write sends back,
 * and whether the spec is read-only here. No CLI command prints a schema, so the row
 * names no twin. Every write still goes through the guarded spec routes.
 */
import { NO_VERB, READ } from "../operations/shared.js";
import type { AreaModule } from "./types.js";

/** One diagnostic, anchored to the setting it is about. */
export type SpecSchemaIssue = {
  readonly path: readonly string[];
  readonly message: string;
  readonly code: string | null;
};

/** One setting of the effective configuration. A credential's value comes back redacted. */
export type SpecEffectiveRow = {
  readonly path: string;
  /** The path as segments: a key may hold a `.`. */
  readonly segments: readonly string[];
  readonly value?: unknown;
  /** `declared` when the file says it; `default` when only the schema does. */
  readonly source: "declared" | "default";
};

/** Why a spec takes no write here, and the one command that can help, when there is one. */
export type SpecReadOnlyState = {
  readonly reason: string;
  readonly paths: readonly string[];
  readonly verb: string | null;
};

/** `specs.schema`: the schema and the effective configuration of one harness's spec. */
export type SpecSchemaView = {
  readonly harness: string;
  readonly present: boolean;
  readonly note: string | null;
  readonly verb: string | null;
  readonly specName: string;
  readonly target: string | null;
  /** The JSON schema narrowed to the spec's target; a credential-named part comes back masked. */
  readonly schema: Readonly<Record<string, unknown>> | null;
  readonly schemaSource: "harness" | "manager";
  readonly schemaVersion: string | null;
  readonly schemaNote: string | null;
  readonly effective: readonly SpecEffectiveRow[];
  /** True when the effective rows stopped at their cap with settings left over. */
  readonly effectiveTruncated: boolean;
  readonly effectiveNote: string | null;
  readonly declaredCount: number;
  readonly defaultedCount: number;
  readonly issues: readonly SpecSchemaIssue[];
  /** The revision a write sends back. */
  readonly rev: string;
  readonly readOnly: SpecReadOnlyState | null;
  /** True when the file is larger than Home reads: this is a view of its head. */
  readonly truncated: boolean;
};

export const CREATION_MODULE = {
  area: "creation",
  operations: [
    {
      ...READ,
      id: "specs.schema",
      method: "GET",
      path: "/api/v1/harnesses/{h}/spec/schema",
      permission: "h.read",
      request: "noBody",
      response: "specSchemaView",
      cliTwin: null,
      noTwinReason: NO_VERB,
      qualifiers: [],
    },
  ],
  refKinds: [],
  eventFamilies: [],
  machines: {},
  commandKinds: [],
  permissions: [],
} as const satisfies AreaModule;
