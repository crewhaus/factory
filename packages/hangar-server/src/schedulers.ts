/**
 * The lane timeline: heartbeat, schedule, dream, janitor — and, for a spec
 * whose `schedule:` is a list (#514), one `schedule:<name>` row per named lane
 * in place of the `schedule` row, in name order.
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
 * The heartbeat and schedule lanes are POKEABLE (`heartbeat`, `schedule`,
 * `schedule:<name>`) because control.v1 arms them; `dream` and `janitor` are
 * read-only timer rows and say why. A lane whose spec never declared it is
 * `armed: false` — absent, not broken. A named lane is listed when the spec
 * declares it or the daemon's `/status` reports it.
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
import { keyedScalar } from "./spec-lines";

/** The fixed lanes the timeline renders, in display order. Named schedule lanes are not listed. */
export const SCHEDULER_LANES = ["heartbeat", "schedule", "dream", "janitor"] as const;
/** A fixed lane, or a named schedule lane `schedule:<name>`. */
export type SchedulerLane = (typeof SCHEDULER_LANES)[number] | `schedule:${string}`;

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

/** One named schedule lane read off the spec text. */
export type DeclaredScheduleLane = { readonly name: string; readonly cadence: string };

export type DeclaredCadences = {
  readonly heartbeat?: string;
  /** The object form's cadence. Absent for the list form. */
  readonly schedule?: string;
  /** The list form's lanes, in name order. Absent for the object form. */
  readonly scheduleLanes?: readonly DeclaredScheduleLane[];
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
 *  trailing `# comment` dropped.
 *  Read by a scan (spec-lines.ts), not `^\s*key\s*:\s*(.*)$`, which was
 *  quadratic in a run of spaces on a line holding a U+2028. */
function scalarIn(block: readonly string[], key: string): string | undefined {
  for (const line of block) {
    const raw = keyedScalar(line, key);
    if (raw === undefined) continue;
    let value = raw.trim();
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

/** The cadence of one schedule entry, object or list item. */
function scheduleCadence(block: readonly string[]): string {
  const cron = scalarIn(block, "cron");
  const every = scalarIn(block, "every");
  const tz = scalarIn(block, "timezone");
  const jitter = scalarIn(block, "jitter");
  const base =
    cron !== undefined
      ? `cron "${cron}"${tz !== undefined ? ` ${tz}` : " UTC"}`
      : every !== undefined
        ? `every ${every}`
        : "declared (no trigger read)";
  return jitter !== undefined ? `${base} ±${jitter}` : base;
}

/** True when a trimmed line opens a sequence item (`- …` or a bare `-`). */
const isItemStart = (trimmed: string): boolean => trimmed === "-" || trimmed.startsWith("- ");

/**
 * The lines of a top-level `schedule:` that is a sequence, or undefined when it
 * is not one. YAML allows the items at the key's own indent (`- name: x` at
 * column 0), which an indented-block read would drop, so column-0 items count.
 */
function scheduleSequence(lines: readonly string[]): string[] | undefined {
  const header = /^schedule\s*:\s*(?:#.*)?$/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!header.test(lines[i] as string)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] as string;
      const trimmed = next.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (indentOf(next) === 0 && !isItemStart(trimmed)) break;
      body.push(next);
    }
    const first = body[0];
    return first !== undefined && isItemStart(first.trim()) ? body : undefined;
  }
  return undefined;
}

/**
 * Split a flow mapping's inside (`name: a, kind: cron, cron: "0 9 * * 1,3"`) on
 * the commas outside quotes, one `key: value` per line.
 */
function flowPairs(inside: string): string[] {
  const out: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < inside.length; i += 1) {
    const ch = inside[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(inside.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inside.slice(start).trim());
  return out.filter((pair) => pair !== "");
}

/** Lane-name grammar, the spec's and control.v1's. */
const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The named lanes of a list-form `schedule:`, leniently: each item whose `name`
 * reads as a lane name yields a lane, its cadence read when it can be and
 * "declared (no trigger read)" when it cannot. An item with no readable name
 * names no lane.
 */
function declaredScheduleLanes(sequence: readonly string[]): DeclaredScheduleLane[] {
  const itemIndent = indentOf(sequence[0] ?? "");
  const items: string[][] = [];
  for (const line of sequence) {
    const trimmed = line.trim();
    if (indentOf(line) === itemIndent && isItemStart(trimmed)) {
      const rest = trimmed.slice(1).trim();
      if (rest.startsWith("{") && rest.endsWith("}")) {
        items.push(flowPairs(rest.slice(1, -1)));
      } else {
        items.push(rest === "" ? [] : [rest]);
      }
      continue;
    }
    items[items.length - 1]?.push(trimmed);
  }
  const lanes = new Map<string, DeclaredScheduleLane>();
  for (const item of items) {
    const name = scalarIn(item, "name");
    if (name === undefined || !LANE_NAME_RE.test(name) || lanes.has(name)) continue;
    lanes.set(name, { name, cadence: scheduleCadence(item) });
  }
  return [...lanes.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Read the declared cadences out of a spec's TEXT. Lenient by design: this
 * is a fleet view, and a harness whose spec is a version ahead of (or behind)
 * the manager's schema must still render its lanes.
 */
export function declaredCadences(yamlText: string): DeclaredCadences {
  const lines = yamlText.split("\n");
  const out: {
    heartbeat?: string;
    schedule?: string;
    scheduleLanes?: DeclaredScheduleLane[];
    dream?: string;
  } = {};

  const heartbeat = blockUnder(lines, "heartbeat", 0);
  if (heartbeat !== undefined) {
    const every = scalarIn(heartbeat, "every");
    out.heartbeat = every !== undefined ? `every ${every}` : "declared (no interval read)";
  }

  const sequence = scheduleSequence(lines);
  if (sequence !== undefined) {
    out.scheduleLanes = declaredScheduleLanes(sequence);
  } else {
    const schedule = blockUnder(lines, "schedule", 0);
    if (schedule !== undefined) out.schedule = scheduleCadence(schedule);
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
    lane: "heartbeat" | "schedule" | `schedule:${string}`,
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
  // Named lanes: every lane the spec declares or the daemon reports, in name
  // order. A list-form spec has no bare `schedule` lane, so that row is not
  // shown for one.
  const listForm = declared.scheduleLanes !== undefined;
  const namedCadence = new Map<string, string | undefined>(
    (declared.scheduleLanes ?? []).map((lane) => [lane.name, lane.cadence]),
  );
  for (const timer of timers ?? []) {
    const name = timer.lane.startsWith("schedule:") ? timer.lane.slice("schedule:".length) : "";
    if (LANE_NAME_RE.test(name) && !namedCadence.has(name)) namedCadence.set(name, undefined);
  }
  const namedRows = [...namedCadence.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      const lane = `schedule:${name}` as const;
      return row(lane, true, namedCadence.get(name), pokeState(lane, true), null);
    });
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
      ...(listForm
        ? []
        : [
            row(
              "schedule",
              scheduleArmed,
              declared.schedule,
              pokeState("schedule", scheduleArmed),
              null,
            ),
          ]),
      ...namedRows,
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
