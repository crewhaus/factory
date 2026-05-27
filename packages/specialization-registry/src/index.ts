/**
 * Track G (§58) — `specialization-registry`. File-backed registry of
 * domain specializations.
 *
 * Source: Meta-Engineering Harnesses (Sengupta et al., HireNimbus,
 * arxiv 2605.25665, §4.4). A specialization is a named collection of
 * domain-specific invariants — for "payments" the invariants are
 * idempotency keys, explicit state transitions, trust-boundary checks;
 * for "auth" they're token expiry, scope checks, etc. The contract
 * compiler (Track G in the same plan) calls into this registry to
 * inject these invariants into the compiled contract.
 *
 * The paper's key safety rule: specializations apply only when
 * **confidence crosses a threshold**. Below that, the pipeline
 * proceeds without specialization to avoid corrupting the contract
 * with wrong domain assumptions. The registry stores
 * `(name, invariants, confidenceThreshold)` triples and exposes a
 * `match(text, opts) → SpecializationMatch | undefined` function.
 *
 * v0 ships:
 *   - In-memory registry seeded with three reference specializations
 *     (payments, auth, booking).
 *   - File-backed registry that reads from
 *     `.crewhaus/specializations/<name>.json` (overrides built-ins).
 *   - `match()` — keyword-based confidence scoring; the contract
 *     compiler can pass `mode: "strict"` to require explicit opt-in
 *     and skip auto-detection entirely.
 *
 * Cited paper: Meta-Engineering Harnesses (arxiv 2605.25665, §4.4).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

export class SpecializationRegistryError extends CrewhausError {
  override readonly name = "SpecializationRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * One named invariant a specialization injects into a contract. The
 * contract compiler maps each to a clause in the compiled YAML.
 */
export type Invariant = {
  readonly id: string;
  readonly description: string;
  /** Severity for the contract reviewer: must-have vs nice-to-have. */
  readonly required: boolean;
};

/**
 * A specialization record. `keywords` are used by the default
 * confidence-scoring heuristic; the score is the fraction of keywords
 * present in the input text (case-insensitive substring match).
 */
export type Specialization = {
  readonly name: string;
  readonly description: string;
  readonly keywords: ReadonlyArray<string>;
  readonly invariants: ReadonlyArray<Invariant>;
  /** Apply only when confidence >= this. Default 0.5. */
  readonly confidenceThreshold: number;
};

export type SpecializationMatch = {
  readonly specialization: Specialization;
  readonly confidence: number;
  /** Which keywords were hit; for audit + debugging. */
  readonly matchedKeywords: ReadonlyArray<string>;
};

/**
 * Built-in reference specializations. These are the ones the
 * Meta-Engineering Harnesses paper specifically calls out as
 * "recurring task domains" in their CTO-as-a-service deployment.
 */
export const BUILTIN_SPECIALIZATIONS: ReadonlyArray<Specialization> = Object.freeze([
  Object.freeze({
    name: "payments",
    description: "Stripe / payment intent flows. Idempotency, state transitions, trust boundaries.",
    keywords: Object.freeze([
      "stripe",
      "payment",
      "paymentintent",
      "charge",
      "refund",
      "invoice",
      "checkout",
      "billing",
    ]),
    invariants: Object.freeze([
      {
        id: "idempotency-key",
        description:
          "Every state-mutating request must carry an idempotency key; the handler must short-circuit on duplicate keys.",
        required: true,
      },
      {
        id: "state-transitions",
        description:
          "Document the allowed state transitions explicitly (pending → succeeded, pending → failed, etc.) and reject any other transition.",
        required: true,
      },
      {
        id: "trust-boundary-client-status",
        description:
          "Never trust client-reported payment status; always verify against the upstream provider.",
        required: true,
      },
      {
        id: "discount-deduction-source",
        description:
          "Final-invoice calculations must read deposit/discount amounts from a single source of truth, not recompute from disparate fields.",
        required: false,
      },
    ]),
    confidenceThreshold: 0.3,
  }),
  Object.freeze({
    name: "auth",
    description:
      "Authentication and session-token handling. Token expiry, scope checks, revocation.",
    keywords: Object.freeze([
      "jwt",
      "session",
      "token",
      "oauth",
      "login",
      "logout",
      "refresh-token",
      "auth",
    ]),
    invariants: Object.freeze([
      {
        id: "token-expiry-check",
        description:
          "Every token verification must check expiry (exp claim) and reject expired tokens.",
        required: true,
      },
      {
        id: "scope-check",
        description:
          "Every protected endpoint must verify the token's scope grants the requested action.",
        required: true,
      },
      {
        id: "revocation-list",
        description:
          "Maintain a revocation list (or short token lifetimes + refresh tokens) so compromised tokens can be invalidated.",
        required: true,
      },
    ]),
    confidenceThreshold: 0.3,
  }),
  Object.freeze({
    name: "booking",
    description:
      "Scheduling / appointment flows. Conflict detection, time-zone handling, cancellation windows.",
    keywords: Object.freeze([
      "booking",
      "appointment",
      "schedule",
      "calendar",
      "reservation",
      "slot",
      "availability",
    ]),
    invariants: Object.freeze([
      {
        id: "conflict-detection",
        description:
          "Reserving a slot must use a transaction that rejects double-bookings (FOR UPDATE / SELECT FOR SHARE / optimistic-lock).",
        required: true,
      },
      {
        id: "timezone-explicit",
        description:
          "Every time field must carry its time zone (or be normalised to UTC) — never assume the server's local time.",
        required: true,
      },
      {
        id: "cancellation-window",
        description:
          "Cancellations must respect a documented cancellation window; the handler enforces it server-side regardless of UI affordance.",
        required: false,
      },
    ]),
    confidenceThreshold: 0.3,
  }),
]);

