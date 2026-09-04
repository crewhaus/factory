# @crewhaus/model-router

Parses `agent.model` strings and lazy-loads the matching `ProviderAdapter`.
Every model call in a compiled CrewHaus harness routes through
`resolveModel(modelString)` — adapters for providers you don't use are never
imported, let alone constructed.

Since 0.2.0 the package also owns the spec-native routing layers built on
`resolveModel`: the provider [failover chain](#failover-chain-agentmodel_fallbacks)
(`createFailoverChain`, behind `agent.model_fallbacks` / `agent.circuit_breaker`),
the [two-tier turn-difficulty router](#two-tier-router-agentmodel_tiers)
(`createTierRouter` / `pickTier`, behind `agent.model_tiers`), and — since 0.2.1
— the [adaptive model pool](#model-pool-agentmodel_pool) (`createPolicyRouter`,
behind `agent.model_pool`), whose `learned` policy improves selection the more
the harness runs.

## Model string grammar

| Model string | Provider / wire path | Credentials (env) |
| --- | --- | --- |
| `claude-sonnet-5` (unprefixed `claude-*`) | Anthropic API | `ANTHROPIC_AUTH_TOKEN` (Claude subscription) or `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` optional for gateways/proxies |
| `openai/gpt-4o-mini` | OpenAI API (or any OpenAI-compatible endpoint via `OPENAI_BASE_URL`) | `OPENAI_API_KEY` (or `OPENAI_BASE_URL` alone for keyless endpoints) |
| `gemini/gemini-2.5-flash` | Gemini API — or Vertex AI when `GOOGLE_GENAI_USE_VERTEXAI=true` / project+location are set | `GEMINI_API_KEY` / `GOOGLE_API_KEY`, or ADC with `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` |
| `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` | AWS Bedrock. Family inferred from the id (`anthropic`, `meta.llama`, `mistral`, `amazon.nova`, `amazon.titan-text`, `deepseek`, `cohere.command`, `ai21`, `qwen`, `openai.gpt-oss`, `writer`), tolerating cross-region inference-profile prefixes (`us.` / `eu.` / `apac.` / `global.` / …). Anthropic streams over the native InvokeModel path; every other family uses ConverseStream. | AWS credential chain (`AWS_ACCESS_KEY_ID`/profile/IAM role) or a Bedrock API key via `AWS_BEARER_TOKEN_BEDROCK`; region from `AWS_REGION`/`AWS_DEFAULT_REGION` or your AWS profile |
| `local/llama3.2@http://localhost:11434/v1` | Any OpenAI-compatible server — Ollama, vLLM, llama.cpp server, LM Studio, LiteLLM. The URL **must include the `/v1` segment**. | None. Loopback URLs may inherit `OPENAI_API_KEY` (LiteLLM-on-localhost); non-loopback URLs only ever get `CREWHAUS_LOCAL_API_KEY` — a spec-supplied URL cannot exfiltrate your OpenAI key. |
| `local/llama3.2` | Shorthand for the Ollama default (`http://localhost:11434/v1`) | None |
| `groq/llama-3.3-70b-versatile` | api.groq.com | `GROQ_API_KEY` |
| `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` | api.together.xyz | `TOGETHER_API_KEY` |
| `fireworks/llama-v3p3-70b-instruct` | api.fireworks.ai | `FIREWORKS_API_KEY` |
| `openrouter/meta-llama/llama-3.3-70b-instruct` | openrouter.ai | `OPENROUTER_API_KEY` |
| `deepseek/deepseek-chat` | api.deepseek.com | `DEEPSEEK_API_KEY` |
| `xai/grok-3-mini` | api.x.ai | `XAI_API_KEY` |
| `mistral/mistral-large-latest` | api.mistral.ai | `MISTRAL_API_KEY` |
| `cerebras/llama-3.3-70b` | api.cerebras.ai | `CEREBRAS_API_KEY` |
| `azure/<deployment>` | Azure OpenAI (classic surface: api-key header + api-version query) | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, optional `AZURE_OPENAI_API_VERSION` |
| `vertex/claude-sonnet-5` | Claude on Google Vertex AI (`@anthropic-ai/vertex-sdk`, optional dependency) | ADC + `ANTHROPIC_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`); region via `CLOUD_ML_REGION`/`GOOGLE_CLOUD_LOCATION` (default `us-east5`) |
| `vertex/gemini-2.5-flash` | Gemini on Vertex AI (Vertex mode forced) | ADC + `GOOGLE_CLOUD_PROJECT` (+ `GOOGLE_CLOUD_LOCATION`, default `us-central1`) |

Named hosts (`groq/`, `xai/`, …) read **their own** key env var, never
`OPENAI_API_KEY` — a spec can mix hosts without the keys fighting over one
variable. All of them reuse `@crewhaus/adapter-openai`'s stream translation.

## Adapter caching

One adapter instance per `(provider, baseUrl/deployment/family, key-env)`
cache key, kept in a module-local map. Repeat resolutions are free;
`clearAdapterCache()` exists for tests.

## Optional dependencies

`@crewhaus/adapter-openai`, `@crewhaus/adapter-gemini`, and
`@crewhaus/adapter-bedrock` are optionalDependencies, loaded with dynamic
`import()` only when a model string routes to them. A missing install fails
with a `ConfigError` naming the package and the model-string family. The
same applies to `@anthropic-ai/vertex-sdk` inside `adapter-anthropic` for
`vertex/claude-*`.

## Failover chain (`agent.model_fallbacks`)

`createFailoverChain({ model, fallbacks, breaker?, getBus?, ... })` builds a
`ProviderAdapter` that wraps an ordered candidate list — the spec's
`agent.model` first, then each `agent.model_fallbacks` entry (deduped).
Every candidate gets its own `@crewhaus/circuit-breaker` wrapper; `breaker`
mirrors the spec's `agent.circuit_breaker` block (`failureThreshold` /
`windowMs` / `cooldownMs`, package defaults 5 failures / 60 s window / 30 s
cooldown). Each `stream()` call routes to the first candidate whose breaker
is closed or half-open.

