# crewhaus

The [factory](https://github.com/crewhaus/factory) command line: compile, run, eval, and deploy agent harness specs (`crewhaus.yaml`).

CrewHaus compiles one spec into the shape each situation calls for — a CLI agent, channel bot, RAG pipeline, multi-agent crew, eval bundle, and more. Every factory workflow starts with a `crewhaus` subcommand.

> This is the bare, unscoped `crewhaus` package. (The earlier `@crewhaus/cli` name is deprecated and points here; the supporting libraries remain scoped under `@crewhaus/*`.)

## Install

The fastest path is the self-contained binary — one file, no Bun/Node required:

```bash
brew tap crewhaus/tap && brew install crewhaus          # macOS / Linux (Homebrew)
scoop install crewhaus                       # Windows (Scoop; see repo for the bucket)
winget install CrewHaus.CLI                   # Windows (winget)
# Debian / Ubuntu (apt): signed repo at https://crewhaus.github.io/apt
```

Or install from npm — this package runs on [Bun](https://bun.sh) ≥ 1.2:

```bash
npm install -g crewhaus        # global
bun add -d crewhaus            # project-local dev dependency
```

Confirm it:

```bash
crewhaus --version
```

## Quickstart

```bash
# Scaffold a starter spec
crewhaus init my-agent
cd my-agent

# Inspect the lowered IR — a quick sanity check of what the compiler sees
crewhaus compile crewhaus.yaml --emit-ir

# Set a provider credential (the starter spec uses an Anthropic model;
# --model accepts other providers, e.g. openai/<m>, gemini/<m>, local/<m>@<url>)
export ANTHROPIC_API_KEY=sk-ant-...

# Compile in-memory and run the agent
crewhaus run crewhaus.yaml
```

To emit a runnable bundle on disk instead, use `crewhaus compile crewhaus.yaml -o build`.

## Subcommands

Run `crewhaus` with no arguments for the full usage text, or any subcommand with `--help` for its flags.

| Subcommand | What it does |
|---|---|
| `compile <spec.yaml> -o <out-dir>` | Compile a spec to a runnable bundle; `--emit-ir` prints the lowered IR as JSON instead |
| `run <spec.yaml>` | Compile in-memory and execute the agent (`--model`, `--resume <id>` / `--continue`, `--prompt <text>`, …) |
| `eval <spec.yaml> --dataset <data> --graders <graders.yaml>` | Run the agent against a dataset and grade (deterministic graders + LLM-as-judge); every run is indexed and auto-diffed against the pinned baseline (`--gate` exits non-zero on regression, `--no-promote` keeps the pin) |
| `eval-report diff <prev> <new>` | Compare two eval runs and emit a diff report; `history` lists recorded runs, `baseline show\|set <runId>` inspects or pins baselines |
| `optimize <spec.yaml> --dataset <data> --graders <graders.yaml>` | Active eval-driven optimization; `--write-back` rewrites the spec in place |
| `init [name]` | Scaffold a new `crewhaus.yaml` |
| `doctor` | Check environment health |
| `context --bundle` | Emit a single-markdown orientation manifest |
| `cost-summary --session <id>` | Summarize cost-accrual events for a session |
| `secrets doctor` / `secrets rotate <name>` | List or rotate secrets via the configured backend |
| `spec put\|list\|get\|pin\|alias …` | Versioned spec storage |
| `deploy promote\|rollback …` | Re-pin a spec for an environment |
| `migrate-all --from N --to N` | Batch-migrate every spec in the registry |
| `build-image <target> --tag <tag>` | Build the docker image for a target shape |
| `cloud deploy` / `cloud teardown` | Deploy or tear down a managed CrewHaus cluster |
| `federation discover <deployment>` | Resolve a federated peer's endpoint and cert fingerprint |
| `sandbox doctor` | List registered sandbox images and healthcheck status |
| `compliance evidence` | Collect SOC 2 / ISO 27001 / HIPAA evidence |
| `version` | Print the CLI version (also `--version`, `-v`) |

## Docs

- [Documentation](https://crewhaus.ai/docs) — start with the [quickstart](https://crewhaus.ai/docs/quickstart) and the [CLI target guide](https://crewhaus.ai/docs/targets/cli)
- [factory repository](https://github.com/crewhaus/factory) — architecture, contributing, and the full target-shape table

Apache-2.0.