/**
 * Match a free-text issue/contract draft against the registered
 * specializations. Returns the highest-confidence match whose score
 * is >= its threshold, or undefined when no specialization matches.
 *
 * `mode: "strict"` skips auto-detection and only returns a match if
 * the caller explicitly named one in `forceMatch`.
 */
export type MatchOptions = {
  readonly mode?: "auto" | "strict";
  readonly forceMatch?: string;
  readonly registry?: ReadonlyArray<Specialization>;
};

export function match(text: string, opts: MatchOptions = {}): SpecializationMatch | undefined {
  const registry = opts.registry ?? BUILTIN_SPECIALIZATIONS;
  if (opts.mode === "strict") {
    if (opts.forceMatch === undefined) return undefined;
    const spec = registry.find((s) => s.name === opts.forceMatch);
    if (spec === undefined) {
      throw new SpecializationRegistryError(
        `forceMatch "${opts.forceMatch}" not found in registry (known: ${registry
          .map((s) => s.name)
          .join(", ")})`,
      );
    }
    return {
      specialization: spec,
      confidence: 1,
      matchedKeywords: spec.keywords,
    };
  }
  const lower = text.toLowerCase();
  let best: SpecializationMatch | undefined;
  for (const spec of registry) {
    const matched: string[] = [];
    for (const kw of spec.keywords) {
      if (lower.includes(kw.toLowerCase())) matched.push(kw);
    }
    const confidence = spec.keywords.length === 0 ? 0 : matched.length / spec.keywords.length;
    if (confidence >= spec.confidenceThreshold) {
      if (best === undefined || confidence > best.confidence) {
        best = { specialization: spec, confidence, matchedKeywords: matched };
      }
    }
  }
  return best;
}

/**
 * Read JSON-encoded specialization records from a directory, merge
 * them with the built-ins (overriding by `name`), and return the
 * combined registry. Used by the contract compiler to pick up
 * project-specific specializations from `.crewhaus/specializations/`.
 */
export function loadRegistry(dir: string): ReadonlyArray<Specialization> {
  const abs = resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return BUILTIN_SPECIALIZATIONS;
  }
  const overrides: Record<string, Specialization> = {};
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(abs, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new SpecializationRegistryError(`failed to parse ${path}: ${(err as Error).message}`);
    }
    const spec = parsed as Specialization;
    if (typeof spec.name !== "string" || spec.name.length === 0) {
      throw new SpecializationRegistryError(`${path}: missing required "name" field`);
    }
    overrides[spec.name] = spec;
  }
  const merged: Specialization[] = [];
  const seen = new Set<string>();
  for (const builtin of BUILTIN_SPECIALIZATIONS) {
    if (overrides[builtin.name] !== undefined) {
      merged.push(overrides[builtin.name] as Specialization);
      seen.add(builtin.name);
    } else {
      merged.push(builtin);
    }
  }
  for (const [name, spec] of Object.entries(overrides)) {
    if (!seen.has(name)) merged.push(spec);
  }
  return merged;
}
