# Recipe 32 — Local Models

Run any spec against a local OpenAI-compatible endpoint — Ollama,
vLLM, llama.cpp server, LiteLLM proxy — by changing one line of YAML.
The model id grammar (`local/<model>@<url>`) bakes the URL into the
spec; no provider switch elsewhere.

You'd reach for local models when:

- You're **air-gapped** or operating under data-residency constraints.
- You want to **avoid API costs** for high-volume cheap workloads
  (extraction, classification, routing).
- You're **iterating on prompts** and the round-trip latency of a
  hosted provider is the bottleneck.

For production user-facing agents, hosted providers usually win on
quality and consistency.

## Prerequisites

- A locally running OpenAI-compatible server:
  - **Ollama** — `ollama serve` (default port 11434; the OpenAI shim
    lives under `/v1`).
  - **vLLM** — `vllm serve <model>` (default port 8000).
  - **llama.cpp** — `llama-server -m <gguf>` (default port 8080).
  - **LiteLLM** — `litellm --model <provider>/<model>` proxies any
    provider behind an OpenAI-compatible endpoint.

## The model id grammar

```
local/<model>@<base-url>
```

`<model>` is the model name the local server expects. `<base-url>`
is the OpenAI-compatible base, **including** the `/v1` segment.

Examples:

```yaml
model: local/llama3.2@http://localhost:11434/v1
model: local/qwen2.5-coder@http://localhost:8080/v1
model: local/meta-llama/Meta-Llama-3-8B-Instruct@http://localhost:8000/v1
model: local/llama3.2@http://gpu-host.lan:11434/v1
```

The URL is parsed once at runtime — no DNS lookups per turn.

## How the router parses it

```
model-router.parseModelId("local/llama3.2@http://localhost:11434/v1")
  → { provider: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.2", family: "local" }
```

The router routes `local/*` through the OpenAI adapter with the
**baseUrl overridden in-flight**. So a spec using `local/llama3.2`
goes through the same code paths as `openai/gpt-4o` — only the
endpoint URL differs.

## No API key needed

The OpenAI adapter sends `Authorization: Bearer ${OPENAI_API_KEY ?? ""}`.
Local servers ignore the header. To be explicit:

```bash
OPENAI_API_KEY="" bun run run:hello   # works
```

If your local server *does* require a key (LiteLLM proxy in front of
an upstream that wants auth), set `OPENAI_API_KEY` as you would for
real OpenAI.

## Worked examples

### Ollama

```bash
ollama pull llama3.2
ollama serve &
```

```yaml
agent:
  model: local/llama3.2@http://localhost:11434/v1
```

Llama 3.2 supports OpenAI-compatible function calling reasonably well
for short tool sequences. Long sequences or complex schemas may degrade.

### vLLM

```bash
vllm serve meta-llama/Meta-Llama-3-8B-Instruct \
  --host 0.0.0.0 --port 8000
```

```yaml
agent:
  model: local/meta-llama/Meta-Llama-3-8B-Instruct@http://localhost:8000/v1
```

vLLM is the fastest local option for production-grade throughput.
GPU-required.

### llama.cpp

```bash
llama-server -m ./models/qwen2.5-coder-7b-instruct.Q4_K_M.gguf \
  --port 8080 --host 0.0.0.0
```

```yaml
agent:
  model: local/qwen2.5-coder@http://localhost:8080/v1
```

llama.cpp is the right pick for CPU-only deployments and low-spec
laptops. Tool-use support varies by model and quantization — test.

### LiteLLM proxy

```bash
litellm --config litellm-config.yaml --port 4000
```

Then any spec can route through the proxy:

```yaml
agent:
  model: local/gpt-4o@http://localhost:4000/v1
```

LiteLLM bridges to upstream providers (Anthropic, OpenAI, Bedrock,
Gemini, ...) behind one OpenAI-compatible endpoint. Useful when you
want a single observability/proxy layer in front of multiple
providers.

## Tool-use considerations

Not all local models support function calling well. Test with a
**single-turn spec first**:

