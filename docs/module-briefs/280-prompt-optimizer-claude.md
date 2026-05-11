# Module brief 280 — `prompt-optimizer-claude`

**Catalog layer:** F-eval.
**Pillar:** Pillar 2 — the model-driven `MutationProvider`.
**Source:** [`packages/prompt-optimizer-claude/src/index.ts`](../../packages/prompt-optimizer-claude/src/index.ts).

## Responsibility

Implements the `MutationProvider` interface from `prompt-optimizer` by delegating each candidate generation to a Claude model call. Closes the v0 prompt-optimizer's L91 comment: "Real-world prompt tuners (DSPy, OPRO) use model-driven rewriting; v0 of this module ships rule-based mutations."

The model receives the current best prompt + a sample of dev-set failures; returns a structured `{ rewrite, rationale }` JSON. The provider validates the response with Zod and falls back to the current best on any failure (model outage, malformed JSON, schema mismatch) so the optimiser's outer search loop never aborts.

## Public surface

```ts
export class ClaudeMutationProvider implements MutationProvider {
  readonly name: "claude";
  constructor(opts: ClaudeMutationProviderOptions);
  async next(state: OptimizerState): Promise<ProviderMutation>;
}

export type ClaudeMutationProviderOptions = {
  readonly adapter: ProviderAdapter;
  readonly model: string;
  readonly maxFailuresInPrompt?: number;       // default 5
  readonly failureThreshold?: number;          // default 0.5
  readonly maxTokens?: number;                 // default 2048
  readonly systemOverride?: string;            // override meta-prompt
};

export function createClaudeMutationProvider(
  opts: ClaudeMutationProviderOptions,
): ClaudeMutationProvider;
```

## Meta-prompt design

The system block constrains the model to a strict output contract:

- Exactly one JSON object: `{"rewrite": "...", "rationale": "..."}`
- No copying expected outputs verbatim (avoids dev-set leakage)
- No instructions overriding safety / compliance / permissions
- 1-3 sentence rationale

The user message contains the current prompt + a sample of failures (input + observed score + optionally expected output) framed as "things the prompt didn't handle well".

## Fallback semantics

The provider returns `{ prompt: currentBest, mutations: [], rationale: "claude-fallback: <reason>" }` when any of these fail:

- Model call throws
- Response missing the `{...}` JSON block
- JSON parse fails
- Zod schema validation fails

The orchestrator's outer loop records the fallback iteration with a no-op score. The search continues — a single bad rewrite doesn't kill the run.

## Depends on

- `@anthropic-ai/sdk` (^0.40.0)
- `@crewhaus/adapter-anthropic` — `ProviderAdapter` interface
- `@crewhaus/errors`
- `@crewhaus/prompt-optimizer` — `MutationProvider` seam
- `zod` — response schema validation

## Unblocks

- `crewhaus optimize --mutator claude` workflow
- Future DSPy-bridge variant (would extend the same `MutationProvider` interface; no change needed to the orchestrator)

## Tests

- `mutation.test.ts` — happy path (clean JSON), code-fence wrapping, malformed JSON fallback, model-error fallback, schema-mismatch fallback. All use a mocked `ProviderAdapter` that yields canonical `StreamEvent`s.

## Risk markers

🟡 (medium risk) — depends on Claude's JSON-mode compliance. Without explicit JSON mode (currently unavailable in Anthropic's API), the meta-prompt's "output exactly one JSON object" instruction is best-effort. The Zod fallback + xargs `try { JSON.parse }` are the safety nets.

## Cost considerations

Each call is ~1-3K tokens (current prompt + 5 dev-set samples + meta-instructions). At `claude-sonnet-4-5` pricing the per-iteration cost is on the order of $0.001-0.005. A 10-iteration optimise pass with the Claude mutator therefore costs ~$0.01-0.05.

The `crewhaus optimize --budget-usd N` flag (follow-up; not yet wired through `cost-tracker`) will cap total spend by surfacing the running cost from §27.
