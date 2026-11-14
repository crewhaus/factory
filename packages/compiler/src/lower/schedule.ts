import type { IrSchedule, IrScheduleLane } from "@crewhaus/ir";

/**
 * Phase 3 §3.1 — parse a duration string ("2h", "30m", "60s", "500ms";
 * v0.3.0 adds "90d") to milliseconds. Caller is expected to have already
 * regex-validated the format at the spec layer; this is the
 * deterministic numeric step. Shared by `heartbeat.every` and the v0.3.0
 * `memory.ttl` lowering.
 */
const DURATION_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d", number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};
export function parseDurationToMs(duration: string): number {
  const m = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) {
    throw new Error(`invalid duration "${duration}" (caught past spec validation)`);
  }
  const n = Number.parseInt(m[1] ?? "0", 10);
  // The capture group is statically one of the table's keys (the regex permits
  // no other unit), so the lookup is total — no unreachable default arm.
  return n * DURATION_UNIT_MS[m[2] as keyof typeof DURATION_UNIT_MS];
}

/**
 * Loop contract 0.4 (Batch F, temporal contract / G84 schedule half) — lower
 * the `schedule:` block on the daemon-able shapes (channel/managed/batch).
 * The discriminated union carries through 1:1; durations (`jitter`, interval
 * `every`) normalize to ms at lower time (the daemon reads literal numbers)
 * while `cron` is verbatim (the daemon's cron parser owns validity beyond the
 * spec's field-count regex). Spread-return-{} discipline (Pillar 1): absent
 * from the IR when the spec omits the block, so every existing daemon bundle
 * stays byte-identical. Every daemon emitter wires both forms into its wake
 * loop, so neither form has an ACCEPTED_BUT_UNWIRED row.
 *
 * The list form (#514) lowers to `scheduleLanes` instead: each lane lowered by
 * the same per-entry code with `name` first, the lanes sorted by name in
 * code-unit order, so the IR does not depend on the order a spec lists them in.
 * The two keys are never present together.
 */
type SpecSchedule =
  | {
      readonly kind: "cron";
      readonly cron: string;
      readonly timezone?: string;
      readonly jitter?: string;
      readonly instructions?: string;
    }
  | {
      readonly kind: "interval";
      readonly every: string;
      readonly jitter?: string;
      readonly instructions?: string;
    };

type SpecScheduleLane = SpecSchedule & { readonly name: string };

function lowerOne(schedule: SpecSchedule): IrSchedule {
  if (schedule.kind === "cron") {
    return {
      kind: "cron",
      cron: schedule.cron,
      ...(schedule.timezone !== undefined ? { timezone: schedule.timezone } : {}),
      ...(schedule.jitter !== undefined ? { jitterMs: parseDurationToMs(schedule.jitter) } : {}),
      ...(schedule.instructions !== undefined ? { instructions: schedule.instructions } : {}),
    };
  }
  return {
    kind: "interval",
    everyMs: parseDurationToMs(schedule.every),
    ...(schedule.jitter !== undefined ? { jitterMs: parseDurationToMs(schedule.jitter) } : {}),
    ...(schedule.instructions !== undefined ? { instructions: schedule.instructions } : {}),
  };
}

/** Code-unit order, so the sort does not depend on the compiling machine's locale. */
function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function lowerSchedule(
  schedule: SpecSchedule | ReadonlyArray<SpecScheduleLane> | undefined,
): { schedule?: IrSchedule; scheduleLanes?: ReadonlyArray<IrScheduleLane> } {
  if (schedule === undefined) return {};
  if (!isLaneList(schedule)) return { schedule: lowerOne(schedule) };
  const scheduleLanes: IrScheduleLane[] = schedule.map(
    (lane): IrScheduleLane => ({ name: lane.name, ...lowerOne(lane) }),
  );
  scheduleLanes.sort(byName);
  return { scheduleLanes };
}

function isLaneList(
  schedule: SpecSchedule | ReadonlyArray<SpecScheduleLane>,
): schedule is ReadonlyArray<SpecScheduleLane> {
  return Array.isArray(schedule);
}