```yaml
name: local-test
target: cli
agent:
  model: local/llama3.2@http://localhost:11434/v1
  instructions: |
    Call the Read tool exactly once with path="README.md" then
    respond with the first 100 characters of the result.
tools:
  - read
```

If the model can't reliably emit valid tool calls, it's not ready
for production. Workarounds:

- Use a **fine-tuned function-calling variant** (e.g. NousResearch's
  Hermes-3-Llama-3.1-8B is tuned for function calling).
- Use a **larger model**: 70B-class models reliably tool-call; 7-8B
  models are inconsistent.
- Route only **structural tasks** to local; keep tool-heavy work on
  hosted models (the workflow target makes per-step routing easy).

## Streaming behavior

Most local servers stream:

| Server     | Streaming?              |
| ---------- | ----------------------- |
| Ollama     | Yes, by default.        |
| vLLM       | Yes.                    |
| llama.cpp  | Yes.                    |
| LiteLLM    | Depends on upstream.    |

Disable streaming with `--no-stream` if a server's streaming
implementation is buggy:

```yaml
agent:
  model: local/llama3.2@http://localhost:11434/v1
  stream: false
```

Falls back to one big response payload at end-of-turn.

## Adapter caching

The model-router caches **one adapter instance per `(provider,
baseUrl)` key**. So a spec using:

```yaml
roles:
  researcher:
    model: claude-sonnet-4-6
  extractor:
    model: local/llama3.2@http://localhost:11434/v1
  judge:
    model: local/llama3.2@http://localhost:11434/v1
```

Imports the Anthropic adapter once and the OpenAI adapter once. The
extractor and judge share the same OpenAI adapter (same baseUrl);
the researcher uses the Anthropic adapter. No duplicate adapter
allocations.

## Cost tracking

The pricing table in [`packages/model-router`](../../packages/model-router)
entries `local/*` at zero by default — local inference is "free"
from the API-billing perspective.

To track electricity / GPU rental against a local model:

```typescript
import { registerPricing } from "@crewhaus/model-router";

registerPricing("local/llama3.2", {
  inputPerMillion: 0.10,    // your imputed cost in USD
  outputPerMillion: 0.20
});
```

The cost-tracker ([Recipe 19](19-rate-limiting-and-budgets.md)) then
attributes spend to local models like it would for hosted ones.

## Latency profile

| Setup                                 | First-token latency  | Tokens/s                 |
| ------------------------------------- | -------------------- | ------------------------ |
| Ollama, llama3.2 8B, M2 Pro            | ~300ms               | 30-60                    |
| vLLM, 8B model, A10G                   | ~50ms                | 100-200                  |
| llama.cpp, 7B Q4, M1 Air                | ~500ms               | 8-15                     |
| Hosted Anthropic (for reference)        | ~250ms (first byte)   | 50-100                   |

For latency-sensitive workloads, **vLLM on dedicated GPU** beats
hosted; for cost-sensitive workloads, local is "free" but you pay
for the hardware.

## Things that look like local-model work but aren't

| Symptom                                                              | Better tool                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Want to **embed** locally (for RAG).                                  | `embedderModel: local/...@...` in pipeline spec.   |
| Want a **smaller hosted** model (cheap but still hosted).             | `claude-haiku-4-5-20251001` or `openai/gpt-4o-mini`. |
| Want to **fine-tune** a model on your data.                           | Fine-tune the model server-side; route via local/.  |
| Want **offline** (truly air-gapped).                                  | Build the agent as a single binary ([Recipe 24](24-docker-and-helm.md)) + bundle the local model server. |

## What to read next

- **Mixed local + hosted with breaker fallback.** [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- **Prompt caching across providers.** [Recipe 33 — Prompt Caching](33-prompt-caching.md).
- **Local embedders for RAG.** [Recipe 06 — RAG Pipeline](06-rag-pipeline.md).

## Pointers to source

- **Model router:** [`packages/model-router`](../../packages/model-router).
- **OpenAI-compatible adapter (used for local):** [`packages/adapter-openai`](../../packages/adapter-openai).
- **Module catalog reference:** §17 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
