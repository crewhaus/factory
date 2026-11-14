/**
 * Codegen for `crewhaus.control.v1` — the ONE place the control-plane wiring
 * that lands in an emitted daemon is written.
 *
 * Five targets emit a daemon (channel, managed, batch, crew, voice). If each
 * of them spelled the control wiring itself, the five would drift the first
 * time one of them was touched, and a supervisor would face five subtly
 * different control planes. So the emitters describe their lanes and
 * side-channels declaratively and this module renders the text; the runtime
 * behind it lives in `./control`, which the emitted daemon imports.
 *
 * Every renderer takes an `indent` and applies it to every line it produces,
 * so a caller can splice a block at any nesting depth without reflowing it.
 */

import type { ControlLane } from "./control";

/** Package specifier the emitted daemon imports the control runtime from. */
export const CONTROL_RUNTIME_MODULE = "@crewhaus/gateway-protocol/control" as const;

function indentBlock(text: string, indent: string): string {
  if (indent === "") return text;
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${indent}${line}`))
    .join("\n");
}

/** JSON-quote a string for embedding in emitted source. */
function q(value: string): string {
  return JSON.stringify(value);
}

export type ControlPlaneEmit = {
  /** Spec name — reported by `/control/v1/healthz` and `/status`. */
  readonly name: string;
  /** Target discriminator (`channel` | `managed` | `batch` | `crew` | `voice`). */
  readonly target: string;
  /** Identifier the plane is bound to in the emitted daemon. Default `__control`. */
  readonly varName?: string;
  /** JS expression evaluating to `string[]` — the channels this daemon serves. */
  readonly channelsExpr?: string;
  /** JS expression evaluating to `number | Promise<number>` — parked approvals. */
  readonly pendingApprovalsExpr?: string;
  /**
   * JS expression evaluating to the harness's `AuditLog` (or `undefined`).
   * Every control call appends a `gateway_request` record through it.
   */
  readonly auditLogExpr?: string;
  readonly indent?: string;
};

/**
 * The import line for the control runtime. Emitted unconditionally by every
 * daemon-shape target — control.v1 is the lowest common denominator all
 * daemon shapes share, so a bundle either has it or is a pre-0.5.0 bundle.
 */
export function renderControlImports(
  opts: {
    readonly pendingApprovals?: boolean;
    /** Pull in {@link runDrainSweep} — a drain step that sweeps housekeeping. */
    readonly drainSweep?: boolean;
    /** Pull in {@link sanitizeControlText} — a daemon that logs untrusted text. */
    readonly logSafe?: boolean;
  } = {},
): string {
  const names = [
    ...(opts.pendingApprovals === true ? ["countPendingApprovals"] : []),
    "createControlPlane",
    ...(opts.drainSweep === true ? ["runDrainSweep"] : []),
    ...(opts.logSafe === true ? ["sanitizeControlText"] : []),
  ].join(", ");
  return `import { ${names} } from ${q(CONTROL_RUNTIME_MODULE)};\n`;
}

/**
 * `const __control = createControlPlane({ … });`
 *
 * Binding is deferred to {@link renderControlStart} so a daemon can register
 * its lanes and drain steps (which close over the server/janitor it creates
 * later) before the socket accepts a single request.
 */
export function renderControlPlaneBoot(opts: ControlPlaneEmit): string {
  const v = opts.varName ?? "__control";
  const fields = [
    `name: ${q(opts.name)},`,
    `target: ${q(opts.target)},`,
    ...(opts.channelsExpr !== undefined ? [`channels: () => ${opts.channelsExpr},`] : []),
    ...(opts.pendingApprovalsExpr !== undefined
      ? [`pendingApprovals: async () => ${opts.pendingApprovalsExpr},`]
      : []),
    ...(opts.auditLogExpr !== undefined
      ? [
          "audit: async (__rec) => {",
          `  const __log = ${opts.auditLogExpr};`,
          "  if (__log !== undefined) await __log.append(__rec);",
          "},",
        ]
      : []),
  ];
  const body = [
    "// crewhaus.control.v1 — the supervisor-facing control plane (§ dedicated",
    "// port from CREWHAUS_CONTROL_PORT, bearer from CREWHAUS_CONTROL_TOKEN or a",
    "// boot-minted .crewhaus/run/control-token). Unset port ⇒ no socket opens.",
    `const ${v} = createControlPlane({`,
    ...fields.map((f) => `  ${f}`),
    "});",
  ].join("\n");
  return `${indentBlock(body, opts.indent ?? "")}\n`;
}

export type ControlLaneEmit = {
  /** The lane an operator can poke: `heartbeat`, `schedule` or `schedule:<name>`. */
  readonly lane: ControlLane;
  /** Identifier the lane handle binds to (e.g. `__heartbeatLane`). */
  readonly varName: string;
  /** Human cadence for `/status` — e.g. `every 60000ms`. */
  readonly cadence: string;
  /** Fixed interval, when the lane has one; projects `nextDueAt`. */
  readonly everyMs?: number;
  /** JS expression returning `string | undefined` — overrides the projection. */
  readonly nextDueAtExpr?: string;
  /**
   * `false` for a lane whose body does NOT thread `__tick.sessionId` into a
   * session of its own (the managed fan-out, the batch producer). Such a lane
   * writes no wake marker and its 202 omits `sessionId` instead of handing the
   * operator an id that names nothing — see `ControlLaneOptions.ownsSession`.
   */
  readonly ownsSession?: boolean;
  /**
   * The tick body. Rendered inside `async (__tick) => { … }`, so it can read
   * `__tick.sessionId` (minted by the lane, identical for timer + operator
   * fires) and `__tick.synthetic`.
   */
  readonly body: string;
  readonly planeVar?: string;
  readonly indent?: string;
};

/**
 * Register a pokeable lane. The returned handle's `tick()` is what the timer
 * calls and `wake()` is what `POST /control/v1/wake` calls — ONE body, so the
 * operator poke can never diverge from the organic fire, and the lane's
 * never-overlap guard covers both (a wake during an in-flight tick 409s).
 */
export function renderControlLane(opts: ControlLaneEmit): string {
  const plane = opts.planeVar ?? "__control";
  const body = [
    `const ${opts.varName} = ${plane}.lane({`,
    `  lane: ${q(opts.lane)},`,
    `  cadence: ${q(opts.cadence)},`,
    ...(opts.everyMs !== undefined ? [`  everyMs: ${opts.everyMs},`] : []),
    ...(opts.nextDueAtExpr !== undefined ? [`  nextDueAt: () => ${opts.nextDueAtExpr},`] : []),
    ...(opts.ownsSession === false ? ["  ownsSession: false,"] : []),
    "  run: async (__tick) => {",
    indentBlock(opts.body, "    "),
    "  },",
    "});",
  ].join("\n");
  return `${indentBlock(body, opts.indent ?? "")}\n`;
}

/** One named schedule lane to render: its wake schedule, plus the prompt each wake runs. */
export type ScheduleLaneEmit = { readonly name: string; readonly instructions: string } & (
  | {
      readonly kind: "cron";
      readonly cron: string;
      readonly timezone?: string;
      readonly jitterMs?: number;
    }
  | {
      readonly kind: "interval";
      readonly everyMs: number;
      readonly jitterMs?: number;
    }
);

/** What a schedule lane's tick body is rendered from. */
export type ScheduleLaneBodyContext = {
  readonly name: string;
  /** The control lane id, `schedule:<name>`. */
  readonly laneId: string;
  /** The lane's position in name order; identifiers use it, since a name may hold `-`. */
  readonly index: number;
  /** A JS expression evaluating to the lane's wake prompt. */
  readonly instructionsVar: string;
};

/** Identifier the armed lanes' cancel handle binds to: `{ cancel(): void } | undefined`. */
export const SCHEDULE_LANES_ARMED_VAR = "__scheduleLanesArmed" as const;

/** The cadence `/status` shows for a schedule: `cron "<expr>" <tz|UTC>` or `every <ms>ms`, then any jitter. */
export function scheduleLaneCadence(lane: ScheduleLaneEmit): string {
  const base =
    lane.kind === "cron"
      ? `cron "${lane.cron}" ${lane.timezone ?? "UTC"}`
      : `every ${lane.everyMs}ms`;
  return lane.jitterMs !== undefined ? `${base} +/-${lane.jitterMs}ms jitter` : base;
}

function wakeLiteral(lane: ScheduleLaneEmit): string {
  const wake =
    lane.kind === "cron"
      ? {
          kind: lane.kind,
          cron: lane.cron,
          ...(lane.timezone !== undefined ? { timezone: lane.timezone } : {}),
          ...(lane.jitterMs !== undefined ? { jitterMs: lane.jitterMs } : {}),
        }
      : {
          kind: lane.kind,
          everyMs: lane.everyMs,
          ...(lane.jitterMs !== undefined ? { jitterMs: lane.jitterMs } : {}),
        };
  return JSON.stringify(wake);
}

/** Code-unit order, so the output does not depend on the compiling machine's locale. */
function byName(a: ScheduleLaneEmit, b: ScheduleLaneEmit): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Named schedule lanes (#514, #513): the lanes literal, one control lane
 * `schedule:<name>` per lane, and one `armScheduleLanes(…)` call that wakes
 * each lane's `tick()` on its own cadence. The lanes are written in name order
 * whatever order they arrive in, and every string is a JSON literal, so a lane's
 * instructions reach the output only as quoted data.
 *
 * The emitted daemon must import `armScheduleLanes` and `nextWakeDelayMs` from
 * `@crewhaus/durable-execution`. The cancel handle binds to
 * {@link SCHEDULE_LANES_ARMED_VAR}, `undefined` until armed; with `armGuard` the
 * lanes are registered (so `/status` lists them) but armed only when the guard
 * holds. `afterArm` runs right after arming and may read `__scheduleLanes`.
 */
export function renderScheduleLanes(opts: {
  readonly lanes: ReadonlyArray<ScheduleLaneEmit>;
  /** The tick body for one lane, rendered inside `async (__tick) => { … }`. */
  readonly body: (lane: ScheduleLaneBodyContext) => string;
  /** As {@link ControlLaneEmit.ownsSession}, for every lane. */
  readonly ownsSession?: boolean;
  /** Rendered inside `(__err, __name) => { … }` for a fault the lane did not absorb. */
  readonly onErrorBody: string;
  /** A JS condition; when set, the lanes arm only while it holds. */
  readonly armGuard?: string;
  readonly afterArm?: string;
  readonly planeVar?: string;
  readonly indent?: string;
}): string {
  const lanes = [...opts.lanes].sort(byName);
  const literal = [
    "const __scheduleLanes = [",
    ...lanes.map(
      (lane) =>
        `  { name: ${q(lane.name)}, wake: ${wakeLiteral(lane)}, cadence: ${q(scheduleLaneCadence(lane))}, instructions: ${q(lane.instructions)} },`,
    ),
    "] as const;",
  ].join("\n");
  const registrations = lanes
    .map((lane, index) => {
      const laneId = `schedule:${lane.name}` as const;
      return renderControlLane({
        lane: laneId,
        varName: `__scheduleLane${index}`,
        cadence: scheduleLaneCadence(lane),
        nextDueAtExpr: `new Date(Date.now() + nextWakeDelayMs(__scheduleLanes[${index}].wake, Date.now())).toISOString()`,
        ...(opts.ownsSession !== undefined ? { ownsSession: opts.ownsSession } : {}),
        ...(opts.planeVar !== undefined ? { planeVar: opts.planeVar } : {}),
        body: opts.body({
          name: lane.name,
          laneId,
          index,
          instructionsVar: `__scheduleLanes[${index}].instructions`,
        }),
      });
    })
    .join("");
  const byNameMap = [
    "const __scheduleLaneByName = new Map([",
    ...lanes.map((lane, index) => `  [${q(lane.name)}, __scheduleLane${index}],`),
    "]);",
  ].join("\n");
  const arm = [
    `${SCHEDULE_LANES_ARMED_VAR} = armScheduleLanes(`,
    "  __scheduleLanes.map((__l) => ({ name: __l.name, ...__l.wake })),",
    "  {",
    "    onWake: async (__name) => {",
    "      await __scheduleLaneByName.get(__name)?.tick();",
    "    },",
    "    onError: (__err, __name) => {",
    indentBlock(opts.onErrorBody, "      "),
    "    },",
    "  },",
    ");",
    ...(opts.afterArm !== undefined ? [opts.afterArm] : []),
  ].join("\n");
  const body = [
    literal,
    `${registrations}${byNameMap}`,
    `let ${SCHEDULE_LANES_ARMED_VAR}: { cancel(): void } | undefined;`,
    opts.armGuard !== undefined
      ? [`if (${opts.armGuard}) {`, indentBlock(arm, "  "), "}"].join("\n")
      : arm,
  ].join("\n");
  return `${indentBlock(body, opts.indent ?? "")}\n`;
}

/**
 * A read-only timer row for `/control/v1/status` (the janitor and dream lanes
 * are observed, not pokeable). `expr` is a JS expression evaluating to a
 * `ControlTimerReport`.
 */
export function renderControlTimer(opts: {
  readonly expr: string;
  readonly planeVar?: string;
  readonly indent?: string;
}): string {
  const plane = opts.planeVar ?? "__control";
  return `${indentBlock(`${plane}.timer(() => (${opts.expr}));`, opts.indent ?? "")}\n`;
}

/**
 * Register a drain step. `POST /control/v1/drain` stops intake first (the
 * public gate starts answering 503 + Retry-After the moment the request lands),
 * waits out in-flight lane ticks, then runs these steps in order and exits 0.
 */
export function renderControlDrain(opts: {
  readonly body: string;
  readonly planeVar?: string;
  readonly indent?: string;
}): string {
  const plane = opts.planeVar ?? "__control";
  const body = [`${plane}.onDrain(async () => {`, indentBlock(opts.body, "  "), "});"].join("\n");
  return `${indentBlock(body, opts.indent ?? "")}\n`;
}

/** `await __control.start();` — binds the dedicated port when one is configured. */
export function renderControlStart(opts: {
  readonly planeVar?: string;
  readonly indent?: string;
}): string {
  const plane = opts.planeVar ?? "__control";
  return `${indentBlock(`await ${plane}.start();`, opts.indent ?? "")}\n`;
}

/**
 * The PUBLIC-port wrapper: a bare unauthenticated `GET /healthz` (liveness
 * only, no state — this is what deployment scaffolds' health checks have been
 * declaring against nothing) plus the 503 + `Retry-After` intake shed once the
 * daemon is draining. Everything else falls through to `innerExpr`.
 *
 * Renders an inline arrow suitable as a `Bun.serve({ fetch })` value.
 */
export function renderPublicGateFetch(opts: {
  readonly innerExpr: string;
  readonly planeVar?: string;
}): string {
  const plane = opts.planeVar ?? "__control";
  return `(__req) => ${plane}.publicGate(__req) ?? (${opts.innerExpr})(__req)`;
}
