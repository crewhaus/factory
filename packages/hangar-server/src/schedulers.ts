/**
 * The four-lane timeline: heartbeat, schedule, dream, janitor.
 *
 * THE ASYMMETRY THIS MODULE ENCODES. A daemon's schedulers are in-process
 * timers, so the **cadence** is knowable offline (it is declared in the
 * spec) but the **phase** — when did it last fire, when does it fire next —
 * is knowable ONLY inside the process that armed it. That is the entire
 * reason `crewhaus.control.v1` exists. So every lane is rendered from two
 * sources and says which it got:
 *
 *   - OFFLINE, always: the declared cadence, scanned leniently out of
 *     `crewhaus.yaml` (a fleet page must render a spec one schema version
 *     ahead of this manager, so this is a block scan, not a zod parse);
 *   - ONLINE, when the control plane answers: `lastFiredAt`, `lastOutcome`,
 *     `nextDueAt` from `/control/v1/status`.
 *
 * Two lanes are POKEABLE (`heartbeat`, `schedule`) because control.v1 arms
 * them; `dream` and `janitor` are read-only timer rows and say why. A lane
 * whose spec never declared it is `armed: false` — absent, not broken.
 *
 * `dream` additionally has a durable offline signal the other lanes lack:
 * `.crewhaus/dream/<spec>/state.json`, which records the last consolidation
 * even when no daemon is running.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SAFE_SEGMENT_RE } from "./constants";
import type { ControlStatusBody, ControlTimerReport } from "./control-client";
import { maskDeep } from "./mask";
import { resolveInside } from "./safety";

/** The lanes the timeline renders, in display order. */
export const SCHEDULER_LANES = ["heartbeat", "schedule", "dream", "janitor"] as const;
export type SchedulerLane = (typeof SCHEDULER_LANES)[number];

export type SchedulerRow = {
  readonly lane: SchedulerLane;
  /** False when the spec declares no such lane — absence, not a fault. */
  readonly armed: boolean;
  /** Human cadence (`every 60s`, `cron "0 * * * *" UTC`), or null. */
  readonly cadence: string | null;
  /** Where the cadence came from. */
  readonly cadenceSource: "spec" | "control" | "default" | "none";
  readonly lastFiredAt: string | null;
  readonly lastOutcome: string | null;
  /** Only the control plane can project this; null when offline. */
  readonly nextDueAt: string | null;
  /** True when an operator can fire this lane now. */
  readonly pokeable: boolean;
  /** Why not, when `pokeable` is false. Always a sentence. */
  readonly pokeReason: string | null;
  /** Extra per-lane facts (dream state, janitor counters). */
  readonly detail: unknown;
};

export type SchedulersView = {
  readonly lanes: readonly SchedulerRow[];
  /** True when `/control/v1/status` answered — phase columns are real. */
  readonly controlReachable: boolean;
  /** Why the control plane could not be read, when it could not. */
  readonly controlReason: string | null;
  /** Counters, when the control plane answered. */
  readonly counters: ControlStatusBody["counters"] | null;
  readonly draining: boolean;
};

// ---------------------------------------------------------------------------
// The lenient spec scan
// ---------------------------------------------------------------------------

export type DeclaredCadences = {
  readonly heartbeat?: string;
  readonly schedule?: string;
  readonly dream?: string;
};

/** Indentation of a YAML line (tabs count as one column, as YAML forbids
 *  them for indentation anyway — a tabbed spec would not parse). */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return n;
}

/** The scalar for `key:` inside a block, or undefined. Quotes stripped,
 *  trailing `# comment` dropped. */