Routing transitions publish `model_failover` trace events (when `getBus`
yields a bus) with one of three reasons:

| Reason | When |
| --- | --- |
| `breaker_open` | The candidate's breaker tripped (consecutive failures crossed `failureThreshold`); the next call routes onward to the next candidate. |
| `probe_restore` | A higher-priority candidate's cooldown elapsed (breaker half-open); the next call routes back up to it as the probe. Probe success closes the breaker; failure re-opens it. |
| `candidate_error` | The candidate couldn't be constructed when actually tried (missing credential, uninstalled optional provider package). |

Semantics worth knowing:

- Only the **primary** resolves fail-fast. Fallbacks preflight tolerantly: a
  resolution failure becomes a doctor-style line in `warnings()` and the
  candidate is re-tried whenever routing actually reaches it — a fallback
  with a missing key warns at boot, never hard-fails the run.
- **Mid-stream errors are not rerouted** (partial output re-issued through
  another provider would duplicate content). The recovery engine's retries
  re-enter `stream()`; once the failing candidate's breaker opens, the next
  attempt routes onward.
- `tripActive(reason?)` force-opens the last-served candidate's breaker —
  this backs the `switch-model` failure-taxonomy recovery action.
- Anthropic-shaped `cache_control` markers are stripped from requests served
  by candidates whose `features.caching !== "explicit"`; explicit-caching
  candidates keep them verbatim.
- Every candidate open or unconstructible → `FailoverExhaustedError`, naming
  each candidate and its breaker state.
- The optional `rankFallbacks` seam reorders the fallback tier (never the
  primary) before routing. **Deliberately unwired in the factory runtime**
  (2026-07 design review): the declared `model_fallbacks` order is a trust
  ordering the runtime honours verbatim — cost/quality routing belongs to
  `agent.model_pool`, and the cache-aware ranking it was designed for has no
  observed traffic to price at boot (a cold profile makes the sort a no-op,
  and a pricing-table miss would sort an unpriced model first). The seam
  stays for library consumers composing their own chains; see the
  `rankFallbacks` docstring in `src/failover.ts` for the full rationale and
  the revisit trigger (trip-time re-ranking, if durable per-model cache
  telemetry ever becomes default-on).

Introspection: `plan()` (predicted next candidate), `lastServed()`,
`candidates()` (per-candidate resolution + breaker snapshot), `warnings()`.

## Two-tier router (`agent.model_tiers`)

`createTierRouter({ fast, default, config? })` holds two boot-resolved tiers
(`ResolvedTier` = adapter + wire model id + spec string). runtime-core calls
`route(signals)` each turn, streams through the returned tier's adapter, and
publishes a `model_tier_route` trace event (persisted to the session log as the
event-log kind of the same name since 0.6.0). The decision (`pickTier`) is
deterministic — no probe calls, fully reproducible from the transcript. Any
single hard-turn signal escalates the turn to the `default` tier:

