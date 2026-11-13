/**
 * The identity of a graders file as a measuring instrument: `gradersHash`.
 *
 * A run records the hash of the graders it was scored by, and two runs are
 * comparable only when it is equal. The hash covers what changes a
 * measurement: every grader, the combine policy and, for a criterion that
 * observes instead of enforcing or that covers only some cases, its `id`,
 * `measured_by`, `mode` and `scope`. A criterion's title, description,
 * severity, owner, provenance, examples and protection describe it and never
 * enter the hash, so a file whose criteria only describe its graders hashes
 * exactly as the same file without them.
 */
import { createHash } from "node:crypto";
import type { GradersConfig } from "./graders-config";

/** JSON with every object's keys sorted, so key order never changes a digest. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of {@link stableStringify}. */
export function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * The part of a parsed graders config that decides what a run measures: the
 * config without `criteria`, plus `{id, measured_by, mode?, scope?}` for each
 * criterion that observes or sets a scope. `mode` appears only as `observe`,
 * because `enforce` is what an absent mode means.
 */
export function measurementProjection(config: GradersConfig): Record<string, unknown> {
  const { criteria, ...rest } = config;
  const measuring = (criteria ?? []).filter((c) => c.mode === "observe" || c.scope !== undefined);
  if (measuring.length === 0) return rest;
  return {
    ...rest,
    criteria: measuring.map((c) => ({
      id: c.id,
      measured_by: c.measured_by,
      ...(c.mode === "observe" ? { mode: c.mode } : {}),
      ...(c.scope !== undefined ? { scope: c.scope } : {}),
    })),
  };
}

/**
 * sha256 hex of a parsed graders config's {@link measurementProjection}: the
 * `gradersHash` every run records and every gate compares.
 */
export function gradersConfigHash(config: GradersConfig): string {
  return stableDigest(measurementProjection(config));
}
