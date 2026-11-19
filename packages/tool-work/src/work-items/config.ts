/**
 * `tool_config.work`, checked: `accept` lists the kinds the runtime may accept on its own
 * (a feature, or a speculative proposal of any kind, still waits for a person unless
 * something was observed), and
 * `ranking.weights` gives each ranking dimension a weight from 0 to 10. Anything else is
 * refused with a message that names the key. Pure.
 */
import {
  WORK_KINDS,
  WORK_RANK_DIMENSIONS,
  type WorkKind,
  type WorkRankDimension,
} from "@crewhaus/control-contract";

export type WorkConfig = {
  readonly accept?: readonly WorkKind[];
  readonly ranking?: { readonly weights: Readonly<Partial<Record<WorkRankDimension, number>>> };
};

export class WorkConfigError extends Error {
  override readonly name = "WorkConfigError";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check a `tool_config.work` block; throws {@link WorkConfigError} naming the key. */
export function parseWorkConfig(raw: unknown): WorkConfig {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new WorkConfigError("tool_config.work is a mapping");
  for (const key of Object.keys(raw)) {
    if (key !== "accept" && key !== "ranking") {
      throw new WorkConfigError(
        `tool_config.work.${key} is not a setting: the work tools read accept and ranking`,
      );
    }
  }
  const out: { accept?: WorkKind[]; ranking?: WorkConfig["ranking"] } = {};
  if (raw["accept"] !== undefined) {
    const accept = raw["accept"];
    if (!Array.isArray(accept)) {
      throw new WorkConfigError("tool_config.work.accept is a list of work kinds");
    }
    for (const [i, kind] of accept.entries()) {
      if (!(WORK_KINDS as readonly unknown[]).includes(kind)) {
        throw new WorkConfigError(
          `tool_config.work.accept[${i}] is not a work kind: use ${WORK_KINDS.join(", ")}`,
        );
      }
    }
    out.accept = [...new Set(accept as WorkKind[])];
  }
  if (raw["ranking"] !== undefined) {
    const ranking = raw["ranking"];
    if (!isRecord(ranking)) throw new WorkConfigError("tool_config.work.ranking is a mapping");
    for (const key of Object.keys(ranking)) {
      if (key !== "weights") {
        throw new WorkConfigError(`tool_config.work.ranking.${key} is not a setting: use weights`);
      }
    }
    const weights = ranking["weights"];
    if (!isRecord(weights)) {
      throw new WorkConfigError("tool_config.work.ranking.weights is a mapping of dimensions");
    }
    const parsed: Partial<Record<WorkRankDimension, number>> = {};
    for (const [name, weight] of Object.entries(weights)) {
      if (!(WORK_RANK_DIMENSIONS as readonly string[]).includes(name)) {
        throw new WorkConfigError(
          `tool_config.work.ranking.weights.${name} is not a dimension: use ${WORK_RANK_DIMENSIONS.join(", ")}`,
        );
      }
      if (!Number.isInteger(weight) || (weight as number) < 0 || (weight as number) > 10) {
        throw new WorkConfigError(
          `tool_config.work.ranking.weights.${name} is a whole number from 0 to 10`,
        );
      }
      parsed[name as WorkRankDimension] = weight as number;
    }
    out.ranking = { weights: parsed };
  }
  return out;
}
