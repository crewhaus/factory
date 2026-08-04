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
  /** The lane an operator can poke. */
  readonly lane: "heartbeat" | "schedule";
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
