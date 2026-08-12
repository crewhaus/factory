/**
 * The typed preflight report: what a manager (CLI or UI) shows before it
 * spawns a harness process, instead of relaying the stack trace the spawn
 * would otherwise die with.
 *
 * Every check in this package is PURE with respect to the environment: core
 * functions take an explicit `env` record and never read `process.env`
 * themselves (the one deliberate exception is the `preflightHarness`
 * convenience wrapper, which defaults `env` to `process.env` for callers
 * that want the ambient behaviour). That injection is what makes the checks
 * deterministic in tests and reusable against a *merged* env (harness
 * `.env` chain under the manager's own environment) rather than whatever
 * the manager process happens to have exported.
 */

/** Which subsystem a preflight item belongs to. */
export type PreflightArea =
  | "spec"
  | "env"
  | "credentials"
  | "channels"
  | "mcp"
  | "ports"
  | "bundle"
  | "durability";

/**
 * Severity of one item.
 *
 *   - `blocking` — the spawn is known to fail (or exit 2 at boot) with the
 *     environment as-is. Managers refuse to start until it is fixed or the
 *     operator explicitly overrides.
 *   - `warn`     — the spawn will work but something is degraded or
 *     approximate (stale bundle, literal secret in the spec, missing
 *     durability env).
 *   - `info`     — context the operator may want (satisfied credentials,
 *     ambient-credential providers such as Bedrock where env vars are only
 *     one of the SDK's sources).
 */
export type PreflightLevel = "info" | "warn" | "blocking";

/** One finding. `id` is stable across runs so UIs can acknowledge/deep-link
 *  individual items; `envVar` names the environment variable the item is
 *  about, when there is exactly one (the fleet credentials matrix keys on
 *  it). */
export type PreflightItem = {
  readonly id: string;
  readonly area: PreflightArea;
  readonly level: PreflightLevel;
  readonly message: string;
  readonly remediation?: string;
  readonly envVar?: string;
};

/** The full report. `items` is every finding in composition order (spec →
 *  credentials → channels → mcp → ports → bundle → durability); `blocking`
 *  is the subset with `level: "blocking"`; `ok` is `blocking.length === 0`. */
export type PreflightReport = {
  readonly ok: boolean;
  readonly blocking: readonly PreflightItem[];
  readonly items: readonly PreflightItem[];
};

/** Injected environment. Structurally compatible with `process.env`. */
export type PreflightEnv = Readonly<Record<string, string | undefined>>;

/**
 * The label/pass/warn/reason check shape shared with the CLI's doctor and
 * `crewhaus channel verify` renderers (`warn: true` with `pass: true`
 * renders as an informational "~" line and never fails the command). The
 * extracted cores below keep returning this shape so the CLI can adopt them
 * without changing its output, while `checkToItem` adapts them into the
 * typed report.
 */
export type PreflightCheck = {
  readonly label: string;
  readonly pass: boolean;
  /** warn+pass renders as "~" — informational, never fails the command. */
  readonly warn?: boolean;
  readonly reason?: string;
};

/** True when `name` is set to a non-empty string in `env`. */
export function isEnvSet(env: PreflightEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v !== "";
}

/** Adapt a {@link PreflightCheck} into a {@link PreflightItem}: fail →
 *  blocking, warn-pass → warn, plain pass → info. */
export function checkToItem(
  id: string,
  area: PreflightArea,
  check: PreflightCheck,
  extra: { readonly remediation?: string; readonly envVar?: string } = {},
): PreflightItem {
  const level: PreflightLevel = !check.pass ? "blocking" : check.warn === true ? "warn" : "info";
  return {
    id,
    area,
    level,
    message: check.reason !== undefined ? `${check.label}: ${check.reason}` : check.label,
    ...(extra.remediation !== undefined ? { remediation: extra.remediation } : {}),
    ...(extra.envVar !== undefined ? { envVar: extra.envVar } : {}),
  };
}

/** Assemble a report from items (order preserved). */
export function buildReport(items: readonly PreflightItem[]): PreflightReport {
  const blocking = items.filter((i) => i.level === "blocking");
  return { ok: blocking.length === 0, blocking, items };
}
