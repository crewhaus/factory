/**
 * `@crewhaus/spec/identity` — which schema answered a check.
 *
 * `specSchemaIdentity()` names this copy of `@crewhaus/spec`: its package, its
 * version and a digest of its JSON schema. A check that reports issues says
 * which schema found them, so a reader can tell this CrewHaus's answer from a
 * harness's own pinned one.
 *
 * A subpath, not part of `.`: it needs `node:crypto`, and the package's main
 * entry stays free of `node:` imports (the Worker-safe compiler bundles it).
 * The digest is computed on the first call and kept, never when the module
 * loads.
 */
import { createHash } from "node:crypto";
import pkg from "../package.json" with { type: "json" };
import { specJsonSchema } from "./index";

export type SchemaIdentity = {
  readonly package: "@crewhaus/spec";
  /** This package's version, from its own package.json. */
  readonly version: string;
  /** `sha256:` over `JSON.stringify(specJsonSchema())`. */
  readonly digest: string;
};

/** `sha256:` over a JSON schema document, as {@link specSchemaIdentity} takes it. */
export function schemaDigest(schema: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(schema), "utf8").digest("hex")}`;
}

let identity: SchemaIdentity | undefined;

/** The schema this copy of `@crewhaus/spec` checks with. */
export function specSchemaIdentity(): SchemaIdentity {
  identity ??= Object.freeze({
    package: "@crewhaus/spec",
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    digest: schemaDigest(specJsonSchema()),
  });
  return identity;
}
