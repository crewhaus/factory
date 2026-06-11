# @crewhaus/model-router

Parses `agent.model` strings and lazy-loads the matching `ProviderAdapter`.
Every model call in a compiled CrewHaus harness routes through
`resolveModel(modelString)` — adapters for providers you don't use are never
imported, let alone constructed.

## Model string grammar

| Model string | Provider / wire path | Credentials (env) |
| --- | --- | --- |
| `claude-sonnet-4-6` (unprefixed `claude-*`) | Anthropic API | `ANTHROPIC_AUTH_TOKEN` (Claude subscription) or `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` optional for gateways/proxies |
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
| `vertex/claude-sonnet-4-6` | Claude on Google Vertex AI (`@anthropic-ai/vertex-sdk`, optional dependency) | ADC + `ANTHROPIC_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`); region via `CLOUD_ML_REGION`/`GOOGLE_CLOUD_LOCATION` (default `us-east5`) |
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
