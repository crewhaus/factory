/**
 * Shared fixtures for the provability tests: a fully resolved config (the
 * compiler's defaults, `IrProvability`), an evidence builder, an in-memory
 * artifact store and a fixed clock. Excluded from the build (tsconfig).
 */
import { buildEvidenceIndex, recordFromCall } from "./evidence";
import type {
  EvidenceIndex,
  ProofArtifact,
  ProofArtifactStore,
  ProvabilityConfig,
  ProvabilityLevel,
} from "./types";

export const NOW = new Date("2026-10-22T12:00:00.000Z");
export const now = (): Date => NOW;

type Patch = {
  readonly [K in keyof ProvabilityConfig]?: ProvabilityConfig[K] extends object
    ? ProvabilityConfig[K] extends ReadonlyArray<unknown>
      ? ProvabilityConfig[K]
      : Partial<ProvabilityConfig[K]>
    : ProvabilityConfig[K];
};

/** The lowered defaults (compiler `lowerProvability`) at `level`, with `patch` merged one level deep. */
export function config(level: ProvabilityLevel, patch: Patch = {}): ProvabilityConfig {
  const base: ProvabilityConfig = {
    level,
    onFail: "retry",
    maxRetries: 1,
    threshold: 1,
    scope: "session",
    assumptions: "allow",
    render: "footer",
    sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
    grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
    execution: { allow: ["evaluate", "moneyAdd", "mcp__calc__add"], replay: true, maxReplays: 20 },
    formal: {
      checkers: ["builtin", "smt"],
      forbid: ["sorry", "axiom", "native_decide"],
      timeoutMs: 30_000,
    },
  };
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prior = (base as Record<string, unknown>)[key];
    out[key] =
      prior !== null &&
      typeof prior === "object" &&
      !Array.isArray(prior) &&
      typeof value === "object"
        ? { ...(prior as object), ...(value as object) }
        : value;
  }
  return out as ProvabilityConfig;
}

export type CallSpec = {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
  readonly content: string;
  readonly isError?: boolean;
  readonly turnNumber?: number;
};

/** An index over calls, origins read the way the real builders read them. */
export function evidenceOf(calls: ReadonlyArray<CallSpec>, workspaceRoot?: string): EvidenceIndex {
  return buildEvidenceIndex(
    calls.map((c) =>
      recordFromCall(
        {
          toolUseId: c.id,
          toolName: c.name,
          input: c.input ?? {},
          content: c.content,
          isError: c.isError ?? false,
          ...(c.turnNumber !== undefined ? { turnNumber: c.turnNumber } : {}),
        },
        workspaceRoot !== undefined ? { workspaceRoot } : {},
      ),
    ),
  );
}

/** A WebFetch result for `url`, as tool-web prints it. */
export function fetched(url: string, body: string, prompt?: string): string {
  const header = `URL: ${url}\nStatus: 200\nContent-Type: text/html\n\n`;
  return prompt === undefined ? `${header}${body}` : `${header}[user prompt: ${prompt}]\n\n${body}`;
}

/** An in-memory artifact store; `reads` counts `get` calls. */
export function memoryArtifacts(
  artifacts: ReadonlyArray<ProofArtifact> = [],
): ProofArtifactStore & {
  reads: number;
} {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const store = {
    reads: 0,
    async get(id: string) {
      store.reads += 1;
      return byId.get(id);
    },
    async put(artifact: ProofArtifact) {
      byId.set(artifact.id, artifact);
    },
    async list() {
      return [...byId.values()];
    },
  };
  return store;
}

/**
 * The `ProofCheck` call that wrote `artifact`, as tool-proof's `checkReport`
 * prints its result: the run's own record that a checker accepted (or
 * rejected) it, which the `proven` rung requires beside the stored file.
 */
export function proofCheckCall(
  artifact: ProofArtifact,
  id = `toolu_check_${artifact.id}`,
): CallSpec {
  return {
    id,
    name: "ProofCheck",
    input: {
      checker: artifact.checker,
      claim: artifact.claim,
      statement: artifact.statement,
      proof: artifact.proof,
    },
    content: JSON.stringify({
      ok: artifact.ok,
      id: artifact.id,
      checker: artifact.checker,
      next: artifact.ok ? `cite it as [n]: proof:${artifact.id}` : "not proven",
      ...(artifact.reason !== undefined ? { reason: artifact.reason } : {}),
      assumptions: [...artifact.assumptions],
      axioms: [...artifact.axioms],
      output: artifact.output,
    }),
  };
}

/** An index holding the `ProofCheck` call of each artifact (`proofCheckCall`), and `more` besides. */
export function checkedBy(
  artifacts: ReadonlyArray<ProofArtifact>,
  more: ReadonlyArray<CallSpec> = [],
): EvidenceIndex {
  return evidenceOf([...artifacts.map((a) => proofCheckCall(a)), ...more]);
}

/** A proof artifact with sensible defaults. */
export function artifact(patch: Partial<ProofArtifact> & { readonly id: string }): ProofArtifact {
  return {
    version: 1,
    checker: "builtin",
    claim: "No two of the six meetings overlap.",
    statement: "forall i j in 1..6, i != j -> disjoint(m_i, m_j)",
    proof: "1. given ...",
    ok: true,
    assumptions: [],
    axioms: [],
    output: "certificate accepted",
    outputDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    checkedAt: NOW.toISOString(),
    ...patch,
  };
}
