---
test:
  spec: examples/hello-harness-designer/crewhaus.yaml
  bun_scripts:
    - compile:hello-harness-designer
---

# Recipe 48 — Harness Designer (meta-recipe)

Build a CrewHaus harness whose job is to **design other CrewHaus
harnesses**. The designer interviews the user about *intent* (what they
want to build, in plain English), walks the diagnostic decision tree
internally, picks a target shape, chooses tools and permissions, writes
a complete `crewhaus.yaml`, and validates it against the in-tree
compiler before handing it back. If the user has a dataset of
example inputs and outputs, it auto-runs `crewhaus optimize` for the
finishing pass.

"Use the tool to create a tool to use the tool." This is the system
designing itself.

By the end of this recipe you'll have a working agent that:

- Pulls the latest crewhaus-factory docs on every run.
- Asks ONE open-ended question, then up to four intent-anchored
  clarifying questions.
- Never asks "which target shape?", "which tools?", or "what
  permission mode?" — those are compiler-level decisions the designer
  makes from intent.
- Produces a `crewhaus.yaml` + `.env.example` + `README.md` in a
  directory of the user's choosing.
- Validates the result by running `bunx crewhaus compile --emit-ir`
  before delivery; retries up to 3 times on failure.
- Auto-runs `crewhaus optimize` when the user has a dataset.

Time: ~10 minutes to read the recipe, ~3 minutes to run it through one
interview end-to-end.

<details>
<summary><strong>Architectural context</strong> — reflexivity, and what
this recipe proves about CrewHaus</summary>

[CLAUDE.md](../../CLAUDE.md) Pillar 1 states "the compiler is the
protagonist": every shape lowers to typed IR, every target is just a
spec variant. The reflexive corollary — that the compiler is general
enough to compile a *meta*-spec which writes other specs — is implicit
in the architecture but easy to overlook. This recipe makes the claim
testable: the harness designer is itself a `target: cli` spec of about
180 lines, with no codegen changes, no new IR variant, no new package.
It uses the same `runChatLoop` from
[packages/runtime-core](../../packages/runtime-core) as Recipe 01.

