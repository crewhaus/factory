/**
 * What the two sandbox checkers (`smt`, `lean4`) share: the noop-backend
 * refusal, the image health probe behind `available()`, and output clipping.
 * design §6.4, §10.
 *
 * Proof text is model output that may have absorbed injected content, and the
 * sandbox checkers hand it to a program. So they run only in a container
 * sandbox (`network=none`, read-only root — the `@crewhaus/sandbox`
 * defaults), and they refuse on the `noop` backend, which would run the
 * checker binary on the host with no isolation — the same posture
 * `tool-code-execution` takes. `ProofCheck` is not `requiresSandbox` at the
 * tool level because the builtin checker needs no sandbox; the refusal lives
 * here, per checker. Trusted code (a test, a developer pointing the checker at
 * a host Z3) may opt in with `allowNoop: true`.
 */
import type { CheckerAvailability, ProofChecker, SandboxLike } from "./types";

/** A sandbox checker also says which image it runs, so callers can allowlist it. */
export interface SandboxProofChecker extends ProofChecker {
  /** The container image `check()` runs (the curated default, or the override). */
  readonly image: string;
}

/** Options every sandbox checker takes. */
export type SandboxCheckerOptions = {
  /** The sandbox the checker runs in. Its `allowedImages` must include {@link SandboxProofChecker.image}. */
  readonly sandbox: SandboxLike;
  /**
   * Image override; default: the curated image. For lean4 it is the spec's
   * `formal.image`; smt has no spec key, so only a programmatic caller sets it.
   */
  readonly image?: string;
  /** Per-check budget when the input carries none (ms, default 30 000 — `formal.timeout_ms`). */
  readonly timeoutMs?: number;
  /**
   * Run on the `noop` backend anyway. Trusted callers only: noop runs the
   * checker binary on the host, with no isolation.
   */
  readonly allowNoop?: boolean;
  /** Budget for the `available()` image probe (ms, default 20 000; a cold pull is slow). */
  readonly probeTimeoutMs?: number;
  /** How long a failed probe is remembered before `available()` probes again (ms, default 60 000). */
  readonly probeRetryMs?: number;
  /** Clock for the probe cache (tests). */
  readonly now?: () => number;
};

export const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_RETRY_MS = 60_000;
/** Checker output kept in a result (the `CheckResult.output` contract: "a few KB"). */
export const OUTPUT_CAP = 4_000;

export function noopRefusal(
  id: string,
  sandbox: SandboxLike,
  allowNoop: boolean,
): string | undefined {
  if (sandbox.backend !== "noop" || allowNoop) return undefined;
  return `the ${id} checker runs proofs only in a container sandbox, and the sandbox backend is noop (no isolation); set CREWHAUS_SANDBOX=docker (or podman), or use the builtin checker`;
}

/** Keep the head and the tail of long output, marking the cut. */
export function clipOutput(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.7));
  const tail = text.slice(text.length - Math.floor(cap * 0.25));
  return `${head}\n… ${text.length - head.length - tail.length} characters omitted …\n${tail}`;
}

/** Longest assumption text kept (they render on every surface). */
export const ASSUMPTION_CAP = 2_000;

/**
 * The first usable budget: a finite, non-negative number of ms. A NaN or a
 * negative value from a caller must not disable a deadline.
 */
export function budgetMs(...candidates: ReadonlyArray<number | undefined>): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  }
  return DEFAULT_SANDBOX_TIMEOUT_MS;
}

export function clipLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `available()` for a sandbox checker: refuse on noop, otherwise run the
 * image's healthcheck argv once. A pass is remembered for the checker's
 * lifetime; a failure for `probeRetryMs`, so a `ProofCheckers` call does not
 * wait out a cold pull every time. Concurrent callers share one probe.
 */
export function createAvailabilityProbe(args: {
  readonly id: string;
  readonly image: string;
  readonly healthcheck: ReadonlyArray<string>;
  readonly opts: SandboxCheckerOptions;
}): () => Promise<CheckerAvailability> {
  const { id, image, healthcheck, opts } = args;
  const now = opts.now ?? Date.now;
  const retryMs = opts.probeRetryMs ?? DEFAULT_PROBE_RETRY_MS;
  let healthy = false;
  let failure: { readonly at: number; readonly result: CheckerAvailability } | undefined;
  let inflight: Promise<CheckerAvailability> | undefined;

  const probe = async (): Promise<CheckerAvailability> => {
    try {
      const result = await opts.sandbox.exec({
        image,
        argv: healthcheck,
        timeoutMs: opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && result.timedOut !== true) return { ok: true };
      const how =
        result.timedOut === true
          ? "timed out (the image may still be pulling)"
          : `exited ${result.exitCode}`;
      const detail = clipLine(result.stderr || result.stdout, 200);
      return {
        ok: false,
        reason: `the ${id} image ${image} is not ready: \`${healthcheck.join(" ")}\` ${how}${detail !== "" ? `: ${detail}` : ""}`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `the ${id} image ${image} could not be probed: ${clipLine(errorMessage(err), 200)}`,
      };
    }
  };

  return async () => {
    const refusal = noopRefusal(id, opts.sandbox, opts.allowNoop === true);
    if (refusal !== undefined) return { ok: false, reason: refusal };
    if (healthy) return { ok: true };
    if (failure !== undefined && now() - failure.at < retryMs) return failure.result;
    if (inflight === undefined) {
      inflight = probe().then((result) => {
        inflight = undefined;
        if (result.ok) {
          healthy = true;
          failure = undefined;
        } else {
          failure = { at: now(), result };
        }
        return result;
      });
    }
    return inflight;
  };
}