function scalarIn(block: readonly string[], key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (const line of block) {
    const m = line.match(re);
    if (m === null) continue;
    let value = (m[1] ?? "").trim();
    if (value === "" || value.startsWith("#")) continue;
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
    if (quote !== undefined && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    return value;
  }
  return undefined;
}

/** The lines strictly inside `<key>:` at the given indent level. */
function blockUnder(lines: readonly string[], key: string, atIndent: number): string[] | undefined {
  const header = new RegExp(`^\\s{${atIndent}}${key}\\s*:\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!header.test(line)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] as string;
      if (next.trim() === "" || next.trim().startsWith("#")) continue;
      if (indentOf(next) <= atIndent) break;
      body.push(next);
    }
    return body;
  }
  return undefined;
}

/**
 * Read the declared cadences out of a spec's TEXT. Lenient by design: this
 * is a fleet view, and a harness whose spec is a version ahead of (or behind)
 * the manager's schema must still render its lanes.
 */
export function declaredCadences(yamlText: string): DeclaredCadences {
  const lines = yamlText.split("\n");
  const out: { heartbeat?: string; schedule?: string; dream?: string } = {};

  const heartbeat = blockUnder(lines, "heartbeat", 0);
  if (heartbeat !== undefined) {
    const every = scalarIn(heartbeat, "every");
    out.heartbeat = every !== undefined ? `every ${every}` : "declared (no interval read)";
  }

  const schedule = blockUnder(lines, "schedule", 0);
  if (schedule !== undefined) {
    const cron = scalarIn(schedule, "cron");
    const every = scalarIn(schedule, "every");
    const tz = scalarIn(schedule, "timezone");
    const jitter = scalarIn(schedule, "jitter");
    const base =
      cron !== undefined
        ? `cron "${cron}"${tz !== undefined ? ` ${tz}` : " UTC"}`
        : every !== undefined
          ? `every ${every}`
          : "declared (no trigger read)";
    out.schedule = jitter !== undefined ? `${base} ±${jitter}` : base;
  }

  const memory = blockUnder(lines, "memory", 0);
  if (memory !== undefined) {
    const dream = blockUnder(memory, "dream", indentOf(memory[0] ?? "  "));
    if (dream !== undefined) {
      const every = scalarIn(dream, "every");
      const mode = scalarIn(dream, "mode");
      out.dream =
        every !== undefined
          ? `every ${every}${mode !== undefined ? ` (${mode})` : ""}`
          : "declared (no interval read)";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dream state (the one lane with a durable offline signal)
// ---------------------------------------------------------------------------

export type DreamLaneState = {
  readonly specName: string;
  readonly state: unknown;
};

/** `.crewhaus/dream/<spec>/state.json` for every spec dir present. */
export function dreamStates(harnessDir: string): DreamLaneState[] {
  const out: DreamLaneState[] = [];
  const dreamDir = resolveInside(harnessDir, [".crewhaus", "dream"]);
  if (dreamDir === undefined) return out;
  let names: string[];
  try {
    names = readdirSync(dreamDir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (!SAFE_SEGMENT_RE.test(name)) continue;
    const path = resolveInside(harnessDir, [".crewhaus", "dream", name, "state.json"]);
    if (path === undefined) continue;
    try {
      out.push({ specName: name, state: maskDeep(JSON.parse(readFileSync(path, "utf8"))) });
    } catch {
      // absent/torn state — the lane still renders its cadence
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const reportFor = (
  timers: readonly ControlTimerReport[] | undefined,
  lane: string,
): ControlTimerReport | undefined => timers?.find((t) => t.lane === lane);

export type BuildSchedulersInput = {
  readonly harnessDir: string;
  readonly specYaml: string;
  readonly target: string;
  /** `/control/v1/status`, when it answered. */
  readonly control?: ControlStatusBody;
  /** Why control was not reachable, when it was not. */
  readonly controlReason?: string;
};

/** The janitor's built-in cadence in the daemon shapes (tunable per-daemon
 *  with `CREWHAUS_JANITOR_INTERVAL_MS`; the control status is authoritative
 *  when it answers). */
const JANITOR_DEFAULT_CADENCE = "every 1h (daemon default)";

/** Shapes whose compiled daemon runs a janitor. */
const JANITOR_TARGETS: ReadonlySet<string> = new Set([
  "managed",
  "channel",
  "batch",
  "crew",
  "voice",
]);

export function buildSchedulersView(input: BuildSchedulersInput): SchedulersView {
  const declared = declaredCadences(input.specYaml);
  const control = input.control;
  const timers = control?.timers;
  const draining = control?.draining === true;

  const pokeState = (
    lane: "heartbeat" | "schedule",
    armed: boolean,
  ): { pokeable: boolean; pokeReason: string | null } => {
    if (!armed) {
      return {
        pokeable: false,
        pokeReason: `the spec declares no ${lane}: block — nothing to poke`,
      };
    }
    if (control === undefined) {
      return {
        pokeable: false,
        pokeReason:
          input.controlReason ??
          "the daemon's control plane is not reachable — start it, or recompile a pre-0.5.0 bundle",
      };
    }
    if (draining) {
      return { pokeable: false, pokeReason: "the daemon is draining — it accepts no new ticks" };
    }
    if (reportFor(timers, lane) === undefined) {
      return {
        pokeable: false,
        pokeReason: `this bundle armed no ${lane} lane — recompile if the spec block is new`,
      };
    }
    return { pokeable: true, pokeReason: null };
  };

  const row = (
    lane: SchedulerLane,
    armed: boolean,
    specCadence: string | undefined,
    poke: { pokeable: boolean; pokeReason: string | null },
    detail: unknown,
    defaultCadence?: string,
  ): SchedulerRow => {
    const report = reportFor(timers, lane);
    const cadence = specCadence ?? report?.cadence ?? defaultCadence ?? null;
    const cadenceSource: SchedulerRow["cadenceSource"] =
      specCadence !== undefined
        ? "spec"
        : report !== undefined
          ? "control"
          : defaultCadence !== undefined
            ? "default"
            : "none";
    return {
      lane,
      armed,
      cadence,
      cadenceSource,
      lastFiredAt: report?.lastFiredAt ?? null,
      lastOutcome: report?.lastOutcome ?? null,
      nextDueAt: report?.nextDueAt ?? null,
      pokeable: poke.pokeable,
      pokeReason: poke.pokeReason,
      detail,
    };
  };

  const heartbeatArmed =
    declared.heartbeat !== undefined || reportFor(timers, "heartbeat") !== undefined;
  const scheduleArmed =
    declared.schedule !== undefined || reportFor(timers, "schedule") !== undefined;
  const dreams = dreamStates(input.harnessDir);
  const dreamArmed = declared.dream !== undefined || dreams.length > 0;
  const janitorArmed =
    JANITOR_TARGETS.has(input.target) || reportFor(timers, "janitor") !== undefined;

  const notPokeable = (reason: string): { pokeable: false; pokeReason: string } => ({
    pokeable: false,
    pokeReason: reason,
  });

  return {
    lanes: [
      row(
        "heartbeat",
        heartbeatArmed,
        declared.heartbeat,
        pokeState("heartbeat", heartbeatArmed),
        null,
      ),
      row("schedule", scheduleArmed, declared.schedule, pokeState("schedule", scheduleArmed), null),
      row(
        "dream",
        dreamArmed,
        declared.dream,
        notPokeable(
          "dream is a read-only timer row in control.v1 — run it now with the dream-run job instead",
        ),
        { states: dreams },
      ),
      row(
        "janitor",
        janitorArmed,
        undefined,
        notPokeable("the janitor is a read-only timer row in control.v1 — it cannot be poked"),
        { runs: control?.counters.janitorRuns ?? null },
        janitorArmed ? JANITOR_DEFAULT_CADENCE : undefined,
      ),
    ],
    controlReachable: control !== undefined,
    controlReason: control !== undefined ? null : (input.controlReason ?? "control not queried"),
    counters: control?.counters ?? null,
    draining,
  };
}

/** Read a harness's spec text tolerantly (absence is not an error). */
export function readSpecYaml(harnessDir: string): string {
  try {
    return readFileSync(join(harnessDir, "crewhaus.yaml"), "utf8");
  } catch {
    return "";
  }
}
