/**
 * The checker registry and the default set (design §6.4, §3 `formal`).
 *
 * `createDefaultCheckers` turns a spec's `provability.formal` block into
 * checkers, in `formal.checkers` order — the order is the preference the
 * `ProofCheckers` tool tells the model. The sandbox checkers are always
 * PRESENT when listed: with no sandbox they say why in `available()` and
 * refuse in `check()`, so the model sees what it could prove with and why it
 * cannot right now, instead of a checker silently missing.
 */
import { CrewhausError } from "@crewhaus/errors";
import { BUILTIN_CHECKER_ID, createBuiltinChecker } from "./builtin/checker";
import {
  LEAN4_CHECKER_ID,
  LEAN4_LANGUAGE,
  type Lean4CheckerOptions,
  createLean4Checker,
} from "./lean4";
import { SMT_CHECKER_ID, SMT_LANGUAGE, createSmtChecker } from "./smt";
import type { CheckInput, CheckResult, ProofChecker, SandboxLike } from "./types";

/** The checkers this package ships. */
export const KNOWN_CHECKER_IDS = [BUILTIN_CHECKER_ID, SMT_CHECKER_ID, LEAN4_CHECKER_ID] as const;
export type KnownCheckerId = (typeof KNOWN_CHECKER_IDS)[number];
/** `formal.checkers`' default (the IR doc's): builtin first, then Z3. */
export const DEFAULT_CHECKER_IDS: ReadonlyArray<KnownCheckerId> = [
  BUILTIN_CHECKER_ID,
  SMT_CHECKER_ID,
];

export class ProofCheckerConfigError extends CrewhausError {
  override readonly name = "ProofCheckerConfigError";
  constructor(message: string) {
    super("config", message);
  }
}

export interface CheckerRegistry {
  /** The checker with this id, or undefined. */
  get(id: string): ProofChecker | undefined;
  has(id: string): boolean;
  /** Every checker, in registration (= preference) order. */
  list(): ReadonlyArray<ProofChecker>;
  ids(): ReadonlyArray<string>;
}

/** A registry over `checkers`; a repeated id is refused rather than shadowed. */
export function createCheckerRegistry(checkers: Iterable<ProofChecker>): CheckerRegistry {
  const byId = new Map<string, ProofChecker>();
  for (const checker of checkers) {
    if (typeof checker.id !== "string" || checker.id.trim() === "") {
      throw new ProofCheckerConfigError("a proof checker needs a non-empty id");
    }
    if (byId.has(checker.id)) {
      throw new ProofCheckerConfigError(`proof checker id "${checker.id}" is registered twice`);
    }
    byId.set(checker.id, checker);
  }
  const ordered = [...byId.values()];
  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    list: () => ordered,
    ids: () => ordered.map((c) => c.id),
  };
}

export type DefaultCheckersOptions = {
  /** The sandbox for `smt` / `lean4`. Absent ⇒ they are listed but unavailable. */
  readonly sandbox?: SandboxLike;
  /** Image overrides. The spec's `formal.image` is the lean4 override (the Mathlib case, design §6.4). */
  readonly images?: { readonly smt?: string; readonly lean4?: string };
  /** The lean4 pre-scan's forbid list (`formal.forbid`). */
  readonly forbid?: readonly string[];
  /**
   * Per-check budget (`formal.timeout_ms`). The sandbox checkers get it whole;
   * the builtin caps it at `BUILTIN_LIMITS.maxTimeoutMs` (10 s), because it
   * runs synchronously on the caller's thread and the 30 s default is sized
   * for a container's cold start.
   */
  readonly timeoutMs?: number;
  /** Which checkers, in preference order (`formal.checkers`; default builtin, smt). */
  readonly ids?: ReadonlyArray<string>;
  /** Let the sandbox checkers run on a noop backend (trusted callers and tests only). */
  readonly allowNoop?: boolean;
  /** Extra options for the lean4 adapter (`imports`, `argv`). */
  readonly lean4?: Pick<Lean4CheckerOptions, "imports" | "argv">;
};

/** A listed sandbox checker that has no sandbox: present, and honest about why it cannot run. */
function unavailableChecker(id: string, language: string, reason: string): ProofChecker {
  return {
    id,
    language,
    async available() {
      return { ok: false, reason };
    },
    async check(_input: CheckInput): Promise<CheckResult> {
      return {
        ok: false,
        checker: id,
        assumptions: [],
        axioms: [],
        output: "",
        reason,
        durationMs: 0,
      };
    },
  };
}

function noSandbox(id: string): string {
  return `the ${id} checker needs a container sandbox and none is configured (set CREWHAUS_SANDBOX=docker or podman); the builtin checker needs none`;
}

/** The checkers for a `provability.formal` block, in its order. */
export function createDefaultCheckers(opts: DefaultCheckersOptions = {}): ProofChecker[] {
  const ids = opts.ids ?? DEFAULT_CHECKER_IDS;
  const out: ProofChecker[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    switch (id) {
      case BUILTIN_CHECKER_ID:
        out.push(
          createBuiltinChecker(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        );
        break;
      case SMT_CHECKER_ID:
        out.push(
          opts.sandbox === undefined
            ? unavailableChecker(SMT_CHECKER_ID, SMT_LANGUAGE, noSandbox(SMT_CHECKER_ID))
            : createSmtChecker({
                sandbox: opts.sandbox,
                ...(opts.images?.smt !== undefined ? { image: opts.images.smt } : {}),
                ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
                ...(opts.allowNoop === true ? { allowNoop: true } : {}),
              }),
        );
        break;
      case LEAN4_CHECKER_ID:
        out.push(
          opts.sandbox === undefined
            ? unavailableChecker(LEAN4_CHECKER_ID, LEAN4_LANGUAGE, noSandbox(LEAN4_CHECKER_ID))
            : createLean4Checker({
                sandbox: opts.sandbox,
                ...(opts.images?.lean4 !== undefined ? { image: opts.images.lean4 } : {}),
                ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
                ...(opts.forbid !== undefined ? { forbid: opts.forbid } : {}),
                ...(opts.allowNoop === true ? { allowNoop: true } : {}),
                ...(opts.lean4?.imports !== undefined ? { imports: opts.lean4.imports } : {}),
                ...(opts.lean4?.argv !== undefined ? { argv: opts.lean4.argv } : {}),
              }),
        );
        break;
      default:
        throw new ProofCheckerConfigError(
          `unknown proof checker "${id}" (known: ${KNOWN_CHECKER_IDS.join(", ")}); a plugin checker is registered with createCheckerRegistry`,
        );
    }
  }
  return out;
}

/**
 * The container images the given checkers run — what a caller adds to its
 * sandbox's `allowedImages` (or registers through `ensureZ3SandboxImage` /
 * `ensureLean4SandboxImage`, which put the curated refs on
 * `listAllowedImageRefs()`). An overridden `formal.image` is only reachable
 * this way.
 */
export function checkerImages(checkers: Iterable<ProofChecker>): string[] {
  const out: string[] = [];
  for (const c of checkers) {
    const image = (c as { readonly image?: unknown }).image;
    if (typeof image === "string" && !out.includes(image)) out.push(image);
  }
  return out;
}
