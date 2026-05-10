# Recipe 32 — Local Models

> **Status:** stub.

## What you'll learn

Run any spec against a local OpenAI-compatible endpoint — Ollama,
vLLM, llama.cpp server, LiteLLM proxy — by changing one line of YAML.
The model id grammar (`local/<model>@<url>`) bakes the URL into the
spec; no provider switch elsewhere.

## Prerequisites

- A locally running OpenAI-compatible server. Examples:
  - `ollama serve` (default port 11434, OpenAI shim under `/v1`).
  - `vllm serve <model>` (default port 8000).
  - `llama-server -m <gguf>` from llama.cpp (default port 8080).

## Roadmap

1. The model id grammar: `local/<model>@<url>`. URL is the OpenAI-compatible base, including `/v1`.
2. How `model-router` parses it: same path as `openai/...` but with `OPENAI_BASE_URL` overridden in-flight.
3. Why no API key needed: the OpenAI adapter sends an empty Bearer; local servers ignore it.
4. Worked examples:
   - Ollama: `local/llama3.2@http://localhost:11434/v1`
   - vLLM: `local/meta-llama/Meta-Llama-3-8B-Instruct@http://localhost:8000/v1`
   - llama.cpp: `local/qwen2.5-coder@http://localhost:8080/v1`
5. Tool-use considerations: not all local models support function calling. Test with a single-turn spec first.
6. Streaming behavior — most servers do, some only on certain models.
7. Adapter caching: the model-router caches one adapter per `(providerId, baseUrl, family)` key, so an Anthropic+local mixed spec doesn't re-import.
8. Cost tracking against local models: pricing table entries are zero by default; override via `pricing.json` to track e.g. electricity.

## Run it now

```bash
# Spin up Ollama:
ollama pull llama3.2 && ollama serve &

# Edit any hello-* spec to use a local model:
# model: local/llama3.2@http://localhost:11434/v1

# Then compile + run normally:
bun run compile:hello && bun run run:hello
```

## Pointers to existing material

- **Module:** [`packages/model-router`](../../packages/model-router).
- **Adapter (OpenAI-compatible):** [`packages/adapter-openai`](../../packages/adapter-openai).
- **Catalog:** §17.

## Where to go next

- For mixed local + Anthropic specs with circuit-breaker fallback → [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- For prompt caching considerations across providers → [Recipe 33 — Prompt Caching](33-prompt-caching.md).