The designer's *methodology* is what makes it intent-driven rather
than config-driven. Existing onboarding paths — `crewhaus init` writes
a stub, [`packages/wizard`](../../packages/wizard) asks five technical
questions (`target`, `name`, `model`, `tools`, `permissions.mode`) —
both require the user to already think in CrewHaus terms before they
can begin. The designer in this recipe inverts that: it thinks in IR
shapes *internally* and surfaces only intent-anchored questions ("Where
will the user interact with it?", not "Which target shape?"). The
mapping from intent to shape lives entirely in the
[`agent.instructions`](../../examples/hello-harness-designer/crewhaus.yaml)
block — about 80 lines of methodology that doubles as the answer to
"how do I think about shape selection?" If you read nothing else in
this recipe, read the instructions block.

This recipe also lays the groundwork for Pillar 2 (eval is active).
When the user has a dataset, the designer auto-runs
[`crewhaus optimize`](42-active-optimization.md) on the generated spec,
making the eval-driven tuning loop the *default* finishing pass rather
than a separate journey. The DSPy MIPRO result — +13% accuracy on 5/7
multi-stage programs ([docs/AI-Harness-Systems.md](../AI-Harness-Systems.md))
— is the empirical motivation; this recipe makes it one prompt away.

</details>

## Prerequisites

- [Bun](https://bun.sh) 1.2 or later.
- An Anthropic credential (`ANTHROPIC_AUTH_TOKEN` from `claude
  setup-token` if you have Pro/Max, otherwise `ANTHROPIC_API_KEY`).
- This repo cloned and `bun install` run once. **Or** set
  `CREWHAUS_FACTORY_PATH=/path/to/crewhaus-factory` to point at a
  checkout living elsewhere. **Or** let the designer clone the repo
  to `~/.crewhaus/factory-cache` on first run — it handles that
  itself.

Recipes 01 ([CLI Coding Agent](01-cli-coding-agent.md)), 29
([Permissions Deep Dive](29-permissions-deep-dive.md)), 41
([Security Fabric](41-security-fabric.md)), and 42
([Active Optimization](42-active-optimization.md)) are useful
background but not strictly required — the designer reads them when it
needs them.

## Step 1 — The smallest spec

Open
[`examples/hello-harness-designer/crewhaus.yaml`](../../examples/hello-harness-designer/crewhaus.yaml).
It's a `target: cli` spec whose `agent.instructions` block encodes the
entire methodology. The shape is the same as Recipe 01; the *content*
is what makes it a harness designer.

The top half of the spec is the methodology. It has two named
sections:

**Resolving the docs path.** The designer needs the recipes catalog
and the Zod schema as a runtime input. It tries three locations in
order: `$CWD` (the common case — running from inside a cloned repo),
`$CREWHAUS_FACTORY_PATH` (escape hatch), and finally
`~/.crewhaus/factory-cache` (clone-on-first-run fallback). Whichever
path wins, the designer runs `git fetch && git pull --ff-only` so the
docs reflect HEAD. This is what makes the designer "always know about
the latest shapes" without needing republishing.

**The Method.** Seven numbered steps walk from "ask one open
question" through "validate against the compiler" to "offer or auto-run
`crewhaus optimize`." The first three steps are interview; steps 4–5
are reading the relevant recipe(s) and generating the YAML; step 6 is
validation; step 7 is the optimize handoff. Each step is anchored to
intent, not config.

The bottom half is the **Rules** block — three hard `NEVER` rules that
forbid asking the user about tools, permission mode, or target shape.
These rules are what make the designer feel like a domain expert
rather than a YAML form. If you remove them, the model degrades back
into a wizard.

Below the instructions are the structural fields:

| Field         | Purpose                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `tools`       | `read, write, edit, glob, grep, bash`. Top-level for `target: cli` (verified at [packages/spec/src/index.ts:189](../../packages/spec/src/index.ts)). |
| `permissions` | `mode: default` plus a tiered rule list (see [Recipe 29](29-permissions-deep-dive.md)). |
| `compaction`  | `model: claude-haiku-4-5-20251001` — the interview reads several recipes and the spec schema, so Haiku-summarized snapshots keep cost manageable. |

The permission rules are the part most worth studying. They follow the
**tier order** from Recipe 29 — `alwaysDeny` beats `alwaysAllow` beats
`alwaysAsk`:

- `alwaysAllow` for `Read`, `Glob`, `Grep` — pure reads, cheap to
  greenlight.
- `alwaysAllow` for `Write` against five specific filename patterns —
  the exact files the designer produces (`crewhaus.yaml`,
  `.env.example`, `README.md`, `dataset.jsonl`, `graders.yaml`). Any
  other write path triggers `ask`.
- `alwaysAllow` for `git fetch`, `git pull --ff-only`, `git status`,
  `git log`, `git clone https://github.com/crewhaus/*`,
  `mkdir -p ~/.crewhaus/*`, and `bunx crewhaus
  {compile,doctor,optimize}` — the exact subcommands the methodology
  invokes.
- `alwaysAsk` for any other `Bash(**)` — the safety net. The
  designer's instructions tell it to use only allowlisted commands,
  but a model is not a contract; the rule list is.
- `alwaysDeny` for `Bash(rm -rf *)` and `Bash(sudo *)` — defense in
  depth.

This is the practical face of Pillar 3 (security as fabric) for a CLI
agent: empower the model on the work it's meant to do, and gate
everything else through human approval. Note especially: the designer
can `Write` a generated `crewhaus.yaml` without asking, but if it ever
tries to write `~/.zshrc`, the rule list converts that to an `ask`.

## Step 2 — Compile and run

From the repo root:

```bash
bun run compile:hello-harness-designer   # writes dist/agent.ts
ANTHROPIC_AUTH_TOKEN=... bun run run:hello-harness-designer
```

The first turn always goes like this:

```
> Hi! In one or two sentences, what do you want this agent to do?
```

This is the only fixed question. Everything else is derived from what
you say next.

## Step 3 — Three worked dialogues

These are the canonical patterns. The first walks the channel branch
of the diagnostic tree, the second walks the pipeline branch and
exercises the optimize handoff, and the third covers what happens when
you ask for something CrewHaus can't do.

### Dialogue A — "A Slack bot that reviews PRs"

> **You:** I want a Slack bot that reviews pull requests on our repo.
>
> **Designer:** *(reads `docs/recipes/INDEX.md`, walks to step 6 of the
> diagnostic tree → channel target with Slack adapter. Reads
> `docs/recipes/03-slack-bot.md`.)* Got it — a Slack bot. Two quick
> questions: should it read the diffs itself via the `gh` CLI, or only
> respond to whatever text the user pastes into Slack? And should it
> post review comments back to GitHub, or only into the Slack thread?
>
> **You:** Read diffs via `gh`, post comments back to Slack only.
>
> **Designer:** *(reads `docs/recipes/14-hooks.md`,
> `docs/recipes/29-permissions-deep-dive.md`,
> `docs/recipes/41-security-fabric.md` because the spec will include
> bash.)* Where should I write this?
>
> **You:** `./slack-pr-reviewer`
>
> **Designer:** *(writes
> `slack-pr-reviewer/crewhaus.yaml` with `target: channel`,
> `channels.slack`, `tools: [read, bash]`,
> `permissions.mode: default` (channel target — the rule in my
> instructions forbids `auto` for non-interactive shapes),
> `alwaysAllow Bash(gh *)`, `alwaysAsk Bash(**)`,
> `alwaysDeny Bash(rm -rf *)`. Header cites recipes 03, 14, 29, 41.
> Also writes `.env.example` listing `SLACK_BOT_TOKEN`,
> `SLACK_APP_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, and a
> `README.md`. Runs `bunx crewhaus compile slack-pr-reviewer/crewhaus.yaml
> --emit-ir` — it passes.)* Done. Shape: `channel` (Slack). Tools:
> `read`, `bash`. Bash gated to `gh` commands by default; everything
> else asks. Run:
>
> ```
> bun apps/cli/src/index.ts compile slack-pr-reviewer/crewhaus.yaml -o slack-pr-reviewer/dist
> SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… GITHUB_TOKEN=… ANTHROPIC_AUTH_TOKEN=… bun slack-pr-reviewer/dist/daemon.ts
> ```
>
> Do you have example PR diffs and the reviews you'd want the bot to
> produce? If so, I can scaffold an eval and run `crewhaus optimize` to
> tune the review style.

Notice the questions the designer *did* ask ("read diffs itself or
only what's pasted?", "post back to GitHub or Slack-only?") and the
ones it *didn't* ("which target shape?", "should I include the bash
tool?", "what permission mode?"). Every question maps to a decision
in user terms, not compiler terms.

### Dialogue B — "I have 500 PDFs and want to ask questions about them"

> **You:** I have a folder of about 500 PDFs (regulatory filings) and
> I want to be able to ask questions about them.
>
> **Designer:** *(walks to step 5 of the decision tree → pipeline
> shape. Reads `docs/recipes/06-rag-pipeline.md`. Defaults from
> [packages/spec-patch/src/index.ts](../../packages/spec-patch/src/index.ts)
> `OPTIMIZABLE_PATHS.pipeline`: `chunkSize: 1000`, `chunkOverlap: 200`,
> `defaultK: 5`.)* Two questions. Are the PDFs all in one folder I can
> point at, or scattered? And do you want fresh ingestion on every
> startup, or a persistent index?
>
> **You:** One folder, persistent index.
>
> **Designer:** Where should I write the spec?
>
> **You:** `./reg-filings-rag`
>
> **Designer:** *(writes `target: pipeline`, `documents.path: ./pdfs`,
> `indexing.chunkStrategy: markdown`, `chunkSize: 1000`,
> `chunkOverlap: 200`, `retrieve.defaultK: 5`,
> `retrieve.persist: true`. Compile passes.)* Done. Shape: `pipeline`
> with persistent vector store. Defaults from Recipe 06.
>
> Do you have example questions and the answers you'd expect?
>
> **You:** Yes — `golden-qa.jsonl` has about 40 of them.
>
> **Designer:** *(scaffolds `reg-filings-rag/dataset.jsonl` by copying
> from `golden-qa.jsonl`, writes
> `reg-filings-rag/graders.yaml` with `string_contains` graders
> (template from Recipe 12). Runs:)*
>
> ```
> bunx crewhaus optimize reg-filings-rag/crewhaus.yaml \
>   --dataset reg-filings-rag/dataset.jsonl \
>   --graders reg-filings-rag/graders.yaml \
>   --iterations 3 --write-back
> ```
>
> *Reports:* Optimization complete. Score: 0.58 → 0.74 (+16pp). The
> rewritten `agent.instructions` is in your YAML. See
> `.crewhaus/optimize/run-2026-05-15-1/report.html` for the diff.

This is what makes Recipe 48 a Pillar 2 recipe in disguise. The user
described the goal once, and the designer carried them all the way
through generation *and* tuning in a single session.

### Dialogue C — Out of scope

> **You:** I want an agent that fine-tunes itself on my data.
>
> **Designer:** Heads up: CrewHaus doesn't fine-tune model weights —
> it's a harness factory, not a training stack. The closest adjacent
> capability is `crewhaus optimize`, which uses eval feedback to tune
> a spec's `agent.instructions` (and other parameters in
> `OPTIMIZABLE_PATHS`) until pass rate plateaus. That gets you most of
> the practical benefit of fine-tuning for instruction-following tasks
> without the training cost. Want me to draft an eval spec for that
> approach? See [Recipe 12](12-eval-harness.md) for the dataset format
> and [Recipe 42](42-active-optimization.md) for the optimization
> mechanics.

The rule is: when intent doesn't map to a supported shape, say so in
user terms and point at the closest adjacent capability. Don't try to
shoehorn the request into a shape that almost-but-not-quite fits.

## Step 4 — Why validation is strict

The Method's step 6 is "run `bunx crewhaus compile <generated>/crewhaus.yaml
--emit-ir`. If it errors, patch and retry — up to 3 attempts. Never
hand the user a spec you have not seen the in-tree compiler accept."
The `--emit-ir` flag is in the spec's `alwaysAllow` list. The model
runs it, catches schema errors (e.g. `tools` placed under `agent`
when the target requires it at top level, or vice versa), patches the
YAML, retries.

This matters for two reasons:

1. **The spec schema is the source of truth, not the recipes.** A
   recipe documents the API as it was *when written*; the Zod schema
   in [packages/spec/src/index.ts](../../packages/spec/src/index.ts)
   documents the API as it is *right now*. The designer reads the
   schema at startup precisely so it generates YAML that the current
   compiler accepts.
2. **Generation is auditable.** The user knows the spec compiled
   before they got it. If it doesn't run, the failure is somewhere
   downstream of the compiler — runtime config, missing env var,
   credentials — not a YAML-level mistake.

If three retries don't produce a parseable spec, the designer hands
back the last attempt plus the compiler error and explains. This is
graceful failure, not silent success.

## Step 5 — The optimize handoff

The Method's step 7 is "ask if the user has a dataset." Two branches:

- **Has a dataset.** The designer scaffolds `dataset.jsonl` (one JSON
  record per line, schema from Recipe 12) and `graders.yaml`
  (template with the canonical graders — `string_contains`,
  `regex_match`, `judge_with_rubric`). Then runs `crewhaus optimize`
  in the same session with `--iterations 3 --write-back`. The
  rewritten YAML is the deliverable; the trajectory and report HTML
  go in `.crewhaus/optimize/<runId>/`.
- **No dataset yet.** Prints the optimize command the user can run
  later, and points at Recipe 12 for the dataset format.

This is what makes the designer a complete entry point: the user
arrives with intent, leaves with a tuned spec (when they brought
data) or a spec plus the next obvious step (when they didn't).

## Step 6 — Hybrid doc-path resolution

The designer needs to read the recipes catalog and the Zod schema at
runtime. It tries three paths in order, all in the instructions:

1. **In-repo (default).** If `$CWD/docs/recipes/INDEX.md` exists,
   `$CWD` is treated as the factory checkout. This is the common case
   — you ran `bun run run:hello-harness-designer` from the repo root.
2. **Env override.** If `$CREWHAUS_FACTORY_PATH` is set and points at
   a valid checkout, use it. This is for users who installed the
   compiled designer somewhere else and want to point at a known
   checkout.
3. **Clone-to-cache fallback.** Otherwise, `git clone
   https://github.com/crewhaus/crewhaus-factory ~/.crewhaus/factory-cache`
   on first run, `git pull --ff-only` on subsequent runs.

In all three cases the designer runs `git pull --ff-only` before
reading any docs, so a session always reflects HEAD (or the closest
fast-forwardable state).

**Trade-off.** The in-repo mode is always at HEAD. The cache mode
survives running anywhere on disk, but a stale cache means the
designer might generate a YAML against an older schema. The startup
sequence prints which path it resolved to, so this is visible.

## Things that look like this but aren't

| Thing | What it does | Why this isn't that |
|---|---|---|
| `crewhaus init` ([apps/cli/src/index.ts](../../apps/cli/src/index.ts)) | Writes a 6-line stub spec with hardcoded defaults | No interview, no shape selection. Use when you already know the shape and want a starter file. |
| [`packages/wizard`](../../packages/wizard) | Headless state machine, asks 5 technical questions (`target`, `name`, `model`, `tools`, `permissions.mode`) and patches a scaffold template | Config-driven, not intent-driven. Use when you know the shape and want a fast template-fill. The designer in this recipe *replaces* the wizard's UX. |
| [Recipe 42 — Active optimization](42-active-optimization.md) | Mutates `agent.instructions` etc. on an *existing* spec via eval feedback | Tunes a spec you already have; doesn't generate one. Natural follow-up — the designer auto-runs it when a dataset is provided. |
| `crewhaus doctor` (`--philosophy-alignment`) | Checks env health and three-pillar alignment | Audits, doesn't author. Useful to run after the designer has produced a spec. |
| [Recipe 26 — Template marketplace](26-template-marketplace.md) | Browse + clone published spec templates | Curated reuse vs. bespoke generation. Use the marketplace when an existing template fits your need. |
| [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) | The canonical `target: cli` walkthrough | This recipe IS a `target: cli` spec; Recipe 01 is the right place to learn the shape itself. Read it first if `target: cli` feels unfamiliar. |

## Verification

Static + smoke validation, run from the repo root:

```bash
bun run recipes:test    # static link + spec-fence validation
bun run recipes:smoke   # compile:hello-harness-designer in CI mode
```

Manual end-to-end:

```bash
bun run compile:hello-harness-designer
ANTHROPIC_AUTH_TOKEN=... bun run run:hello-harness-designer
```

Then paste any of the three dialogue intents above. Confirm:

- The designer's first question is open-ended ("what do you want this
  agent to do?"), not a multiple-choice menu.
- It never asks "which target shape?" or "which tools?".
- It reads `docs/recipes/INDEX.md` and at least one recipe before
  generating.
- The generated YAML has a header comment block citing intent +
  consulted recipes.
- `bunx crewhaus compile <generated>/crewhaus.yaml --emit-ir` exits 0
  on the spec the designer hands back.

## Future hardening

- **Prompt-cache the doc reads.** A single interview reads the schema
  + INDEX + 2–4 recipes — about 30–60K tokens. Adding `cache_control`
  markers (see [Recipe 33](33-prompt-caching.md)) on those reads cuts
  cost ~90% after the first interview. Deliberately deferred to keep
  the v1 spec readable.
- **Extract the methodology to a skill.** The 80-line "Method" +
  "Rules" block lives inline in `agent.instructions` today. Promoting
  it to a skill at
  `examples/hello-harness-designer/.crewhaus/skills/intent-driven-design/SKILL.md`
  would let multiple consumers share it (e.g., a future `crewhaus
  design` subcommand, or a Studio UI shell). Worth doing once a second
  consumer materializes.
- **Sub-agent for recipe reading.** For very complex requests the
  designer reads 4+ recipes serially. A sub-agent (Recipe 13) that
  reads recipes and returns digests would parallelize that step and
  cut context pressure.

## What to read next

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) — the simplest
  shape the designer typically generates, and the right place to
  build mental model of `target: cli`.
- [Recipe 12 — Eval Harness](12-eval-harness.md) — the dataset format
  the auto-optimize step expects.
- [Recipe 42 — Active Optimization](42-active-optimization.md) — the
  optimization mechanics. Especially useful if you want to understand
  what the designer just did when it auto-ran `crewhaus optimize`.
- [Part A — Target shapes](INDEX.md#part-a--target-shapes-one-recipe-per-shape) —
  the 14 shapes the designer picks from. Reading these makes you
  better than the designer at edge cases; the designer is good
  enough at the common ones.

## Pointers to source

- **Example spec:** [examples/hello-harness-designer/crewhaus.yaml](../../examples/hello-harness-designer/crewhaus.yaml)
- **Spec schema (source of truth the designer reads at startup):** [packages/spec/src/index.ts](../../packages/spec/src/index.ts)
- **The compiler the designer validates against:** [apps/cli/src/index.ts](../../apps/cli/src/index.ts) (`runCompile`)
- **The decision tree the designer walks:** [docs/recipes/INDEX.md](INDEX.md) (lines 20–67)
- **Contrast: the config-driven wizard:** [packages/wizard/src/index.ts](../../packages/wizard/src/index.ts)
- **Contrast: the stub-only init:** [apps/cli/src/index.ts](../../apps/cli/src/index.ts) (`runInit`)
- **`OPTIMIZABLE_PATHS` defaults the designer uses:** [packages/spec-patch/src/index.ts](../../packages/spec-patch/src/index.ts)
