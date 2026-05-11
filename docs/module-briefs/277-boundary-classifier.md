# Module brief 277 — `boundary-classifier`

**Catalog layer:** R8 (safety). Extends §18 (the `prompt-injection-detector` primitive).
**Pillar:** Pillar 3 — security is a fabric, not a perimeter.
**Source:** [`packages/boundary-classifier/src/index.ts`](../../packages/boundary-classifier/src/index.ts).

## Responsibility

`boundary-classifier` is the **single chokepoint** through which every cross-trust-domain content transition flows. It wraps [`prompt-injection-detector`](086-prompt-injection-detector.md) with:

1. **`TrustOrigin` metadata** — `"user" | "mcp" | "subagent" | "channel" | "federation" | "skill" | "compaction" | "tool"`. Every boundary site tags its content with the strongest applicable origin label. The same content gets classified differently per origin (a `"user"`-origin string defaults to `pass`; the same string from `"mcp"` defaults to `block`).
2. **Content-hash LRU cache** — `sha256(content) + origin` keys, 1024-entry cap. Compaction loops and repeated channel messages don't burn classification budget on identical bytes.
3. **Per-origin severity policy** — `block` (substitute redaction notice on malicious), `warn` (keep + log on suspicious), `pass` (verbatim). Defaults table inside `ORIGIN_DEFAULT_POLICY`.
4. **Audit-honest semantics** — the classifier ALWAYS runs (so the trace bus records every non-clean verdict), even when severity is `pass`. Severity only controls what the caller does with the verdict.

## Public surface

```ts
export type TrustOrigin =
  | "user" | "mcp" | "subagent" | "channel"
  | "federation" | "skill" | "compaction" | "tool";

export type BoundarySeverity = "block" | "warn" | "pass";
export type BoundaryAction = "pass" | "warn" | "redact";

export type ClassifyBoundaryOptions = {
  readonly origin: TrustOrigin;
  readonly severity?: BoundarySeverity;
  readonly llmClassifier?: LlmClassifyFn;
  readonly bypassCache?: boolean;
};

export type BoundaryResult = {
  readonly action: BoundaryAction;
  readonly original: string;
  readonly redacted?: string;
  readonly origin: TrustOrigin;
  readonly verdict: PromptInjectionResult;
  readonly fromCache: boolean;
};

export async function classifyBoundary(
  text: string,
  opts: ClassifyBoundaryOptions,
): Promise<BoundaryResult>;

export async function classifyBoundaryRaw(
  text: string,
  opts: Pick<ClassifyBoundaryOptions, "origin" | "llmClassifier" | "bypassCache">,
): Promise<{ verdict: PromptInjectionResult; origin: TrustOrigin; fromCache: boolean }>;

export function clearBoundaryCache(): void;     // test-only
export function boundaryCacheSize(): number;    // diagnostics
export { buildRedactionNotice };                // re-exported for consistent copy
```

## Boundary inventory (call sites)

| Site | Origin | Caller |
|---|---|---|
| MCP tool responses | `"mcp"` | [`packages/tool-mcp/src/index.ts`](../../packages/tool-mcp/src/index.ts) |
| Sub-agent `finalMessage` | `"subagent"` | [`packages/sub-agent-spawner/src/index.ts`](../../packages/sub-agent-spawner/src/index.ts) |
| Skill bodies (lazy load) | `"skill"` | [`packages/skills-registry/src/index.ts`](../../packages/skills-registry/src/index.ts) |
| Compaction summaries | `"compaction"` | [`packages/compaction-autocompact/src/index.ts`](../../packages/compaction-autocompact/src/index.ts) |
| Tool results (post-tool path) | `"tool"` | [`packages/runtime-core/src/index.ts:867`](../../packages/runtime-core/src/index.ts) — `applyInjectionClassification` (still in place; can be refactored to delegate to `classifyBoundary` for full single-chokepoint compliance — follow-up) |
| Inbound channel text | `"channel"` | `packages/channel-adapter-*` (deferred to follow-up) |
| Federation peer payloads | `"federation"` | [`packages/federation-router`](../../packages/federation-router) (deferred to follow-up) |

## Boundary semantics

- **`block` severity** (the default for every untrusted origin): malicious → substitute redaction notice; suspicious → keep content but emit trace event; clean → verbatim.
- **`warn` severity**: non-clean → keep content, emit trace event; clean → verbatim.
- **`pass` severity**: verbatim regardless of verdict. The classifier still runs; the audit trail remains honest.
- **The classifier ALWAYS runs** unless `bypassCache: true` AND a cached entry exists for the same `(hash, origin)`. Production callers should never use `bypassCache: true` — it's exclusively a test affordance.

## Depends on

- [`@crewhaus/errors`](002-error-types.md)
- [`@crewhaus/prompt-injection-detector`](086-prompt-injection-detector.md)

## Unblocks

- The boundary fabric across MCP / sub-agent / skill / compaction / channel / federation.
- `crewhaus doctor --philosophy-alignment` (Workstream D) — audits each example against the fabric requirement.
- Future plugin-loaded boundary sites (§41 plugin-sdk + §42 module-marketplace) — third-party plugins importing user-controlled content must classify through this package.

## Tests

- `cache.test.ts` — content-hash cache hits/misses, eviction.
- `origins.test.ts` — per-origin default severity, severity overrides, audit-honest semantics under `pass` severity.
- `runtime-core/__tests__/indirect-injection-mcp.test.ts` — end-to-end fabric proof: malicious MCP response is redacted before reaching parent context.

## Risk markers

🟢 (low risk) — pure-function wrapper over an already-shipped detector; no I/O of its own; the only state is an in-process LRU cache.

## Catalog cross-references

This is the orchestration layer that gives §18's `prompt-injection-detector` its operational meaning at every boundary. §18 itself remains the *detector*; this brief is the *fabric*.