| Signal | Escalates when | Config knob (default) |
| --- | --- | --- |
| Turn index | first turn of the run (task framing) | `firstTurnToDefault` (`true`) |
| Tools | any tools in play this turn | `toolsToDefault` (`true`) |
| Context size | estimated context tokens exceed the threshold | `contextTokenThreshold` (`16000`) |
| Prior tool density | previous turn issued ≥ N tool calls | `priorToolDensityThreshold` (`3`) |

No escalator firing → the cheap `fast` tier serves. A fast-tier turn that
fails re-runs on `default` (`escalation()`) — the misroute recovery,
composing with the `switch-model` recovery ladder. Unlike the failover chain
this is not a `stream()` wrapper: the tier decision is a loop-level signal,
so the loop picks per turn and streams directly through the chosen adapter.

## Model pool (`agent.model_pool`)

Since 0.2.1, `createPolicyRouter` generalises the two-tier router to **N
user-declared candidate models with a selection `policy`** — and, under the
`learned` policy, a choice that improves the more the harness runs. It is the
N-candidate superset of `model_tiers` (mutually exclusive with `model_tiers`
and `model_fallbacks` at the spec layer). Like the tier router, every candidate
adapter binds once at boot and `route(signals)` only selects among them;
runtime-core streams through the chosen candidate and publishes a `model_route`
trace event each turn.

| Policy | Per-turn pick | State |
| --- | --- | --- |
| `static` | always the first declared candidate | none |
| `heuristic` (default) | hard turns → a `strong`-tagged candidate, easy turns → a `cheap`-tagged one (same `pickTier` difficulty signals as `model_tiers`; declaration order is the tag-less fallback) | none |
| `learned` | the best arm for the turn's difficulty band, off a durable reward scoreboard | `@crewhaus/routing-store` |

The `learned` policy **warms up deterministically** — it explores
least-sampled-first (declared order breaks ties) until every candidate in a
band clears `minSamplesPerArm`. After warm-up it exploits the highest mean
reward, with an optional online-exploration strategy (`learning.bandit`, since
0.2.2) so it keeps sampling and can escape a stale optimum instead of
hard-committing to the argmax forever:

- **`epsilon-greedy`** (default) — try a non-best arm a fraction
  `learning.explorationRate` of the time. `explorationRate: 0` (the default)
  never draws, so it is byte-for-byte the deterministic exploit of 0.2.1.
- **`thompson`** — draw each arm from its reward posterior
  `Normal(meanReward, varReward / n)` and take the highest draw; uncertain arms
  self-explore, so there is no ε to tune.

Both draws are seeded from the run plus a monotonic transcript position
(`learning.seed` overrides the per-run seed), so exploration stays **replayable
from the transcript** — no persisted RNG — and keeps drawing a fresh coin
across `--resume` (and a channel bot's resume-per-message pattern). Selection is
fs-free: the policy reads the scoreboard through an injected
`score(routeKey, model)` lookup, so runtime-core owns all persistence. After
each turn runtime-core folds
the observed outcome (success, latency, token-priced cost — a failed turn scores
0, so a fast failure can't out-rank a reliable model) into
[`@crewhaus/routing-store`](../routing-store), whose reward function and
append-only per-`(routeKey, model)` scoreboard live there. A failed candidate
escalates to the strongest candidate (`escalation()`), mirroring the tier
router's fast→default misroute recovery.

Inspect the accumulated scoreboard, replay a single run's decisions, or reset,
from the CLI:

```
crewhaus route status              # per-bucket arms, best-per-band starred
crewhaus route explain <session>   # replay one run's per-turn routing decisions
crewhaus route reset               # wipe the scoreboard (kill switch)
```

`route explain` reads the durable `model_route` events runtime-core persists to
the session log each routing decision (a turn that runs tools re-routes as the
difficulty band shifts, so a `turnNumber` can repeat), showing band, model,
policy, explore/exploit, and reason per turn. Since 0.6.0 the line also carries
the derived `signals` the decision was made from and, when it differs from the
wire id, the candidate's `specModel` (the string scoreboard arms key on); the
chain's `model_failover` events are mirrored into the same log as a durable
`model_failover` kind.

Exports: `createPolicyRouter`, `PolicyRouter`, `PolicyDecision`, `PoolCandidate`,
`PoolPolicy`, `PoolRoutingConfig`, `PoolLearningConfig`, `ScoreLookup`.
