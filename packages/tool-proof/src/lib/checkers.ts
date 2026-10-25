/**
 * The proof checkers a harness proves with, and what `ProofCheckers` says
 * about each (design §6.4, §7).
 *
 * The checkers come from `@crewhaus/proof-checker`'s `createDefaultCheckers`
 * in the configured preference order (`formal.checkers`), with the builtin
 * certificate checker always among them: it needs no sandbox, so a harness
 * can always prove something. The sandbox checkers (`smt`, `lean4`) are
 * always LISTED when configured — with no sandbox they say why in
 * `available()` and refuse in `check()` — so the model sees what it could
 * prove with and why it cannot right now, instead of a checker silently
 * missing (the registry's own rule).
 *
 * The sandbox is created lazily, on the first call that needs the checkers,
 * the way tool-code-execution creates its own: importing the package (the
 * CLI imports every tool package) must not touch a container runtime.
 */
import {
  type CheckerAvailability,
  DEFAULT_LEAN4_IMAGE,
  DEFAULT_SMT_IMAGE,
  type ProofChecker,
  type SandboxLike,
  createDefaultCheckers,
} from "@crewhaus/proof-checker";
import type { ProvabilityConfig } from "@crewhaus/provability";

/** The id of the checker that is always present. */
export const BUILTIN_ID = "builtin";

/**
 * How long `ProofCheckers` waits on one checker's `available()`. The sandbox
 * checkers bound their own probe (a cold image pull is slow, so 20 s), and
 * remember the answer; this is the backstop for a plugin checker that never
 * answers, so one hung probe cannot hang the listing.
 */
export const AVAILABILITY_TIMEOUT_MS = 30_000;

/** One checker as `ProofCheckers` reports it. */
export type CheckerListing = {
  readonly id: string;
  readonly available: boolean;
  /** Why it cannot run here, when it cannot. */
  readonly reason?: string;
  /** The checker's own paragraph on its statement language. */
  readonly language: string;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `checker.available()`, bounded and total: a throw, a malformed answer or
 * no answer within `timeoutMs` reads as unavailable, with the reason.
 */
export async function probeChecker(
  checker: ProofChecker,
  timeoutMs = AVAILABILITY_TIMEOUT_MS,
): Promise<CheckerAvailability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckerAvailability>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          reason: `the ${checker.id} checker did not say whether it can run within ${timeoutMs} ms`,
        }),
      timeoutMs,
    );
  });
  try {
    const answer = await Promise.race([
      Promise.resolve()
        .then(() => checker.available())
        .catch(
          (err: unknown): CheckerAvailability => ({
            ok: false,
            reason: `the ${checker.id} checker's availability probe failed: ${message(err)}`,
          }),
        ),
      timeout,
    ]);
    if (typeof answer !== "object" || answer === null || typeof answer.ok !== "boolean") {
      return { ok: false, reason: `the ${checker.id} checker gave no availability answer` };
    }
    if (answer.ok) return { ok: true };
    return {
      ok: false,
      reason:
        typeof answer.reason === "string" && answer.reason.trim() !== ""
          ? answer.reason
          : `the ${checker.id} checker cannot run here`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Every checker with its probed availability, in preference order. Probes run in parallel. */
export async function listCheckers(
  checkers: ReadonlyArray<ProofChecker>,
  timeoutMs = AVAILABILITY_TIMEOUT_MS,
): Promise<CheckerListing[]> {
  return Promise.all(
    checkers.map(async (checker) => {
      const availability = await probeChecker(checker, timeoutMs);
      return {
        id: checker.id,
        available: availability.ok,
        ...(availability.ok ? {} : { reason: availability.reason as string }),
        language: typeof checker.language === "string" ? checker.language : "",
      };
    }),
  );
}

/** `formal.checkers` in order, with the builtin appended when the config left it out. */
export function defaultCheckerIds(config: ProvabilityConfig): string[] {
  const ids = [...new Set(config.formal.checkers as ReadonlyArray<string>)];
  return ids.includes(BUILTIN_ID) ? ids : [...ids, BUILTIN_ID];
}

/** The container images the configured sandbox checkers run (what the sandbox must allow). */
export function sandboxImages(config: ProvabilityConfig): string[] {
  const ids = defaultCheckerIds(config);
  const images: string[] = [];
  if (ids.includes("smt")) images.push(DEFAULT_SMT_IMAGE);
  // `formal.image` is the lean4 override (the Mathlib case) — proof-checker's
  // reading of the spec key, which the gate's composition root shares.
  if (ids.includes("lean4")) images.push(config.formal.image ?? DEFAULT_LEAN4_IMAGE);
  return images;
}

export type DefaultCheckerDeps = {
  /** Whether a container sandbox may be used (CREWHAUS_SANDBOX, or the loop said one is wired). */
  readonly sandboxAvailable: boolean;
  /** Build the sandbox; `@crewhaus/sandbox`'s `createSandbox` in production. */
  readonly createSandbox: (opts: { readonly allowedImages: ReadonlyArray<string> }) => SandboxLike;
};

/**
 * A sandbox that could not be built stands in as one whose every exec
 * throws the reason: the sandbox checkers' probe then reports WHY ("could
 * not be probed: CREWHAUS_SANDBOX=… is not a sandbox backend") instead of
 * the generic "no sandbox is configured".
 */
function brokenSandbox(err: unknown): SandboxLike {
  const reason = message(err);
  return {
    backend: "unavailable",
    async exec() {
      throw new Error(`the sandbox could not be created: ${reason}`);
    },
  };
}

/**
 * The default checkers for `config`: `formal.checkers` in order plus the
 * builtin, with a sandbox for the sandbox checkers when one is available.
 * Without one they are present and unavailable, saying why.
 */
export function buildDefaultCheckers(
  config: ProvabilityConfig,
  deps: DefaultCheckerDeps,
): ProofChecker[] {
  const ids = defaultCheckerIds(config);
  const images = sandboxImages(config);
  let sandbox: SandboxLike | undefined;
  if (images.length > 0 && deps.sandboxAvailable) {
    try {
      sandbox = deps.createSandbox({ allowedImages: images });
    } catch (err) {
      sandbox = brokenSandbox(err);
    }
  }
  return createDefaultCheckers({
    ids,
    timeoutMs: config.formal.timeoutMs,
    forbid: config.formal.forbid,
    ...(config.formal.image !== undefined ? { images: { lean4: config.formal.image } } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
  });
}
